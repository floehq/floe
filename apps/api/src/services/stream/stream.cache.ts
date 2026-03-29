import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { UploadConfig } from "../../config/uploads.config.js";
import { WalrusReadLimits } from "../../config/walrus.config.js";
import { fetchWalrusBlob } from "../walrus/read.js";
import {
  observeStreamCacheFill,
  recordStreamCacheAccess,
  recordStreamCacheEviction,
  setStreamCacheMetrics,
} from "../metrics/runtime.metrics.js";

const STREAM_CACHE_DIR = path.join(UploadConfig.tmpDir, "_stream_cache");
const STREAM_CACHE_FULL_DIR = path.join(STREAM_CACHE_DIR, "full");
const STREAM_CACHE_RANGE_DIR = path.join(STREAM_CACHE_DIR, "ranges");
const CACHE_TTL_MS = Number(process.env.FLOE_STREAM_CACHE_TTL_MS ?? 30 * 60_000);
const CACHE_MAX_BYTES = Number(process.env.FLOE_STREAM_CACHE_MAX_BYTES ?? 2 * 1024 * 1024 * 1024);
const CACHE_FILL_CONCURRENCY = Number(process.env.FLOE_STREAM_CACHE_FILL_CONCURRENCY ?? 4);

const inFlightCacheFill = new Map<string, Promise<string | null>>();
const inFlightRangeFill = new Map<string, Promise<string>>();
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
    `${params.start}-${params.end}.part`
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

async function pruneStreamCacheIfNeeded() {
  if (!Number.isFinite(CACHE_MAX_BYTES) || CACHE_MAX_BYTES <= 0) return;
  const files = await listCacheFiles();
  let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes <= CACHE_MAX_BYTES) return;

  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const file of files) {
    await fsp.rm(file.path, { force: true }).catch(() => {});
    recordStreamCacheEviction({ reason: "size", bytes: file.size });
    totalBytes -= file.size;
    if (totalBytes <= CACHE_MAX_BYTES) break;
  }
}

async function sweepExpiredStreamCache() {
  if (!Number.isFinite(CACHE_TTL_MS) || CACHE_TTL_MS <= 0) return;
  const files = await listCacheFiles();
  const cutoff = Date.now() - CACHE_TTL_MS;
  for (const file of files) {
    if (file.mtimeMs > cutoff) continue;
    await fsp.rm(file.path, { force: true }).catch(() => {});
  }
}

async function expireStreamCacheIfNeeded(filePath: string) {
  if (!Number.isFinite(CACHE_TTL_MS) || CACHE_TTL_MS <= 0) return;
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat) return;
  if (Date.now() - stat.mtimeMs <= CACHE_TTL_MS) return;
  await fsp.rm(filePath, { force: true }).catch(() => {});
  recordStreamCacheEviction({ reason: "ttl", bytes: stat.size });
}

export async function initStreamCache() {
  await ensureStreamCacheDir();
  await sweepExpiredStreamCache();
  await pruneStreamCacheIfNeeded();
}

export function shouldCacheFullObject(sizeBytes: number): boolean {
  return (
    Number.isFinite(sizeBytes) &&
    sizeBytes > 0 &&
    sizeBytes <= WalrusReadLimits.inlineFullObjectMaxBytes
  );
}

export async function getCachedStreamPath(
  blobId: string,
  expectedSize?: number
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

export async function ensureCachedStreamBlob(params: {
  blobId: string;
  sizeBytes: number;
  signal?: AbortSignal;
}): Promise<string | null> {
  if (!shouldCacheFullObject(params.sizeBytes)) {
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
        throw new Error(`WALRUS_CACHE_FILL_FAILED status=${res.status}${body ? ` body=${body.slice(0, 120)}` : ""}`);
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
          `STREAM_CACHE_FULL_TRUNCATED expected=${params.sizeBytes} read=${bytesWritten}`
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
        throw new Error(`WALRUS_CACHE_FILL_FAILED status=${res.status}${body ? ` body=${body.slice(0, 120)}` : ""}`);
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
        throw new Error(`STREAM_CACHE_RANGE_TRUNCATED expected=${expectedSize} read=${bytesWritten}`);
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

export function createCachedReadStream(params: {
  filePath: string;
  start: number;
  end: number;
}) {
  return fs.createReadStream(params.filePath, {
    start: params.start,
    end: params.end,
  });
}

async function acquireCacheFillSlot(): Promise<() => void> {
  if (!Number.isFinite(CACHE_FILL_CONCURRENCY) || CACHE_FILL_CONCURRENCY <= 0) {
    return () => {};
  }

  while (activeCacheFills >= CACHE_FILL_CONCURRENCY) {
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
  if (!Number.isFinite(CACHE_MAX_BYTES) || CACHE_MAX_BYTES <= 0) {
    return () => {};
  }
  if (expectedBytes > CACHE_MAX_BYTES) {
    return null;
  }

  return withCacheReservationLock(async () => {
    await pruneStreamCacheIfNeeded();
    const files = await listCacheFiles();
    const currentBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (currentBytes + reservedCacheBytes + expectedBytes > CACHE_MAX_BYTES) {
      return null;
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
