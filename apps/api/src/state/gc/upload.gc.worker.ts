// src/state/gc/upload.gc.worker.ts

import fs from "fs/promises";
import path from "path";
import type { FastifyBaseLogger } from "fastify";

import { getRedis } from "../client.js";
import { uploadKeys } from "../keys.js";
import {
  UploadConfig,
  GcConfig,
} from "../../config/uploads.config.js";

/**
 * Grace period after last filesystem activity
 * before artifacts are eligible for deletion.
 */
const GRACE_MS = GcConfig.grace;

/**
 * Only these states are GC-eligible.
 * Everything else is protected.
 */
const GC_ELIGIBLE_STATUSES = new Set([
  "failed",
  "expired",
  "canceled",
]);

export async function runUploadGc(log: FastifyBaseLogger) {
  const redis = getRedis();
  const baseDir = UploadConfig.tmpDir;

  /**
   * SINGLE SOURCE OF TRUTH:
   * GC only considers uploads registered here.
   */
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

    /**
     * HARD SAFETY:
     * If a finalize lock exists, NEVER TOUCH.
     */
    if (hasLock) {
      continue;
    }

    /**
     * CRITICAL FIX:
     * Infer expiration when the session is gone but
     * the status never transitioned.
     *
     * TTL ≠ state transition.
     */
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

    /**
     * Capacity reservations can leak into gcIndex if creation crashes before meta/session writes.
     * If nothing exists for this id, remove it so capacity accounting can recover.
     */
    if (!status && !hasSession) {
      await redis
        .multi()
        .del(uploadKeys.chunks(uploadId))
        .srem(uploadKeys.gcIndex(), uploadId)
        .exec();
      continue;
    }

    /**
     * Only failed / expired uploads are collectible.
     */
    if (!status || !GC_ELIGIBLE_STATUSES.has(status)) {
      continue;
    }

    const dirPath = path.join(baseDir, uploadId);
    const binPath = path.join(baseDir, `${uploadId}.bin`);

    /**
     * Determine age from the most valuable artifact.
     * `.bin` takes precedence over chunk dir.
     */
    let mtimeMs = 0;

    try {
      const st = await fs.stat(binPath);
      mtimeMs = st.mtimeMs;
    } catch {
      try {
        const st = await fs.stat(dirPath);
        mtimeMs = st.mtimeMs;
      } catch {
        /**
         * No filesystem artifacts left.
         * Clean Redis only.
         */
        await redis.multi()
          .del(metaKey)
          .del(uploadKeys.chunks(uploadId))
          .del(sessionKey)
          .srem(uploadKeys.gcIndex(), uploadId)
          .exec();
        continue;
      }
    }

    /**
     * Respect grace period.
     */
    if (Date.now() - mtimeMs < GRACE_MS) {
      continue;
    }

    log.warn(
      { uploadId, status },
      "GC deleting failed/expired upload artifacts"
    );

    /**
     * Always attempt both deletions.
     * Chunk dir may not exist. `.bin` may not exist.
     * That is fine.
     */
    await Promise.all([
      fs.rm(dirPath, { recursive: true, force: true }).catch(() => {}),
      fs.rm(binPath, { force: true }).catch(() => {}),
      redis.multi()
        .del(metaKey)
        .del(uploadKeys.chunks(uploadId))
        .del(sessionKey)
        .srem(uploadKeys.gcIndex(), uploadId)
        .exec(),
    ]);

    /**
     * Yield to event loop to avoid starvation
     * when GC backlog is large.
     */
    await new Promise(r => setImmediate(r));
  }
}
