import path from "path";
import { parsePositiveIntEnv } from "../utils/parseEnv.js";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

export const UploadConfig = {
  get tmpDir() {
    return path.resolve(requireEnv("UPLOAD_TMP_DIR"));
  },

  maxFileSizeBytes: parsePositiveIntEnv("FLOE_MAX_FILE_SIZE_BYTES", 15 * 1024 * 1024 * 1024),
  // Defensive cap to avoid Redis/Disk blowups from absurd client requests.
  // Example: tiny chunk sizes + huge file sizes -> massive chunk counts.
  maxTotalChunks: parsePositiveIntEnv("FLOE_MAX_TOTAL_CHUNKS", 200_000),
  maxActiveUploads: parsePositiveIntEnv("FLOE_MAX_ACTIVE_UPLOADS", 100),
  sessionTtlMs: parsePositiveIntEnv("FLOE_UPLOAD_SESSION_TTL_MS", 6 * 60 * 60 * 1000), // 6 hours
};

const chunkMinBytes = parsePositiveIntEnv("FLOE_CHUNK_MIN_BYTES", 256 * 1024);
const chunkMaxBytes = parsePositiveIntEnv("FLOE_CHUNK_MAX_BYTES", 20 * 1024 * 1024);
const chunkDefaultBytes = parsePositiveIntEnv("FLOE_CHUNK_DEFAULT_BYTES", 2 * 1024 * 1024);

if (chunkMinBytes > chunkMaxBytes) {
  throw new Error("FLOE_CHUNK_MIN_BYTES must be <= FLOE_CHUNK_MAX_BYTES");
}
if (chunkDefaultBytes < chunkMinBytes || chunkDefaultBytes > chunkMaxBytes) {
  throw new Error(
    "FLOE_CHUNK_DEFAULT_BYTES must be between FLOE_CHUNK_MIN_BYTES and FLOE_CHUNK_MAX_BYTES",
  );
}

export const ChunkConfig = {
  minBytes: chunkMinBytes,
  maxBytes: chunkMaxBytes,
  defaultBytes: chunkDefaultBytes,
};

export const GcConfig = {
  gcInterval: parsePositiveIntEnv("FLOE_GC_INTERVAL_MS", 5 * 60 * 1000), // 5 minutes
  grace: parsePositiveIntEnv("FLOE_GC_GRACE_MS", 15 * 60 * 1000), // 15 minutes
};
