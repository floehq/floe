import type { FastifyBaseLogger } from "fastify";
import { GcConfig } from "../../config/uploads.config.js";
import { getRedis } from "../redis.js";
import { runUploadGc } from "./upload.gc.worker.js";

const GC_LOCK_KEY = "floe:gc:upload:distributed-lock";

let timer: NodeJS.Timeout | null = null;
let running: Promise<void> | null = null;

export function startUploadGc(log: FastifyBaseLogger) {
  if (timer) return;

  log.info("Upload GC started");

  timer = setInterval(async () => {
    if (running) return; // prevent overlap

    const redis = getRedis();
    const lockTtl = Math.max(Math.ceil(GcConfig.gcInterval / 1000) + 30, 60);
    const acquired = await redis.set(GC_LOCK_KEY, "1", { nx: true, ex: lockTtl });

    if (!acquired) {
      log.debug("Upload GC skipped — distributed lock held by another instance");
      return;
    }

    running = runUploadGc(log)
      .catch((err) => {
        log.error(err, "Upload GC failed");
      })
      .finally(async () => {
        running = null;
        await redis.del(GC_LOCK_KEY).catch((err) => {
          log.warn(err, "Failed to release GC lock");
        });
      });
  }, GcConfig.gcInterval);

  timer.unref();
}

export async function stopUploadGc(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  if (running) {
    await running;
    running = null;
  }
}
