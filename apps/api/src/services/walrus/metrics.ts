import type { Readable } from "stream";
import { walrusQueue } from "./limiter.js";
import { uploadToWalrusOnce } from "./upload.js";
import { WalrusUploadLimits } from "../../config/walrus.config.js";
import {
  recordWalrusUploadMetric,
  classifyWalrusError,
} from "../../types/walrus.metrics.js";
import { observeWalrusPublish } from "../metrics/runtime.metrics.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
type WalrusUploadResult = Awaited<ReturnType<typeof uploadToWalrusOnce>>;

function extractWalrusHttpStatus(err: unknown): number | undefined {
  const msg = String((err as any)?.message ?? "");
  const m = msg.match(/WALRUS_UPLOAD_FAILED:(\d{3})\b/);
  if (!m) return undefined;
  const status = Number(m[1]);
  return Number.isFinite(status) ? status : undefined;
}

export async function uploadToWalrusWithMetrics(params: {
  uploadId: string;
  sizeBytes: number;
  epochs: number;
  streamFactory: () => Readable;
}): Promise<{
  blobId: string;
  objectId?: string;
  cost?: number;
  endEpoch?: number;
}> {
  const start = Date.now();
  let lastError: any;

  try {
    const result = (await walrusQueue.add(async () => {
      for (let attempt = 1; attempt <= WalrusUploadLimits.maxRetries; attempt++) {
        try {
          const res = await uploadToWalrusOnce(
            params.streamFactory,
            params.epochs
          );

          recordWalrusUploadMetric({
            uploadId: params.uploadId,
            sizeBytes: params.sizeBytes,
            epochs: params.epochs,
            attempt,
            durationMs: Date.now() - start,
            outcome: "success",
            walrusCost: res.cost,
            walrusEndEpoch: res.endEpoch,
            network: process.env.FLOE_NETWORK as any,
            timestamp: Date.now(),
          });
          observeWalrusPublish({
            durationMs: Date.now() - start,
            outcome: "success",
            mode: (process.env.FLOE_WALRUS_STORE_MODE === "cli" ? "cli" : "sdk"),
            source: res.source,
          });

          return res;

        } catch (err) {
          lastError = err;
          if (attempt === WalrusUploadLimits.maxRetries) break;
          await sleep(WalrusUploadLimits.baseRetryDelayMs * attempt);
        }
      }

      throw lastError ?? new Error("WALRUS_RETRIES_EXHAUSTED");
    })) as WalrusUploadResult;

    return result;

  } catch (err: any) {
    recordWalrusUploadMetric({
      uploadId: params.uploadId,
      sizeBytes: params.sizeBytes,
      epochs: params.epochs,
      attempt: WalrusUploadLimits.maxRetries,
      durationMs: Date.now() - start,
      outcome: classifyWalrusError(err),
      error: err?.message ?? "unknown",
      httpStatus: extractWalrusHttpStatus(err),
      network: process.env.FLOE_NETWORK as any,
      timestamp: Date.now(),
    });
    observeWalrusPublish({
      durationMs: Date.now() - start,
      outcome: "failure",
      mode: (process.env.FLOE_WALRUS_STORE_MODE === "cli" ? "cli" : "sdk"),
      source: "unknown",
    });

    throw err;
  }
}
