import fs from "fs/promises";
import path from "path";
import { Readable } from "stream";
import crypto from "crypto";
import type { FastifyBaseLogger } from "fastify";

import { UploadConfig } from "../../config/uploads.config.js";
import { InternalSession } from "./session.js";
import { getRedis } from "../../state/redis.js";
import { uploadKeys } from "../../state/keys.js";
import { chunkStore } from "../../store/index.js";
import { uploadToWalrusWithMetrics } from "../walrus/metrics.js";
import { finalizeFileMetadata } from "../../sui/file.metadata.js";
import {
  observeFinalizeStage,
  observeSuiFinalize,
} from "../metrics/runtime.metrics.js";
import { upsertIndexedFile } from "../../db/files.repository.js";
import {
  buildCompletedFinalizeResult,
  buildFinalizeFollowupWarningMeta,
  normalizeFinalizeFailure,
  shouldPersistFinalizeFailure,
  type FinalizeFailureCode,
} from "./finalize.shared.js";

const finalFilePath = (uploadId: string) =>
  path.join(UploadConfig.tmpDir, `${uploadId}.bin`);

const FINALIZE_LOCK_TTL_SECONDS = 15 * 60;
const FINALIZE_LOCK_REFRESH_INTERVAL_MS = 60_000;

type FinalizeStage =
  | "verify_chunks"
  | "walrus_publish"
  | "sui_finalize"
  | "redis_commit"
  | "cleanup";

type FinalizeStageDurations = Record<FinalizeStage, number>;

type FinalizeContext = {
  log?: FastifyBaseLogger;
  attempt?: number;
  queueWaitMs?: number;
};

function attachFinalizeStage(err: unknown, stage: FinalizeStage): Error {
  const wrapped = err instanceof Error ? err : new Error(String(err));
  (wrapped as Error & { finalizeStage?: FinalizeStage }).finalizeStage = stage;
  return wrapped;
}

async function refreshFinalizeLockAtomic(params: {
  lockKey: string;
  lockToken: string;
  ttlSeconds: number;
}): Promise<boolean> {
  const redis = getRedis();
  const script = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("EXPIRE", KEYS[1], tonumber(ARGV[2]))
    end
    return 0
  `;
  const res = await redis.eval(
    script,
    [params.lockKey],
    [params.lockToken, String(params.ttlSeconds)]
  );
  return Number(res) === 1;
}

async function releaseFinalizeLockAtomic(params: {
  lockKey: string;
  lockToken: string;
}): Promise<boolean> {
  const redis = getRedis();
  const script = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    end
    return 0
  `;
  const res = await redis.eval(script, [params.lockKey], [params.lockToken]);
  return Number(res) === 1;
}

function createChunkAssemblyStream(params: {
  uploadId: string;
  totalChunks: number;
}): Readable {
  const iter = async function* () {
    for (let i = 0; i < params.totalChunks; i++) {
      const rs = chunkStore.openChunk(params.uploadId, i);
      for await (const buf of rs) {
        yield buf as Uint8Array;
      }
    }
  };
  return Readable.from(iter());
}

export async function finalizeUpload(
  session: InternalSession,
  context: FinalizeContext = {}
): Promise<{
  fileId: string;
  blobId: string;
  sizeBytes: number;
  status: "ready";
  walrusEndEpoch?: number;
  finalize: {
    totalMs: number;
    stageDurationsMs: FinalizeStageDurations;
  };
}> {
  const redis = getRedis();
  const uploadId = session.uploadId;
  const metaKey = uploadKeys.meta(uploadId);
  const startedAt = Date.now();
  const stageDurationsMs: FinalizeStageDurations = {
    verify_chunks: 0,
    walrus_publish: 0,
    sui_finalize: 0,
    redis_commit: 0,
    cleanup: 0,
  };
  let currentStage: FinalizeStage | null = null;
  let committedCompletedState = false;
  const setFinalizeStage = async (stage: FinalizeStage) => {
    currentStage = stage;
    await redis.hset(metaKey, {
      finalizeStage: stage,
      finalizeStageStartedAt: String(Date.now()),
      finalizeLastProgressAt: String(Date.now()),
    });
  };

  const runStage = async <T>(stage: FinalizeStage, fn: () => Promise<T>): Promise<T> => {
    await setFinalizeStage(stage);
    const stageStartedAt = Date.now();

    try {
      const result = await fn();
      const durationMs = Date.now() - stageStartedAt;
      stageDurationsMs[stage] = durationMs;
      observeFinalizeStage({ stage, outcome: "success", durationMs });
      await redis.hset(metaKey, {
        finalizeLastSuccessfulStage: stage,
        finalizeLastProgressAt: String(Date.now()),
      });
      return result;
    } catch (err) {
      const durationMs = Date.now() - stageStartedAt;
      stageDurationsMs[stage] = durationMs;
      observeFinalizeStage({ stage, outcome: "failure", durationMs });
      throw attachFinalizeStage(err, stage);
    }
  };

  // Fast-path idempotency.
  const pre = await redis.hgetall<Record<string, string>>(metaKey);
  if (pre?.status === "completed") {
    return buildCompletedFinalizeResult(pre, session.sizeBytes);
  }

  const lockKey = `${metaKey}:lock`;
  const lockToken = crypto.randomUUID();
  const locked = await redis.set(lockKey, lockToken, {
    nx: true,
    ex: FINALIZE_LOCK_TTL_SECONDS,
  });

  if (!locked) {
    throw new Error("UPLOAD_FINALIZATION_IN_PROGRESS");
  }

  const refreshFinalizeLock = async () => {
    const refreshed = await refreshFinalizeLockAtomic({
      lockKey,
      lockToken,
      ttlSeconds: FINALIZE_LOCK_TTL_SECONDS,
    });
    if (!refreshed) {
      throw new Error("UPLOAD_FINALIZATION_LOCK_LOST");
    }
  };

  let lockError: Error | null = null;
  const lockRefreshTimer = setInterval(() => {
    void refreshFinalizeLock().catch((err) => {
      lockError = err instanceof Error ? err : new Error("UPLOAD_FINALIZATION_LOCK_LOST");
    });
  }, FINALIZE_LOCK_REFRESH_INTERVAL_MS);
  lockRefreshTimer.unref();

  const assertFinalizeLockHealthy = () => {
    if (lockError) throw lockError;
  };

  try {
    // Re-check inside the lock (race-safe).
    const meta = await redis.hgetall<Record<string, string>>(metaKey);
    if (meta?.status === "completed") {
      return buildCompletedFinalizeResult(meta, session.sizeBytes);
    }

    await redis.hset(metaKey, {
      status: "finalizing",
      finalizingAt: String(Date.now()),
      finalizeAttemptState: "running",
      finalizeLastProgressAt: String(Date.now()),
    });

    await runStage("verify_chunks", async () => {
      const redisCount = await redis.scard(uploadKeys.chunks(uploadId));
      if (redisCount !== session.totalChunks) {
        throw new Error("INCOMPLETE_CHUNKS");
      }

      const chunks = await chunkStore.listChunks(uploadId);
      const set = new Set(chunks);
      for (let i = 0; i < session.totalChunks; i++) {
        if (!set.has(i)) {
          throw new Error("MISSING_CHUNKS");
        }
      }
    });

    let blobId: string | null = meta?.blobId ?? null;
    let fileId: string | null = meta?.fileId ?? null;
    let walrusEndEpoch: number | undefined =
      meta?.walrusEndEpoch !== undefined ? Number(meta.walrusEndEpoch) : undefined;

    if (!blobId) {
      assertFinalizeLockHealthy();
      await refreshFinalizeLock();
      const result = await runStage("walrus_publish", async () =>
        uploadToWalrusWithMetrics({
          uploadId,
          sizeBytes: session.sizeBytes,
          epochs: session.resolvedEpochs,
          streamFactory: () =>
            createChunkAssemblyStream({
              uploadId,
              totalChunks: session.totalChunks,
            }),
        })
      );

      blobId = result.blobId;
      walrusEndEpoch = result.endEpoch;

      if (!blobId) {
        throw new Error("WALRUS_UPLOAD_FAILED");
      }

      await redis.hset(metaKey, {
        blobId,
        walrusUploadedAt: String(Date.now()),
        ...(walrusEndEpoch !== undefined ? { walrusEndEpoch: String(walrusEndEpoch) } : {}),
      });
    }

    if (!fileId) {
      assertFinalizeLockHealthy();
      await refreshFinalizeLock();
      const minted = await runStage("sui_finalize", async () => {
        const suiStartedAt = Date.now();
        try {
          const result = await finalizeFileMetadata({
            blobId,
            sizeBytes: session.sizeBytes,
            mimeType: session.contentType ?? "application/octet-stream",
            owner: session.owner,
            walrusEndEpoch,
          });
          observeSuiFinalize({
            durationMs: Date.now() - suiStartedAt,
            outcome: "success",
          });
          return result;
        } catch (err) {
          observeSuiFinalize({
            durationMs: Date.now() - suiStartedAt,
            outcome: "failure",
          });
          throw err;
        }
      });

      fileId = minted.fileId;

      await redis.hset(metaKey, {
        fileId,
        metadataFinalizedAt: String(Date.now()),
      });
    }

    assertFinalizeLockHealthy();
    await refreshFinalizeLock();
    const tx = await runStage("redis_commit", async () =>
      redis
        .multi()
        .hset(metaKey, {
          status: "completed",
          fileId,
          blobId,
          sizeBytes: String(session.sizeBytes),
          completedAt: String(Date.now()),
          finalizeStage: "completed",
          finalizeAttemptState: "completed",
          finalizeLastProgressAt: String(Date.now()),
          finalizeVerifyMs: String(stageDurationsMs.verify_chunks),
          finalizeWalrusMs: String(stageDurationsMs.walrus_publish),
          finalizeSuiMs: String(stageDurationsMs.sui_finalize),
          ...(walrusEndEpoch !== undefined ? { walrusEndEpoch: String(walrusEndEpoch) } : {}),
        })
        .del(uploadKeys.session(uploadId))
        .del(uploadKeys.chunks(uploadId))
        .srem(uploadKeys.gcIndex(), uploadId)
        .srem(uploadKeys.activeIndex(), uploadId)
        .exec()
    );

    if (!tx) {
      throw new Error("REDIS_FINALIZE_TRANSACTION_FAILED");
    }
    committedCompletedState = true;

    await upsertIndexedFile({
      fileId,
      blobId,
      ownerAddress: session.owner ?? null,
      sizeBytes: session.sizeBytes,
      mimeType: session.contentType ?? "application/octet-stream",
      walrusEndEpoch: walrusEndEpoch ?? null,
      createdAtMs: Date.now(),
    }).catch(() => {});

    const cleanupStartedAt = Date.now();
    currentStage = "cleanup";
    try {
      await Promise.all([
        chunkStore.cleanup(uploadId).catch(() => {}),
        fs.unlink(finalFilePath(uploadId)).catch(() => {}),
      ]);
    } finally {
      stageDurationsMs.cleanup = Date.now() - cleanupStartedAt;
      observeFinalizeStage({
        stage: "cleanup",
        outcome: "success",
        durationMs: stageDurationsMs.cleanup,
      });
    }

    const finalizeTotalMs = Date.now() - startedAt;
    await redis
      .hset(metaKey, {
        finalizeStage: "completed",
        finalizeCleanupMs: String(stageDurationsMs.cleanup),
        finalizeRedisMs: String(stageDurationsMs.redis_commit),
        finalizeTotalMs: String(finalizeTotalMs),
        finalizeLastProgressAt: String(Date.now()),
        finalizeAttemptState: "completed",
      })
      .catch((postCommitErr) => {
        context.log?.warn({ uploadId, err: postCommitErr }, "Upload finalize post-commit metadata update failed");
      });

    context.log?.info(
      {
        uploadId,
        attempt: context.attempt ?? 1,
        queueWaitMs: context.queueWaitMs ?? 0,
        totalMs: finalizeTotalMs,
        stageDurationsMs,
      },
      "Upload finalize completed"
    );

    return {
      fileId,
      blobId,
      sizeBytes: session.sizeBytes,
      status: "ready",
      ...(walrusEndEpoch !== undefined ? { walrusEndEpoch } : {}),
      finalize: {
        totalMs: finalizeTotalMs,
        stageDurationsMs,
      },
    };
  } catch (err) {
    const wrapped = err as Error & { finalizeStage?: FinalizeStage };
    const message = wrapped.message;
    const failure = normalizeFinalizeFailure(err);

    if (
      shouldPersistFinalizeFailure({
        committedCompletedState,
        errorMessage: message,
      })
    ) {
      await redis.hset(metaKey, {
        status: failure.retryable ? "finalizing" : "failed",
        error: message,
        failedAt: String(Date.now()),
        failedStage: wrapped.finalizeStage ?? currentStage ?? "unknown",
        failedReasonCode: failure.reasonCode,
        failedRetryable: failure.retryable ? "1" : "0",
        finalizeAttemptState: failure.retryable ? "retryable_failure" : "terminal_failure",
        finalizeLastProgressAt: String(Date.now()),
      });
    } else if (committedCompletedState) {
      await redis
        .hset(metaKey, buildFinalizeFollowupWarningMeta({
          errorMessage: message,
          nowMs: Date.now(),
        }))
        .catch(() => {});
    }

    context.log?.error(
      {
        uploadId,
        attempt: context.attempt ?? 1,
        queueWaitMs: context.queueWaitMs ?? 0,
        failedStage: wrapped.finalizeStage ?? currentStage ?? "unknown",
        reasonCode: failure.reasonCode,
        retryable: failure.retryable,
        stageDurationsMs,
        err,
      },
      "Upload finalize failed"
    );

    throw err;
  } finally {
    clearInterval(lockRefreshTimer);
    await releaseFinalizeLockAtomic({ lockKey, lockToken }).catch(() => {});
  }
}
