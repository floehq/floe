import { parseBoolEnv } from "../utils/parseEnv.js";
import { isUuid } from "../utils/validation.js";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
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
  checkS3Health,
  checkWalrusDependencyHealth,
} from "../services/health/dependencies.js";
import { buildOperatorUploadSummary } from "../services/ops/upload.summary.js";
import { emitAuditEvent, requestEventContext } from "../services/events/infrastructure.events.js";
import { getAllSloStatuses } from "../services/reliability/sli.js";
import { TopologyConfig } from "../config/topology.config.js";
import { describeWalrusReaders } from "../config/walrus.config.js";
import { describeWalrusWriters } from "../services/walrus/upload.js";
import { buildVersionInfo } from "../version.js";

const METRICS_ENABLED = parseBoolEnv("FLOE_ENABLE_METRICS", true);
const METRICS_TOKEN = (process.env.FLOE_METRICS_TOKEN ?? "").trim();
const PUBLIC_HEALTH_DETAILS = parseBoolEnv("FLOE_PUBLIC_HEALTH_DETAILS", false);

const FINALIZE_QUEUE_STUCK_AGE_MS = (() => {
  const raw = process.env.FLOE_FINALIZE_QUEUE_STUCK_AGE_MS;
  if (raw === undefined || raw === "") return 5 * 60_000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1000) {
    throw new Error("FLOE_FINALIZE_QUEUE_STUCK_AGE_MS must be an integer >= 1000");
  }
  return n;
})();

const HEALTH_CACHE_TTL_MS = (() => {
  const raw = process.env.FLOE_HEALTH_CACHE_TTL_MS;
  if (raw === undefined || raw === "") return 1000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("FLOE_HEALTH_CACHE_TTL_MS must be an integer >= 0");
  }
  return n;
})();

type HealthSnapshot = {
  statusCode: number;
  payload: Record<string, unknown>;
  expiresAt: number;
};

let cachedHealthSnapshot: HealthSnapshot | null = null;
let inFlightHealthSnapshot: Promise<HealthSnapshot> | null = null;

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

function authzStatusCode(code?: string): 401 | 403 {
  return code === "AUTH_REQUIRED" ? 401 : 403;
}

function authzErrorCode(code?: string): "AUTH_REQUIRED" | "INSUFFICIENT_SCOPE" {
  if (code === "AUTH_REQUIRED") return "AUTH_REQUIRED";
  return "INSUFFICIENT_SCOPE";
}

function requireMetricsToken(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!METRICS_ENABLED) {
    sendApiError(reply, 404, "FILE_NOT_FOUND", "Not Found");
    return false;
  }

  if (!METRICS_TOKEN) {
    req.childLogger.error("FLOE_METRICS_TOKEN is missing while ops auth is enabled");
    sendApiError(reply, 503, "INTERNAL_ERROR", "Metrics auth is not configured", {
      retryable: true,
    });
    return false;
  }

  const supplied =
    (typeof req.headers["x-metrics-token"] === "string"
      ? req.headers["x-metrics-token"].trim()
      : "") ||
    bearerTokenFromAuthHeader(req.headers.authorization) ||
    "";

  if (!supplied || !secureEqual(supplied, METRICS_TOKEN)) {
    sendApiError(reply, 401, "UNAUTHORIZED", "Unauthorized");
    return false;
  }

  return true;
}

function parseBoolQuery(raw: unknown): boolean {
  return raw === true || raw === "1" || raw === "true";
}

async function buildHealthSnapshot(req: FastifyRequest): Promise<HealthSnapshot> {
  const timestamp = new Date().toISOString();
  const version = buildVersionInfo();
  let finalizeQueue: {
    depth: number;
    pendingUnique: number;
    activeLocal: number;
    concurrency: number;
    oldestQueuedAt: number | null;
    oldestQueuedAgeMs: number | null;
  } | null = null;
  const [redis, postgres, s3, walrus] = await Promise.all([
    checkRedisDependencyHealth(),
    checkPostgresDependencyHealth(),
    checkS3Health(),
    checkWalrusDependencyHealth(),
  ]);

  if (!redis.ok) {
    req.childLogger.error("Redis Health Check Failed");
  }

  if (redis.ok) {
    try {
      finalizeQueue = await getUploadFinalizeQueueStats();
    } catch (err) {
      req.childLogger.error({ err }, "Finalize queue health read failed");
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
    finalizeQueueHealth.ready && redis.status === "healthy" && postgres.status !== "unavailable";
  const degraded = finalizeQueueHealth.backlogStalled || postgres.status === "degraded";
  const serviceStatus = ready ? (degraded ? "DEGRADED" : "UP") : "DOWN";
  const statusCode = ready ? 200 : 503;

  return {
    statusCode,
    expiresAt: Date.now() + HEALTH_CACHE_TTL_MS,
    payload: {
      ...version,
      role: TopologyConfig.role,
      capabilities: {
        uploads: TopologyConfig.routes.uploads,
        files: TopologyConfig.routes.files,
        ops: TopologyConfig.routes.ops,
        finalizeWorker: TopologyConfig.workers.finalize,
      },
      slo: getAllSloStatuses(),
      walrus: {
        readers: describeWalrusReaders(),
        writers: describeWalrusWriters(),
      },
      status: serviceStatus,
      ready,
      degraded,
      timestamp,
      checks: {
        redis,
        postgres,
        s3,
        walrus,
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
    },
  };
}

async function getCachedHealthSnapshot(req: FastifyRequest): Promise<HealthSnapshot> {
  if (cachedHealthSnapshot && cachedHealthSnapshot.expiresAt > Date.now()) {
    return cachedHealthSnapshot;
  }

  if (!inFlightHealthSnapshot) {
    inFlightHealthSnapshot = buildHealthSnapshot(req)
      .then((snapshot) => {
        cachedHealthSnapshot = snapshot;
        return snapshot;
      })
      .finally(() => {
        inFlightHealthSnapshot = null;
      });
  }

  return inFlightHealthSnapshot;
}

export const healthRouteTestHooks = {
  resetCache() {
    cachedHealthSnapshot = null;
    inFlightHealthSnapshot = null;
  },
};

export default async function healthRoute(app: FastifyInstance) {
  app.get(
    "/livez",
    {
      schema: {
        tags: ["Health"],
        summary: "Liveness check",
        description:
          "Simple liveness probe that always returns 200 if the process is running. Returns version info, status, role, and timestamp.",
        response: {
          200: {
            type: "object",
            properties: {
              service: { type: "string" },
              apiVersion: { type: "string" },
              serverVersion: { type: "string" },
              status: { type: "string" },
              role: { type: "string" },
              timestamp: { type: "string", format: "date-time" },
            },
          },
        },
      },
    },
    async (_req, reply) => {
      return reply.code(200).send({
        ...buildVersionInfo(),
        status: "UP",
        role: TopologyConfig.role,
        timestamp: new Date().toISOString(),
      });
    },
  );

  app.get(
    "/version",
    {
      schema: {
        tags: ["Health"],
        summary: "Version info",
        description: "Returns the current service, API, and server version strings.",
        response: {
          200: {
            type: "object",
            properties: {
              service: { type: "string" },
              apiVersion: { type: "string" },
              serverVersion: { type: "string" },
            },
          },
        },
      },
    },
    async (_req, reply) => {
      return reply.code(200).send(buildVersionInfo());
    },
  );

  app.get(
    "/metrics",
    {
      schema: {
        tags: ["Health"],
        summary: "Prometheus metrics",
        description:
          "Returns Prometheus-format metrics. Requires a valid metrics token via x-metrics-token header or Bearer authorization.",
        security: [{ bearerToken: [] }],
        response: {
          200: {
            type: "string",
            description: "Prometheus metrics text",
          },
          401: {
            type: "object",
            properties: {
              code: { type: "string" },
              message: { type: "string" },
            },
          },
          429: {
            type: "object",
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              retryable: { type: "boolean" },
            },
          },
          503: {
            type: "object",
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              retryable: { type: "boolean" },
            },
          },
        },
      },
    },
    async (req, reply) => {
    // Enforce the metrics token (constant-time comparison against FLOE_METRICS_TOKEN).
    if (!requireMetricsToken(req, reply)) {
      emitAuditEvent(req.childLogger, {
        action: "metrics_access_denied",
        resource: "metrics",
        actor: requestEventContext(req).actor,
        requestId: req.id,
        before: null,
        after: null,
        metadata: { reason: "missing_or_invalid_metrics_token" },
      });
      return;
    }

    // Rate limit metrics reads to protect against brute-force of the token
    // and excessive Prometheus scrape overhead.
    const metricsLimit = await req.server.authProvider.checkRateLimit({
      req,
      scope: "ops_read",
    });
    if (!metricsLimit.allowed) {
      return sendApiError(reply, 429, "RATE_LIMITED", "Metrics rate limit exceeded", {
        retryable: true,
        details: {
          limit: metricsLimit.limit,
          current: metricsLimit.current,
          windowSeconds: metricsLimit.windowSeconds,
        },
      });
    }

    // Emit audit event for successful metrics scrape
    emitAuditEvent(req.childLogger, {
      action: "metrics_access",
      resource: "metrics",
      actor: requestEventContext(req).actor,
      requestId: req.id,
      before: null,
      after: null,
      metadata: {
        authenticated: true,
        method: "metrics_token",
      },
    });

    await syncFinalizeQueueMetrics().catch((err) => {
      req.childLogger.error({ err }, "Failed to sync finalize queue metrics");
    });

    return reply
      .code(200)
      .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
      .send(renderPrometheusMetrics());
  });

  if (TopologyConfig.routes.ops) {
    app.get(
      "/ops/uploads/:uploadId",
      {
        schema: {
          tags: ["Ops"],
          summary: "Operator upload detail",
          description:
            "Retrieve detailed upload session state for operator inspection, including chunk progress, finalization status, Redis/Postgres health, and dependency checks. Requires operator authorization.",
          security: [{ bearerToken: [] }],
          params: {
            type: "object",
            required: ["uploadId"],
            properties: {
              uploadId: { type: "string", format: "uuid", description: "Upload session ID" },
            },
          },
          querystring: {
            type: "object",
            properties: {
              includeReceivedIndexes: {
                type: "string",
                description: "Set to '1' to include the list of received chunk indexes",
              },
            },
          },
          response: {
            200: {
              type: "object",
              properties: {
                uploadId: { type: "string", format: "uuid" },
                summary: { type: "object" },
                dependencies: { type: "object" },
                session: { type: ["object", "null"] },
                meta: { type: ["object", "null"] },
                chunks: { type: "object" },
                finalize: { type: "object" },
              },
            },
            400: {
              type: "object",
              properties: {
                code: { type: "string" },
                message: { type: "string" },
              },
            },
            404: {
              type: "object",
              properties: {
                code: { type: "string" },
                message: { type: "string" },
              },
            },
          },
        },
      },
      async (req, reply) => {
      // Rate limit ops reads to prevent brute-force of upload IDs and
      // excessive backend queries.
      const opsLimit = await req.server.authProvider.checkRateLimit({
        req,
        scope: "ops_read",
      });
      if (!opsLimit.allowed) {
        return sendApiError(reply, 429, "RATE_LIMITED", "Ops rate limit exceeded", {
          retryable: true,
          details: {
            limit: opsLimit.limit,
            current: opsLimit.current,
            windowSeconds: opsLimit.windowSeconds,
          },
        });
      }

      const authz = await req.server.authProvider.authorizeOpsAccess({
        req,
        action: "upload_read",
      });
      if (!authz.allowed) {
        return sendApiError(
          reply,
          authzStatusCode(authz.code),
          authzErrorCode(authz.code),
          authz.message ?? "Operator access denied",
        );
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
          { retryable: true, details: { dependency: "redis" } },
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
        ? chunkMembers
            .map(Number)
            .filter(Number.isInteger)
            .sort((a, b) => a - b)
        : [];
      const includeReceivedIndexes = parseBoolQuery(
        (req.query as Record<string, unknown>)?.includeReceivedIndexes,
      );
      const operatorSummary = buildOperatorUploadSummary({
        session,
        meta: metaObject,
        receivedChunkIndexes: chunkIndexes,
        finalizePending: Number(pending) === 1,
        finalizeActiveLock: Number(hasLock) === 1,
        finalizeLockTtlSeconds: Number(lockTtlSeconds),
        finalizeQueue: queueStats,
        dependencies: {
          redis: redisHealth,
          postgres: postgresHealth,
        },
        finalizeStuckAgeThresholdMs: FINALIZE_QUEUE_STUCK_AGE_MS,
      });

      // Emit audit event for operator upload read
      emitAuditEvent(req.childLogger, {
        action: "ops_upload_read",
        resource: `upload:${uploadId}`,
        actor: requestEventContext(req).actor,
        requestId: req.id,
        before: null,
        after: null,
        metadata: {
          uploadId,
          hasSession: Boolean(session),
          metaStatus: metaObject?.status ?? null,
          hasChunks: chunkIndexes.length,
        },
      });

      return reply.code(200).send({
        uploadId,
        summary: operatorSummary,
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
  }

  app.get(
    "/health",
    {
      schema: {
        tags: ["Health"],
        summary: "Health check",
        description:
          "Returns service readiness, degradation status, and dependency health (Redis, Postgres, S3, Walrus). Returns 200 when ready, 503 when degraded or down. Response detail is controlled by FLOE_PUBLIC_HEALTH_DETAILS.",
        response: {
          200: {
            type: "object",
            properties: {
              service: { type: "string" },
              apiVersion: { type: "string" },
              serverVersion: { type: "string" },
              status: { type: "string" },
              ready: { type: "boolean" },
              degraded: { type: "boolean" },
              timestamp: { type: "string" },
            },
          },
          503: {
            type: "object",
            properties: {
              service: { type: "string" },
              apiVersion: { type: "string" },
              serverVersion: { type: "string" },
              status: { type: "string" },
              ready: { type: "boolean" },
              degraded: { type: "boolean" },
              timestamp: { type: "string" },
            },
          },
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
    const snapshot = await getCachedHealthSnapshot(req);
    if (!PUBLIC_HEALTH_DETAILS) {
      const p = snapshot.payload as Record<string, unknown>;
      return reply.status(snapshot.statusCode).send({
        service: p.service as string,
        apiVersion: p.apiVersion as string,
        serverVersion: p.serverVersion as string,
        status: p.status as string,
        ready: p.ready as boolean,
        degraded: p.degraded as boolean,
        timestamp: p.timestamp as string,
      });
    }
    return reply.status(snapshot.statusCode).send(snapshot.payload);
  });
}
