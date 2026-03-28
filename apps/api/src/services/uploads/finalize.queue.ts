import type { FastifyBaseLogger } from "fastify";

import { getRedis } from "../../state/redis.js";
import { uploadKeys } from "../../state/keys.js";
import { getSession } from "./session.js";
import {
  classifyFinalizeJobFailure,
  decideFinalizeWorkerFailureAction,
  executeFinalizeRecoveryPlan,
  executeFinalizeWorkerFailureAction,
  planFinalizeRecoveryPass,
  reserveFinalizeActiveLocal,
  shapeFinalizeQueueStats,
} from "./finalize.shared.js";
import {
  observeFinalizeQueueWait,
  recordFinalizeEnqueue,
  recordFinalizeJobResult,
  setFinalizeQueueMetrics,
} from "../metrics/runtime.metrics.js";

class LocalAsyncQueue {
  private readonly concurrency: number;
  private readonly queued: Array<() => void> = [];
  private readonly idleResolvers: Array<() => void> = [];
  pending = 0;
  size = 0;

  constructor(params: { concurrency: number }) {
    this.concurrency = params.concurrency;
  }

  add<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queued.push(() => {
        this.size -= 1;
        this.pending += 1;
        void task()
          .then(resolve, reject)
          .finally(() => {
            this.pending -= 1;
            this.pump();
            this.resolveIdleIfNeeded();
          });
      });
      this.size += 1;
      this.pump();
    });
  }

  onIdle(): Promise<void> {
    if (this.pending === 0 && this.size === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  private pump() {
    while (this.pending < this.concurrency && this.queued.length > 0) {
      const next = this.queued.shift();
      next?.();
    }
  }

  private resolveIdleIfNeeded() {
    if (this.pending !== 0 || this.size !== 0) return;
    while (this.idleResolvers.length > 0) {
      this.idleResolvers.shift()?.();
    }
  }
}

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
const FINALIZE_RETRYABLE_FAILURE_BASE_MS = parsePositiveIntEnv(
  "FLOE_FINALIZE_RETRYABLE_FAILURE_BASE_MS",
  2000,
  200
);
const FINALIZE_RETRYABLE_FAILURE_MAX_MS = parsePositiveIntEnv(
  "FLOE_FINALIZE_RETRYABLE_FAILURE_MAX_MS",
  30_000,
  1000
);
const FINALIZE_RETRYABLE_FAILURE_MAX_ATTEMPTS = parsePositiveIntEnv(
  "FLOE_FINALIZE_RETRYABLE_FAILURE_MAX_ATTEMPTS",
  4
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

const finalizeWorkers = new LocalAsyncQueue({
  concurrency: FINALIZE_CONCURRENCY,
});

let drainTimer: NodeJS.Timeout | null = null;
const activeLocal = new Set<string>();
let processFinalizeImpl: typeof processFinalize = processFinalize;
let scheduleRetryImpl: typeof scheduleRetry = scheduleRetry;

function queueKey() {
  return uploadKeys.finalizeQueue();
}

function pendingKey() {
  return uploadKeys.finalizePending();
}

async function markUploadFailed(params: {
  uploadId: string;
  errorMessage: string;
  reason: string;
  retryable: boolean;
  stage?: string;
  queueWaitMs?: number;
}) {
  const redis = getRedis();
  await redis
    .hset(uploadKeys.meta(params.uploadId), {
      status: "failed",
      failedAt: String(Date.now()),
      error: params.errorMessage.slice(0, 500),
      failedReasonCode: params.reason,
      failedRetryable: params.retryable ? "1" : "0",
      ...(params.stage ? { failedStage: params.stage } : {}),
      ...(params.queueWaitMs !== undefined
        ? { finalizeQueueWaitMs: String(params.queueWaitMs) }
        : {}),
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
  const queuedAt = Date.now();
  const script = `
    local pendingKey = KEYS[1]
    local queueKey = KEYS[2]
    local pendingSinceKey = KEYS[3]
    local uploadId = ARGV[1]
    local queuedAt = ARGV[2]

    local added = redis.call("SADD", pendingKey, uploadId)
    if added == 1 then
      redis.call("LPUSH", queueKey, uploadId)
      redis.call("ZADD", pendingSinceKey, queuedAt, uploadId)
    end
    return added
  `;

  const added = await redis.eval(
    script,
    [pendingKey(), queueKey(), uploadKeys.finalizePendingSince()],
    [uploadId, String(queuedAt)]
  );
  return Number(added) === 1;
}

async function enqueueUploadIdForce(uploadId: string): Promise<void> {
  const redis = getRedis();
  const queuedAt = Date.now();
  const script = `
    redis.call("SADD", KEYS[1], ARGV[1])
    redis.call("LPUSH", KEYS[2], ARGV[1])
    redis.call("ZADD", KEYS[3], ARGV[2], ARGV[1])
    return 1
  `;
  await redis.eval(
    script,
    [pendingKey(), queueKey(), uploadKeys.finalizePendingSince()],
    [uploadId, String(queuedAt)]
  );
}

async function dequeueUploadId(): Promise<string | null> {
  const redis = getRedis();
  const uploadId = await redis.rpop<string>(queueKey());
  if (!uploadId || typeof uploadId !== "string") return null;
  return uploadId;
}

async function clearPending(uploadId: string): Promise<void> {
  const redis = getRedis();
  await Promise.all([
    redis.srem(pendingKey(), uploadId),
    redis.zrem(uploadKeys.finalizePendingSince(), uploadId),
  ]);
}

async function processFinalize(params: {
  uploadId: string;
  log: FastifyBaseLogger;
  attempt: number;
  queueWaitMs: number;
}): Promise<void> {
  const session = await getSession(params.uploadId);
  if (!session) {
    const redis = getRedis();
    const meta = await redis.hgetall<Record<string, string>>(
      uploadKeys.meta(params.uploadId)
    );
    if (meta?.status === "completed") return;
    throw new Error("UPLOAD_NOT_FOUND");
  }

  const { finalizeUpload } = await import("./finalize.js");
  await finalizeUpload(session, {
    log: params.log,
    attempt: params.attempt,
    queueWaitMs: params.queueWaitMs,
  });
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
        await markUploadFailed({
          uploadId,
          errorMessage: String(err?.message ?? "FINALIZE_REQUEUE_FAILED"),
          reason: "finalize_requeue_failed",
          retryable: true,
        });
        log.error({ uploadId, err }, "Finalize retry enqueue failed");
      }
    })();
  }, delayMs);
}

async function runFinalizeJob(uploadId: string, log: FastifyBaseLogger) {
  const startedAt = Date.now();
  let timeoutHandle: NodeJS.Timeout | null = null;
  let timedOut = false;
  const redis = getRedis();
  const queuedAtRaw = await redis.hget<string>(uploadKeys.meta(uploadId), "finalizingQueuedAt");
  const queueWaitMs =
    queuedAtRaw && Number.isFinite(Number(queuedAtRaw))
      ? Math.max(0, startedAt - Number(queuedAtRaw))
      : 0;
  observeFinalizeQueueWait(queueWaitMs);
  const attempt = Number(await redis.hincrby(uploadKeys.meta(uploadId), "finalizeAttempts", 1));
  await redis.hset(uploadKeys.meta(uploadId), {
    lastFinalizeAttemptAt: String(startedAt),
    finalizeQueueWaitMs: String(queueWaitMs),
  });

  try {
    const processPromise = processFinalizeImpl({ uploadId, log, attempt, queueWaitMs });
    void processPromise.then(
      () => {
        if (timedOut) {
          log.warn({ uploadId }, "Upload finalize settled after timeout recovery");
        }
      },
      (lateErr) => {
        if (timedOut) {
          log.warn({ uploadId, err: lateErr }, "Upload finalize rejected after timeout recovery");
        }
      }
    );

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        log.error(
          {
            uploadId,
            elapsedMs: Date.now() - startedAt,
            timeoutMs: FINALIZE_TIMEOUT_MS,
          },
          "Upload finalize worker exceeded timeout; forcing retry recovery"
        );
        const timeoutErr = new Error("UPLOAD_FINALIZE_TIMEOUT") as Error & {
          finalizeStage?: string;
        };
        timeoutErr.finalizeStage = "timeout";
        reject(timeoutErr);
      }, FINALIZE_TIMEOUT_MS);
      timeoutHandle.unref?.();
    });

    await Promise.race([processPromise, timeoutPromise]);
    log.info({ uploadId, attempt, queueWaitMs }, "Upload finalize worker completed");
    await clearPending(uploadId);
    recordFinalizeJobResult({
      outcome: "success",
      durationMs: Date.now() - startedAt,
      retryable: false,
    });
  } catch (err: any) {
    const msg = String(err?.message ?? "UPLOAD_FINALIZE_FAILED");
    const failure = classifyFinalizeJobFailure(err);
    const failureAction = decideFinalizeWorkerFailureAction({
      message: msg,
      attempt,
      reason: failure.reason,
      retryable: failure.retryable,
      stage: failure.stage,
      lockRetryDelayMs: await lockRetryDelayMs(uploadId).catch(
        () => FINALIZE_IN_PROGRESS_RETRY_MS
      ),
      retryableBaseDelayMs: FINALIZE_RETRYABLE_FAILURE_BASE_MS,
      retryableMaxDelayMs: FINALIZE_RETRYABLE_FAILURE_MAX_MS,
      retryableMaxAttempts: FINALIZE_RETRYABLE_FAILURE_MAX_ATTEMPTS,
    });
    const actionResult = await executeFinalizeWorkerFailureAction({
      action: failureAction,
      uploadId,
      nowMs: Date.now(),
      writeMeta: async (fields) => {
        await redis.hset(uploadKeys.meta(uploadId), fields).catch(() => {});
      },
      scheduleRetry: async (nextUploadId, nextDelayMs) => {
        await scheduleRetryImpl(nextUploadId, log, nextDelayMs);
      },
      clearPending: async (nextUploadId) => {
        await clearPending(nextUploadId);
      },
      markFailed: async ({ uploadId: failedUploadId, reason, retryable, stage }) => {
        await markUploadFailed({
          uploadId: failedUploadId,
          errorMessage: msg,
          reason,
          retryable,
          stage,
          queueWaitMs,
        });
      },
    });

    if (actionResult.metricsOutcome !== "failed") {
      log.warn(
        {
          uploadId,
          attempt,
          queueWaitMs,
          reason: actionResult.reason,
          failedStage: failure.stage,
          delayMs: failureAction.action === "failed" ? undefined : failureAction.delayMs,
          err,
          ...(timedOut ? { timeoutMs: FINALIZE_TIMEOUT_MS } : {}),
        },
        actionResult.metricsOutcome === "retry_lock"
          ? "Upload finalize worker requeued due to lock contention"
          : "Upload finalize worker scheduled retry for transient failure"
      );
      recordFinalizeJobResult({
        outcome: actionResult.metricsOutcome,
        reason: actionResult.reason,
        durationMs: Date.now() - startedAt,
        retryable: true,
      });
      return;
    }

    log.error(
      {
        uploadId,
        attempt,
        queueWaitMs,
        reason: failure.reason,
        retryable: failure.retryable,
        failedStage: failure.stage,
        err,
        ...(timedOut ? { timeoutMs: FINALIZE_TIMEOUT_MS } : {}),
      },
      timedOut
        ? "Upload finalize worker failed after exceeding timeout"
        : "Upload finalize worker failed"
    );
    recordFinalizeJobResult({
      outcome: "failed",
      reason: failure.reason,
      durationMs: Date.now() - startedAt,
      retryable: failure.retryable,
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
    const reservation = reserveFinalizeActiveLocal({
      activeLocalIds: [...activeLocal],
      uploadId,
    });
    if (!reservation.reserved) continue;

    activeLocal.add(uploadId);
    void finalizeWorkers.add(async () => {
      await runFinalizeJob(uploadId, log);
    });
  }
}

async function recoverFinalizingUploads(log: FastifyBaseLogger): Promise<{
  scanned: number;
  recovered: number;
  cleaned: number;
}> {
  const redis = getRedis();
  const activeIds = await redis.smembers<string[]>(uploadKeys.gcIndex());
  if (!Array.isArray(activeIds) || activeIds.length === 0) {
    return { scanned: 0, recovered: 0, cleaned: 0 };
  }

  const entries = await Promise.all(
    activeIds.map(async (uploadId) => {
      const meta = await redis.hgetall<Record<string, string>>(uploadKeys.meta(uploadId));
      return {
        uploadId,
        status: meta?.status,
        failedRetryable: meta?.failedRetryable,
        finalizeAttemptState: meta?.finalizeAttemptState,
      };
    })
  );
  const recoveryPlan = planFinalizeRecoveryPass(entries);

  const { recovered, cleaned } = await executeFinalizeRecoveryPlan({
    plan: recoveryPlan,
    requeue: async (uploadId) => {
      // Force requeue on startup so stale pending entries do not block recovery.
      await enqueueUploadIdForce(uploadId);
    },
    cleanup: async (uploadId) => {
      // Cleanup stale queue/pending entries for non-finalizing uploads.
      await Promise.all([
        redis.srem(pendingKey(), uploadId),
        redis.zrem(uploadKeys.finalizePendingSince(), uploadId),
        redis.lrem(queueKey(), 0, uploadId),
      ]);
    },
  });
  log.info(
    { count: activeIds.length, recovered, cleaned },
    "Finalize queue recovery scan completed"
  );
  return {
    scanned: activeIds.length,
    recovered,
    cleaned,
  };
}

export const finalizeQueueTestHooks = {
  async runFinalizeJob(params: { uploadId: string; log: FastifyBaseLogger }) {
    await runFinalizeJob(params.uploadId, params.log);
  },
  async runNextQueuedJob(log: FastifyBaseLogger) {
    const uploadId = await dequeueUploadId();
    if (!uploadId) throw new Error("FINALIZE_QUEUE_EMPTY");
    activeLocal.add(uploadId);
    await runFinalizeJob(uploadId, log);
    return uploadId;
  },
  async recoverFinalizingUploads(log: FastifyBaseLogger) {
    return recoverFinalizingUploads(log);
  },
  async forceEnqueue(uploadId: string) {
    await enqueueUploadIdForce(uploadId);
  },
  reset() {
    activeLocal.clear();
    processFinalizeImpl = processFinalize;
    scheduleRetryImpl = scheduleRetry;
  },
  setProcessFinalize(fn?: typeof processFinalize) {
    processFinalizeImpl = fn ?? processFinalize;
  },
  setScheduleRetry(fn?: typeof scheduleRetry) {
    scheduleRetryImpl = fn ?? scheduleRetry;
  },
};

export async function startUploadFinalizeWorker(log: FastifyBaseLogger): Promise<{
  scanned: number;
  recovered: number;
  cleaned: number;
}> {
  const recovery = await recoverFinalizingUploads(log);
  await drainOnce(log);

  if (drainTimer) clearInterval(drainTimer);
  drainTimer = setInterval(() => {
    void drainOnce(log).catch((err) => log.error({ err }, "Finalize queue drain failed"));
  }, FINALIZE_DRAIN_INTERVAL_MS);
  drainTimer.unref?.();
  return recovery;
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
  oldestQueuedAt: number | null;
  oldestQueuedAgeMs: number | null;
}> {
  const redis = getRedis();
  const script = `
    local depth = redis.call("LLEN", KEYS[1])
    local pending = redis.call("SCARD", KEYS[2])
    local oldest = redis.call("ZRANGE", KEYS[3], 0, 0, "WITHSCORES")
    local oldestScore = false
    if oldest[2] then
      oldestScore = oldest[2]
    end
    return { depth, pending, oldestScore }
  `;
  const result = await redis.eval(
    script,
    [queueKey(), pendingKey(), uploadKeys.finalizePendingSince()],
    []
  );
  const [depth, pendingUnique, oldestQueuedAt] = Array.isArray(result) ? result : [0, 0, null];
  return shapeFinalizeQueueStats({
    depth,
    pendingUnique,
    activeLocal: activeLocal.size,
    concurrency: FINALIZE_CONCURRENCY,
    oldestQueuedAt,
  });
}

export async function syncFinalizeQueueMetrics(): Promise<void> {
  const stats = await getUploadFinalizeQueueStats();
  setFinalizeQueueMetrics({
    depth: stats.depth,
    pendingUnique: stats.pendingUnique,
    activeLocal: stats.activeLocal,
    oldestQueuedAgeMs: stats.oldestQueuedAgeMs ?? 0,
  });
}
