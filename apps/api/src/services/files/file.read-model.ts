import { getSuiClient } from "../../state/sui.js";
import { getIndexedFile, upsertIndexedFile } from "../../db/files.repository.js";
import { isPostgresConfigured, isPostgresEnabled } from "../../state/postgres.js";
import { AuthModeConfig, AuthOwnerPolicyConfig } from "../../config/auth.config.js";

const SUI_ADDRESS_RE = /^(0x)?[0-9a-fA-F]{64}$/;
const TRUSTED_FILE_OBJECT_TYPE = `${process.env.SUI_PACKAGE_ID}::file::FileMeta`.toLowerCase();

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
  return typeof raw === "string" && raw.toLowerCase() === TRUSTED_FILE_OBJECT_TYPE;
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
    const vec = (raw as any)?.vec;
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
    const vec = (raw as any)?.vec;
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
    const vec = (raw as any)?.vec;
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

const fileFieldsMemoryCache = new Map<
  string,
  { value: any; expiresAt: number; touchedAt: number }
>();

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

  const maxEntries =
    Number.isFinite(FILE_FIELDS_MEMORY_CACHE_MAX) && FILE_FIELDS_MEMORY_CACHE_MAX > 0
      ? Math.floor(FILE_FIELDS_MEMORY_CACHE_MAX)
      : 5000;
  if (fileFieldsMemoryCache.size <= maxEntries) return;

  let over = fileFieldsMemoryCache.size - maxEntries;
  const entries = [...fileFieldsMemoryCache.entries()].sort(
    (a, b) => a[1].touchedAt - b[1].touchedAt,
  );
  for (const [k] of entries) {
    if (over <= 0) break;
    fileFieldsMemoryCache.delete(k);
    over -= 1;
  }
}

export function clearFileFieldsCache(fileId: string) {
  fileFieldsMemoryCache.delete(fileId);
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

  const obj = await getSuiClient().getObject({
    id: fileId,
    options: { showContent: true },
  });

  if (
    !obj.data?.content ||
    obj.data.content.dataType !== "moveObject" ||
    !isTrustedFileObjectType((obj.data as any).type)
  ) {
    return { fields: null, source: null, postgresState };
  }

  const fields = obj.data.content.fields as any;
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
