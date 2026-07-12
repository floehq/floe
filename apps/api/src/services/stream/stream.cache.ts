import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";

import { UploadConfig } from "../../config/uploads.config.js";
import { fetchWalrusBlob } from "../walrus/read.js";
import {
  STREAM_CACHE_FILL_CONCURRENCY,
  STREAM_CACHE_MAX_BYTES,
  STREAM_CACHE_MIN_FREE_DISK_BYTES,
  STREAM_CACHE_MIN_FREE_DISK_FRACTION,
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

const inFlightCacheFill = new Map<string, Promise<string | null>>();
const inFlightRangeFill = new Map<string, Promise<string>>();
const inFlightTeeCacheFill = new Map<string, InFlightTeeEntry>();
const inFlightTeeRangeFill = new Map<string, InFlightTeeEntry>();
let reservedCacheBytes = 0;
let activeCacheFills = 0;
const pendingFillWaiters: Array<() => void> = [];
let cacheReservationLock: Promise<void> = Promise.resolve();

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

async function listCacheFiles() {
  const scanDir = async (dir: string) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await scanDir(filePath)));
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fsp.stat(filePath).catch(() => null);
      if (!stat) continue;
      out.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    return out;
  };

  return scanDir(STREAM_CACHE_DIR);
}

async function ensureFreeDiskSpace(): Promise<void> {
  try {
    const stat = await fsp.statfs(STREAM_CACHE_DIR);
    const availableBytes = stat.bsize * stat.bavail;
    const minFreeBytes = Math.max(
      Number.isFinite(STREAM_CACHE_MIN_FREE_DISK_BYTES) && STREAM_CACHE_MIN_FREE_DISK_BYTES > 0
        ? STREAM_CACHE_MIN_FREE_DISK_BYTES
        : 0,
      Number.isFinite(STREAM_CACHE_MIN_FREE_DISK_FRACTION) &&
        STREAM_CACHE_MIN_FREE_DISK_FRACTION > 0
        ? Math.floor(stat.blocks * stat.bsize * STREAM_CACHE_MIN_FREE_DISK_FRACTION)
        : 0,
    );
    if (availableBytes < minFreeBytes) {
      await pruneStreamCacheByBytes(availableBytes - minFreeBytes);
    }
  } catch {
    // statfs not available or not supported; skip disk-free check
  }
}

async function pruneStreamCacheByBytes(targetFreeBytes: number) {
  const files = await listCacheFiles();
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let freed = 0;
  for (const file of files) {
    await fsp.rm(file.path, { force: true }).catch(() => {});
    recordStreamCacheEviction({ reason: "size", bytes: file.size });
    freed += file.size;
    if (freed >= targetFreeBytes) break;
  }
}

async function pruneStreamCacheIfNeeded() {
  if (!Number.isFinite(STREAM_CACHE_MAX_BYTES) || STREAM_CACHE_MAX_BYTES <= 0) return;
  const files = await listCacheFiles();
  let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > STREAM_CACHE_MAX_BYTES) {
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of files) {
      await fsp.rm(file.path, { force: true }).catch(() => {});
      recordStreamCacheEviction({ reason: "size", bytes: file.size });
      totalBytes -= file.size;
      if (totalBytes <= STREAM_CACHE_MAX_BYTES) break;
    }
  }
  await ensureFreeDiskSpace();
}

async function sweepExpiredStreamCache() {
  if (!Number.isFinite(STREAM_CACHE_TTL_MS) || STREAM_CACHE_TTL_MS <= 0) return;
  const files = await listCacheFiles();
  const cutoff = Date.now() - STREAM_CACHE_TTL_MS;
  for (const file of files) {
    if (file.mtimeMs > cutoff) continue;
    await fsp.rm(file.path, { force: true }).catch(() => {});
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
  recordStreamCacheEviction({ reason: "ttl", bytes: stat.size });
}

export async function initStreamCache() {
  await ensureStreamCacheDir();
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

  const releaseFillSlot = await acquireCacheFillSlot();
  const cachePath = streamRangeCachePath(params);
  await fsp.mkdir(path.dirname(cachePath), { recursive: true });
  const tempPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
  const expectedSize = params.end - params.start + 1;
  const broadcastStream = new PassThrough();
  const consumerStreams = new Set<PassThrough>();
  const fillStartedAt = Date.now();

  const session: InFlightTeeEntry = {
    cachePath,
    consumerStreams,
    writeDone: undefined!,
    writeError: null,
  };
  inFlightTeeRangeFill.set(rangeKey, session);

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

  const cleanupSession = () => {
    broadcastStream.off("data", fwdData);
    broadcastStream.off("error", fwdError);
    inFlightTeeRangeFill.delete(rangeKey);
    releaseFillSlot();
  };

  session.writeDone = (async () => {
    const releaseReservation = await reserveCacheBytes(expectedSize);
    if (!releaseReservation) {
      recordStreamCacheAccess({ cacheType: "range", outcome: "rejected" });
      for (const cs of consumerStreams) {
        if (!cs.destroyed) cs.destroy(new Error("STREAM_CACHE_CAPACITY_EXCEEDED"));
      }
      cleanupSession();
      throw new Error("STREAM_CACHE_CAPACITY_EXCEEDED");
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
      await pruneStreamCacheIfNeeded();
      recordStreamCacheAccess({ cacheType: "range", outcome: "filled" });
      observeStreamCacheFill({
        cacheType: "range",
        durationMs: Date.now() - fillStartedAt,
      });
      // Now that we've confirmed the write is complete and valid, end
      // all consumer streams so they signal completion to their readers.
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
      throw innerError;
    } finally {
      releaseReservation();
      cleanupSession();
    }
  })();

  // Suppress unhandled rejections: consumer streams are already destroyed
  // on error (above), and callers that need write success can await writeDone.
  session.writeDone.catch(() => {});

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

  const releaseFillSlot = await acquireCacheFillSlot();
  const filePath = streamCachePath(params.blobId);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const broadcastStream = new PassThrough();
  const consumerStreams = new Set<PassThrough>();
  const fillStartedAt = Date.now();

  const session: InFlightTeeEntry = {
    cachePath: filePath,
    consumerStreams,
    writeDone: undefined!,
    writeError: null,
  };
  inFlightTeeCacheFill.set(params.blobId, session);

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

  const cleanupSession = () => {
    broadcastStream.off("data", fwdData);
    broadcastStream.off("error", fwdError);
    inFlightTeeCacheFill.delete(params.blobId);
    releaseFillSlot();
  };

  session.writeDone = (async () => {
    const releaseReservation = await reserveCacheBytes(params.sizeBytes);
    if (!releaseReservation) {
      recordStreamCacheAccess({ cacheType: "full", outcome: "rejected" });
      for (const cs of consumerStreams) {
        if (!cs.destroyed) cs.destroy(new Error("STREAM_CACHE_CAPACITY_EXCEEDED"));
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
      await pruneStreamCacheIfNeeded();
      recordStreamCacheAccess({ cacheType: "full", outcome: "filled" });
      observeStreamCacheFill({
        cacheType: "full",
        durationMs: Date.now() - fillStartedAt,
      });
      // Now that we've confirmed the write is complete and valid, end
      // all consumer streams so they signal completion to their readers.
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
      throw innerError;
    } finally {
      releaseReservation();
      cleanupSession();
    }
  })();
  // Suppress unhandled rejections: consumer streams are already destroyed
  // on error, and callers that need write success can await writeDone directly.
  session.writeDone.catch(() => {});

  return {
    kind: "tee",
    cachePath: filePath,
    stream: firstConsumer,
  };
}

/** @deprecated Use teeCachedStreamBlob instead for streaming-aware callers. */
export async function ensureCachedStreamBlob(params: {
  blobId: string;
  sizeBytes: number;
  signal?: AbortSignal;
}): Promise<string | null> {
  if (!shouldCacheFullObjectPolicy(params.sizeBytes)) {
    recordStreamCacheAccess({ cacheType: "full", outcome: "bypass" });
    return null;
  }

  const existing = await getCachedStreamPath(params.blobId, params.sizeBytes);
  if (existing) return existing;

  const inFlight = inFlightCacheFill.get(params.blobId);
  if (inFlight) return inFlight;

  const fillPromise = (async () => {
    const releaseFillSlot = await acquireCacheFillSlot();
    const releaseReservation = await reserveCacheBytes(params.sizeBytes);
    if (!releaseReservation) {
      recordStreamCacheAccess({ cacheType: "full", outcome: "rejected" });
      releaseFillSlot();
      return null;
    }

    await ensureStreamCacheDir();
    const filePath = streamCachePath(params.blobId);
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    const fillStartedAt = Date.now();

    try {
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

      let bytesWritten = 0;
      await new Promise<void>((resolve, reject) => {
        const ws = fs.createWriteStream(tempPath, { flags: "wx" });
        const rs = Readable.fromWeb(body as any);
        rs.on("data", (chunk: Uint8Array) => {
          bytesWritten += chunk.byteLength;
        });
        rs.once("error", reject);
        ws.once("error", reject);
        ws.once("finish", resolve);
        rs.pipe(ws);
      }).catch(async (err) => {
        await fsp.rm(tempPath, { force: true }).catch(() => {});
        throw err;
      });

      if (bytesWritten !== params.sizeBytes) {
        await fsp.rm(tempPath, { force: true }).catch(() => {});
        throw new Error(
          `STREAM_CACHE_FULL_TRUNCATED expected=${params.sizeBytes} read=${bytesWritten}`,
        );
      }

      await fsp.rename(tempPath, filePath).catch(async (err) => {
        await fsp.rm(tempPath, { force: true }).catch(() => {});
        throw err;
      });
      await pruneStreamCacheIfNeeded();
      recordStreamCacheAccess({ cacheType: "full", outcome: "filled" });
      observeStreamCacheFill({
        cacheType: "full",
        durationMs: Date.now() - fillStartedAt,
      });
      return filePath;
    } finally {
      releaseReservation();
      releaseFillSlot();
    }
  })().finally(() => {
    inFlightCacheFill.delete(params.blobId);
  });

  inFlightCacheFill.set(params.blobId, fillPromise);
  return fillPromise;
}

export async function ensureCachedStreamRange(params: {
  blobId: string;
  start: number;
  end: number;
  signal?: AbortSignal;
}): Promise<string> {
  const existing = await getCachedStreamRangePath(params);
  if (existing) return existing;

  const rangeKey = streamRangeCacheKey(params);
  const inFlight = inFlightRangeFill.get(rangeKey);
  if (inFlight) return inFlight;

  const fillPromise = (async () => {
    const releaseFillSlot = await acquireCacheFillSlot();
    await ensureStreamCacheDir();
    const cachePath = streamRangeCachePath(params);
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    const tempPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
    const expectedSize = params.end - params.start + 1;
    const releaseReservation = await reserveCacheBytes(expectedSize);
    if (!releaseReservation) {
      recordStreamCacheAccess({ cacheType: "range", outcome: "rejected" });
      releaseFillSlot();
      throw new Error("STREAM_CACHE_CAPACITY_EXCEEDED");
    }
    const fillStartedAt = Date.now();

    try {
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

      const body = res.body;
      if (!body) throw new Error("WALRUS_CACHE_FILL_MISSING_BODY");

      let bytesWritten = 0;
      await new Promise<void>((resolve, reject) => {
        const ws = fs.createWriteStream(tempPath, { flags: "wx" });
        const rs = Readable.fromWeb(body as any);
        rs.on("data", (chunk: Uint8Array) => {
          bytesWritten += chunk.byteLength;
        });
        rs.once("error", reject);
        ws.once("error", reject);
        ws.once("finish", resolve);
        rs.pipe(ws);
      }).catch(async (err) => {
        await fsp.rm(tempPath, { force: true }).catch(() => {});
        throw err;
      });

      if (bytesWritten !== expectedSize) {
        await fsp.rm(tempPath, { force: true }).catch(() => {});
        throw new Error(
          `STREAM_CACHE_RANGE_TRUNCATED expected=${expectedSize} read=${bytesWritten}`,
        );
      }

      await fsp.rename(tempPath, cachePath).catch(async (err) => {
        await fsp.rm(tempPath, { force: true }).catch(() => {});
        throw err;
      });
      await pruneStreamCacheIfNeeded();
      recordStreamCacheAccess({ cacheType: "range", outcome: "filled" });
      observeStreamCacheFill({
        cacheType: "range",
        durationMs: Date.now() - fillStartedAt,
      });
      return cachePath;
    } finally {
      releaseReservation();
      releaseFillSlot();
    }
  })().finally(() => {
    inFlightRangeFill.delete(rangeKey);
  });

  inFlightRangeFill.set(rangeKey, fillPromise);
  return fillPromise;
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
    const files = await listCacheFiles();
    const currentBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (currentBytes + reservedCacheBytes + expectedBytes > STREAM_CACHE_MAX_BYTES) {
      return null;
    }
    if (
      !Number.isFinite(STREAM_CACHE_MIN_FREE_DISK_BYTES) ||
      STREAM_CACHE_MIN_FREE_DISK_BYTES <= 0
    ) {
      // skip disk-free check if not configured
    } else {
      try {
        const stat = await fsp.statfs(STREAM_CACHE_DIR);
        const availableBytes = stat.bsize * stat.bavail;
        const minFreeBytes = Math.max(
          STREAM_CACHE_MIN_FREE_DISK_BYTES,
          Number.isFinite(STREAM_CACHE_MIN_FREE_DISK_FRACTION) &&
            STREAM_CACHE_MIN_FREE_DISK_FRACTION > 0
            ? Math.floor(stat.blocks * stat.bsize * STREAM_CACHE_MIN_FREE_DISK_FRACTION)
            : 0,
        );
        const needed = currentBytes + reservedCacheBytes + expectedBytes;
        if (availableBytes < minFreeBytes || availableBytes < needed * 0.1) {
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
