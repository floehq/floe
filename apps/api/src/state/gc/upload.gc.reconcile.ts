import fs from "fs/promises";
import path from "path";
import type { FastifyBaseLogger } from "fastify";

import { getRedis } from "../redis.js";
import { uploadKeys } from "../keys.js";
import { UploadConfig } from "../../config/uploads.config.js";
import { chunkStore } from "../../store/index.js";

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

export async function reconcileOrphanUploads(
  log: FastifyBaseLogger
): Promise<{ recovered: number; scanned: number }> {
  if (chunkStore.backend() !== "disk") {
    return { recovered: 0, scanned: 0 };
  }

  const redis = getRedis();
  const baseDir = UploadConfig.tmpDir;

  let entries: string[];
  try {
    entries = await fs.readdir(baseDir);
  } catch {
    return { recovered: 0, scanned: 0 };
  }

  let recovered = 0;
  let scanned = 0;

  for (const entry of entries) {
    const isBin = entry.endsWith(".bin");
    const uploadId = isBin ? entry.slice(0, -4) : entry;

    if (!isUuid(uploadId)) continue;

    const fullPath = path.join(baseDir, entry);
    let stat;
    try {
      stat = await fs.lstat(fullPath);
    } catch {
      continue;
    }

    if (isBin && !stat.isFile()) continue;
    if (!isBin && !stat.isDirectory()) continue;
    scanned += 1;

    const isTracked = await redis.sismember(
      uploadKeys.gcIndex(),
      uploadId
    );

    if (isTracked) continue;

    log.warn(
      { uploadId, artifactType: isBin ? "final_bin" : "chunk_dir" },
      "Recovered orphan upload; registering for GC"
    );

    await redis.multi()
      .hset(uploadKeys.meta(uploadId), {
        status: "expired",
        recoveredAt: String(Date.now()),
        recoveredBy: "disk_reconcile",
        recoveredArtifactType: isBin ? "final_bin" : "chunk_dir",
      })
      .sadd(uploadKeys.gcIndex(), uploadId)
      .exec();
    recovered += 1;
  }

  return { recovered, scanned };
}
