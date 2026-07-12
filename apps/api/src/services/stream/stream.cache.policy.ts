import { WalrusReadLimits } from "../../config/walrus.config.js";

export const STREAM_CACHE_TTL_MS = Number(process.env.FLOE_STREAM_CACHE_TTL_MS ?? 30 * 60_000);
export const STREAM_CACHE_MAX_BYTES = Number(
  process.env.FLOE_STREAM_CACHE_MAX_BYTES ?? 2 * 1024 * 1024 * 1024,
);
export const STREAM_CACHE_FILL_CONCURRENCY = Number(
  process.env.FLOE_STREAM_CACHE_FILL_CONCURRENCY ?? 4,
);
export const STREAM_CACHE_MIN_FREE_DISK_BYTES = Number(
  process.env.FLOE_STREAM_CACHE_MIN_FREE_DISK_BYTES ?? 1 * 1024 * 1024 * 1024,
);

export function shouldCacheFullObject(sizeBytes: number): boolean {
  return (
    Number.isFinite(sizeBytes) &&
    sizeBytes > 0 &&
    sizeBytes <= WalrusReadLimits.inlineFullObjectMaxBytes
  );
}
