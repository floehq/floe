import { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { getRedis } from "../state/redis.js";
import {
  getUploadFinalizeQueueStats,
  syncFinalizeQueueMetrics,
} from "../services/uploads/finalize.queue.js";
import { renderPrometheusMetrics } from "../services/metrics/runtime.metrics.js";
import { sendApiError } from "../utils/apiError.js";
import { checkPostgresHealth, isPostgresConfigured } from "../state/postgres.js";

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "1" || raw.toLowerCase() === "true") return true;
  if (raw === "0" || raw.toLowerCase() === "false") return false;
  return fallback;
}

const METRICS_ENABLED = parseBoolEnv("FLOE_ENABLE_METRICS", true);
const METRICS_TOKEN = (process.env.FLOE_METRICS_TOKEN ?? "").trim();

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

export default async function healthRoute(app: FastifyInstance) {
  app.get("/metrics", async (req, reply) => {
    if (!METRICS_ENABLED) {
      return sendApiError(reply, 404, "FILE_NOT_FOUND", "Not Found");
    }

    if (!METRICS_TOKEN) {
      req.log.error("FLOE_METRICS_TOKEN is missing while /metrics is enabled");
      return sendApiError(
        reply,
        503,
        "INTERNAL_ERROR",
        "Metrics auth is not configured",
        { retryable: true }
      );
    }

    const supplied =
      (typeof req.headers["x-metrics-token"] === "string"
        ? req.headers["x-metrics-token"].trim()
        : "") || bearerTokenFromAuthHeader(req.headers.authorization) || "";

    if (!supplied || !secureEqual(supplied, METRICS_TOKEN)) {
      return sendApiError(reply, 401, "UNAUTHORIZED", "Unauthorized");
    }

    await syncFinalizeQueueMetrics().catch((err) => {
      req.log.error({ err }, "Failed to sync finalize queue metrics");
    });

    return reply
      .code(200)
      .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
      .send(renderPrometheusMetrics());
  });

  app.get("/health", async (req, reply) => {
    const start = Date.now();
    const timestamp = new Date().toISOString();

    let redisOk = false;
    let latencyMs: number | null = null;
    let finalizeQueue:
      | {
          depth: number;
          pendingUnique: number;
          activeLocal: number;
          concurrency: number;
        }
      | null = null;
    let postgres = {
      enabled: false,
      ok: null as boolean | null,
      latencyMs: null as number | null,
    };

    try {
      const redis = getRedis();
      await redis.ping();
      redisOk = true;
      latencyMs = Date.now() - start;
    } catch (err) {
      req.log.error({ err }, "Redis Health Check Failed");
    }

    if (redisOk) {
      try {
        finalizeQueue = await getUploadFinalizeQueueStats();
      } catch (err) {
        req.log.error({ err }, "Finalize queue health read failed");
      }
    }

    if (isPostgresConfigured()) {
      postgres = await checkPostgresHealth();
    }

    const ready = redisOk && (!postgres.enabled || postgres.ok === true);

    return reply.status(ready ? 200 : 503).send({
      status: ready ? "UP" : "DOWN",
      service: "floe-api-v1",
      ready,
      timestamp,
      checks: {
        redis: {
          ok: redisOk,
          latencyMs,
          timestamp,
        },
        postgres,
        finalizeQueue: finalizeQueue ?? {
          depth: null,
          pendingUnique: null,
          activeLocal: null,
          concurrency: null,
        },
      },
    });
  });
}
