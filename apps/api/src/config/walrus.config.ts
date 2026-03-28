function parseUrlList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function assertHttpUrl(name: string, url: string) {
  if (!/^https?:\/\//.test(url)) {
    throw new Error(`${name} must start with http:// or https://`);
  }
}

function parsePositiveIntEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return n;
}

if (!process.env.WALRUS_AGGREGATOR_URL) {
  throw new Error("Missing required env: WALRUS_AGGREGATOR_URL");
}

const primaryAggregator = process.env.WALRUS_AGGREGATOR_URL;
const fallbackAggregators = parseUrlList(
  process.env.WALRUS_AGGREGATOR_FALLBACK_URLS
);

assertHttpUrl("WALRUS_AGGREGATOR_URL", primaryAggregator);
for (const u of fallbackAggregators) assertHttpUrl("WALRUS_AGGREGATOR_FALLBACK_URLS", u);

export const WalrusEnv = {
  // Ordered list. Reader will try primary first, then fallbacks.
  aggregatorUrls: [primaryAggregator, ...fallbackAggregators],
};

export const WalrusReadLimits = {
  timeoutMs: parsePositiveIntEnv("WALRUS_READ_TIMEOUT_MS", 10 * 60_000),

  // Max size for a single upstream Walrus Range request. Used to stitch large reads into bounded segments so public aggregators can serve big files.
  maxRangeBytes: parsePositiveIntEnv("FLOE_STREAM_MAX_RANGE_BYTES", 64 * 1024 * 1024),

  // Default stitched segment size for media playback. Keep this smaller than the
  // absolute max range size so seeks and cold reads are less sensitive to
  // aggregator hiccups during long streams.
  mediaSegmentBytes: parsePositiveIntEnv(
    "FLOE_STREAM_MEDIA_SEGMENT_BYTES",
    8 * 1024 * 1024
  ),

  // Larger first read for cold full-object playback so players can start with
  // fewer round-trips before normal stitched reads continue.
  initialSegmentBytes: parsePositiveIntEnv(
    "FLOE_STREAM_INITIAL_SEGMENT_BYTES",
    32 * 1024 * 1024
  ),

  // For small full-object reads, avoid stitched multi-range behavior entirely.
  inlineFullObjectMaxBytes: parsePositiveIntEnv(
    "FLOE_STREAM_INLINE_FULL_MAX_BYTES",
    32 * 1024 * 1024
  ),

  // Retry budget per stitched segment (network errors, 5xx, 429).
  maxSegmentRetries: parsePositiveIntEnv("WALRUS_READ_MAX_RETRIES", 2),
  baseRetryDelayMs: parsePositiveIntEnv("WALRUS_READ_RETRY_DELAY_MS", 250),
};

export const WalrusEpochLimits = {
  min: 1,
  max: 90,
  default: 3,
} as const;

export const WalrusUploadLimits = {
  maxRetries: parsePositiveIntEnv("FLOE_WALRUS_UPLOAD_MAX_RETRIES", 3),
  baseRetryDelayMs: parsePositiveIntEnv("FLOE_WALRUS_UPLOAD_RETRY_DELAY_MS", 2000),
  timeoutMs: parsePositiveIntEnv("FLOE_WALRUS_UPLOAD_TIMEOUT_MS", 20 * 60_000, 10_000),
};

export const WalrusQueueLimits = {
  /**
   * Max concurrent Walrus publish requests.
   */
  concurrency: parsePositiveIntEnv("FLOE_WALRUS_QUEUE_CONCURRENCY", 4),

  /**
   * Max jobs per interval window.
   */
  intervalCap: parsePositiveIntEnv("FLOE_WALRUS_QUEUE_INTERVAL_CAP", 4),

  /**
   * Interval window in ms.
   */
  intervalMs: parsePositiveIntEnv("FLOE_WALRUS_QUEUE_INTERVAL_MS", 1000),
};
