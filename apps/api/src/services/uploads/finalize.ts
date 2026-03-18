import fs from "fs/promises";
import path from "path";
import { Readable } from "stream";
import crypto from "crypto";

import { UploadConfig } from "../../config/uploads.config.js";
import { InternalSession } from "./session.js";
import { getRedis } from "../../state/redis.js";
import { uploadKeys } from "../../state/keys.js";
import { chunkStore } from "../../store/index.js";
import { uploadToWalrusWithMetrics } from "../walrus/metrics.js";
import { finalizeFileMetadata } from "../../sui/file.metadata.js";
import { observeSuiFinalize } from "../metrics/runtime.metrics.js";
import { upsertIndexedFile } from "../../db/files.repository.js";

const finalFilePath = (uploadId: string) =>
  path.join(UploadConfig.tmpDir, `${uploadId}.bin`);

const FINALIZE_LOCK_TTL_SECONDS = 15 * 60;
const FINALIZE_LOCK_REFRESH_INTERVAL_MS = 60_000;

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

export async function finalizeUpload(session: InternalSession): Promise<{
  fileId: string;
  blobId: string;
  sizeBytes: number;
  status: "ready";
  walrusEndEpoch?: number;
}> {
  const redis = getRedis();
  const uploadId = session.uploadId;
  const metaKey = uploadKeys.meta(uploadId);

  // Fast-path idempotency.
  const pre = await redis.hgetall<Record<string, string>>(metaKey);
  if (pre?.status === "completed") {
    if (!pre.fileId || !pre.blobId) {
      throw new Error("CORRUPT_COMPLETED_UPLOAD");
    }

    return {
      fileId: pre.fileId,
      blobId: pre.blobId,
      sizeBytes: Number(pre.sizeBytes ?? session.sizeBytes),
      status: "ready",
      ...(pre.walrusEndEpoch ? { walrusEndEpoch: Number(pre.walrusEndEpoch) } : {}),
    };
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
      if (!meta.fileId || !meta.blobId) {
        throw new Error("CORRUPT_COMPLETED_UPLOAD");
      }

      return {
        fileId: meta.fileId,
        blobId: meta.blobId,
        sizeBytes: Number(meta.sizeBytes ?? session.sizeBytes),
        status: "ready",
        ...(meta.walrusEndEpoch ? { walrusEndEpoch: Number(meta.walrusEndEpoch) } : {}),
      };
    }

    await redis.hset(metaKey, {
      status: "finalizing",
      finalizingAt: String(Date.now()),
    });

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

    let blobId: string | null = meta?.blobId ?? null;
    let fileId: string | null = meta?.fileId ?? null;
    let walrusEndEpoch: number | undefined =
      meta?.walrusEndEpoch !== undefined ? Number(meta.walrusEndEpoch) : undefined;

    if (!blobId) {
      assertFinalizeLockHealthy();
      await refreshFinalizeLock();
      const result = await uploadToWalrusWithMetrics({
        uploadId,
        sizeBytes: session.sizeBytes,
        epochs: session.resolvedEpochs,
        streamFactory: () =>
          createChunkAssemblyStream({
            uploadId,
            totalChunks: session.totalChunks,
          }),
      });

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
      const suiStartedAt = Date.now();
      let minted;
      try {
        minted = await finalizeFileMetadata({
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
      } catch (err) {
        observeSuiFinalize({
          durationMs: Date.now() - suiStartedAt,
          outcome: "failure",
        });
        throw err;
      }

      fileId = minted.fileId;

      await redis.hset(metaKey, {
        fileId,
        metadataFinalizedAt: String(Date.now()),
      });
    }

    assertFinalizeLockHealthy();
    await refreshFinalizeLock();
    const tx = await redis
      .multi()
      .hset(metaKey, {
        status: "completed",
        fileId,
        blobId,
        sizeBytes: String(session.sizeBytes),
        completedAt: String(Date.now()),
        ...(walrusEndEpoch !== undefined ? { walrusEndEpoch: String(walrusEndEpoch) } : {}),
      })
      .del(uploadKeys.session(uploadId))
      .del(uploadKeys.chunks(uploadId))
      .srem(uploadKeys.gcIndex(), uploadId)
      .exec();

    if (!tx) {
      throw new Error("REDIS_FINALIZE_TRANSACTION_FAILED");
    }

    await upsertIndexedFile({
      fileId,
      blobId,
      ownerAddress: session.owner ?? null,
      sizeBytes: session.sizeBytes,
      mimeType: session.contentType ?? "application/octet-stream",
      walrusEndEpoch: walrusEndEpoch ?? null,
      createdAtMs: Date.now(),
    }).catch(() => {});

    await Promise.all([
      chunkStore.cleanup(uploadId).catch(() => {}),
      fs.unlink(finalFilePath(uploadId)).catch(() => {}),
    ]);

    return {
      fileId,
      blobId,
      sizeBytes: session.sizeBytes,
      status: "ready",
      ...(walrusEndEpoch !== undefined ? { walrusEndEpoch } : {}),
    };
  } catch (err) {
    const message = (err as Error).message;
    const isLockOwnershipError =
      message === "UPLOAD_FINALIZATION_LOCK_LOST" ||
      message === "UPLOAD_FINALIZATION_IN_PROGRESS";

    // If we no longer own the lock, avoid forcing terminal "failed" state.
    if (!isLockOwnershipError) {
      await redis.hset(metaKey, {
        status: "failed",
        error: message,
        failedAt: String(Date.now()),
      });
    }

    throw err;
  } finally {
    clearInterval(lockRefreshTimer);
    await releaseFinalizeLockAtomic({ lockKey, lockToken }).catch(() => {});
  }
}
