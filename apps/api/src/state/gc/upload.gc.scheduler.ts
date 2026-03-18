import type { FastifyBaseLogger } from "fastify";
import { GcConfig } from "../../config/uploads.config.js";
import { runUploadGc } from "./upload.gc.worker.js";

let timer: NodeJS.Timeout | null = null;
let running: Promise<void> | null = null;

export function startUploadGc(log: FastifyBaseLogger) {
  if (timer) return;

  log.info("Upload GC started");

  timer = setInterval(async () => {
    if (running) return; // prevent overlap

    running = runUploadGc(log).catch(err => {
      log.error(err, "Upload GC failed");
    }).finally(() => {
      running = null;
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
