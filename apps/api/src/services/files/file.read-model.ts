import { getSuiClient } from "../../state/sui.js";
import { getIndexedFile, upsertIndexedFile } from "../../db/files.repository.js";
import { isPostgresConfigured, isPostgresEnabled } from "../../state/postgres.js";
import { AuthModeConfig, AuthOwnerPolicyConfig } from "../../config/auth.config.js";
import { parseBoolEnv } from "../../utils/parseEnv.js";

// Latency fix: gate Sui RPC metadata fallback behind an env var.
// When false (default), reads that miss Postgres return null instead of
// falling back to a 200-2000ms Sui RPC call. This eliminates the cold-start
// penalty — upload finalize should have already populated Postgres.
const SUI_METADATA_FALLBACK_ENABLED = parseBoolEnv("FLOE_SUI_METADATA_FALLBACK", false);

const SUI_ADDRESS_RE = /^(0x)?[0-9a-fA-F]{64}$/;

function getTrustedFileObjectType(): string {
  const suiPackageId = process.env.SUI_PACKAGE_ID?.trim();
  if (!suiPackageId) return "";
  return `${suiPackageId}::file::FileMeta`.toLowerCase();
}

export type NormalizedFileFields = {
  blobId: string;
  blobObjectId: string | null;
  checksum: string | null;
  sizeBytes: number;
  mimeType: string;
  createdAt: number;
  owner: unknown;
  ownerAddress: string | null;
  walrusEndEpoch: number | null;
};

export type FileFieldsSource = "memory" | "postgres" | "sui";
export type PostgresReadState = "disabled" | "healthy" | "degraded";

export type CachedFileFieldsResult = {
  fields: any | null;
  source: FileFieldsSource | null;
  postgresState: PostgresReadState;
};

function normalizeSuiAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!SUI_ADDRESS_RE.test(value)) return null;
  return `0x${value.replace(/^0x/i, "").toLowerCase()}`;
}

export function normalizeFileIdParam(raw: unknown): string | null {
  return normalizeSuiAddress(raw);
}

function isTrustedFileObjectType(raw: unknown): boolean {
  const trustedType = getTrustedFileObjectType();
  return typeof raw === "string" && trustedType !== "" && raw.toLowerCase() === trustedType;
}

/** Represents a Sui optional value that may be a vector (for Move Option types). */
interface SuiOptionalValue {
  vec?: unknown[];
}

function parseOptionalU64(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;

  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  if (typeof raw === "object") {
    const vec = (raw as SuiOptionalValue)?.vec;
    if (Array.isArray(vec)) {
      if (vec.length === 0) return null;
      return parseOptionalU64(vec[0]);
    }
  }

  return null;
}

function parseOptionalAddress(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") return normalizeSuiAddress(raw);
  if (typeof raw === "object") {
    const vec = (raw as SuiOptionalValue)?.vec;
    if (Array.isArray(vec)) {
      if (vec.length === 0) return null;
      return normalizeSuiAddress(vec[0]);
    }
  }
  return null;
}

function parseOptionalString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    const value = raw.trim();
    return value ? value : null;
  }
  if (typeof raw === "object") {
    const vec = (raw as SuiOptionalValue)?.vec;
    if (Array.isArray(vec)) {
      if (vec.length === 0) return null;
      return parseOptionalString(vec[0]);
    }
  }
  return null;
}

export function normalizeFileFields(fields: any): NormalizedFileFields | null {
  if (!fields || typeof fields !== "object") return null;

  const blobId = typeof fields.blob_id === "string" ? fields.blob_id.trim() : "";
  const blobObjectId = parseOptionalAddress(fields.blob_object_id);
  const checksum = parseOptionalString(fields.checksum);
  const rawSizeBytes = Number(fields.size_bytes);
  const rawCreatedAt = Number(fields.created_at);
  const mimeType =
    typeof fields.mime === "string" && fields.mime.trim().length > 0
      ? fields.mime
      : "application/octet-stream";

  if (!blobId) return null;
  if (!Number.isFinite(rawSizeBytes) || !Number.isInteger(rawSizeBytes) || rawSizeBytes <= 0) {
    return null;
  }
  if (!Number.isFinite(rawCreatedAt) || rawCreatedAt < 0) return null;

  return {
    blobId,
    blobObjectId,
    checksum,
    sizeBytes: rawSizeBytes,
    mimeType,
    createdAt: rawCreatedAt,
    owner: fields.owner ?? null,
    ownerAddress: normalizeSuiAddress(fields.owner),
    walrusEndEpoch: parseOptionalU64(fields.walrus_end_epoch),
  };
}

const FILE_FIELDS_MEMORY_CACHE_TTL_MS = Number(
  process.env.FLOE_FILE_FIELDS_MEMORY_CACHE_TTL_MS ?? 60_000,
);
const FILE_FIELDS_MEMORY_CACHE_MAX = Number(
  process.env.FLOE_FILE_FIELDS_MEMORY_CACHE_MAX_ENTRIES ?? 5000,
);
const FILE_FIELDS_DEBUG = process.env.FLOE_FILE_FIELDS_DEBUG === "1";

function canExposePublicFileRead(): boolean {
  return AuthModeConfig.mode !== "private" && !AuthOwnerPolicyConfig.enforceUploadOwner;
}

export function getPublicStreamUrl(fileId: string): string | null {
  if (!canExposePublicFileRead()) return null;
  const configuredBaseUrl = (process.env.FLOE_PUBLIC_STREAM_BASE_URL ?? "").trim();
  if (!configuredBaseUrl) return null;
  const base = configuredBaseUrl.replace(/\/+$/, "");
  return `${base}/v1/files/${encodeURIComponent(fileId)}/stream`;
}

export function applyFileReadCacheHeaders(reply: any) {
  if (canExposePublicFileRead()) {
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return;
  }

  reply.header("Cache-Control", "private, no-store");
  reply.header("Vary", "Authorization, x-api-key");
}

export function isFileFieldsDebugEnabled(): boolean {
  return FILE_FIELDS_DEBUG;
}

export class LruMap<V> {
  private readonly max: number;
  private readonly map = new Map<string, V>();

  constructor(max: number) {
    this.max = max;
  }

  get size(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Move to end (most recently used) on access
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    this.evictIfNeeded();
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  clear(): void {
    this.map.clear();
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  /**
   * Iterate entries from least-recently-used to most-recently-used.
   * Supports for...of destructuring: for (const [key, value] of map)
   */
  *[Symbol.iterator](): IterableIterator<[string, V]> {
    yield* this.map.entries();
  }

  entries(): IterableIterator<[string, V]> {
    return this.map.entries();
  }

  keys(): IterableIterator<string> {
    return this.map.keys();
  }

  private evictIfNeeded(): void {
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }
  }
}

const fileFieldsMemoryCache = new LruMap<{ value: any; expiresAt: number; touchedAt: number }>(
  Math.floor(FILE_FIELDS_MEMORY_CACHE_MAX) || 5000,
);

function getMemoryFileFields(fileId: string): any | null {
  if (!Number.isFinite(FILE_FIELDS_MEMORY_CACHE_TTL_MS) || FILE_FIELDS_MEMORY_CACHE_TTL_MS <= 0) {
    return null;
  }
  const now = Date.now();
  const hit = fileFieldsMemoryCache.get(fileId);
  if (!hit) return null;
  if (hit.expiresAt <= now) {
    fileFieldsMemoryCache.delete(fileId);
    return null;
  }
  hit.touchedAt = now;
  return hit.value;
}

function setMemoryFileFields(fileId: string, fields: any) {
  if (!Number.isFinite(FILE_FIELDS_MEMORY_CACHE_TTL_MS) || FILE_FIELDS_MEMORY_CACHE_TTL_MS <= 0) {
    return;
  }
  const now = Date.now();
  fileFieldsMemoryCache.set(fileId, {
    value: fields,
    expiresAt: now + FILE_FIELDS_MEMORY_CACHE_TTL_MS,
    touchedAt: now,
  });
}

export function clearFileFieldsCache(fileId: string) {
  fileFieldsMemoryCache.delete(fileId);
}

/** @internal test-only hook — clears all cached file fields entries. */
export function resetFileFieldsMemoryCacheForTests(): void {
  fileFieldsMemoryCache.clear();
}

export function applyFileLookupHeaders(
  reply: any,
  params: { source: FileFieldsSource | null; postgresState: PostgresReadState },
) {
  reply.header("x-floe-metadata-source", params.source ?? "unknown");
  reply.header("x-floe-postgres-state", params.postgresState);
}

export async function getFileFieldsCached(fileId: string): Promise<CachedFileFieldsResult> {
  const memory = getMemoryFileFields(fileId);
  const postgresConfigured = isPostgresConfigured();
  const postgresEnabled = isPostgresEnabled();
  let postgresState: PostgresReadState = !postgresConfigured
    ? "disabled"
    : postgresEnabled
      ? "healthy"
      : "degraded";
  if (memory) {
    const normalizedMemory = normalizeFileFields(memory);
    if (normalizedMemory && !normalizedMemory.blobObjectId) {
      const indexed = await getIndexedFile(fileId).catch(() => null);
      if (indexed?.blobObjectId) {
        return {
          fields: { ...memory, blob_object_id: indexed.blobObjectId },
          source: "memory",
          postgresState,
        };
      }
    }
    return { fields: memory, source: "memory", postgresState };
  }

  const indexed = await getIndexedFile(fileId).catch(() => {
    postgresState = "degraded";
    return null;
  });
  if (indexed) {
    const fields = {
      blob_id: indexed.blobId,
      blob_object_id: indexed.blobObjectId,
      checksum: indexed.checksum,
      size_bytes: indexed.sizeBytes,
      mime: indexed.mimeType,
      created_at: indexed.createdAtMs,
      owner: indexed.ownerAddress,
      walrus_end_epoch: indexed.walrusEndEpoch,
    };
    setMemoryFileFields(fileId, fields);
    return { fields, source: "postgres", postgresState };
  }

  // Latency fix: skip Sui RPC fallback by default. The 200-2000ms Sui RPC
  // call is the dominant cold-start penalty. Upload finalize should have
  // already populated Postgres. Set FLOE_SUI_METADATA_FALLBACK=true to
  // re-enable for legacy data migration scenarios.
  if (!SUI_METADATA_FALLBACK_ENABLED) {
    return { fields: null, source: null, postgresState };
  }

  const obj = await getSuiClient().getObject({
    id: fileId,
    options: { showContent: true },
  });

  if (
    !obj.data?.content ||
    obj.data.content.dataType !== "moveObject" ||
    !isTrustedFileObjectType(obj.data.content.type)
  ) {
    return { fields: null, source: null, postgresState };
  }

  const fields = obj.data.content.fields as Record<string, unknown>;
  setMemoryFileFields(fileId, fields);
  const normalized = normalizeFileFields(fields);
  if (normalized) {
    await upsertIndexedFile({
      fileId,
      blobId: normalized.blobId,
      blobObjectId: normalized.blobObjectId,
      checksum: normalized.checksum,
      ownerAddress: normalized.ownerAddress,
      sizeBytes: normalized.sizeBytes,
      mimeType: normalized.mimeType,
      walrusEndEpoch: normalized.walrusEndEpoch,
      createdAtMs: normalized.createdAt,
    }).catch(() => {
      postgresState = "degraded";
    });
  }

  return { fields, source: "sui", postgresState };
}
