import fs from "fs/promises";
import path from "path";
import type { FastifyBaseLogger } from "fastify";

import { getRedis } from "../redis.js";
import { uploadKeys } from "../keys.js";
import {
  UploadConfig,
  GcConfig,
} from "../../config/uploads.config.js";
import { chunkStore } from "../../store/index.js";

const GRACE_MS = GcConfig.grace;

const GC_ELIGIBLE_STATUSES = new Set([
  "failed",
  "expired",
  "canceled",
]);

export async function runUploadGc(log: FastifyBaseLogger) {
  const redis = getRedis();
  const baseDir = UploadConfig.tmpDir;
  const isDiskBackend = chunkStore.backend() === "disk";

  const uploadIds = await redis.smembers(uploadKeys.gcIndex());
  if (uploadIds.length === 0) return;

  for (const uploadId of uploadIds) {
    const metaKey = uploadKeys.meta(uploadId);
    const sessionKey = uploadKeys.session(uploadId);
    const lockKey = `${metaKey}:lock`;

    const [meta, hasSession, hasLock] = await Promise.all([
      redis.hgetall<Record<string, string>>(metaKey),
      redis.exists(sessionKey),
      redis.exists(lockKey),
    ]);

    let status = meta?.status;
    const expiresAt = Number(meta?.expiresAt ?? 0);

    if (hasLock) {
      continue;
    }

    if (
      (status === "uploading" || status === "finalizing" || (!status && hasSession)) &&
      Number.isFinite(expiresAt) &&
      expiresAt > 0 &&
      expiresAt <= Date.now()
    ) {
      await redis.multi()
        .hset(metaKey, {
          status: "expired",
          expiredAt: String(Date.now()),
        })
        .del(sessionKey)
        .sadd(uploadKeys.gcIndex(), uploadId)
        .exec();
      status = "expired";
    }

    if (
      !hasSession &&
      (status === "uploading" || status === "finalizing")
    ) {
      await redis.hset(metaKey, {
        status: "expired",
        expiredAt: String(Date.now()),
      });
      status = "expired";
    }

    if (!status && !hasSession) {
      await redis
        .multi()
        .del(uploadKeys.chunks(uploadId))
        .srem(uploadKeys.gcIndex(), uploadId)
        .exec();
      continue;
    }

    if (!status || !GC_ELIGIBLE_STATUSES.has(status)) {
      continue;
    }

    const dirPath = path.join(baseDir, uploadId);
    const binPath = path.join(baseDir, `${uploadId}.bin`);

    let mtimeMs = 0;
    if (isDiskBackend) {
      try {
        const st = await fs.stat(binPath);
        mtimeMs = st.mtimeMs;
      } catch {
        try {
          const st = await fs.stat(dirPath);
          mtimeMs = st.mtimeMs;
        } catch {
          await redis.multi()
            .del(metaKey)
            .del(uploadKeys.chunks(uploadId))
            .del(sessionKey)
            .srem(uploadKeys.gcIndex(), uploadId)
            .exec();
          continue;
        }
      }
    } else {
      const timestampCandidate =
        meta?.failedAt ?? meta?.expiredAt ?? meta?.canceledAt ?? meta?.updatedAt ?? meta?.createdAt;
      mtimeMs = Number(timestampCandidate ?? 0);
      if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) {
        mtimeMs = Date.now();
      }
    }

    if (Date.now() - mtimeMs < GRACE_MS) {
      continue;
    }

    log.warn(
      { uploadId, status },
      "GC deleting failed/expired upload artifacts"
    );

    await Promise.all([
      chunkStore.cleanup(uploadId).catch(() => {}),
      ...(isDiskBackend
        ? [
            fs.rm(dirPath, { recursive: true, force: true }).catch(() => {}),
            fs.rm(binPath, { force: true }).catch(() => {}),
          ]
        : []),
      redis
        .multi()
        .del(metaKey)
        .del(uploadKeys.chunks(uploadId))
        .del(sessionKey)
        .srem(uploadKeys.gcIndex(), uploadId)
        .exec(),
    ]);

    await new Promise(r => setImmediate(r));
  }
}
