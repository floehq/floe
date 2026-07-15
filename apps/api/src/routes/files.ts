import { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import { Readable } from "node:stream";

import {
  findFileByBlobId,
  findFileByChecksum,
  getBlobObjectIdByBlobId,
  getIndexedFile,
  upsertIndexedFile,
} from "../db/files.repository.js";
import { checkWalrusBlobExists, fetchWalrusBlob } from "../services/walrus/read.js";
import { renewWalrusBlob } from "../services/walrus/renew.js";
import { getCurrentWalrusEpoch } from "../services/walrus/epoch.js";
import { renewFileMetadata } from "../sui/file.metadata.js";
import { WalrusReadLimits } from "../config/walrus.config.js";
import { sendApiError } from "../utils/apiError.js";
import { applyRateLimitHeaders } from "../services/auth/auth.headers.js";
import {
  applyFileLookupHeaders,
  applyFileReadCacheHeaders,
  clearFileFieldsCache,
  getFileFieldsCached,
  getPublicStreamUrl,
  isFileFieldsDebugEnabled,
  LruMap,
  normalizeFileFields,
  normalizeFileIdParam,
  type CachedFileFieldsResult,
  type FileFieldsSource,
  type PostgresReadState,
} from "../services/files/file.read-model.js";
import {
  observeMetadataLookup,
  observeStreamTtfb,
  recordStreamReadError,
} from "../services/metrics/runtime.metrics.js";
import { recordStreamSli } from "../services/reliability/sli.js";
import {
  emitAuditEvent,
  emitInfrastructureEvent,
  requestEventContext,
} from "../services/events/infrastructure.events.js";
import {
  createCachedReadStream,
  getCachedStreamPath,
  StreamCacheCapacityError,
  teeCachedStreamBlob,
  teeCachedStreamRange,
} from "../services/stream/stream.cache.js";

// In-memory cache for positive Walrus blob existence results.
// Keyed by blobId, stores expiry timestamp. Negative results are NOT cached.
// TTL is 60 seconds to avoid re-checking per-request during playback bursts.
const blobExistenceCacheTTL = 60_000;
const BLOB_EXISTENCE_CACHE_MAX_ENTRIES = 100_000;
const blobExistenceCache = new LruMap<number>(BLOB_EXISTENCE_CACHE_MAX_ENTRIES);

/** In-flight dedup map: prevents concurrent requests for the same cold blobId
 *  from issuing duplicate checkWalrusBlobExists upstream calls. */
const inFlightExistenceChecks = new Map<string, Promise<{ exists: boolean }>>();

/** Remove all expired entries from blobExistenceCache. */
function pruneBlobExistenceCache() {
  const now = Date.now();
  for (const [blobId, expiry] of blobExistenceCache) {
    if (expiry <= now) {
      blobExistenceCache.delete(blobId);
    }
  }
}

/**
 * Escape a string for safe embedding in HTML text content or attributes.
 * Replaces &, <, >, ", and ' with their corresponding HTML entities.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** @internal test-only hook */
export function getBlobExistenceCacheForTests() {
  return blobExistenceCache;
}

/**
 * Normalize a client-provided ETag (possibly quoted or weak) and compare
 * it against the server's raw blobId ETag value.
 */
function matchesETag(clientETag: string | undefined, serverBlobId: string): boolean {
  if (!clientETag) return false;
  // Strip optional weakness prefix W/ and surrounding quotes
  const clean = clientETag.replace(/^(W\/)?"/, "").replace(/"$/, "");
  return clean === serverBlobId;
}

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
    authz.message ?? "File access denied",
  );
}

async function resolveFileFields(id: string): Promise<CachedFileFieldsResult> {
  const fileId = normalizeFileIdParam(id);
  let out: CachedFileFieldsResult = { fields: null, source: null, postgresState: "disabled" };

  if (fileId) {
    try {
      out = await getFileFieldsCached(fileId);
    } catch {
      // Fallback
    }
  }

  if (!out.fields) {
    const indexed = await findFileByBlobId(id).catch(() => null);
    if (indexed) {
      out = {
        fields: {
          blob_id: indexed.blobId,
          blob_object_id: indexed.blobObjectId,
          checksum: indexed.checksum,
          size_bytes: indexed.sizeBytes,
          mime: indexed.mimeType,
          created_at: indexed.createdAtMs,
          owner: indexed.ownerAddress,
          walrus_end_epoch: indexed.walrusEndEpoch,
        },
        source: "postgres",
        postgresState: "healthy",
      };
    }
  }

  return out;
}

export type StreamReadPlan = {
  initialSegmentBytes: number;
  segmentBytes: number;
};

type ParsedRange = {
  start: number;
  end: number;
};

function parseSingleRangeHeader(params: {
  rangeHeader: string;
  sizeBytes: number;
}): { range: ParsedRange; kind: "bounded" | "open" | "suffix" } | { error: "INVALID_RANGE" } {
  const { rangeHeader, sizeBytes } = params;

  const m = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!m) return { error: "INVALID_RANGE" };

  const rawStart = m[1];
  const rawEnd = m[2];

  if (rawStart === "" && rawEnd !== "") {
    const suffixLen = Number(rawEnd);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return { error: "INVALID_RANGE" };

    const end = sizeBytes - 1;
    const start = Math.max(0, sizeBytes - suffixLen);
    return { range: { start, end }, kind: "suffix" };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start < 0) return { error: "INVALID_RANGE" };

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

async function* walrusByteStream(params: {
  blobId: string;
  start: number;
  end: number;
  maxSegmentBytes: number;
  initialSegmentBytes?: number;
  signal: AbortSignal;
  requestId?: string;
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
      `WALRUS_RANGE_FAILED status=${upstreamStatus}${snippet ? ` body=${snippet}` : ""}`.trim(),
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
          requestId: params.requestId,
        }));
      } catch (err) {
        if (params.signal.aborted || (err as Error)?.name === "AbortError") {
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

      const isFullObjectAttempt = params.start === 0 && offset === 0 && segEnd === params.end;

      if (upstream.status === 200 && isFullObjectAttempt) {
        // Full-object 200 response is valid even without 206
      } else if (upstream.status !== 206) {
        const text = await upstream.text().catch(() => "");
        throw makeWalrusReadError(upstream.status, text);
      }

      const body = upstream.body;
      if (!body) {
        throw new Error(
          `WALRUS_MISSING_BODY status=${upstream.status} offset=${offset} end=${segEnd}`,
        );
      }

      const rs = Readable.fromWeb(body as ReadableStream<Uint8Array>);
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
          throw new Error(`WALRUS_EMPTY_SEGMENT offset=${offset} end=${segEnd}`);
        }

        offset += read;
        segSize = Math.max(minSegmentBytes, Math.floor(segSize / 2));
        continue;
      }

      if (read > expected) {
        throw new Error(`WALRUS_SEGMENT_OVERRUN expected=${expected} read=${read}`);
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
  requestId?: string;
  log?: { warn: (...args: any[]) => void };
}): AsyncGenerator<Uint8Array> {
  let offset = params.start;

  while (offset <= params.end) {
    if (params.signal.aborted) return;

    const preferredSegmentBytes =
      offset === params.start ? params.initialSegmentBytes : params.segmentBytes;
    const segmentEnd = Math.min(params.end, offset + preferredSegmentBytes - 1);
    const expected = segmentEnd - offset + 1;
    try {
      const fillResult = await teeCachedStreamRange({
        blobId: params.blobId,
        start: offset,
        end: segmentEnd,
        signal: params.signal,
        log: params.log,
      });

      if (fillResult.kind === "tee") {
        // Stream bytes directly from the tee stream while they're being cached.
        let read = 0;
        for await (const chunk of fillResult.stream) {
          if (params.signal.aborted) return;
          const buf = chunk as Uint8Array;
          read += buf.byteLength;
          yield buf;
        }
        if (read !== expected) {
          throw new Error(`STREAM_CACHE_RANGE_TRUNCATED expected=${expected} read=${read}`);
        }
      } else {
        const rs = createCachedReadStream({
          filePath: fillResult.cachePath,
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
      }
    } catch (err) {
      if (!(err instanceof StreamCacheCapacityError)) {
        throw err;
      }

      for await (const chunk of walrusByteStream({
        blobId: params.blobId,
        start: offset,
        end: segmentEnd,
        maxSegmentBytes: params.segmentBytes,
        initialSegmentBytes: expected,
        signal: params.signal,
        requestId: params.requestId,
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
    WalrusReadLimits.mediaSegmentBytes,
  );
  const boundedInitialSegment = Math.min(
    WalrusReadLimits.maxRangeBytes,
    Math.max(
      boundedMediaSegment,
      WalrusReadLimits.initialSegmentBytes,
      WalrusReadLimits.inlineFullObjectMaxBytes,
    ),
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
  app.get(
    "/v1/files/:fileId/metadata",
    {
      schema: {
        tags: ["Files"],
        summary: "Get file metadata",
        description:
          "Fetch metadata about a stored file, including size, MIME type, and storage details.",
        params: {
          type: "object",
          required: ["fileId"],
          properties: {
            fileId: {
              type: "string",
              description: "Sui object ID, blob ID, or file UUID",
            },
          },
        },
      },
    },
    async (req, res) => {
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
        req.childLogger.warn({ fileId: rawFileId }, "Invalid file id");
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

      const t0 = Date.now();
      let fields: any | null;
      let fieldsSource: FileFieldsSource | null;
      let postgresState: PostgresReadState;
      try {
        const out = await getFileFieldsCached(fileId);
        fields = out.fields;
        fieldsSource = out.source;
        postgresState = out.postgresState;
      } catch (_err) {
        req.childLogger.error({ err: _err, fileId }, "Sui read failed");
        return sendApiError(res, 503, "SUI_UNAVAILABLE", "Failed to fetch file metadata from Sui", {
          retryable: true,
        });
      }

      if (!fields) {
        return sendApiError(res, 404, "FILE_NOT_FOUND", "File not found");
      }
      applyFileLookupHeaders(res, { source: fieldsSource, postgresState });

      const normalized = normalizeFileFields(fields);
      if (!normalized) {
        req.childLogger.error({ fileId, fields }, "Invalid file metadata fields");
        return sendApiError(res, 502, "INVALID_FILE_METADATA", "File metadata is invalid");
      }

      if (isFileFieldsDebugEnabled()) {
        req.childLogger.info(
          { fileId, source: fieldsSource ?? "unknown", durationMs: Date.now() - t0 },
          "metadata fields lookup",
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

      // Estimate expiry status
      let expiryStatus: any = null;
      if (normalized.walrusEndEpoch !== null) {
        try {
          const currentEpoch = await getCurrentWalrusEpoch();
          if (currentEpoch !== null) {
            const epochsRemaining = Math.max(0, normalized.walrusEndEpoch - currentEpoch);
            // Walrus testnet epochs are currently 1 day.
            const daysRemaining = epochsRemaining;
            expiryStatus = {
              currentEpoch,
              endEpoch: normalized.walrusEndEpoch,
              epochsRemaining,
              estimatedDaysRemaining: daysRemaining,
              isExpired: epochsRemaining === 0,
            };
          }
        } catch (err) {
          req.childLogger.warn({ err }, "Failed to fetch Walrus epoch for expiry estimation");
        }
      }

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
        ...(exposeBlobId
          ? { blobId: normalized.blobId, blobObjectId: normalized.blobObjectId }
          : {}),
        sizeBytes: normalized.sizeBytes,
        mimeType: normalized.mimeType,
        ...(publicStreamUrl ? { streamUrl: publicStreamUrl } : {}),
        owner: normalized.owner,
        createdAt: normalized.createdAt,
        ...(normalized.walrusEndEpoch !== null
          ? { walrusEndEpoch: normalized.walrusEndEpoch }
          : {}),
        ...(expiryStatus ? { expiryStatus } : {}),
      };
    },
  );

  app.post(
    "/v1/files/:fileId/renew",
    {
      bodyLimit: 64 * 1024,
      schema: {
        tags: ["Files"],
        summary: "Renew file storage",
        description:
          "Extend the Walrus storage duration for a stored file. Requires the file owner's authorization.",
        params: {
          type: "object",
          required: ["fileId"],
          properties: {
            fileId: {
              type: "string",
              description: "Sui object ID of the file",
            },
          },
        },
        body: {
          type: "object",
          required: ["epochs"],
          properties: {
            epochs: {
              type: "integer",
              description: "Number of Walrus epochs to extend by",
              minimum: 1,
              maximum: 53,
            },
          },
        },
      },
    },
    async (req, res) => {
      const { fileId: rawFileId } = req.params as { fileId: string };
      const { epochs } = req.body as { epochs: number };

      const fileId = normalizeFileIdParam(rawFileId);
      if (!fileId) {
        return sendApiError(res, 400, "INVALID_FILE_ID", "fileId must be a valid Sui object id");
      }

      if (!Number.isInteger(epochs) || epochs <= 0 || epochs > 53) {
        return sendApiError(
          res,
          400,
          "INVALID_EPOCHS",
          "epochs must be an integer between 1 and 53",
        );
      }

      const authz = await req.server.authProvider.authorizeFileAccess({
        req,
        action: "renew",
        fileId,
      });
      if (!authz.allowed) {
        return sendFileAccessDenied(res, authz);
      }

      const { fields } = await getFileFieldsCached(fileId);
      if (!fields) {
        return sendApiError(res, 404, "FILE_NOT_FOUND", "File not found");
      }

      const normalized = normalizeFileFields(fields);
      if (!normalized) {
        return sendApiError(res, 502, "INVALID_FILE_METADATA", "File metadata is invalid");
      }

      // Walrus renewal requires a Blob object ID.
      // Older Floe uploads might not have this stored.
      // If missing, we try to update it if the user provides it or we can find it.
      let blobObjectId = normalized.blobObjectId;
      if (!blobObjectId) {
        // For beta, we allow the user to provide it in the body if missing from metadata.
        const b = req.body as Record<string, unknown>;
        blobObjectId =
          (b.blobObjectId as string | undefined) ??
          (b.blob_object_id as string | undefined) ??
          null;
      }
      if (!blobObjectId) {
        const indexed = await getIndexedFile(fileId).catch(() => null);
        blobObjectId = indexed?.blobObjectId ?? null;
      }
      if (!blobObjectId && normalized.blobId) {
        const mapped = await getBlobObjectIdByBlobId(normalized.blobId).catch(() => null);
        blobObjectId = mapped ?? null;
      }
      if (!blobObjectId && normalized.blobId) {
        const byBlob = await findFileByBlobId(normalized.blobId).catch(() => null);
        blobObjectId = byBlob?.blobObjectId ?? null;
      }
      if (!blobObjectId && normalized.checksum) {
        const byChecksum = await findFileByChecksum(normalized.checksum).catch(() => null);
        blobObjectId = byChecksum?.blobObjectId ?? null;
      }

      // Capture before-state for audit trail
      const auditBefore = {
        fileId,
        blobObjectId: normalized.blobObjectId ?? null,
        walrusEndEpoch: normalized.walrusEndEpoch,
      };

      if (!blobObjectId) {
        emitAuditEvent(req.childLogger, {
          action: "file_renew_missing_blob_object_id",
          resource: `file:${fileId}`,
          actor: requestEventContext(req).actor,
          requestId: req.id,
          before: auditBefore,
          after: null,
          metadata: { error: "Missing blob object ID", epochs },
        });
        return sendApiError(
          res,
          400,
          "MISSING_BLOB_OBJECT_ID",
          "Walrus renewal requires a blob object ID which is missing from this file's metadata.",
        );
      }

      try {
        // 1. Extend Walrus storage
        const walrusResult = await renewWalrusBlob({
          blobObjectId,
          epochs,
        });

        // 2. Update Floe metadata on Sui
        try {
          await renewFileMetadata({
            fileId,
            blobObjectId: !normalized.blobObjectId ? blobObjectId : undefined,
            walrusEndEpoch: walrusResult.endEpoch,
          });
        } catch (metadataErr) {
          const metadataMessage = (metadataErr as Error)?.message ?? "unknown";
          if (
            metadataMessage.includes("SUI_RENEW_SUBMIT_FAILED") &&
            metadataMessage.includes("notExists")
          ) {
            req.childLogger.warn(
              { err: metadataErr, fileId },
              "Skipping Sui renewal metadata update because the file object is missing",
            );
          } else {
            throw metadataErr;
          }
        }

        // 3. Update local cache
        clearFileFieldsCache(fileId);
        await upsertIndexedFile({
          ...normalized,
          fileId,
          blobObjectId,
          checksum: normalized.checksum,
          walrusEndEpoch: walrusResult.endEpoch,
          createdAtMs: normalized.createdAt,
        }).catch(() => {});

        // Emit audit event on successful renewal
        const auditAfter = {
          fileId,
          blobObjectId: normalized.blobObjectId ?? blobObjectId,
          walrusEndEpoch: walrusResult.endEpoch,
          endEpochDelta:
            normalized.walrusEndEpoch !== null
              ? walrusResult.endEpoch - normalized.walrusEndEpoch
              : epochs,
        };
        emitAuditEvent(req.childLogger, {
          action: "file_renew",
          resource: `file:${fileId}`,
          actor: requestEventContext(req).actor,
          requestId: req.id,
          before: auditBefore,
          after: auditAfter,
          metadata: { epochs },
        });

        return {
          success: true,
          fileId,
          walrusEndEpoch: walrusResult.endEpoch,
        };
      } catch (err) {
        req.childLogger.error({ err, fileId }, "Renewal failed");
        emitAuditEvent(req.childLogger, {
          action: "file_renew_failed",
          resource: `file:${fileId}`,
          actor: requestEventContext(req).actor,
          requestId: req.id,
          before: auditBefore,
          after: null,
          metadata: { error: (err as Error)?.message ?? "unknown", epochs },
        });
        return sendApiError(
          res,
          500,
          "RENEWAL_FAILED",
          `Failed to renew file: ${(err as Error)?.message ?? "unknown"}`,
        );
      }
    },
  );

  app.get(
    "/v1/files/:fileId/manifest",
    {
      schema: {
        tags: ["Files"],
        summary: "Get file manifest",
        description:
          "Get the storage manifest for a file, describing the blob layout for direct Walrus access.",
        params: {
          type: "object",
          required: ["fileId"],
          properties: {
            fileId: { type: "string", description: "Sui object ID of the file" },
          },
        },
      },
    },
    async (req, res) => {
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
        req.childLogger.warn({ fileId: rawFileId }, "Invalid file id");
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

      const t0 = Date.now();
      let fields: any | null;
      let fieldsSource: FileFieldsSource | null;
      let postgresState: PostgresReadState;
      try {
        const out = await getFileFieldsCached(fileId);
        fields = out.fields;
        fieldsSource = out.source;
        postgresState = out.postgresState;
      } catch (_err) {
        req.childLogger.error({ err: _err, fileId }, "Sui read failed");
        return sendApiError(res, 503, "SUI_UNAVAILABLE", "Failed to fetch file metadata from Sui", {
          retryable: true,
        });
      }

      if (!fields) {
        return sendApiError(res, 404, "FILE_NOT_FOUND", "File not found");
      }
      applyFileLookupHeaders(res, { source: fieldsSource, postgresState });

      const normalized = normalizeFileFields(fields);
      if (!normalized) {
        req.childLogger.error({ fileId, fields }, "Invalid file metadata fields");
        return sendApiError(res, 502, "INVALID_FILE_METADATA", "File metadata is invalid");
      }

      if (isFileFieldsDebugEnabled()) {
        req.childLogger.info(
          { fileId, source: fieldsSource ?? "unknown", durationMs: Date.now() - t0 },
          "manifest fields lookup",
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
        ...(normalized.walrusEndEpoch !== null
          ? { walrusEndEpoch: normalized.walrusEndEpoch }
          : {}),
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
    },
  );

  app.route({
    method: ["GET", "HEAD"],
    url: "/v1/files/:fileId/stream",
    schema: {
      tags: ["Files"],
      summary: "Stream file content",
      description:
        "Stream a stored file's content. Supports HTTP range requests (partial content). Returns the raw file bytes with appropriate Content-Type.",
      params: {
        type: "object",
        required: ["fileId"],
        properties: {
          fileId: {
            type: "string",
            description: "Sui object ID, blob ID, or file UUID",
          },
        },
      },
      querystring: {
        type: "object",
        properties: {
          skipBlobCheck: {
            type: "string",
            description: "Bypass Walrus aggregator HEAD check (requires admin:uploads scope)",
          },
        },
      },
      headers: {
        type: "object",
        properties: {
          range: { type: "string", description: "HTTP Range header for partial content" },
          "if-none-match": {
            type: "string",
            description: "Conditional request ETag",
          },
          "if-range": {
            type: "string",
            description: "Conditional range request ETag",
          },
        },
      },
    },
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
      const normalizedFileId = normalizeFileIdParam(rawFileId);
      const indexedByBlob = normalizedFileId
        ? null
        : await findFileByBlobId(rawFileId).catch(() => null);
      const fileId = normalizedFileId ?? indexedByBlob?.fileId ?? null;
      if (!fileId) {
        req.childLogger.warn({ fileId: rawFileId }, "Invalid file id");
        return sendApiError(
          reply,
          400,
          "INVALID_FILE_ID",
          "fileId must be a valid Sui object id or blob id",
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

      const fieldsResult = await resolveFileFields(rawFileId);
      const fields = fieldsResult.fields;
      const fieldsSource = fieldsResult.source;
      const postgresState: PostgresReadState = fieldsResult.postgresState;
      const t0 = Date.now();

      if (!fields) {
        return sendApiError(reply, 404, "FILE_NOT_FOUND", "File not found");
      }
      applyFileLookupHeaders(reply, { source: fieldsSource, postgresState });

      const normalized = normalizeFileFields(fields);
      if (!normalized) {
        req.childLogger.error({ fileId, fields }, "Invalid file metadata fields");
        return sendApiError(reply, 502, "INVALID_FILE_METADATA", "File metadata is invalid");
      }

      if (isFileFieldsDebugEnabled()) {
        req.childLogger.info(
          { fileId, source: fieldsSource ?? "unknown", durationMs: Date.now() - t0 },
          "stream fields lookup",
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
      const eventContext = requestEventContext(req);

      reply.header("Accept-Ranges", "bytes");
      reply.header("ETag", blobId);

      const rangeHeader = req.headers.range as string | undefined;
      const ifNoneMatch = req.headers["if-none-match"] as string | undefined;
      const ifRange = req.headers["if-range"] as string | undefined;

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
          return sendApiError(reply, 416, "INVALID_RANGE", "Unsupported Range header");
        }

        start = parsedOrErr.range.start;
        end = parsedOrErr.range.end;
        status = 206;
      }

      // ============================================================
      // Conditional request handling (RFC 7232, RFC 7233)
      // Ordered so If-Range (resume semantics) takes priority over
      // If-None-Match (cache revalidation).
      // ============================================================

      // 1. If-Range: client resuming a partial download.
      //    - If the ETag matches, proceed with normal range handling (206).
      //    - If it doesn't match, ignore Range and serve full 200.
      if (ifRange && rangeHeader) {
        if (matchesETag(ifRange, blobId)) {
          // If-Range matches → proceed with 206 as already parsed.
        } else {
          // If-Range stale → ignore Range, serve full entity.
          start = 0;
          end = sizeBytes - 1;
          status = 200;
        }
      } else if (ifNoneMatch && matchesETag(ifNoneMatch, blobId)) {
        // 2. If-None-Match: cache revalidation. Matching ETag → 304.
        // applyFileReadCacheHeaders was already called above, setting
        // the correct Cache-Control per public/private mode.
        return reply.status(304).send();
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
      // Cache-Control was already set by applyFileReadCacheHeaders above.
      if (req.method === "HEAD") {
        return reply.status(status).send();
      }

      // Trusted clients can pass ?skipBlobCheck=1 to bypass the Walrus
      // aggregator HEAD check and go straight to streaming. The 503 blob
      // guard is useful for freshly-published blobs but adds latency.
      // Only allowed when the request identity has admin:uploads scope.
      const q = req.query as Record<string, string | undefined>;
      const rawSkipBlobCheck: boolean = q.skipBlobCheck === "1" || q.skip_blob_check === "1";
      const hasAdminScopes = req.authContext?.scopes?.includes("admin:uploads") ?? false;
      const skipBlobCheck: boolean = rawSkipBlobCheck && hasAdminScopes;
      if (rawSkipBlobCheck && !hasAdminScopes) {
        req.childLogger.warn(
          { fileId },
          "skipBlobCheck requested but denied — caller lacks admin:uploads scope",
        );
      }

      // Check local disk cache first. If we already have the blob cached,
      // we can skip the Walrus existence check entirely — the file on disk
      // is proof the blob exists.
      const cachedPath = await getCachedStreamPath(blobId, sizeBytes);

      let blobExists: { exists: boolean } | null = skipBlobCheck ? { exists: true } : null;

      if (!cachedPath) {
        // Check the short-TTL positive-result cache before hitting Walrus.
        const cachedExpiry = blobExistenceCache.get(blobId);
        if (cachedExpiry !== undefined && cachedExpiry > Date.now()) {
          blobExists = { exists: true };
        } else {
          // Clean up expired entry if present
          if (cachedExpiry !== undefined) {
            blobExistenceCache.delete(blobId);
          }

          // Dedup concurrent existence checks for the same cold blobId
          let pending = inFlightExistenceChecks.get(blobId);
          if (!pending) {
            pending = checkWalrusBlobExists({ blobId, requestId: req.id }).catch(() => ({
              exists: true,
            }));
            inFlightExistenceChecks.set(blobId, pending);
          }
          blobExists = await pending;
          inFlightExistenceChecks.delete(blobId);

          if (blobExists.exists) {
            // Cache positive results for 60s to avoid re-checking during
            // playback bursts. Negative results are NOT cached.
            // LruMap handles LRU eviction automatically on set().
            blobExistenceCache.set(blobId, Date.now() + blobExistenceCacheTTL);

            // Opportunistic prune of expired entries at > 80% capacity
            if (blobExistenceCache.size > BLOB_EXISTENCE_CACHE_MAX_ENTRIES * 0.8) {
              pruneBlobExistenceCache();
            }
          }
        }

        if (!blobExists.exists) {
          const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Blob Not Available</title></head>
<body style="font-family:sans-serif;padding:2rem;max-width:600px;margin:auto;text-align:center">
  <h1>503 — Blob Not Yet Available</h1>
  <p>The blob <code>${escapeHtml(blobId)}</code> has been submitted to the Walrus network but has not
  been fully indexed by storage aggregators yet. This is usually temporary.</p>
  <p>Try refreshing the page in a minute.</p>
</body>
</html>`;
          return reply.status(503).type("text/html").send(html);
        }
      }

      // Use cached file if available; otherwise try to tee-cache + stream.
      if (cachedPath) {
        const stat = await fs.stat(cachedPath).catch(() => null);
        if (stat?.isFile() && stat.size >= end + 1) {
          emitInfrastructureEvent(req.childLogger, {
            event: "stream_started",
            requestId: eventContext.requestId,
            actor: eventContext.actor,
            fileId,
            blobId,
            outcome: "success",
            statusCode: status,
            bytes: span,
            metadata: {
              method: req.method,
              cacheHit: true,
              range: rangeHeader ?? null,
              start,
              end,
            },
          });
          const cachedStream = createCachedReadStream({
            filePath: cachedPath,
            start,
            end,
          });
          cachedStream.once("end", () => {
            emitInfrastructureEvent(req.childLogger, {
              event: "stream_completed",
              requestId: eventContext.requestId,
              actor: eventContext.actor,
              fileId,
              blobId,
              outcome: "success",
              statusCode: status,
              bytes: span,
              metadata: {
                range: rangeHeader ?? null,
                start,
                end,
                cacheHit: true,
              },
            });
          });
          cachedStream.once("error", (err: Error) => {
            emitInfrastructureEvent(req.childLogger, {
              event: "stream_failed",
              requestId: eventContext.requestId,
              actor: eventContext.actor,
              fileId,
              blobId,
              outcome: "failure",
              statusCode: (err as { statusCode?: number })?.statusCode,
              metadata: {
                range: rangeHeader ?? null,
                start,
                end,
                cacheHit: true,
                reason: classifyStreamErrorReason(String(err?.message ?? "")),
              },
            });
          });
          return reply.status(status).send(cachedStream);
        }
      }

      // Full-file tee cache: for status === 200 and small files, fetch and
      // stream the entire blob at once (tee writes to disk concurrently).
      if (status === 200) {
        const teeResult = await teeCachedStreamBlob({
          blobId,
          sizeBytes,
          log: req.childLogger,
        }).catch(() => null);
        if (teeResult) {
          if (teeResult.kind === "tee") {
            return reply.status(status).send(teeResult.stream);
          }
          // cache_hit: serve from the now-cached file
          const stat = await fs.stat(teeResult.cachePath).catch(() => null);
          if (stat?.isFile() && stat.size >= end + 1) {
            return reply.status(status).send(
              createCachedReadStream({
                filePath: teeResult.cachePath,
                start,
                end,
              }),
            );
          }
        }
      }

      const streamStartMs = Date.now();
      let firstByteObserved = false;
      let totalStreamedBytes = 0;
      emitInfrastructureEvent(req.childLogger, {
        event: "stream_started",
        requestId: eventContext.requestId,
        actor: eventContext.actor,
        fileId,
        blobId,
        outcome: "success",
        statusCode: status,
        bytes: span,
        metadata: {
          method: req.method,
          cacheHit: false,
          range: rangeHeader ?? null,
          start,
          end,
        },
      });
      const stream = Readable.from(
        (async function* () {
          for await (const chunk of cachedSegmentByteStream({
            blobId,
            start,
            end,
            initialSegmentBytes: readPlan.initialSegmentBytes,
            segmentBytes: readPlan.segmentBytes,
            signal: abortController.signal,
            requestId: req.id,
            log: req.childLogger,
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
        })(),
      );
      stream.once("end", () => {
        emitInfrastructureEvent(req.childLogger, {
          event: "stream_completed",
          requestId: eventContext.requestId,
          actor: eventContext.actor,
          fileId,
          blobId,
          outcome: "success",
          statusCode: status,
          bytes: totalStreamedBytes,
          durationMs: Date.now() - streamStartMs,
          metadata: {
            range: rangeHeader ?? null,
            start,
            end,
          },
        });
      });
      stream.once("end", detachAbortHooks);
      stream.once("close", detachAbortHooks);
      stream.once("error", detachAbortHooks);
      stream.once("error", (err: Error) => {
        if (err?.message === "FILE_CONTENT_NOT_FOUND") {
          err.message = "FILE_BLOB_UNAVAILABLE";
        }
        req.childLogger.warn(
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
          "Stream failed",
        );
        recordStreamReadError(classifyStreamErrorReason(String(err?.message ?? "")));
        emitInfrastructureEvent(req.childLogger, {
          event: "stream_failed",
          requestId: eventContext.requestId,
          actor: eventContext.actor,
          fileId,
          blobId,
          outcome: "failure",
          statusCode: (err as { statusCode?: number })?.statusCode,
          bytes: totalStreamedBytes,
          durationMs: Date.now() - streamStartMs,
          metadata: {
            range: rangeHeader ?? null,
            start,
            end,
            expectedBytes: span,
            reason: classifyStreamErrorReason(String(err?.message ?? "")),
          },
        });
      });

      // Record stream SLI on completion or error
      stream.once("end", () => {
        recordStreamSli(true, Date.now() - streamStartMs);
      });
      stream.once("error", () => {
        recordStreamSli(false, Date.now() - streamStartMs);
      });

      return reply.status(status).send(stream);
    },
  });
}
