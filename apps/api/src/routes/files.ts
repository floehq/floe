import { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import { Readable } from "node:stream";

import { suiClient } from "../state/sui.js";
import { getIndexedFile, upsertIndexedFile } from "../db/files.repository.js";
import { isPostgresConfigured, isPostgresEnabled } from "../state/postgres.js";
import { fetchWalrusBlob } from "../services/walrus/read.js";
import { WalrusReadLimits } from "../config/walrus.config.js";
import { AuthModeConfig, AuthOwnerPolicyConfig } from "../config/auth.config.js";
import { sendApiError } from "../utils/apiError.js";
import { applyRateLimitHeaders } from "../services/auth/auth.headers.js";
import {
  observeMetadataLookup,
  observeStreamTtfb,
  recordStreamReadError,
} from "../services/metrics/runtime.metrics.js";
import {
  createCachedReadStream,
  ensureCachedStreamBlob,
  ensureCachedStreamRange,
  getCachedStreamPath,
} from "../services/stream/stream.cache.js";

function inferContainerFromMime(mimeType: string): string | null {
  const m = (mimeType ?? "").toLowerCase();
  if (m.includes("mp4")) return "mp4";
  if (m.includes("webm")) return "webm";
  if (m.includes("quicktime")) return "mov";
  if (m.includes("x-matroska") || m.includes("mkv")) return "mkv";
  return null;
}

function classifyStreamErrorReason(message: string): string {
  const msg = (message ?? "").toUpperCase();
  if (msg.includes("FILE_BLOB_UNAVAILABLE")) return "blob_unavailable";
  if (msg.includes("INVALID_RANGE")) return "invalid_range";
  if (msg.includes("WALRUS_RANGE_FAILED")) return "walrus_range_failed";
  if (msg.includes("WALRUS_EMPTY_SEGMENT")) return "walrus_empty_segment";
  if (msg.includes("WALRUS_SEGMENT_OVERRUN")) return "walrus_segment_overrun";
  if (msg.includes("WALRUS_MISSING_BODY")) return "walrus_missing_body";
  if (msg.includes("STREAM_TRUNCATED")) return "stream_truncated";
  if (msg.includes("ABORT")) return "aborted";
  return "other";
}

function shouldExposeBlobId(req: any): boolean {
  // Default: never expose blobId unless explicitly requested.
  if (process.env.FLOE_EXPOSE_BLOB_ID === "1") return true;
  const q = req?.query ?? {};
  const raw = q.includeBlobId ?? q.include_blob_id ?? q.includeStorage;
  return raw === "1" || raw === "true" || raw === true;
}

function authzStatusCode(code?: string): 401 | 403 {
  return code === "AUTH_REQUIRED" ? 401 : 403;
}

function authzErrorCode(code?: string): "AUTH_REQUIRED" | "OWNER_MISMATCH" | "INSUFFICIENT_SCOPE" {
  if (code === "AUTH_REQUIRED") return "AUTH_REQUIRED";
  if (code === "INSUFFICIENT_SCOPE") return "INSUFFICIENT_SCOPE";
  return "OWNER_MISMATCH";
}

function sendFileAccessDenied(reply: any, authz: { code?: string; message?: string }) {
  if (authz.code === "OWNER_MISMATCH") {
    return sendApiError(reply, 404, "FILE_NOT_FOUND", "File not found");
  }
  return sendApiError(
    reply,
    authzStatusCode(authz.code),
    authzErrorCode(authz.code),
    authz.message ?? "File access denied"
  );
}

export type StreamReadPlan = {
  initialSegmentBytes: number;
  segmentBytes: number;
};

type ParsedRange = {
  start: number;
  end: number;
};

type NormalizedFileFields = {
  blobId: string;
  sizeBytes: number;
  mimeType: string;
  createdAt: number;
  owner: unknown;
  ownerAddress: string | null;
  walrusEndEpoch: number | null;
};

const SUI_ADDRESS_RE = /^(0x)?[0-9a-fA-F]{64}$/;

function normalizeSuiAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!SUI_ADDRESS_RE.test(value)) return null;
  return `0x${value.replace(/^0x/i, "").toLowerCase()}`;
}

function normalizeFileIdParam(raw: unknown): string | null {
  return normalizeSuiAddress(raw);
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

function normalizeFileFields(fields: any): NormalizedFileFields | null {
  if (!fields || typeof fields !== "object") return null;

  const blobId = typeof fields.blob_id === "string" ? fields.blob_id.trim() : "";
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
    sizeBytes: rawSizeBytes,
    mimeType,
    createdAt: rawCreatedAt,
    owner: fields.owner ?? null,
    ownerAddress: normalizeSuiAddress(fields.owner),
    walrusEndEpoch: parseOptionalU64(fields.walrus_end_epoch),
  };
}

function parseSingleRangeHeader(params: {
  rangeHeader: string;
  sizeBytes: number;
}): { range: ParsedRange; kind: "bounded" | "open" | "suffix" } | { error: "INVALID_RANGE" } {
  const { rangeHeader, sizeBytes } = params;

  const m = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!m) return { error: "INVALID_RANGE" };

  const rawStart = m[1];
  const rawEnd = m[2];

  // Suffix: bytes=-N
  if (rawStart === "" && rawEnd !== "") {
    const suffixLen = Number(rawEnd);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return { error: "INVALID_RANGE" };

    const end = sizeBytes - 1;
    const start = Math.max(0, sizeBytes - suffixLen);
    return { range: { start, end }, kind: "suffix" };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start < 0) return { error: "INVALID_RANGE" };

  // Open ended: bytes=N-
  if (rawEnd === "") {
    const end = sizeBytes - 1;
    if (start > end) return { error: "INVALID_RANGE" };
    return { range: { start, end }, kind: "open" };
  }

  const endRaw = Number(rawEnd);
  if (!Number.isFinite(endRaw) || endRaw < start) return { error: "INVALID_RANGE" };
  if (start >= sizeBytes) return { error: "INVALID_RANGE" };

  const end = Math.min(endRaw, sizeBytes - 1);
  return { range: { start, end }, kind: "bounded" };
}

const FILE_FIELDS_MEMORY_CACHE_TTL_MS = Number(
  process.env.FLOE_FILE_FIELDS_MEMORY_CACHE_TTL_MS ?? 60_000
);
const FILE_FIELDS_MEMORY_CACHE_MAX = Number(
  process.env.FLOE_FILE_FIELDS_MEMORY_CACHE_MAX_ENTRIES ?? 5000
);
const FILE_FIELDS_DEBUG = process.env.FLOE_FILE_FIELDS_DEBUG === "1";

type FileFieldsSource = "memory" | "postgres" | "sui";
type PostgresReadState = "disabled" | "healthy" | "degraded";
type CachedFileFieldsResult = {
  fields: any | null;
  source: FileFieldsSource | null;
  postgresState: PostgresReadState;
};

function canExposePublicFileRead(): boolean {
  return AuthModeConfig.mode !== "private" && !AuthOwnerPolicyConfig.enforceUploadOwner;
}

function getPublicStreamUrl(fileId: string): string | null {
  if (!canExposePublicFileRead()) return null;
  const configuredBaseUrl = (process.env.FLOE_PUBLIC_STREAM_BASE_URL ?? "").trim();
  if (!configuredBaseUrl) return null;
  const base = configuredBaseUrl.replace(/\/+$/, "");
  return `${base}/v1/files/${encodeURIComponent(fileId)}/stream`;
}

function applyFileReadCacheHeaders(reply: any) {
  if (canExposePublicFileRead()) {
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return;
  }

  reply.header("Cache-Control", "private, no-store");
  reply.header("Vary", "Authorization, x-api-key");
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

  const maxEntries = Number.isFinite(FILE_FIELDS_MEMORY_CACHE_MAX) && FILE_FIELDS_MEMORY_CACHE_MAX > 0
    ? Math.floor(FILE_FIELDS_MEMORY_CACHE_MAX)
    : 5000;
  if (fileFieldsMemoryCache.size <= maxEntries) return;

  // Drop least-recently-touched entries when we exceed max size.
  let over = fileFieldsMemoryCache.size - maxEntries;
  const entries = [...fileFieldsMemoryCache.entries()].sort(
    (a, b) => a[1].touchedAt - b[1].touchedAt
  );
  for (const [k] of entries) {
    if (over <= 0) break;
    fileFieldsMemoryCache.delete(k);
    over -= 1;
  }
}

async function getFileFieldsCached(fileId: string): Promise<CachedFileFieldsResult> {
  const memory = getMemoryFileFields(fileId);
  const postgresConfigured = isPostgresConfigured();
  const postgresEnabled = isPostgresEnabled();
  let postgresState: PostgresReadState = !postgresConfigured
    ? "disabled"
    : postgresEnabled
      ? "healthy"
      : "degraded";
  if (memory) {
    return { fields: memory, source: "memory", postgresState };
  }

  const indexed = await getIndexedFile(fileId).catch((err) => {
    postgresState = "degraded";
    return null;
  });
  if (indexed) {
    const fields = {
      blob_id: indexed.blobId,
      size_bytes: indexed.sizeBytes,
      mime: indexed.mimeType,
      created_at: indexed.createdAtMs,
      owner: indexed.ownerAddress,
      walrus_end_epoch: indexed.walrusEndEpoch,
    };
    setMemoryFileFields(fileId, fields);
    return { fields, source: "postgres", postgresState };
  }

  const obj = await suiClient.getObject({
    id: fileId,
    options: { showContent: true },
  });

  if (!obj.data?.content || obj.data.content.dataType !== "moveObject") {
    return { fields: null, source: null, postgresState };
  }

  const fields = obj.data.content.fields as any;
  setMemoryFileFields(fileId, fields);
  const normalized = normalizeFileFields(fields);
  if (normalized) {
    await upsertIndexedFile({
      fileId,
      blobId: normalized.blobId,
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

function applyFileLookupHeaders(reply: any, params: {
  source: FileFieldsSource | null;
  postgresState: PostgresReadState;
}) {
  reply.header("x-floe-metadata-source", params.source ?? "unknown");
  reply.header("x-floe-postgres-state", params.postgresState);
}

async function* walrusByteStream(params: {
  blobId: string;
  start: number;
  end: number;
  maxSegmentBytes: number;
  initialSegmentBytes?: number;
  signal: AbortSignal;
}): AsyncGenerator<Uint8Array> {
  const safeUpstreamSnippet = (body: string): string => {
    const trimmed = (body ?? "").trim();
    if (!trimmed) return "";
    const snippet = trimmed.slice(0, 160);
    const ascii = snippet.replace(/[^\x20-\x7E]/g, "");
    return ascii;
  };

  const makeWalrusReadError = (upstreamStatus: number, upstreamBody: string) => {
    const snippet = safeUpstreamSnippet(upstreamBody);
    const err = new Error(
      `WALRUS_RANGE_FAILED status=${upstreamStatus}${snippet ? ` body=${snippet}` : ""}`.trim()
    ) as Error & { statusCode?: number };

    if (upstreamStatus === 404) {
      err.statusCode = 404;
      err.message = "FILE_BLOB_UNAVAILABLE";
      return err;
    }

    err.statusCode = upstreamStatus >= 500 ? 503 : 502;
    return err;
  };

  const maxSegmentBytes =
    Number.isFinite(params.maxSegmentBytes) && params.maxSegmentBytes > 0
      ? params.maxSegmentBytes
      : 16 * 1024 * 1024;

  const minSegmentBytes = 256 * 1024; // 256KiB

  let offset = params.start;

  while (offset <= params.end) {
    if (params.signal.aborted) return;

    const preferredSegmentBytes =
      offset === params.start && params.initialSegmentBytes
        ? Math.max(maxSegmentBytes, params.initialSegmentBytes)
        : maxSegmentBytes;
    let segSize = Math.min(preferredSegmentBytes, params.end - offset + 1);

    while (true) {
      const segEnd = Math.min(params.end, offset + segSize - 1);

      let upstream: Response;
      try {
        ({ res: upstream } = await fetchWalrusBlob({
          blobId: params.blobId,
          rangeHeader: `bytes=${offset}-${segEnd}`,
          signal: params.signal,
        }));
      } catch (err) {
        if (params.signal.aborted || (err as any)?.name === "AbortError") {
          return;
        }

        if (segSize > minSegmentBytes) {
          segSize = Math.max(minSegmentBytes, Math.floor(segSize / 2));
          continue;
        }

        throw err;
      }

      if (upstream.status === 416 && segSize > minSegmentBytes) {
        segSize = Math.max(minSegmentBytes, Math.floor(segSize / 2));
        continue;
      }

      const isFullObjectAttempt =
        params.start === 0 && offset === 0 && segEnd === params.end;

      if (upstream.status === 200 && isFullObjectAttempt) {
      } else if (upstream.status !== 206) {
        const text = await upstream.text().catch(() => "");
        throw makeWalrusReadError(upstream.status, text);
      }

      const body = upstream.body;
      if (!body) {
        throw new Error(`WALRUS_MISSING_BODY status=${upstream.status} offset=${offset} end=${segEnd}`);
      }

      const rs = Readable.fromWeb(body as any);
      const expected = segEnd - offset + 1;
      let read = 0;

      for await (const chunk of rs) {
        if (params.signal.aborted) return;
        const buf = chunk as Uint8Array;
        read += buf.byteLength;
        yield buf;
      }

      if (read < expected) {
        if (read === 0) {
          throw new Error(
            `WALRUS_EMPTY_SEGMENT offset=${offset} end=${segEnd}`
          );
        }

        offset += read;
        segSize = Math.max(minSegmentBytes, Math.floor(segSize / 2));
        continue;
      }

      if (read > expected) {
        throw new Error(
          `WALRUS_SEGMENT_OVERRUN expected=${expected} read=${read}`
        );
      }

      offset = segEnd + 1;
      break;
    }
  }
}

async function* cachedSegmentByteStream(params: {
  blobId: string;
  start: number;
  end: number;
  initialSegmentBytes: number;
  segmentBytes: number;
  signal: AbortSignal;
}): AsyncGenerator<Uint8Array> {
  let offset = params.start;

  while (offset <= params.end) {
    if (params.signal.aborted) return;

    const preferredSegmentBytes =
      offset === params.start ? params.initialSegmentBytes : params.segmentBytes;
    const segmentEnd = Math.min(params.end, offset + preferredSegmentBytes - 1);
    const expected = segmentEnd - offset + 1;
    try {
      const cachePath = await ensureCachedStreamRange({
        blobId: params.blobId,
        start: offset,
        end: segmentEnd,
        signal: params.signal,
      });

      const rs = createCachedReadStream({
        filePath: cachePath,
        start: 0,
        end: segmentEnd - offset,
      });

      let read = 0;
      for await (const chunk of rs) {
        if (params.signal.aborted) return;
        const buf = chunk as Uint8Array;
        read += buf.byteLength;
        yield buf;
      }

      if (read !== expected) {
        throw new Error(`STREAM_CACHE_RANGE_TRUNCATED expected=${expected} read=${read}`);
      }
    } catch (err) {
      if ((err as Error)?.message !== "STREAM_CACHE_CAPACITY_EXCEEDED") {
        throw err;
      }

      for await (const chunk of walrusByteStream({
        blobId: params.blobId,
        start: offset,
        end: segmentEnd,
        maxSegmentBytes: params.segmentBytes,
        initialSegmentBytes: expected,
        signal: params.signal,
      })) {
        yield chunk;
      }
    }

    offset = segmentEnd + 1;
  }
}

export function chooseStreamReadPlan(params: {
  sizeBytes: number;
  hasRangeHeader: boolean;
}): StreamReadPlan {
  const boundedMediaSegment = Math.min(
    WalrusReadLimits.maxRangeBytes,
    WalrusReadLimits.mediaSegmentBytes
  );
  const boundedInitialSegment = Math.min(
    WalrusReadLimits.maxRangeBytes,
    Math.max(
      boundedMediaSegment,
      WalrusReadLimits.initialSegmentBytes,
      WalrusReadLimits.inlineFullObjectMaxBytes
    )
  );

  if (params.hasRangeHeader) {
    return {
      initialSegmentBytes: boundedMediaSegment,
      segmentBytes: boundedMediaSegment,
    };
  }

  if (params.sizeBytes <= WalrusReadLimits.inlineFullObjectMaxBytes) {
    const fullSize = Math.min(params.sizeBytes, WalrusReadLimits.maxRangeBytes);
    return {
      initialSegmentBytes: fullSize,
      segmentBytes: fullSize,
    };
  }

  return {
    initialSegmentBytes: boundedInitialSegment,
    segmentBytes: boundedMediaSegment,
  };
}

export async function filesRoutes(app: FastifyInstance) {
  app.get("/v1/files/:fileId/metadata", async (req, res) => {
    const readLimit = await req.server.authProvider.checkRateLimit({
      req,
      scope: "file_meta_read",
    });
    applyRateLimitHeaders(res, readLimit);
    if (!readLimit.allowed) {
      return sendApiError(res, 429, "RATE_LIMITED", "Rate limit exceeded", {
        retryable: true,
      });
    }

    const { fileId: rawFileId } = req.params as { fileId: string };
    const fileId = normalizeFileIdParam(rawFileId);
    if (!fileId) {
      req.log.warn({ fileId: rawFileId }, "Invalid file id");
      return sendApiError(res, 400, "INVALID_FILE_ID", "fileId must be a valid Sui object id");
    }

    const authzPrecheck = await req.server.authProvider.authorizeFileAccess({
      req,
      action: "metadata",
      fileId,
    });
    if (!authzPrecheck.allowed) {
      return sendFileAccessDenied(res, authzPrecheck);
    }

    let fields: any | null = null;
    let fieldsSource: FileFieldsSource | null = null;
    let postgresState: PostgresReadState = "disabled";
    const t0 = Date.now();
    try {
      const out = await getFileFieldsCached(fileId);
      fields = out.fields;
      fieldsSource = out.source;
      postgresState = out.postgresState;
    } catch (err) {
      req.log.error({ err, fileId }, "Sui read failed");
      return sendApiError(
        res,
        503,
        "SUI_UNAVAILABLE",
        "Failed to fetch file metadata from Sui",
        { retryable: true }
      );
    }

    if (!fields) {
      return sendApiError(res, 404, "FILE_NOT_FOUND", "File not found");
    }
    applyFileLookupHeaders(res, { source: fieldsSource, postgresState });

    const normalized = normalizeFileFields(fields);
    if (!normalized) {
      req.log.error({ fileId, fields }, "Invalid file metadata fields");
      return sendApiError(
        res,
        502,
        "INVALID_FILE_METADATA",
        "File metadata is invalid"
      );
    }

    if (FILE_FIELDS_DEBUG) {
      req.log.info(
        { fileId, source: fieldsSource ?? "unknown", durationMs: Date.now() - t0 },
        "metadata fields lookup"
      );
    }
    observeMetadataLookup({
      endpoint: "metadata",
      source: fieldsSource ?? "unknown",
      durationMs: Date.now() - t0,
    });

    const exposeBlobId = shouldExposeBlobId(req);
    const container = inferContainerFromMime(normalized.mimeType);
    const publicStreamUrl = getPublicStreamUrl(fileId);
    const authz = await req.server.authProvider.authorizeFileAccess({
      req,
      action: "metadata",
      fileId,
      fileOwner: normalized.ownerAddress,
    });
    if (!authz.allowed) {
      return sendFileAccessDenied(res, authz);
    }
    applyFileReadCacheHeaders(res);

    return {
      fileId,
      manifestVersion: 1,
      container,
      ...(exposeBlobId ? { blobId: normalized.blobId } : {}),
      sizeBytes: normalized.sizeBytes,
      mimeType: normalized.mimeType,
      ...(publicStreamUrl ? { streamUrl: publicStreamUrl } : {}),
      owner: normalized.owner,
      createdAt: normalized.createdAt,
      ...(normalized.walrusEndEpoch !== null ? { walrusEndEpoch: normalized.walrusEndEpoch } : {}),
    };
  });

  app.get("/v1/files/:fileId/manifest", async (req, res) => {
    const readLimit = await req.server.authProvider.checkRateLimit({
      req,
      scope: "file_meta_read",
    });
    applyRateLimitHeaders(res, readLimit);
    if (!readLimit.allowed) {
      return sendApiError(res, 429, "RATE_LIMITED", "Rate limit exceeded", {
        retryable: true,
      });
    }

    const { fileId: rawFileId } = req.params as { fileId: string };
    const fileId = normalizeFileIdParam(rawFileId);
    if (!fileId) {
      req.log.warn({ fileId: rawFileId }, "Invalid file id");
      return sendApiError(res, 400, "INVALID_FILE_ID", "fileId must be a valid Sui object id");
    }

    const authzPrecheck = await req.server.authProvider.authorizeFileAccess({
      req,
      action: "manifest",
      fileId,
    });
    if (!authzPrecheck.allowed) {
      return sendFileAccessDenied(res, authzPrecheck);
    }

    let fields: any | null = null;
    let fieldsSource: FileFieldsSource | null = null;
    let postgresState: PostgresReadState = "disabled";
    const t0 = Date.now();
    try {
      const out = await getFileFieldsCached(fileId);
      fields = out.fields;
      fieldsSource = out.source;
      postgresState = out.postgresState;
    } catch (err) {
      req.log.error({ err, fileId }, "Sui read failed");
      return sendApiError(
        res,
        503,
        "SUI_UNAVAILABLE",
        "Failed to fetch file metadata from Sui",
        { retryable: true }
      );
    }

    if (!fields) {
      return sendApiError(res, 404, "FILE_NOT_FOUND", "File not found");
    }
    applyFileLookupHeaders(res, { source: fieldsSource, postgresState });

    const normalized = normalizeFileFields(fields);
    if (!normalized) {
      req.log.error({ fileId, fields }, "Invalid file metadata fields");
      return sendApiError(
        res,
        502,
        "INVALID_FILE_METADATA",
        "File metadata is invalid"
      );
    }

    if (FILE_FIELDS_DEBUG) {
      req.log.info(
        { fileId, source: fieldsSource ?? "unknown", durationMs: Date.now() - t0 },
        "manifest fields lookup"
      );
    }
    observeMetadataLookup({
      endpoint: "manifest",
      source: fieldsSource ?? "unknown",
      durationMs: Date.now() - t0,
    });

    const exposeBlobId = shouldExposeBlobId(req);
    const container = inferContainerFromMime(normalized.mimeType);
    const publicStreamUrl = getPublicStreamUrl(fileId);
    const authz = await req.server.authProvider.authorizeFileAccess({
      req,
      action: "manifest",
      fileId,
      fileOwner: normalized.ownerAddress,
    });
    if (!authz.allowed) {
      return sendFileAccessDenied(res, authz);
    }
    applyFileReadCacheHeaders(res);

    return {
      manifestVersion: 1,
      fileId,
      createdAt: normalized.createdAt,
      sizeBytes: normalized.sizeBytes,
      mimeType: normalized.mimeType,
      container,
      ...(publicStreamUrl ? { streamUrl: publicStreamUrl } : {}),
      ...(normalized.walrusEndEpoch !== null ? { walrusEndEpoch: normalized.walrusEndEpoch } : {}),
      layout: {
        type: "walrus_single_blob",
        segments: [
          {
            index: 0,
            offsetBytes: 0,
            sizeBytes: normalized.sizeBytes,
            ...(exposeBlobId ? { blobId: normalized.blobId } : {}),
          },
        ],
      },
    };
  });

  app.route({
    method: ["GET", "HEAD"],
    url: "/v1/files/:fileId/stream",
    handler: async (req, reply) => {
      const readLimit = await req.server.authProvider.checkRateLimit({
        req,
        scope: "file_stream_read",
      });
      applyRateLimitHeaders(reply, readLimit);
      if (!readLimit.allowed) {
        return sendApiError(reply, 429, "RATE_LIMITED", "Rate limit exceeded", {
          retryable: true,
        });
      }

      const { fileId: rawFileId } = req.params as { fileId: string };
      const fileId = normalizeFileIdParam(rawFileId);
      if (!fileId) {
        req.log.warn({ fileId: rawFileId }, "Invalid file id");
        return sendApiError(
          reply,
          400,
          "INVALID_FILE_ID",
          "fileId must be a valid Sui object id"
        );
      }

      const authzPrecheck = await req.server.authProvider.authorizeFileAccess({
        req,
        action: "stream",
        fileId,
      });
      if (!authzPrecheck.allowed) {
        return sendFileAccessDenied(reply, authzPrecheck);
      }

      let fields: any | null = null;
      let fieldsSource: FileFieldsSource | null = null;
      let postgresState: PostgresReadState = "disabled";
      const t0 = Date.now();
      try {
        const out = await getFileFieldsCached(fileId);
        fields = out.fields;
        fieldsSource = out.source;
        postgresState = out.postgresState;
      } catch (err) {
        req.log.error({ err, fileId }, "Sui read failed");
        return sendApiError(
          reply,
          503,
          "SUI_UNAVAILABLE",
          "Failed to fetch file metadata from Sui",
          { retryable: true }
        );
      }

      if (!fields) {
        return sendApiError(reply, 404, "FILE_NOT_FOUND", "File not found");
      }
      applyFileLookupHeaders(reply, { source: fieldsSource, postgresState });

      const normalized = normalizeFileFields(fields);
      if (!normalized) {
        req.log.error({ fileId, fields }, "Invalid file metadata fields");
        return sendApiError(
          reply,
          502,
          "INVALID_FILE_METADATA",
          "File metadata is invalid"
        );
      }

      if (FILE_FIELDS_DEBUG) {
        req.log.info(
          { fileId, source: fieldsSource ?? "unknown", durationMs: Date.now() - t0 },
          "stream fields lookup"
        );
      }
      observeMetadataLookup({
        endpoint: "stream",
        source: fieldsSource ?? "unknown",
        durationMs: Date.now() - t0,
      });

      const authz = await req.server.authProvider.authorizeFileAccess({
        req,
        action: "stream",
        fileId,
        fileOwner: normalized.ownerAddress,
      });
      if (!authz.allowed) {
        return sendFileAccessDenied(reply, authz);
      }
      applyFileReadCacheHeaders(reply);

      const blobId = normalized.blobId;
      const sizeBytes = normalized.sizeBytes;
      const mimeType = normalized.mimeType;

      reply.header("Accept-Ranges", "bytes");
      reply.header("ETag", blobId);

      const rangeHeader = (req.headers as any)?.range as string | undefined;

      let start = 0;
      let end = sizeBytes - 1;
      let status = 200;

      if (rangeHeader) {
        const parsedOrErr = parseSingleRangeHeader({
          rangeHeader,
          sizeBytes,
        });

        if ("error" in parsedOrErr) {
          reply.header("Content-Range", `bytes */${sizeBytes}`);
          return sendApiError(
            reply,
            416,
            "INVALID_RANGE",
            "Unsupported Range header"
          );
        }

        start = parsedOrErr.range.start;
        end = parsedOrErr.range.end;
        status = 206;
      }

      const abortController = new AbortController();
      const abortUpstream = () => abortController.abort();
      const detachAbortHooks = () => {
        req.raw.removeListener("aborted", abortUpstream);
        reply.raw.removeListener("close", abortUpstream);
      };
      req.raw.once("aborted", abortUpstream);
      reply.raw.once("close", abortUpstream);

      const span = end - start + 1;
      const readPlan = chooseStreamReadPlan({
        sizeBytes: span,
        hasRangeHeader: Boolean(rangeHeader),
      });

      reply.header("Content-Type", mimeType);
      reply.header("Content-Length", String(span));

      if (status === 206) {
        reply.header("Content-Range", `bytes ${start}-${end}/${sizeBytes}`);
      }

      // HEAD requests are satisfied from metadata but should still reflect range semantics.
      if (req.method === "HEAD") {
        return reply.status(status).send();
      }

      const cachedPath =
        (await getCachedStreamPath(blobId, sizeBytes)) ??
        (status === 200
          ? await ensureCachedStreamBlob({
              blobId,
              sizeBytes,
            }).catch(() => null)
          : null);

      if (cachedPath) {
        const stat = await fs.stat(cachedPath).catch(() => null);
        if (stat?.isFile() && stat.size >= end + 1) {
          const cachedStream = createCachedReadStream({
            filePath: cachedPath,
            start,
            end,
          });
          return reply.status(status).send(cachedStream);
        }
      }

      const streamStartMs = Date.now();
      let firstByteObserved = false;
      let totalStreamedBytes = 0;
      const stream = Readable.from(
        (async function* () {
          for await (const chunk of cachedSegmentByteStream({
            blobId,
            start,
            end,
            initialSegmentBytes: readPlan.initialSegmentBytes,
            segmentBytes: readPlan.segmentBytes,
            signal: abortController.signal,
          })) {
            if (!firstByteObserved && chunk.byteLength > 0) {
              firstByteObserved = true;
              observeStreamTtfb({
                range: rangeHeader ? "partial" : "full",
                durationMs: Date.now() - streamStartMs,
              });
            }
            totalStreamedBytes += chunk.byteLength;
            yield chunk;
          }

          if (totalStreamedBytes !== span) {
            throw new Error(`STREAM_TRUNCATED expected=${span} read=${totalStreamedBytes}`);
          }
        })()
      );
      stream.once("end", detachAbortHooks);
      stream.once("close", detachAbortHooks);
      stream.once("error", detachAbortHooks);
      stream.once("error", (err: any) => {
        if (err?.message === "FILE_CONTENT_NOT_FOUND") {
          err.message = "FILE_BLOB_UNAVAILABLE";
        }
        req.log.warn(
          {
            err,
            fileId,
            blobId,
            range: rangeHeader ?? null,
            start,
            end,
            expectedBytes: span,
            streamedBytes: totalStreamedBytes,
            reason: classifyStreamErrorReason(String(err?.message ?? "")),
          },
          "Stream failed"
        );
        recordStreamReadError(classifyStreamErrorReason(String(err?.message ?? "")));
      });

      return reply.status(status).send(stream);
    },
  });
}
