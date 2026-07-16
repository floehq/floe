import fs from "fs/promises";
import path from "path";
import { Readable, Transform, type TransformCallback } from "stream";
import crypto from "crypto";
import type { FastifyBaseLogger } from "fastify";

import { UploadConfig } from "../../config/uploads.config.js";
import { InternalSession } from "./session.js";
import { getRedis } from "../../state/redis.js";
import { uploadKeys } from "../../state/keys.js";
import { chunkStore } from "../../store/index.js";
import { uploadToWalrusWithMetrics } from "../walrus/metrics.js";
import { renewWalrusBlob } from "../walrus/renew.js";
import { getCurrentWalrusEpoch } from "../walrus/epoch.js";
import { getWalrusBlobState } from "../walrus/blob.js";
import { finalizeFileMetadata } from "../../sui/file.metadata.js";
import {
  observeFinalizeStage,
  observeSuiFinalize,
  recordUploadTotalDuration,
} from "../metrics/runtime.metrics.js";
import {
  findFileByChecksum,
  getBlobObjectIdByBlobId,
  upsertBlobObjectMapping,
  upsertIndexedFile,
} from "../../db/files.repository.js";
import {
  buildCompletedFinalizeResult,
  buildFinalizeFollowupWarningMeta,
  normalizeFinalizeFailure,
  shouldPersistFinalizeFailure,
} from "./finalize.shared.js";
import { emitAuditEvent, emitInfrastructureEvent } from "../events/infrastructure.events.js";

const finalFilePath = (uploadId: string) => path.join(UploadConfig.tmpDir, `${uploadId}.bin`);

const CHUNK_READ_CONCURRENCY = 4;

const FINALIZE_LOCK_TTL_SECONDS = 15 * 60;
const FINALIZE_LOCK_REFRESH_INTERVAL_MS = 60_000;

type FinalizeStage =
  "verify_chunks" | "walrus_publish" | "sui_finalize" | "redis_commit" | "cleanup";

type FinalizeStageDurations = Record<FinalizeStage, number>;

type FinalizeContext = {
  log?: FastifyBaseLogger;
  attempt?: number;
  queueWaitMs?: number;
};

type ReusedWalrusBlob = {
  blobId: string;
  blobObjectId?: string;
  walrusEndEpoch: number;
  walrusSource: "already_certified";
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
    [params.lockToken, String(params.ttlSeconds)],
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

/**
 * A PassThrough-style Transform that computes a running SHA-256 hash
 * as data flows through. After the stream completes (or on demand),
 * call digest() to get the hex-encoded SHA-256.
 *
 * Used to tee the chunk assembly stream so we compute the upload
 * checksum during the Walrus upload instead of reading chunks twice.
 */
class HashStream extends Transform {
  readonly #hash: crypto.Hash;

  constructor() {
    super();
    this.#hash = crypto.createHash("sha256");
  }

  _transform(chunk: Buffer, _enc: string, callback: TransformCallback) {
    this.#hash.update(chunk);
    callback(null, chunk);
  }

  digest(): string {
    return this.#hash.digest("hex");
  }
}

function createChunkAssemblyStream(params: {
  uploadId: string;
  totalChunks: number;
  concurrency?: number;
}): Readable {
  const cq = params.concurrency ?? CHUNK_READ_CONCURRENCY;

  return Readable.from(
    (async function* () {
      // Pre-allocate arrays by index so we can fill them out of order
      const buffers: Buffer[][] = new Array(params.totalChunks);
      const errors: Array<Error | null> = new Array(params.totalChunks);
      const completions: Array<Promise<void>> = new Array(params.totalChunks);
      let nextToStart = 0;

      // AbortController ensures in-flight S3 reads from earlier chunks
      // don't produce unhandled rejections when a later chunk errors.
      const abortController = new AbortController();
      const signal = abortController.signal;

      const startRead = (index: number) => {
        if (signal.aborted || index >= params.totalChunks) return;
        const promise = new Promise<void>((resolve, reject) => {
          const rs = chunkStore.openChunk(params.uploadId, index);
          const bufs: Buffer[] = [];
          buffers[index] = bufs;
          rs.on("data", (c: Buffer) => bufs.push(c));
          rs.on("end", resolve);
          rs.on("error", (err: Error) => {
            if (!signal.aborted) {
              errors[index] = err;
              reject(err);
            }
          });
        });
        completions[index] = promise;
        // Suppress unhandled rejections: once abort fires, remaining
        // in-flight reads resolve/reject silently.
        promise.catch(() => {});
      };

      for (let i = 0; i < params.totalChunks; i++) {
        // If a previous chunk triggered abort, stop immediately
        if (signal.aborted) {
          const firstError = errors.find((e) => e !== null);
          throw firstError || new Error("STREAM_ABORTED");
        }

        // Ensure up to `cq` chunks are being fetched ahead of the current position
        while (nextToStart < params.totalChunks && nextToStart < i + cq) {
          startRead(nextToStart);
          nextToStart++;
        }

        // Wait for this chunk to be available
        await completions[i];
        if (errors[i]) {
          abortController.abort();
          throw errors[i];
        }

        // Yield its data in order
        for (const buf of buffers[i]) {
          yield buf;
        }
        // Free memory
        buffers[i] = [];
      }
    })(),
  );
}

async function resolveReusableWalrusBlob(params: {
  checksum?: string;
  requestedEpochs: number;
  log?: FastifyBaseLogger;
}): Promise<ReusedWalrusBlob | null> {
  const checksum = params.checksum?.trim();
  if (!checksum) return null;

  const indexed = await findFileByChecksum(checksum).catch((err) => {
    params.log?.warn({ err, checksum }, "Checksum lookup failed during finalize");
    return null;
  });
  if (!indexed?.blobId) return null;

  let walrusEndEpoch =
    indexed.walrusEndEpoch !== null && Number.isFinite(indexed.walrusEndEpoch)
      ? indexed.walrusEndEpoch
      : undefined;
  const blobObjectId =
    indexed.blobObjectId ??
    (await getBlobObjectIdByBlobId(indexed.blobId).catch(() => null)) ??
    undefined;

  const currentEpochPromise = getCurrentWalrusEpoch().catch((err) => {
    params.log?.warn({ err }, "Failed to fetch current Walrus epoch during finalize reuse");
    return null;
  });

  if (blobObjectId) {
    const blobState = await getWalrusBlobState(blobObjectId).catch((err) => {
      params.log?.warn({ err, blobObjectId }, "Failed to inspect reusable Walrus blob state");
      return null;
    });
    if (blobState && blobState.endEpoch !== null) {
      walrusEndEpoch = blobState.endEpoch;
    }
  }

  if (walrusEndEpoch === undefined) return null;

  const currentWalrusEpoch = await currentEpochPromise;
  if (currentWalrusEpoch === null) {
    return null;
  }

  const epochsRemaining = Math.max(0, walrusEndEpoch - currentWalrusEpoch);
  const missingEpochs = Math.max(0, params.requestedEpochs - epochsRemaining);

  if (missingEpochs > 0) {
    if (!blobObjectId) {
      return null;
    }
    const renewResult = await renewWalrusBlob({
      blobObjectId,
      epochs: missingEpochs,
    }).catch((err) => {
      params.log?.warn(
        { err, blobObjectId, missingEpochs, checksum },
        "Failed to extend reusable Walrus blob during finalize",
      );
      return null;
    });
    if (!renewResult?.endEpoch || !Number.isFinite(renewResult.endEpoch)) {
      return null;
    }
    walrusEndEpoch = renewResult.endEpoch;
  }

  return {
    blobId: indexed.blobId,
    blobObjectId,
    walrusEndEpoch,
    walrusSource: "already_certified",
  };
}

export async function finalizeUpload(
  session: InternalSession,
  context: FinalizeContext = {},
): Promise<{
  fileId: string;
  blobId: string;
  sizeBytes: number;
  status: "ready";
  walrusEndEpoch?: number;
  walrusSource?: "newly_created" | "already_certified" | "unknown";
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

    const providedChecksum = session.checksum?.trim() || meta?.checksum?.trim() || undefined;
    let checksum: string | undefined;

    await runStage("verify_chunks", async () => {
      // Use Redis chunk index (uploadKeys.chunks) instead of calling
      // S3 ListObjectsV2 — cheaper and sufficient for existence checks.
      const chunkMembers = await redis.smembers<string[]>(uploadKeys.chunks(uploadId));
      const chunkSet = new Set(chunkMembers.map(String));
      for (let i = 0; i < session.totalChunks; i++) {
        if (!chunkSet.has(String(i))) {
          throw new Error("MISSING_CHUNKS");
        }
      }
    });

    let blobId: string | null = meta?.blobId ?? null;
    let walrusObjectId: string | undefined = meta?.walrusObjectId ?? undefined;
    let fileId: string | null = meta?.fileId ?? null;
    let walrusEndEpoch: number | undefined =
      meta?.walrusEndEpoch !== undefined ? Number(meta.walrusEndEpoch) : undefined;
    let walrusSource: "newly_created" | "already_certified" | "unknown" | undefined =
      meta?.walrusSource === "newly_created" ||
      meta?.walrusSource === "already_certified" ||
      meta?.walrusSource === "unknown"
        ? meta.walrusSource
        : undefined;

    if (!blobId) {
      assertFinalizeLockHealthy();
      await refreshFinalizeLock();

      // Track the most recently used HashStream so we can read the
      // computed checksum after uploadToWalrusWithMetrics completes.
      let lastHashStream: HashStream | null = null;

      const result = await runStage("walrus_publish", async () => {
        const reused = await resolveReusableWalrusBlob({
          checksum: providedChecksum,
          requestedEpochs: session.resolvedEpochs,
          log: context.log,
        });
        if (reused) {
          // BUG 1 FIX: On the reuse path, verify the actual chunk data
          // matches the claimed checksum by computing the SHA-256 from
          // the stored chunks. If mismatch, fall through to the upload
          // path instead of trusting providedChecksum blindly.
          const computed = await new Promise<string>((resolve, reject) => {
            const hs = new HashStream();
            const assembly = createChunkAssemblyStream({
              uploadId,
              totalChunks: session.totalChunks,
            }).pipe(hs);
            const chunks: Buffer[] = [];
            assembly.on("data", (c: Buffer) => chunks.push(c));
            assembly.on("end", () => resolve(hs.digest()));
            assembly.on("error", reject);
          });
          checksum = computed;

          if (providedChecksum && computed !== providedChecksum) {
            // Checksum mismatch — do NOT reuse the blob. Fall through
            // to the upload path below so the actual data gets published.
            context.log?.warn(
              { uploadId, providedChecksum, computed },
              "Reuse checksum mismatch; falling through to upload path",
            );
          } else {
            return {
              blobId: reused.blobId,
              objectId: reused.blobObjectId,
              endEpoch: reused.walrusEndEpoch,
              source: reused.walrusSource,
            };
          }
        }

        // Upload path — compute SHA-256 while streaming to Walrus.
        // Each streamFactory call creates a fresh HashStream so retries
        // (internal to uploadToWalrusWithMetrics) don't pipe into a
        // single consumed stream. lastHashStream captures the final
        // (successful) attempt's hash.
        const uploadResult = await uploadToWalrusWithMetrics({
          uploadId,
          sizeBytes: session.sizeBytes,
          epochs: session.resolvedEpochs,
          streamFactory: () => {
            const hs = new HashStream();
            lastHashStream = hs;
            return createChunkAssemblyStream({
              uploadId,
              totalChunks: session.totalChunks,
            }).pipe(hs);
          },
        });

        checksum = lastHashStream!.digest();

        if (providedChecksum && checksum !== providedChecksum) {
          throw new Error("CHECKSUM_MISMATCH");
        }

        return uploadResult;
      });

      blobId = result.blobId;
      walrusObjectId = result.objectId;
      walrusEndEpoch = result.endEpoch;
      walrusSource = result.source;

      if (!blobId) {
        throw new Error("WALRUS_UPLOAD_FAILED");
      }

      if (
        walrusSource === "already_certified" &&
        (walrusEndEpoch === undefined || !Number.isFinite(walrusEndEpoch))
      ) {
        throw new Error(
          `WALRUS_RETENTION_TOO_LOW:unknown:${session.resolvedEpochs}:already_certified`,
        );
      }

      await redis.hset(metaKey, {
        blobId,
        walrusUploadedAt: String(Date.now()),
        ...(walrusObjectId ? { walrusObjectId } : {}),
        ...(walrusEndEpoch !== undefined ? { walrusEndEpoch: String(walrusEndEpoch) } : {}),
        ...(walrusSource ? { walrusSource } : {}),
      });

      // Persist the computed checksum now that walrus_publish has produced it
      if (checksum && checksum !== meta?.checksum) {
        await Promise.all([
          redis.hset(metaKey, { checksum }).catch(() => {}),
          redis.hset(uploadKeys.session(uploadId), { checksum }).catch(() => {}),
        ]);
      }
    }

    if (!fileId) {
      assertFinalizeLockHealthy();
      await refreshFinalizeLock();
      const minted = await runStage("sui_finalize", async () => {
        const suiStartedAt = Date.now();
        try {
          const result = await finalizeFileMetadata({
            blobId,
            blobObjectId: walrusObjectId,
            sizeBytes: session.sizeBytes,
            mimeType: session.contentType ?? "application/octet-stream",
            checksum,
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
          ...(checksum ? { checksum } : {}),
          sizeBytes: String(session.sizeBytes),
          completedAt: String(Date.now()),
          finalizeStage: "completed",
          finalizeAttemptState: "completed",
          finalizeLastProgressAt: String(Date.now()),
          finalizeVerifyMs: String(stageDurationsMs.verify_chunks),
          finalizeWalrusMs: String(stageDurationsMs.walrus_publish),
          finalizeSuiMs: String(stageDurationsMs.sui_finalize),
          ...(walrusObjectId ? { walrusObjectId } : {}),
          ...(walrusEndEpoch !== undefined ? { walrusEndEpoch: String(walrusEndEpoch) } : {}),
          ...(walrusSource ? { walrusSource } : {}),
        })
        .del(uploadKeys.session(uploadId))
        .del(uploadKeys.chunks(uploadId))
        .srem(uploadKeys.gcIndex(), uploadId)
        .srem(uploadKeys.activeIndex(), uploadId)
        .exec(),
    );

    if (!tx) {
      throw new Error("REDIS_FINALIZE_TRANSACTION_FAILED");
    }
    committedCompletedState = true;

    await Promise.all([
      upsertIndexedFile({
        fileId,
        blobId,
        blobObjectId: walrusObjectId ?? null,
        checksum: checksum ?? null,
        ownerAddress: session.owner ?? null,
        sizeBytes: session.sizeBytes,
        mimeType: session.contentType ?? "application/octet-stream",
        walrusEndEpoch: walrusEndEpoch ?? null,
        createdAtMs: Date.now(),
      }).catch((pgErr) => {
        context.log?.warn(
          { uploadId, fileId, blobId, err: pgErr },
          "Failed to persist indexed file metadata to Postgres during finalize — Redis and Postgres are now divergent",
        );
      }),
      walrusObjectId
        ? upsertBlobObjectMapping({
            blobId,
            blobObjectId: walrusObjectId,
            checksum: checksum ?? null,
          }).catch((pgErr) => {
            context.log?.warn(
              { uploadId, blobId, blobObjectId: walrusObjectId, err: pgErr },
              "Failed to persist blob-object mapping to Postgres during finalize — Redis and Postgres are now divergent",
            );
          })
        : Promise.resolve(),
    ]);

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
        context.log?.warn(
          { uploadId, err: postCommitErr },
          "Upload finalize post-commit metadata update failed",
        );
      });

    context.log?.info(
      {
        uploadId,
        attempt: context.attempt ?? 1,
        queueWaitMs: context.queueWaitMs ?? 0,
        totalMs: finalizeTotalMs,
        stageDurationsMs,
      },
      "Upload finalize completed",
    );
    const uploadDurationMs = Date.now() - Number(pre?.createdAt ?? startedAt);
    if (Number.isFinite(uploadDurationMs) && uploadDurationMs > 0) {
      recordUploadTotalDuration({
        durationMs: uploadDurationMs,
        outcome: "succeeded",
      });
    }

    emitInfrastructureEvent(context.log ?? console, {
      event: "finalize_succeeded",
      uploadId,
      fileId,
      blobId,
      outcome: "success",
      bytes: session.sizeBytes,
      durationMs: finalizeTotalMs,
      metadata: {
        owner: session.owner ?? null,
        attempt: context.attempt ?? 1,
        queueWaitMs: context.queueWaitMs ?? 0,
        walrusEndEpoch: walrusEndEpoch ?? null,
        walrusSource: walrusSource ?? null,
        stageDurationsMs,
      },
    });

    emitAuditEvent(context.log ?? console, {
      action: "finalize_completed",
      resource: `upload:${uploadId}`,
      actor: {
        authenticated: true,
        method: "external",
        subject: `system:finalize_worker`,
        apiKeyId: null,
        owner: session.owner ?? null,
        tier: "authenticated",
      },
      before: {
        status: "finalizing",
      },
      after: {
        status: "completed",
        fileId,
        blobId,
        walrusEndEpoch: walrusEndEpoch ?? null,
        sizeBytes: session.sizeBytes,
      },
      metadata: {
        uploadId,
        attempt: context.attempt ?? 1,
        queueWaitMs: context.queueWaitMs ?? 0,
        stageDurationsMs,
      },
    });

    return {
      fileId,
      blobId,
      sizeBytes: session.sizeBytes,
      status: "ready",
      ...(walrusEndEpoch !== undefined ? { walrusEndEpoch } : {}),
      ...(walrusSource ? { walrusSource } : {}),
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
        .hset(
          metaKey,
          buildFinalizeFollowupWarningMeta({
            errorMessage: message,
            nowMs: Date.now(),
          }),
        )
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
      "Upload finalize failed",
    );
    const failUploadDurationMs = Date.now() - Number(pre?.createdAt ?? startedAt);
    if (Number.isFinite(failUploadDurationMs) && failUploadDurationMs > 0) {
      recordUploadTotalDuration({
        durationMs: failUploadDurationMs,
        outcome: "failed",
      });
    }

    emitInfrastructureEvent(context.log ?? console, {
      event: "finalize_failed",
      uploadId,
      outcome: "failure",
      bytes: session.sizeBytes,
      durationMs: Date.now() - startedAt,
      metadata: {
        owner: session.owner ?? null,
        attempt: context.attempt ?? 1,
        queueWaitMs: context.queueWaitMs ?? 0,
        failedStage: wrapped.finalizeStage ?? currentStage ?? "unknown",
        reasonCode: failure.reasonCode,
        retryable: failure.retryable,
      },
    });

    emitAuditEvent(context.log ?? console, {
      action: "finalize_failed",
      resource: `upload:${uploadId}`,
      actor: {
        authenticated: true,
        method: "external",
        subject: `system:finalize_worker`,
        apiKeyId: null,
        owner: session.owner ?? null,
        tier: "authenticated",
      },
      before: {
        status: "finalizing",
      },
      after: null,
      metadata: {
        uploadId,
        attempt: context.attempt ?? 1,
        queueWaitMs: context.queueWaitMs ?? 0,
        failedStage: wrapped.finalizeStage ?? currentStage ?? "unknown",
        reasonCode: failure.reasonCode,
        retryable: failure.retryable,
        errorMessage: message.slice(0, 500),
      },
    });

    throw err;
  } finally {
    clearInterval(lockRefreshTimer);
    await releaseFinalizeLockAtomic({ lockKey, lockToken }).catch(() => {});
  }
}
