import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";

import { UploadConfig } from "../../config/uploads.config.js";
import { fetchWalrusBlob } from "../walrus/read.js";

/**
 * Error thrown when the stream cache cannot accommodate a new cache fill
 * because the total cache size would exceed STREAM_CACHE_MAX_BYTES or
 * available disk space is below STREAM_CACHE_MIN_FREE_DISK_BYTES.
 *
 * Use `instanceof StreamCacheCapacityError` for type-safe error handling
 * instead of fragile string matching on error.message.
 */
export class StreamCacheCapacityError extends Error {
  readonly expectedBytes: number;

  constructor(expectedBytes: number) {
    super("STREAM_CACHE_CAPACITY_EXCEEDED");
    this.name = "StreamCacheCapacityError";
    this.expectedBytes = expectedBytes;
  }
}
import {
  STREAM_CACHE_FILL_CONCURRENCY,
  STREAM_CACHE_MAX_BYTES,
  STREAM_CACHE_MIN_FREE_DISK_BYTES,
  STREAM_CACHE_TTL_MS,
  shouldCacheFullObject as shouldCacheFullObjectPolicy,
} from "./stream.cache.policy.js";
import {
  observeStreamCacheFill,
  recordStreamCacheAccess,
  recordStreamCacheEviction,
  setStreamCacheMetrics,
} from "../metrics/runtime.metrics.js";

export const shouldCacheFullObject = shouldCacheFullObjectPolicy;

const noop = () => {};

const STREAM_CACHE_DIR = path.join(UploadConfig.tmpDir, "_stream_cache");
const STREAM_CACHE_FULL_DIR = path.join(STREAM_CACHE_DIR, "full");
const STREAM_CACHE_RANGE_DIR = path.join(STREAM_CACHE_DIR, "ranges");

export type StreamFillResult =
  { kind: "cache_hit"; cachePath: string } | { kind: "tee"; cachePath: string; stream: Readable };

interface InFlightTeeEntry {
  cachePath: string;
  consumerStreams: Set<PassThrough>;
  writeDone: Promise<void>;
  writeError: Error | null;
}

const inFlightTeeCacheFill = new Map<string, InFlightTeeEntry>();
const inFlightTeeRangeFill = new Map<string, InFlightTeeEntry>();
/**
 * In-memory cache index: maps file path -> { size, mtimeMs }.
 * This avoids recursive directory scans on every prune/reservation call.
 * Rebuilt on initStreamCache() and updated on every cache write/delete.
 */
const cacheIndex = new Map<string, { size: number; mtimeMs: number }>();

let reservedCacheBytes = 0;
let activeCacheFills = 0;
const pendingFillWaiters: Array<() => void> = [];
let cacheReservationLock: Promise<void> = Promise.resolve();

/** Running total of all cached bytes — avoids O(n) scans on every fill. */
let cachedBytesTotal = 0;

function updateCacheIndexInsert(filePath: string, size: number, mtimeMs: number) {
  cacheIndex.set(filePath, { size, mtimeMs });
  cachedBytesTotal += size;
}

function updateCacheIndexDelete(filePath: string) {
  const entry = cacheIndex.get(filePath);
  if (entry) {
    cachedBytesTotal = Math.max(0, cachedBytesTotal - entry.size);
  }
  cacheIndex.delete(filePath);
}

async function rebuildCacheIndex() {
  cacheIndex.clear();
  cachedBytesTotal = 0;
  const scanDir = async (dir: string) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await scanDir(filePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fsp.stat(filePath).catch(() => null);
      if (!stat) continue;
      cacheIndex.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs });
      cachedBytesTotal += stat.size;
    }
  };
  await scanDir(STREAM_CACHE_DIR);
}

function sanitizeBlobId(blobId: string): string {
  return blobId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function streamCachePath(blobId: string): string {
  return path.join(STREAM_CACHE_FULL_DIR, `${sanitizeBlobId(blobId)}.blob`);
}

function streamRangeCacheKey(params: { blobId: string; start: number; end: number }): string {
  return `${params.blobId}:${params.start}:${params.end}`;
}

function streamRangeCachePath(params: { blobId: string; start: number; end: number }): string {
  return path.join(
    STREAM_CACHE_RANGE_DIR,
    sanitizeBlobId(params.blobId),
    `${params.start}-${params.end}.part`,
  );
}

async function ensureStreamCacheDir() {
  await fsp.mkdir(STREAM_CACHE_FULL_DIR, { recursive: true });
  await fsp.mkdir(STREAM_CACHE_RANGE_DIR, { recursive: true });
}

/**
 * Returns cached file entries, sorted by mtimeMs ascending (oldest first).
 * Uses the in-memory cacheIndex instead of scanning the directory.
 */
function listCachedFiles(): Array<{ path: string; size: number; mtimeMs: number }> {
  const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const [filePath, meta] of cacheIndex) {
    out.push({ path: filePath, size: meta.size, mtimeMs: meta.mtimeMs });
  }
  return out;
}

async function ensureFreeDiskSpace(): Promise<void> {
  try {
    const stat = await fsp.statfs(STREAM_CACHE_DIR);
    const availableBytes = stat.bsize * stat.bavail;
    if (
      Number.isFinite(STREAM_CACHE_MIN_FREE_DISK_BYTES) &&
      STREAM_CACHE_MIN_FREE_DISK_BYTES > 0 &&
      availableBytes < STREAM_CACHE_MIN_FREE_DISK_BYTES
    ) {
      await pruneStreamCacheByBytes(STREAM_CACHE_MIN_FREE_DISK_BYTES - availableBytes);
    }
  } catch {
    // statfs not available or not supported; skip disk-free check
  }
}

async function pruneStreamCacheByBytes(targetFreeBytes: number) {
  const files = listCachedFiles().sort((a, b) => a.mtimeMs - b.mtimeMs);
  let freed = 0;
  for (const file of files) {
    await fsp.rm(file.path, { force: true }).catch(() => {});
    updateCacheIndexDelete(file.path);
    recordStreamCacheEviction({ reason: "size", bytes: file.size });
    freed += file.size;
    if (freed >= targetFreeBytes) break;
  }
}

async function pruneStreamCacheIfNeeded() {
  if (!Number.isFinite(STREAM_CACHE_MAX_BYTES) || STREAM_CACHE_MAX_BYTES <= 0) return;
  // Use the running total to skip the O(n) scan entirely when under the limit.
  if (cachedBytesTotal <= STREAM_CACHE_MAX_BYTES) {
    await ensureFreeDiskSpace();
    return;
  }
  // Only scan the index (not disk) when we need to prune.
  const files = listCachedFiles().sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const file of files) {
    await fsp.rm(file.path, { force: true }).catch(() => {});
    updateCacheIndexDelete(file.path);
    recordStreamCacheEviction({ reason: "size", bytes: file.size });
    if (cachedBytesTotal <= STREAM_CACHE_MAX_BYTES) break;
  }
  await ensureFreeDiskSpace();
}

async function sweepExpiredStreamCache() {
  if (!Number.isFinite(STREAM_CACHE_TTL_MS) || STREAM_CACHE_TTL_MS <= 0) return;
  const files = listCachedFiles();
  const cutoff = Date.now() - STREAM_CACHE_TTL_MS;
  for (const file of files) {
    if (file.mtimeMs > cutoff) continue;
    await fsp.rm(file.path, { force: true }).catch(() => {});
    updateCacheIndexDelete(file.path);
  }
}

const ORPHAN_TMP_GRACE_MS = 30 * 60_000;

async function cleanupOrphanedTempFiles() {
  const scanDir = async (dir: string) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await scanDir(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".tmp")) continue;
      try {
        const stat = await fsp.stat(fullPath);
        if (Date.now() - stat.mtimeMs > ORPHAN_TMP_GRACE_MS) {
          await fsp.rm(fullPath, { force: true }).catch(() => {});
        }
      } catch {
        // ignore
      }
    }
  };
  await scanDir(STREAM_CACHE_DIR);
}

async function expireStreamCacheIfNeeded(filePath: string) {
  if (!Number.isFinite(STREAM_CACHE_TTL_MS) || STREAM_CACHE_TTL_MS <= 0) return;
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat) return;
  if (Date.now() - stat.mtimeMs <= STREAM_CACHE_TTL_MS) return;
  await fsp.rm(filePath, { force: true }).catch(() => {});
  updateCacheIndexDelete(filePath);
  recordStreamCacheEviction({ reason: "ttl", bytes: stat.size });
}

export async function initStreamCache() {
  await ensureStreamCacheDir();
  await rebuildCacheIndex();
  await cleanupOrphanedTempFiles();
  await sweepExpiredStreamCache();
  await pruneStreamCacheIfNeeded();
}

export async function getCachedStreamPath(
  blobId: string,
  expectedSize?: number,
): Promise<string | null> {
  await ensureStreamCacheDir();
  const filePath = streamCachePath(blobId);
  await expireStreamCacheIfNeeded(filePath);
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    recordStreamCacheAccess({ cacheType: "full", outcome: "miss" });
    return null;
  }
  if (expectedSize !== undefined && stat.size !== expectedSize) {
    await fsp.rm(filePath, { force: true }).catch(() => {});
    updateCacheIndexDelete(filePath);
    recordStreamCacheEviction({ reason: "invalid", bytes: stat.size });
    recordStreamCacheAccess({ cacheType: "full", outcome: "miss" });
    return null;
  }
  await fsp.utimes(filePath, new Date(), new Date()).catch(() => {});
  recordStreamCacheAccess({ cacheType: "full", outcome: "hit" });
  return filePath;
}

export async function getCachedStreamRangePath(params: {
  blobId: string;
  start: number;
  end: number;
}): Promise<string | null> {
  await ensureStreamCacheDir();
  const filePath = streamRangeCachePath(params);
  await expireStreamCacheIfNeeded(filePath);
  const stat = await fsp.stat(filePath).catch(() => null);
  const expectedSize = params.end - params.start + 1;
  if (!stat?.isFile() || stat.size !== expectedSize) {
    if (stat) {
      await fsp.rm(filePath, { force: true }).catch(() => {});
      updateCacheIndexDelete(filePath);
      recordStreamCacheEviction({ reason: "invalid", bytes: stat.size });
    }
    recordStreamCacheAccess({ cacheType: "range", outcome: "miss" });
    return null;
  }
  await fsp.utimes(filePath, new Date(), new Date()).catch(() => {});
  recordStreamCacheAccess({ cacheType: "range", outcome: "hit" });
  return filePath;
}

/**
 * Fetch a blob range from Walrus and simultaneously:
 * 1. Write to local disk cache
 * 2. Stream to caller via Readable
 *
 * Concurrent callers for the same cold range get their own tee leg from
 * the same underlying fetch. Truncation errors propagate to all consumers.
 */
export async function teeCachedStreamRange(params: {
  blobId: string;
  start: number;
  end: number;
  signal?: AbortSignal;
  log?: { warn: (...args: any[]) => void };
}): Promise<StreamFillResult> {
  const existing = await getCachedStreamRangePath(params);
  if (existing) return { kind: "cache_hit", cachePath: existing };

  const rangeKey = streamRangeCacheKey(params);
  const existingSession = inFlightTeeRangeFill.get(rangeKey);
  if (existingSession) {
    const cs = new PassThrough();
    existingSession.consumerStreams.add(cs);
    if (existingSession.writeError) {
      cs.destroy(existingSession.writeError);
    }
    return { kind: "tee", cachePath: existingSession.cachePath, stream: cs };
  }

  const cachePath = streamRangeCachePath(params);
  const expectedSize = params.end - params.start + 1;
  const broadcastStream = new PassThrough();
  const consumerStreams = new Set<PassThrough>();
  const fillStartedAt = Date.now();

  // Register the session in the dedup map BEFORE any await so concurrent
  // requests for the same range join this session rather than issuing
  // duplicate Walrus fetches.  The earlier the registration, the fewer
  // duplicate fetches can slip through on the async boundary.
  const session: InFlightTeeEntry = {
    cachePath,
    consumerStreams,
    writeDone: undefined!,
    writeError: null,
  };
  inFlightTeeRangeFill.set(rangeKey, session);

  // If setup (mkdir, acquireCacheFillSlot) fails before writeDone is assigned,
  // clean up the session so late consumers don't hang forever on an orphaned
  // entry with no writeDone promise.
  let releaseFillSlot: (() => void) | null = null;
  const setupCleanup = (err: Error) => {
    for (const cs of consumerStreams) {
      if (!cs.destroyed) cs.destroy(err);
    }
    broadcastStream.destroy(err);
    broadcastStream.on("error", noop);
    inFlightTeeRangeFill.delete(rangeKey);
    releaseFillSlot?.();
  };

  const firstConsumer = new PassThrough();
  consumerStreams.add(firstConsumer);

  const fwdData = (chunk: Buffer) => {
    for (const cs of consumerStreams) {
      if (!cs.destroyed) cs.write(chunk);
    }
  };
  const fwdError = (err: Error) => {
    for (const cs of consumerStreams) {
      if (!cs.destroyed) cs.destroy(err);
    }
  };
  broadcastStream.on("data", fwdData);
  broadcastStream.on("error", fwdError);

  try {
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    releaseFillSlot = await acquireCacheFillSlot();
  } catch (err) {
    const setupErr = err instanceof Error ? err : new Error(String(err));
    setupCleanup(setupErr);
    throw setupErr;
  }

  const tempPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;

  const cleanupSession = () => {
    broadcastStream.off("data", fwdData);
    broadcastStream.off("error", fwdError);
    // Suppress late async 'error' events from broadcastStream.destroy(err).
    // Node.js streams emit 'error' via process.nextTick, so the event can
    // fire AFTER cleanupSession removes the listener in the finally block,
    // causing an uncaughtException.  A no-op handler prevents that.
    broadcastStream.on("error", noop);
    inFlightTeeRangeFill.delete(rangeKey);
    releaseFillSlot();
  };

  session.writeDone = (async () => {
    const releaseReservation = await reserveCacheBytes(expectedSize);
    if (!releaseReservation) {
      recordStreamCacheAccess({ cacheType: "range", outcome: "rejected" });
      const capErr = new StreamCacheCapacityError(expectedSize);
      for (const cs of consumerStreams) {
        if (!cs.destroyed) cs.destroy(capErr);
      }
      cleanupSession();
      throw capErr;
    }

    let innerError: Error | null = null;

    try {
      await ensureStreamCacheDir();

      const { res } = await fetchWalrusBlob({
        blobId: params.blobId,
        rangeHeader: `bytes=${params.start}-${params.end}`,
        signal: params.signal,
      });

      if (res.status !== 206 && !(res.status === 200 && params.start === 0)) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `WALRUS_CACHE_FILL_FAILED status=${res.status}${body ? ` body=${body.slice(0, 120)}` : ""}`,
        );
      }

      // Validate Content-Range header matches the requested range.
      // Aggregators out of sync or behind a misconfigured proxy can return
      // data from the wrong offset, causing silent byte-level corruption
      // that would be cached and served to all subsequent clients.
      if (res.status === 206) {
        const contentRange = res.headers.get("content-range");
        if (contentRange) {
          const rangeMatch = contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/);
          if (rangeMatch) {
            const respStart = Number(rangeMatch[1]);
            const respEnd = Number(rangeMatch[2]);
            if (respStart !== params.start || respEnd !== params.end) {
              throw new Error(
                `WALRUS_CACHE_CONTENT_RANGE_MISMATCH requested=${params.start}-${params.end} got=${respStart}-${respEnd} content-range=${contentRange}`,
              );
            }
          }
        }
      }

      const body = res.body;
      if (!body) throw new Error("WALRUS_CACHE_FILL_MISSING_BODY");

      const [writeLeg, broadcastLeg] = body.tee();

      let bytesWritten = 0;
      const writeDone = new Promise<void>((resolveWrite, rejectWrite) => {
        const ws = fs.createWriteStream(tempPath, { flags: "wx" });
        const rs = Readable.fromWeb(writeLeg);
        rs.on("data", (chunk: Uint8Array) => {
          bytesWritten += chunk.byteLength;
        });
        rs.once("error", rejectWrite);
        ws.once("error", rejectWrite);
        ws.once("finish", resolveWrite);
        rs.pipe(ws);
      });

      const broadcastNode = Readable.fromWeb(broadcastLeg);
      broadcastNode.pipe(broadcastStream);

      await writeDone;

      if (bytesWritten !== expectedSize) {
        const truncErr = new Error(
          `STREAM_CACHE_RANGE_TRUNCATED expected=${expectedSize} read=${bytesWritten}`,
        );
        session.writeError = truncErr;
        for (const cs of consumerStreams) {
          if (!cs.destroyed) cs.destroy(truncErr);
        }
        broadcastStream.destroy(truncErr);
        await fsp.rm(tempPath, { force: true }).catch(() => {});
        throw truncErr;
      }

      await fsp.rename(tempPath, cachePath).catch(async (err) => {
        await fsp.rm(tempPath, { force: true }).catch(() => {});
        throw err;
      });
      updateCacheIndexInsert(cachePath, bytesWritten, Date.now());
      await pruneStreamCacheIfNeeded();
      recordStreamCacheAccess({ cacheType: "range", outcome: "filled" });
      observeStreamCacheFill({
        cacheType: "range",
        durationMs: Date.now() - fillStartedAt,
      });
      // Wait for the broadcast pipe to finish delivering all chunks to
      // consumer streams before ending them. Ending consumers before the
      // broadcast pipe finishes causes ERR_STREAM_WRITE_AFTER_END on
      // late-arriving chunks, which truncates/corrupts the output.
      await new Promise<void>((resolveBroadcast) => {
        broadcastStream.once("end", resolveBroadcast);
        broadcastStream.once("error", () => resolveBroadcast());
        if (broadcastStream.destroyed || broadcastStream.readableEnded) {
          resolveBroadcast();
        }
      });
      for (const cs of consumerStreams) {
        if (!cs.destroyed) cs.end();
      }
    } catch (err) {
      innerError = err instanceof Error ? err : new Error(String(err));
      // Destroy all consumer streams on any write failure (fetch error,
      // disk error, truncation, etc.) so clients don't hang indefinitely.
      for (const cs of consumerStreams) {
        if (!cs.destroyed) cs.destroy(innerError);
      }
      broadcastStream.destroy(innerError);
      // AbortError means the client disconnected — consumer streams are
      // already destroyed above. Re-throwing would bubble to
      // process.on("uncaughtException") and crash the server because
      // Node.js streams emit 'error' events via processTicksAndRejections
      // which can escape the .catch() handler below.
      if (innerError.name === "AbortError" || params.signal?.aborted) {
        return;
      }
      throw innerError;
    } finally {
      releaseReservation();
      cleanupSession();
    }
  })();

  // Suppress unhandled rejections: consumer streams are already destroyed
  // on error (above), and callers that need write success can await writeDone.
  session.writeDone.catch((err) => {
    const logFn = params.log?.warn ?? console.warn;
    logFn(
      { err, blobId: params.blobId, rangeKey, cachePath: session.cachePath },
      "Tee cache fill failed after stream start",
    );
  });

  return {
    kind: "tee",
    cachePath,
    stream: firstConsumer,
  };
}

/**
 * Fetch a full blob from Walrus and simultaneously:
 * 1. Write to local disk cache
 * 2. Stream to caller via Readable
 *
 * Concurrent callers for the same cold blob get their own tee leg from
 * the same underlying fetch. Truncation errors propagate to all consumers.
 */
export async function teeCachedStreamBlob(params: {
  blobId: string;
  sizeBytes: number;
  signal?: AbortSignal;
  log?: { warn: (...args: any[]) => void };
}): Promise<StreamFillResult | null> {
  if (!shouldCacheFullObjectPolicy(params.sizeBytes)) {
    recordStreamCacheAccess({ cacheType: "full", outcome: "bypass" });
    return null;
  }

  const existing = await getCachedStreamPath(params.blobId, params.sizeBytes);
  if (existing) return { kind: "cache_hit", cachePath: existing };

  const existingSession = inFlightTeeCacheFill.get(params.blobId);
  if (existingSession) {
    const cs = new PassThrough();
    existingSession.consumerStreams.add(cs);
    if (existingSession.writeError) {
      cs.destroy(existingSession.writeError);
    }
    return { kind: "tee", cachePath: existingSession.cachePath, stream: cs };
  }

  const filePath = streamCachePath(params.blobId);
  const broadcastStream = new PassThrough();
  const consumerStreams = new Set<PassThrough>();
  const fillStartedAt = Date.now();

  // Register the session in the dedup map BEFORE any await so concurrent
  // requests for the same blobId see this entry and join rather than
  // issuing a duplicate Walrus fetch.
  const session: InFlightTeeEntry = {
    cachePath: filePath,
    consumerStreams,
    writeDone: undefined!,
    writeError: null,
  };
  inFlightTeeCacheFill.set(params.blobId, session);

  // If setup fails before writeDone is assigned, clean up the session so
  // late consumers don't hang forever on an orphaned entry.
  let releaseFillSlot: (() => void) | null = null;
  const setupCleanup = (err: Error) => {
    for (const cs of consumerStreams) {
      if (!cs.destroyed) cs.destroy(err);
    }
    broadcastStream.destroy(err);
    broadcastStream.on("error", noop);
    inFlightTeeCacheFill.delete(params.blobId);
    releaseFillSlot?.();
  };

  const firstConsumer = new PassThrough();
  consumerStreams.add(firstConsumer);

  const fwdData = (chunk: Buffer) => {
    for (const cs of consumerStreams) {
      if (!cs.destroyed) cs.write(chunk);
    }
  };
  const fwdError = (err: Error) => {
    for (const cs of consumerStreams) {
      if (!cs.destroyed) cs.destroy(err);
    }
  };
  // Note: we do NOT forward `end` from broadcastStream to consumer streams.
  // Consumer streams stay open until the cache write completes (or fails),
  // so that truncation can be propagated as an error instead of a premature
  // successful end.
  broadcastStream.on("data", fwdData);
  broadcastStream.on("error", fwdError);

  try {
    releaseFillSlot = await acquireCacheFillSlot();
  } catch (err) {
    const setupErr = err instanceof Error ? err : new Error(String(err));
    setupCleanup(setupErr);
    throw setupErr;
  }

  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;

  const cleanupSession = () => {
    broadcastStream.off("data", fwdData);
    broadcastStream.off("error", fwdError);
    broadcastStream.on("error", noop);
    inFlightTeeCacheFill.delete(params.blobId);
    releaseFillSlot();
  };

  session.writeDone = (async () => {
    const releaseReservation = await reserveCacheBytes(params.sizeBytes);
    if (!releaseReservation) {
      recordStreamCacheAccess({ cacheType: "full", outcome: "rejected" });
      const capErr = new StreamCacheCapacityError(params.sizeBytes);
      for (const cs of consumerStreams) {
        if (!cs.destroyed) cs.destroy(capErr);
      }
      cleanupSession();
      return;
    }

    let innerError: Error | null = null;

    try {
      await ensureStreamCacheDir();

      const { res } = await fetchWalrusBlob({
        blobId: params.blobId,
        rangeHeader: `bytes=0-${params.sizeBytes - 1}`,
        signal: params.signal,
      });

      if (res.status !== 200 && res.status !== 206) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `WALRUS_CACHE_FILL_FAILED status=${res.status}${body ? ` body=${body.slice(0, 120)}` : ""}`,
        );
      }

      const body = res.body;
      if (!body) throw new Error("WALRUS_CACHE_FILL_MISSING_BODY");

      const [writeLeg, broadcastLeg] = body.tee();

      let bytesWritten = 0;
      const writeDone = new Promise<void>((resolveWrite, rejectWrite) => {
        const ws = fs.createWriteStream(tempPath, { flags: "wx" });
        const rs = Readable.fromWeb(writeLeg as any);
        rs.on("data", (chunk: Uint8Array) => {
          bytesWritten += chunk.byteLength;
        });
        rs.once("error", rejectWrite);
        ws.once("error", rejectWrite);
        ws.once("finish", resolveWrite);
        rs.pipe(ws);
      });

      const broadcastNode = Readable.fromWeb(broadcastLeg as any);
      broadcastNode.pipe(broadcastStream);

      await writeDone;

      if (bytesWritten !== params.sizeBytes) {
        const truncErr = new Error(
          `STREAM_CACHE_FULL_TRUNCATED expected=${params.sizeBytes} read=${bytesWritten}`,
        );
        for (const cs of consumerStreams) {
          if (!cs.destroyed) cs.destroy(truncErr);
        }
        broadcastStream.destroy(truncErr);
        await fsp.rm(tempPath, { force: true }).catch(() => {});
        throw truncErr;
      }

      await fsp.rename(tempPath, filePath).catch(async (err) => {
        await fsp.rm(tempPath, { force: true }).catch(() => {});
        throw err;
      });
      updateCacheIndexInsert(filePath, bytesWritten, Date.now());
      await pruneStreamCacheIfNeeded();
      recordStreamCacheAccess({ cacheType: "full", outcome: "filled" });
      observeStreamCacheFill({
        cacheType: "full",
        durationMs: Date.now() - fillStartedAt,
      });
      // Wait for the broadcast pipe to finish delivering all chunks
      // before ending consumer streams (same race fix as teeCachedStreamRange).
      await new Promise<void>((resolveBroadcast) => {
        broadcastStream.once("end", resolveBroadcast);
        broadcastStream.once("error", () => resolveBroadcast());
        if (broadcastStream.destroyed || broadcastStream.readableEnded) {
          resolveBroadcast();
        }
      });
      for (const cs of consumerStreams) {
        if (!cs.destroyed) cs.end();
      }
    } catch (err) {
      innerError = err instanceof Error ? err : new Error(String(err));
      // Destroy all consumer streams on any write failure (fetch error,
      // disk error, truncation, etc.) so clients don't hang indefinitely.
      for (const cs of consumerStreams) {
        if (!cs.destroyed) cs.destroy(innerError);
      }
      broadcastStream.destroy(innerError);
      // AbortError means the client disconnected — consumer streams are
      // already destroyed above. Re-throwing would bubble to
      // process.on("uncaughtException") and crash the server.
      if (innerError.name === "AbortError" || params.signal?.aborted) {
        return;
      }
      throw innerError;
    } finally {
      releaseReservation();
      cleanupSession();
    }
  })();
  // Suppress unhandled rejections: consumer streams are already destroyed
  // on error, and callers that need write success can await writeDone directly.
  session.writeDone.catch((err) => {
    const logFn = params.log?.warn ?? console.warn;
    logFn(
      { err, blobId: params.blobId, cachePath: session.cachePath },
      "Tee cache fill failed after stream start",
    );
  });

  return {
    kind: "tee",
    cachePath: filePath,
    stream: firstConsumer,
  };
}

export function createCachedReadStream(params: { filePath: string; start: number; end: number }) {
  return fs.createReadStream(params.filePath, {
    start: params.start,
    end: params.end,
  });
}

async function acquireCacheFillSlot(): Promise<() => void> {
  if (!Number.isFinite(STREAM_CACHE_FILL_CONCURRENCY) || STREAM_CACHE_FILL_CONCURRENCY <= 0) {
    return () => {};
  }

  while (activeCacheFills >= STREAM_CACHE_FILL_CONCURRENCY) {
    await new Promise<void>((resolve) => pendingFillWaiters.push(resolve));
  }
  activeCacheFills += 1;
  setStreamCacheMetrics({ activeFills: activeCacheFills, reservedBytes: reservedCacheBytes });

  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeCacheFills = Math.max(0, activeCacheFills - 1);
    setStreamCacheMetrics({ activeFills: activeCacheFills, reservedBytes: reservedCacheBytes });
    pendingFillWaiters.shift()?.();
  };
}

async function reserveCacheBytes(expectedBytes: number): Promise<null | (() => void)> {
  if (!Number.isFinite(STREAM_CACHE_MAX_BYTES) || STREAM_CACHE_MAX_BYTES <= 0) {
    return () => {};
  }
  if (expectedBytes > STREAM_CACHE_MAX_BYTES) {
    return null;
  }

  return withCacheReservationLock(async () => {
    await pruneStreamCacheIfNeeded();
    if (cachedBytesTotal + reservedCacheBytes + expectedBytes > STREAM_CACHE_MAX_BYTES) {
      return null;
    }
    if (Number.isFinite(STREAM_CACHE_MIN_FREE_DISK_BYTES) && STREAM_CACHE_MIN_FREE_DISK_BYTES > 0) {
      try {
        const stat = await fsp.statfs(STREAM_CACHE_DIR);
        const availableBytes = stat.bsize * stat.bavail;
        const needed = cachedBytesTotal + reservedCacheBytes + expectedBytes;
        if (availableBytes < STREAM_CACHE_MIN_FREE_DISK_BYTES || availableBytes < needed * 0.1) {
          return null;
        }
      } catch {
        // statfs not available; skip
      }
    }

    reservedCacheBytes += expectedBytes;
    setStreamCacheMetrics({ activeFills: activeCacheFills, reservedBytes: reservedCacheBytes });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      reservedCacheBytes = Math.max(0, reservedCacheBytes - expectedBytes);
      setStreamCacheMetrics({ activeFills: activeCacheFills, reservedBytes: reservedCacheBytes });
    };
  });
}

async function withCacheReservationLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = cacheReservationLock;
  let release!: () => void;
  cacheReservationLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}
