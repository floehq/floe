import PQueue from "p-queue";
import type { FastifyBaseLogger } from "fastify";

import { getRedis } from "../../state/redis.js";
import { uploadKeys } from "../../state/keys.js";
import { getSession } from "./session.js";
import { finalizeUpload } from "./finalize.js";
import {
  recordFinalizeEnqueue,
  recordFinalizeJobResult,
  setFinalizeQueueMetrics,
} from "../metrics/runtime.metrics.js";

function parsePositiveIntEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return n;
}

const FINALIZE_CONCURRENCY = parsePositiveIntEnv("FLOE_FINALIZE_CONCURRENCY", 4);
const FINALIZE_TIMEOUT_MS = parsePositiveIntEnv(
  "FLOE_FINALIZE_TIMEOUT_MS",
  30 * 60_000,
  1000
);
const FINALIZE_IN_PROGRESS_RETRY_MS = parsePositiveIntEnv(
  "FLOE_FINALIZE_RETRY_MS",
  2000,
  200
);
const FINALIZE_IN_PROGRESS_RETRY_MAX_MS = parsePositiveIntEnv(
  "FLOE_FINALIZE_RETRY_MAX_MS",
  30_000,
  1000
);
const FINALIZE_DRAIN_INTERVAL_MS = parsePositiveIntEnv(
  "FLOE_FINALIZE_DRAIN_INTERVAL_MS",
  500,
  100
);
const FINALIZE_QUEUE_MAX_DEPTH = parsePositiveIntEnv(
  "FLOE_FINALIZE_QUEUE_MAX_DEPTH",
  5000
);

const finalizeWorkers = new PQueue({
  concurrency: FINALIZE_CONCURRENCY,
});

let drainTimer: NodeJS.Timeout | null = null;
const activeLocal = new Set<string>();

function classifyFinalizeReason(message: string): string {
  const msg = (message ?? "").toUpperCase();
  if (msg.includes("UPLOAD_FINALIZE_TIMEOUT")) return "timeout";
  if (msg.includes("UPLOAD_NOT_FOUND")) return "not_found";
  if (msg.includes("INCOMPLETE_CHUNKS")) return "incomplete_chunks";
  if (msg.includes("MISSING_CHUNKS")) return "missing_chunks";
  if (msg.includes("WALRUS")) return "walrus";
  if (msg.includes("SUI")) return "sui";
  if (msg.includes("REDIS")) return "redis";
  if (msg.includes("LOCK")) return "lock";
  return "other";
}

function queueKey() {
  return uploadKeys.finalizeQueue();
}

function pendingKey() {
  return uploadKeys.finalizePending();
}

async function markUploadFailed(uploadId: string, errorMessage: string) {
  const redis = getRedis();
  await redis
    .hset(uploadKeys.meta(uploadId), {
      status: "failed",
      failedAt: String(Date.now()),
      error: errorMessage.slice(0, 500),
    })
    .catch(() => {});
}

async function markUploadFinalizing(uploadId: string) {
  const redis = getRedis();
  await redis
    .hset(uploadKeys.meta(uploadId), {
      status: "finalizing",
      finalizingQueuedAt: String(Date.now()),
    })
    .catch(() => {});
}

async function enqueueUploadId(uploadId: string): Promise<boolean> {
  const redis = getRedis();
  const script = `
    local pendingKey = KEYS[1]
    local queueKey = KEYS[2]
    local uploadId = ARGV[1]

    local added = redis.call("SADD", pendingKey, uploadId)
    if added == 1 then
      redis.call("LPUSH", queueKey, uploadId)
    end
    return added
  `;

  const added = await redis.eval(script, [pendingKey(), queueKey()], [uploadId]);
  return Number(added) === 1;
}

async function enqueueUploadIdForce(uploadId: string): Promise<void> {
  const redis = getRedis();
  const script = `
    redis.call("SADD", KEYS[1], ARGV[1])
    redis.call("LPUSH", KEYS[2], ARGV[1])
    return 1
  `;
  await redis.eval(script, [pendingKey(), queueKey()], [uploadId]);
}

async function dequeueUploadId(): Promise<string | null> {
  const redis = getRedis();
  const uploadId = await redis.rpop<string>(queueKey());
  if (!uploadId || typeof uploadId !== "string") return null;
  return uploadId;
}

async function clearPending(uploadId: string): Promise<void> {
  const redis = getRedis();
  await redis.srem(pendingKey(), uploadId);
}

async function processFinalize(uploadId: string): Promise<void> {
  const session = await getSession(uploadId);
  if (!session) {
    const redis = getRedis();
    const meta = await redis.hgetall<Record<string, string>>(uploadKeys.meta(uploadId));
    if (meta?.status === "completed") return;
    throw new Error("UPLOAD_NOT_FOUND");
  }

  await finalizeUpload(session);
}

async function lockRetryDelayMs(uploadId: string): Promise<number> {
  const redis = getRedis();
  const ttlSeconds = Number(await redis.ttl(`${uploadKeys.meta(uploadId)}:lock`));
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return FINALIZE_IN_PROGRESS_RETRY_MS;
  }

  return Math.max(
    FINALIZE_IN_PROGRESS_RETRY_MS,
    Math.min(ttlSeconds * 1000, FINALIZE_IN_PROGRESS_RETRY_MAX_MS)
  );
}

async function scheduleRetry(uploadId: string, log: FastifyBaseLogger, delayMs: number) {
  setTimeout(() => {
    void (async () => {
      try {
        await enqueueUploadIdForce(uploadId);
        await drainOnce(log);
      } catch (err: any) {
        await markUploadFailed(uploadId, String(err?.message ?? "FINALIZE_REQUEUE_FAILED"));
        log.error({ uploadId, err }, "Finalize retry enqueue failed");
      }
    })();
  }, delayMs);
}

async function runFinalizeJob(uploadId: string, log: FastifyBaseLogger) {
  const startedAt = Date.now();
  let timeoutHandle: NodeJS.Timeout | null = null;
  let timedOut = false;

  try {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      log.error(
        {
          uploadId,
          elapsedMs: Date.now() - startedAt,
          timeoutMs: FINALIZE_TIMEOUT_MS,
        },
        "Upload finalize worker exceeded timeout; keeping job active until finalize settles"
      );
    }, FINALIZE_TIMEOUT_MS);
    timeoutHandle.unref?.();

    await processFinalize(uploadId);
    log.info({ uploadId }, "Upload finalize worker completed");
    await clearPending(uploadId);
    recordFinalizeJobResult({
      outcome: "success",
      durationMs: Date.now() - startedAt,
    });
  } catch (err: any) {
    const msg = String(err?.message ?? "UPLOAD_FINALIZE_FAILED");
    if (msg === "UPLOAD_FINALIZATION_IN_PROGRESS") {
      const delayMs = await lockRetryDelayMs(uploadId).catch(
        () => FINALIZE_IN_PROGRESS_RETRY_MS
      );
      await scheduleRetry(uploadId, log, delayMs);
      await clearPending(uploadId);
      recordFinalizeJobResult({
        outcome: "retry_lock",
        reason: "UPLOAD_FINALIZATION_IN_PROGRESS",
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    await markUploadFailed(uploadId, msg);
    await clearPending(uploadId);
    log.error(
      {
        uploadId,
        err,
        ...(timedOut ? { timeoutMs: FINALIZE_TIMEOUT_MS } : {}),
      },
      timedOut
        ? "Upload finalize worker failed after exceeding timeout"
        : "Upload finalize worker failed"
    );
    recordFinalizeJobResult({
      outcome: "failed",
      reason: classifyFinalizeReason(msg),
      durationMs: Date.now() - startedAt,
    });
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    activeLocal.delete(uploadId);
  }
}

async function drainOnce(log: FastifyBaseLogger) {
  while (finalizeWorkers.size + finalizeWorkers.pending < FINALIZE_CONCURRENCY) {
    const uploadId = await dequeueUploadId();
    if (!uploadId) return;
    if (activeLocal.has(uploadId)) continue;

    activeLocal.add(uploadId);
    void finalizeWorkers.add(async () => {
      await runFinalizeJob(uploadId, log);
    });
  }
}

async function recoverFinalizingUploads(log: FastifyBaseLogger) {
  const redis = getRedis();
  const activeIds = await redis.smembers<string[]>(uploadKeys.gcIndex());
  if (!Array.isArray(activeIds) || activeIds.length === 0) return;

  let recovered = 0;
  let cleaned = 0;

  for (const uploadId of activeIds) {
    const status = await redis.hget<string>(uploadKeys.meta(uploadId), "status");
    if (status === "finalizing") {
      // Force requeue on startup so stale pending entries do not block recovery.
      await enqueueUploadIdForce(uploadId);
      recovered += 1;
      continue;
    }

    // Cleanup stale queue/pending entries for non-finalizing uploads.
    await Promise.all([
      redis.srem(pendingKey(), uploadId),
      redis.lrem(queueKey(), 0, uploadId),
    ]);
    cleaned += 1;
  }
  log.info(
    { count: activeIds.length, recovered, cleaned },
    "Finalize queue recovery scan completed"
  );
}

export async function startUploadFinalizeWorker(log: FastifyBaseLogger): Promise<void> {
  await recoverFinalizingUploads(log);
  await drainOnce(log);

  if (drainTimer) clearInterval(drainTimer);
  drainTimer = setInterval(() => {
    void drainOnce(log).catch((err) => log.error({ err }, "Finalize queue drain failed"));
  }, FINALIZE_DRAIN_INTERVAL_MS);
  drainTimer.unref?.();
}

export async function stopUploadFinalizeWorker(): Promise<void> {
  if (drainTimer) {
    clearInterval(drainTimer);
    drainTimer = null;
  }
  await finalizeWorkers.onIdle();
}

export async function enqueueUploadFinalize(params: {
  uploadId: string;
  log: FastifyBaseLogger;
}): Promise<{ enqueued: boolean; rejectedByBackpressure: boolean }> {
  const stats = await getUploadFinalizeQueueStats();
  if (stats.depth >= FINALIZE_QUEUE_MAX_DEPTH) {
    recordFinalizeEnqueue({ result: "rejected_backpressure" });
    return { enqueued: false, rejectedByBackpressure: true };
  }

  await markUploadFinalizing(params.uploadId);
  const enqueued = await enqueueUploadId(params.uploadId);
  recordFinalizeEnqueue({ result: enqueued ? "enqueued" : "duplicate" });
  await drainOnce(params.log);
  return { enqueued, rejectedByBackpressure: false };
}

export function isUploadFinalizeQueued(uploadId: string): boolean {
  return activeLocal.has(uploadId);
}

export async function getUploadFinalizeQueueStats(): Promise<{
  depth: number;
  pendingUnique: number;
  activeLocal: number;
  concurrency: number;
}> {
  const redis = getRedis();
  const [depth, pendingUnique] = await Promise.all([
    redis.llen(queueKey()),
    redis.scard(pendingKey()),
  ]);
  return {
    depth: Number(depth ?? 0),
    pendingUnique: Number(pendingUnique ?? 0),
    activeLocal: activeLocal.size,
    concurrency: FINALIZE_CONCURRENCY,
  };
}

export async function syncFinalizeQueueMetrics(): Promise<void> {
  const stats = await getUploadFinalizeQueueStats();
  setFinalizeQueueMetrics({
    depth: stats.depth,
    pendingUnique: stats.pendingUnique,
    activeLocal: stats.activeLocal,
  });
}
