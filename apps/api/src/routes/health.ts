import { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { getSession } from "../services/uploads/session.js";
import { getRedis } from "../state/redis.js";
import { uploadKeys } from "../state/keys.js";
import {
  getUploadFinalizeQueueStats,
  syncFinalizeQueueMetrics,
} from "../services/uploads/finalize.queue.js";
import { renderPrometheusMetrics } from "../services/metrics/runtime.metrics.js";
import { assessFinalizeQueueHealth } from "../services/uploads/finalize.shared.js";
import { sendApiError } from "../utils/apiError.js";
import {
  checkPostgresDependencyHealth,
  checkRedisDependencyHealth,
} from "../services/health/dependencies.js";

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "1" || raw.toLowerCase() === "true") return true;
  if (raw === "0" || raw.toLowerCase() === "false") return false;
  return fallback;
}

const METRICS_ENABLED = parseBoolEnv("FLOE_ENABLE_METRICS", true);
const METRICS_TOKEN = (process.env.FLOE_METRICS_TOKEN ?? "").trim();

const FINALIZE_QUEUE_STUCK_AGE_MS = (() => {
  const raw = process.env.FLOE_FINALIZE_QUEUE_STUCK_AGE_MS;
  if (raw === undefined || raw === "") return 5 * 60_000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1000) {
    throw new Error("FLOE_FINALIZE_QUEUE_STUCK_AGE_MS must be an integer >= 1000");
  }
  return n;
})();

function bearerTokenFromAuthHeader(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1]?.trim();
  return token || undefined;
}

function secureEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function requireMetricsToken(req: any, reply: any): boolean {
  if (!METRICS_ENABLED) {
    sendApiError(reply, 404, "FILE_NOT_FOUND", "Not Found");
    return false;
  }

  if (!METRICS_TOKEN) {
    req.log.error("FLOE_METRICS_TOKEN is missing while ops auth is enabled");
    sendApiError(
      reply,
      503,
      "INTERNAL_ERROR",
      "Metrics auth is not configured",
      { retryable: true }
    );
    return false;
  }

  const supplied =
    (typeof req.headers["x-metrics-token"] === "string"
      ? req.headers["x-metrics-token"].trim()
      : "") || bearerTokenFromAuthHeader(req.headers.authorization) || "";

  if (!supplied || !secureEqual(supplied, METRICS_TOKEN)) {
    sendApiError(reply, 401, "UNAUTHORIZED", "Unauthorized");
    return false;
  }

  return true;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  );
}

function parseBoolQuery(raw: unknown): boolean {
  return raw === true || raw === "1" || raw === "true";
}

export default async function healthRoute(app: FastifyInstance) {
  app.get("/metrics", async (req, reply) => {
    if (!requireMetricsToken(req, reply)) {
      return;
    }

    await syncFinalizeQueueMetrics().catch((err) => {
      req.log.error({ err }, "Failed to sync finalize queue metrics");
    });

    return reply
      .code(200)
      .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
      .send(renderPrometheusMetrics());
  });

  app.get("/ops/uploads/:uploadId", async (req, reply) => {
    if (!requireMetricsToken(req, reply)) {
      return;
    }

    const { uploadId } = req.params as { uploadId: string };
    if (!isUuid(uploadId)) {
      return sendApiError(reply, 400, "INVALID_UPLOAD_ID", "uploadId must be a UUID");
    }

    const redisHealth = await checkRedisDependencyHealth();
    const postgresHealth = await checkPostgresDependencyHealth();
    if (!redisHealth.ok) {
      return sendApiError(
        reply,
        503,
        "DEPENDENCY_UNAVAILABLE",
        "Redis is unavailable, retry shortly",
        { retryable: true, details: { dependency: "redis" } }
      );
    }

    const redis = getRedis();
    const metaKey = uploadKeys.meta(uploadId);
    const lockKey = `${metaKey}:lock`;
    const [session, meta, chunkMembers, pending, hasLock, lockTtlSeconds] = await Promise.all([
      getSession(uploadId),
      redis.hgetall<Record<string, string>>(metaKey),
      redis.smembers<string[]>(uploadKeys.chunks(uploadId)),
      redis.sismember(uploadKeys.finalizePending(), uploadId),
      redis.exists(lockKey),
      redis.ttl(lockKey),
    ]);

    const metaObject = meta && Object.keys(meta).length > 0 ? meta : null;
    if (!session && !metaObject) {
      return sendApiError(reply, 404, "UPLOAD_NOT_FOUND", "Invalid uploadId");
    }

    const queueStats = await getUploadFinalizeQueueStats().catch(() => null);
    const chunkIndexes = Array.isArray(chunkMembers)
      ? chunkMembers.map(Number).filter(Number.isInteger).sort((a, b) => a - b)
      : [];
    const includeReceivedIndexes = parseBoolQuery((req as any).query?.includeReceivedIndexes);

    return reply.code(200).send({
      uploadId,
      dependencies: {
        redis: redisHealth,
        postgres: postgresHealth,
      },
      session: session ?? null,
      meta: metaObject,
      chunks: {
        receivedCount: chunkIndexes.length,
        ...(includeReceivedIndexes ? { receivedIndexes: chunkIndexes } : {}),
      },
      finalize: {
        pending: Number(pending) === 1,
        activeLock: Number(hasLock) === 1,
        lockTtlSeconds: Number(lockTtlSeconds),
        queue: queueStats,
      },
    });
  });

  app.get("/health", async (req, reply) => {
    const timestamp = new Date().toISOString();
    let finalizeQueue:
      | {
          depth: number;
          pendingUnique: number;
          activeLocal: number;
          concurrency: number;
          oldestQueuedAt: number | null;
          oldestQueuedAgeMs: number | null;
        }
      | null = null;
    const redis = await checkRedisDependencyHealth();
    const postgres = await checkPostgresDependencyHealth();

    if (!redis.ok) {
      req.log.error("Redis Health Check Failed");
    }

    if (redis.ok) {
      try {
        finalizeQueue = await getUploadFinalizeQueueStats();
      } catch (err) {
        req.log.error({ err }, "Finalize queue health read failed");
      }
    }

    const baseReady =
      redis.status === "healthy" &&
      (postgres.status === "healthy" ||
        postgres.status === "disabled" ||
        postgres.status === "degraded");
    const finalizeQueueHealth = assessFinalizeQueueHealth({
      ready: baseReady,
      finalizeQueue,
      stuckAgeThresholdMs: FINALIZE_QUEUE_STUCK_AGE_MS,
    });
    const ready =
      finalizeQueueHealth.ready &&
      redis.status === "healthy" &&
      postgres.status !== "unavailable";
    const degraded =
      finalizeQueueHealth.backlogStalled || postgres.status === "degraded";
    const serviceStatus = ready ? (degraded ? "DEGRADED" : "UP") : "DOWN";

    return reply.status(ready ? 200 : 503).send({
      status: serviceStatus,
      service: "floe-api-v1",
      ready,
      degraded,
      timestamp,
      checks: {
        redis,
        postgres,
        finalizeQueue: finalizeQueue ?? {
          depth: null,
          pendingUnique: null,
          activeLocal: null,
          concurrency: null,
          oldestQueuedAt: null,
          oldestQueuedAgeMs: null,
        },
        finalizeQueueWarning: finalizeQueueHealth.finalizeQueueWarning,
      },
    });
  });
}
