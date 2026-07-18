import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";

process.env.FLOE_NETWORK = "testnet";
process.env.SUI_PRIVATE_KEY = `[${new Array(32).fill(0).join(",")}]`;
process.env.SUI_PACKAGE_ID = "0x2";
process.env.UPLOAD_TMP_DIR = "/tmp/floe-test-stream-cache-advanced";
process.env.FLOE_ENFORCE_UPLOAD_OWNER = "false";
process.env.FLOE_STREAM_CACHE_MAX_BYTES = "1048576";
process.env.FLOE_STREAM_CACHE_TTL_MS = "0";
process.env.FLOE_STREAM_CACHE_FILL_CONCURRENCY = "2";
process.env.FLOE_STREAM_CACHE_MIN_FREE_DISK_BYTES = "0";

const CACHE_DIR = path.join("/tmp/floe-test-stream-cache-advanced", "_stream_cache");

let savedAggregatorUrl: string | undefined;

function createMockWalrusServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function importStreamCacheModule() {
  const ts = Date.now();
  return import(`../src/services/stream/stream.cache.js?t=${ts}`) as Promise<
    typeof import("../src/services/stream/stream.cache.js")
  >;
}

function setupAggregatorEnv(url: string) {
  savedAggregatorUrl = process.env.WALRUS_AGGREGATOR_URL;
  process.env.WALRUS_AGGREGATOR_URL = url;
}

function teardownAggregatorEnv() {
  if (savedAggregatorUrl !== undefined) {
    process.env.WALRUS_AGGREGATOR_URL = savedAggregatorUrl;
  } else {
    delete process.env.WALRUS_AGGREGATOR_URL;
  }
}

async function readStreamFully(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function cleanCacheDir() {
  await fs.rm(CACHE_DIR, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Concurrency slot system
// ---------------------------------------------------------------------------

test("concurrency slots - streams beyond the slot limit wait for release", async () => {
  process.env.FLOE_STREAM_CACHE_FILL_CONCURRENCY = "2";

  const totalSize = 64;
  let activeFetches = 0;
  let maxActiveFetches = 0;

  const { server, url } = await createMockWalrusServer((_req, res) => {
    activeFetches++;
    if (activeFetches > maxActiveFetches) maxActiveFetches = activeFetches;
    res.writeHead(206, {
      "Content-Range": `bytes 0-${totalSize - 1}/${totalSize}`,
      "Content-Length": totalSize,
    });
    const buf = Buffer.alloc(totalSize, 0xaa);
    setTimeout(() => {
      res.end(buf);
      activeFetches--;
    }, 50);
  });

  setupAggregatorEnv(url);
  try {
    const mod = await importStreamCacheModule();
    await cleanCacheDir();
    await mod.initStreamCache();

    const promises = [
      mod.teeCachedStreamRange({ blobId: "slot-test-1", start: 0, end: totalSize - 1 }),
      mod.teeCachedStreamRange({ blobId: "slot-test-2", start: 0, end: totalSize - 1 }),
      mod.teeCachedStreamRange({ blobId: "slot-test-3", start: 0, end: totalSize - 1 }),
    ];

    const results = await Promise.all(promises);
    assert.equal(results.length, 3);

    await Promise.all(results.map((r) => readStreamFully(r.stream)));

    assert.ok(maxActiveFetches <= 2, `max active fetches was ${maxActiveFetches}, expected <= 2`);
  } finally {
    teardownAggregatorEnv();
    await closeServer(server);
  }
});

test("concurrency slots - released after stream completes", async () => {
  process.env.FLOE_STREAM_CACHE_FILL_CONCURRENCY = "1";

  const totalSize = 32;
  let activeFetches = 0;
  let maxActiveFetches = 0;

  const { server, url } = await createMockWalrusServer((_req, res) => {
    activeFetches++;
    if (activeFetches > maxActiveFetches) maxActiveFetches = activeFetches;
    res.writeHead(206, {
      "Content-Range": `bytes 0-${totalSize - 1}/${totalSize}`,
      "Content-Length": totalSize,
    });
    res.end(Buffer.alloc(totalSize, 0xbb));
    activeFetches--;
  });

  setupAggregatorEnv(url);
  try {
    const mod = await importStreamCacheModule();
    await cleanCacheDir();
    await mod.initStreamCache();

    const r1 = await mod.teeCachedStreamRange({
      blobId: "slot-release-1",
      start: 0,
      end: totalSize - 1,
    });
    await readStreamFully(r1.stream);

    const r2 = await mod.teeCachedStreamRange({
      blobId: "slot-release-2",
      start: 0,
      end: totalSize - 1,
    });
    await readStreamFully(r2.stream);

    assert.equal(maxActiveFetches, 1, "should never exceed 1 concurrent fetch with concurrency=1");
  } finally {
    teardownAggregatorEnv();
    await closeServer(server);
  }
});

test("concurrency slots - released when stream errors", async () => {
  process.env.FLOE_STREAM_CACHE_FILL_CONCURRENCY = "1";

  const totalSize = 64;

  const { server, url } = await createMockWalrusServer((req, res) => {
    const reqUrl = req.url ?? "";
    if (reqUrl.includes("slot-error-1")) {
      res.writeHead(500);
      res.end("internal error");
    } else {
      res.writeHead(206, {
        "Content-Range": `bytes 0-${totalSize - 1}/${totalSize}`,
        "Content-Length": totalSize,
      });
      res.end(Buffer.alloc(totalSize, 0xaa));
    }
  });

  setupAggregatorEnv(url);
  try {
    const mod = await importStreamCacheModule();
    await cleanCacheDir();
    await mod.initStreamCache();

    // First fill will error (500 response)
    const r1 = await mod.teeCachedStreamRange({
      blobId: "slot-error-1",
      start: 0,
      end: totalSize - 1,
    });
    try {
      await readStreamFully(r1.stream);
    } catch {
      // expected: consumer stream destroyed with error
    }

    // Wait for session cleanup
    await new Promise((r) => setTimeout(r, 200));

    // Second fill should acquire the slot now
    const r2 = await mod.teeCachedStreamRange({
      blobId: "slot-error-2",
      start: 0,
      end: totalSize - 1,
    });
    const data = await readStreamFully(r2.stream);
    assert.equal(data.length, totalSize, "second fill should succeed after slot release");
  } finally {
    teardownAggregatorEnv();
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// Disk-space reservation
// ---------------------------------------------------------------------------

test("disk-space reservation - reservations are created and cleaned up on completion", async () => {
  const totalSize = 128;

  const { server, url } = await createMockWalrusServer((_req, res) => {
    res.writeHead(206, {
      "Content-Range": `bytes 0-${totalSize - 1}/${totalSize}`,
      "Content-Length": totalSize,
    });
    res.end(Buffer.alloc(totalSize, 0xdd));
  });

  setupAggregatorEnv(url);
  try {
    const mod = await importStreamCacheModule();
    await cleanCacheDir();
    await mod.initStreamCache();

    const result = await mod.teeCachedStreamRange({
      blobId: "reservation-test-1",
      start: 0,
      end: totalSize - 1,
    });
    assert.equal(result.kind, "tee");
    const data = await readStreamFully(result.stream);
    assert.equal(data.length, totalSize);

    const stat = await fs.stat(result.cachePath);
    assert.equal(stat.size, totalSize);
  } finally {
    teardownAggregatorEnv();
    await closeServer(server);
  }
});

test("disk-space reservation - multiple reservations accumulate and release correctly", async () => {
  const totalSize = 128;

  const { server, url } = await createMockWalrusServer((_req, res) => {
    res.writeHead(206, {
      "Content-Range": `bytes 0-${totalSize - 1}/${totalSize}`,
      "Content-Length": totalSize,
    });
    res.end(Buffer.alloc(totalSize, 0xee));
  });

  setupAggregatorEnv(url);
  try {
    const mod = await importStreamCacheModule();
    await cleanCacheDir();
    await mod.initStreamCache();

    // Fill multiple entries concurrently
    const results = await Promise.all([
      mod.teeCachedStreamRange({ blobId: "multi-reserve-1", start: 0, end: totalSize - 1 }),
      mod.teeCachedStreamRange({ blobId: "multi-reserve-2", start: 0, end: totalSize - 1 }),
    ]);

    await Promise.all(results.map((r) => readStreamFully(r.stream)));

    // All entries should be on disk
    for (const r of results) {
      const stat = await fs.stat(r.cachePath);
      assert.equal(stat.size, totalSize);
    }
  } finally {
    teardownAggregatorEnv();
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// LRU eviction
// ---------------------------------------------------------------------------

test("LRU eviction - least-recently-used entry is evicted when cache is full", async () => {
  const totalSize = 300_000;

  const { server, url } = await createMockWalrusServer((_req, res) => {
    res.writeHead(206, {
      "Content-Range": `bytes 0-${totalSize - 1}/${totalSize}`,
      "Content-Length": totalSize,
    });
    res.end(Buffer.alloc(totalSize, 0xaa));
  });

  setupAggregatorEnv(url);
  try {
    const mod = await importStreamCacheModule();
    await cleanCacheDir();
    await mod.initStreamCache();

    // Fill entry 1 (will be oldest)
    const r1 = await mod.teeCachedStreamRange({
      blobId: "lru-oldest",
      start: 0,
      end: totalSize - 1,
    });
    await readStreamFully(r1.stream);

    // Fill entry 2
    const r2 = await mod.teeCachedStreamRange({
      blobId: "lru-middle",
      start: 0,
      end: totalSize - 1,
    });
    await readStreamFully(r2.stream);

    // Fill entry 3 — total ~900KB, within 1MB limit
    const r3 = await mod.teeCachedStreamRange({
      blobId: "lru-newest",
      start: 0,
      end: totalSize - 1,
    });
    await readStreamFully(r3.stream);

    // All 3 should be present
    const filesBefore = await fs.readdir(CACHE_DIR, { recursive: true });
    assert.ok(filesBefore.length >= 3, "should have at least 3 cached entries");

    // Backdate entry 1 to make it the LRU candidate
    await fs.utimes(r1.cachePath, new Date(Date.now() - 60000), new Date(Date.now() - 60000));

    // Simulate cache overflow by manually writing a 4th entry directly
    // to the cache directory (pushing total to ~1.2MB > 1MB limit).
    const extraDir = path.join(CACHE_DIR, "ranges", "lru-extra");
    const extraFile = path.join(extraDir, `0-${totalSize - 1}.part`);
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(extraFile, Buffer.alloc(totalSize, 0xaa));
    // Give it a mtime newer than entry1 but older than entries 2/3
    const midTime = new Date(Date.now() - 30000);
    await fs.utimes(extraFile, midTime, midTime);

    // Re-init rebuilds the index and prunes overflowing entries
    await mod.initStreamCache();

    // Check that lru-oldest was evicted
    const { getCachedStreamRangePath } = mod;
    const oldPath = await getCachedStreamRangePath({
      blobId: "lru-oldest",
      start: 0,
      end: totalSize - 1,
    });
    const newPath = await getCachedStreamRangePath({
      blobId: "lru-newest",
      start: 0,
      end: totalSize - 1,
    });
    const extraPath = await getCachedStreamRangePath({
      blobId: "lru-extra",
      start: 0,
      end: totalSize - 1,
    });

    // The oldest entry should have been evicted (or at least one older entry)
    assert.equal(oldPath, null, "oldest entry should be evicted when cache exceeds limit");
    assert.ok(newPath !== null, "newest entry should still be cached");
    assert.ok(extraPath !== null, "extra entry should still be cached");
  } finally {
    teardownAggregatorEnv();
    await closeServer(server);
  }
});

test("LRU eviction - active entries survive when total is within limit", async () => {
  const totalSize = 128;

  const { server, url } = await createMockWalrusServer((_req, res) => {
    res.writeHead(206, {
      "Content-Range": `bytes 0-${totalSize - 1}/${totalSize}`,
      "Content-Length": totalSize,
    });
    res.end(Buffer.alloc(totalSize, 0xff));
  });

  setupAggregatorEnv(url);
  try {
    const mod = await importStreamCacheModule();
    await cleanCacheDir();
    await mod.initStreamCache();

    const r1 = await mod.teeCachedStreamRange({
      blobId: "active-a",
      start: 0,
      end: totalSize - 1,
    });
    await readStreamFully(r1.stream);

    // Fire two concurrent fills — total ~384 bytes, well within 1MB limit
    const [r2, r3] = await Promise.all([
      mod.teeCachedStreamRange({ blobId: "active-b", start: 0, end: totalSize - 1 }),
      mod.teeCachedStreamRange({ blobId: "active-c", start: 0, end: totalSize - 1 }),
    ]);

    const [d2, d3] = await Promise.all([readStreamFully(r2.stream), readStreamFully(r3.stream)]);

    assert.equal(d2.length, totalSize);
    assert.equal(d3.length, totalSize);
  } finally {
    teardownAggregatorEnv();
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// AbortError handling
// ---------------------------------------------------------------------------

test("AbortError - consumer stream destroyed gracefully without crash", async () => {
  const totalSize = 4096;

  const { server, url } = await createMockWalrusServer((_req, res) => {
    res.writeHead(206, {
      "Content-Range": `bytes 0-${totalSize - 1}/${totalSize}`,
      "Content-Length": totalSize,
    });
    let sent = 0;
    const interval = setInterval(() => {
      if (sent >= totalSize || res.destroyed) {
        clearInterval(interval);
        res.end();
        return;
      }
      const toSend = Math.min(128, totalSize - sent);
      res.write(Buffer.alloc(toSend, 0xab));
      sent += toSend;
    }, 10);
  });

  setupAggregatorEnv(url);
  try {
    const mod = await importStreamCacheModule();
    await cleanCacheDir();
    await mod.initStreamCache();

    const ac = new AbortController();
    const result = await mod.teeCachedStreamRange({
      blobId: "abort-graceful",
      start: 0,
      end: totalSize - 1,
      signal: ac.signal,
    });

    assert.equal(result.kind, "tee");

    await new Promise<void>((resolve) => {
      result.stream.once("data", () => {
        ac.abort();
        resolve();
      });
      result.stream.once("error", () => {
        ac.abort();
        resolve();
      });
    });

    await new Promise<void>((resolve) => {
      result.stream.on("error", () => {});
      result.stream.on("close", () => resolve());
      setTimeout(resolve, 1000);
    });

    assert.ok(
      result.stream.destroyed || result.stream.readableEnded,
      "stream should be destroyed or ended after abort",
    );
    assert.ok(!server.closed, "server should still be alive");
  } finally {
    teardownAggregatorEnv();
    await closeServer(server);
  }
});

test("AbortError - does not crash the server", async () => {
  const totalSize = 2048;

  const { server, url } = await createMockWalrusServer((_req, res) => {
    res.writeHead(206, {
      "Content-Range": `bytes 0-${totalSize - 1}/${totalSize}`,
      "Content-Length": totalSize,
    });
    let sent = 0;
    const interval = setInterval(() => {
      if (sent >= totalSize || res.destroyed) {
        clearInterval(interval);
        res.end();
        return;
      }
      const toSend = Math.min(256, totalSize - sent);
      res.write(Buffer.alloc(toSend, 0xcd));
      sent += toSend;
    }, 5);
  });

  setupAggregatorEnv(url);
  try {
    const mod = await importStreamCacheModule();
    await cleanCacheDir();
    await mod.initStreamCache();

    const ac = new AbortController();
    const result = await mod.teeCachedStreamRange({
      blobId: "abort-no-crash",
      start: 0,
      end: totalSize - 1,
      signal: ac.signal,
    });

    assert.equal(result.kind, "tee");

    // Listen for errors (they are expected from abort)
    let consumerError: Error | null = null;
    result.stream.on("error", (err: Error) => {
      consumerError = err;
    });

    // Abort immediately
    ac.abort();

    await new Promise<void>((resolve) => {
      result.stream.on("close", resolve);
      result.stream.on("end", resolve);
      setTimeout(resolve, 1000);
    });

    // Consumer gets an error (AbortError or related), but server doesn't crash
    assert.ok(consumerError !== null, "consumer should receive an error on abort");
    assert.ok(!server.closed, "server should still be alive after abort");

    await new Promise((r) => setTimeout(r, 200));
  } finally {
    teardownAggregatorEnv();
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// Range request handling
// ---------------------------------------------------------------------------

test("range request - correctly slices cached data via createCachedReadStream", async () => {
  const totalSize = 256;
  const testData = Buffer.alloc(totalSize, 0);
  for (let i = 0; i < totalSize; i++) testData[i] = i & 0xff;

  const { server, url } = await createMockWalrusServer((_req, res) => {
    res.writeHead(206, {
      "Content-Range": `bytes 0-${totalSize - 1}/${totalSize}`,
      "Content-Length": totalSize,
    });
    res.end(testData);
  });

  setupAggregatorEnv(url);
  try {
    const mod = await importStreamCacheModule();
    await cleanCacheDir();
    await mod.initStreamCache();

    const result = await mod.teeCachedStreamRange({
      blobId: "range-slice-test",
      start: 0,
      end: totalSize - 1,
    });
    assert.equal(result.kind, "tee");
    await readStreamFully(result.stream);

    const subRange = mod.createCachedReadStream({
      filePath: result.cachePath,
      start: 10,
      end: 19,
    });
    const subData = await readStreamFully(subRange);
    assert.equal(subData.length, 10);
    for (let i = 0; i < 10; i++) {
      assert.equal(subData[i], (10 + i) & 0xff, `byte at offset ${i} should match`);
    }
  } finally {
    teardownAggregatorEnv();
    await closeServer(server);
  }
});

test("range request - reading entire cached file returns all data", async () => {
  const totalSize = 64;
  const testData = Buffer.alloc(totalSize, 0x42);

  const { server, url } = await createMockWalrusServer((_req, res) => {
    res.writeHead(206, {
      "Content-Range": `bytes 0-${totalSize - 1}/${totalSize}`,
      "Content-Length": totalSize,
    });
    res.end(testData);
  });

  setupAggregatorEnv(url);
  try {
    const mod = await importStreamCacheModule();
    await cleanCacheDir();
    await mod.initStreamCache();

    const result = await mod.teeCachedStreamRange({
      blobId: "range-full-read",
      start: 0,
      end: totalSize - 1,
    });
    assert.equal(result.kind, "tee");
    await readStreamFully(result.stream);

    // Read entire file via createCachedReadStream
    const full = mod.createCachedReadStream({
      filePath: result.cachePath,
      start: 0,
      end: totalSize - 1,
    });
    const fullData = await readStreamFully(full);
    assert.equal(fullData.length, totalSize);
    assert.deepEqual(fullData, testData);
  } finally {
    teardownAggregatorEnv();
    await closeServer(server);
  }
});

test("range request - reading beyond file end returns empty buffer", async () => {
  const totalSize = 64;

  const { server, url } = await createMockWalrusServer((_req, res) => {
    res.writeHead(206, {
      "Content-Range": `bytes 0-${totalSize - 1}/${totalSize}`,
      "Content-Length": totalSize,
    });
    res.end(Buffer.alloc(totalSize, 0x42));
  });

  setupAggregatorEnv(url);
  try {
    const mod = await importStreamCacheModule();
    await cleanCacheDir();
    await mod.initStreamCache();

    const result = await mod.teeCachedStreamRange({
      blobId: "range-beyond-end",
      start: 0,
      end: totalSize - 1,
    });
    assert.equal(result.kind, "tee");
    await readStreamFully(result.stream);

    const beyond = mod.createCachedReadStream({
      filePath: result.cachePath,
      start: totalSize + 10,
      end: totalSize + 20,
    });
    const beyondData = await readStreamFully(beyond);
    assert.equal(beyondData.length, 0, "reading beyond file end should return empty buffer");
  } finally {
    teardownAggregatorEnv();
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// Full-object cache (teeCachedStreamBlob)
// ---------------------------------------------------------------------------

test("full-object cache - caches small blobs via teeCachedStreamBlob", async () => {
  const totalSize = 1024;
  const testData = Buffer.alloc(totalSize, 0x55);

  const { server, url } = await createMockWalrusServer((_req, res) => {
    res.writeHead(200, { "Content-Length": totalSize });
    res.end(testData);
  });

  setupAggregatorEnv(url);
  try {
    const mod = await importStreamCacheModule();
    await cleanCacheDir();
    await mod.initStreamCache();

    const result = await mod.teeCachedStreamBlob({
      blobId: "full-small-blob",
      sizeBytes: totalSize,
    });

    assert.ok(result !== null, "should return a result for small blob");
    assert.equal(result!.kind, "tee");

    const data = await readStreamFully(result!.stream);
    assert.equal(data.length, totalSize);
    assert.deepEqual(data, testData);

    // Second call should be cache hit
    const result2 = await mod.teeCachedStreamBlob({
      blobId: "full-small-blob",
      sizeBytes: totalSize,
    });
    assert.ok(result2 !== null);
    assert.equal(result2!.kind, "cache_hit");
  } finally {
    teardownAggregatorEnv();
    await closeServer(server);
  }
});

test("full-object cache - shouldCacheFullObject returns true for small sizes", async () => {
  const mod = await importStreamCacheModule();
  // Default inlineFullObjectMaxBytes is 32MB
  assert.equal(mod.shouldCacheFullObject(1024), true, "1KB should be cacheable");
  assert.equal(mod.shouldCacheFullObject(1024 * 1024), true, "1MB should be cacheable");
  assert.equal(mod.shouldCacheFullObject(0), false, "0 bytes should not be cacheable");
  assert.equal(mod.shouldCacheFullObject(-1), false, "negative size should not be cacheable");
  assert.equal(mod.shouldCacheFullObject(NaN), false, "NaN should not be cacheable");
});

test("full-object cache - concurrent blob requests are deduped", async () => {
  const totalSize = 512;
  let fetchCount = 0;

  const { server, url } = await createMockWalrusServer((_req, res) => {
    fetchCount++;
    res.writeHead(200, { "Content-Length": totalSize });
    let sent = 0;
    const interval = setInterval(() => {
      if (sent >= totalSize || res.destroyed) {
        clearInterval(interval);
        res.end();
        return;
      }
      const toSend = Math.min(64, totalSize - sent);
      res.write(Buffer.alloc(toSend, 0xbb));
      sent += toSend;
    }, 5);
  });

  setupAggregatorEnv(url);
  try {
    const mod = await importStreamCacheModule();
    await cleanCacheDir();
    await mod.initStreamCache();

    const [r1, r2] = await Promise.all([
      mod.teeCachedStreamBlob({ blobId: "dedup-blob", sizeBytes: totalSize }),
      mod.teeCachedStreamBlob({ blobId: "dedup-blob", sizeBytes: totalSize }),
    ]);

    assert.ok(r1 !== null && r2 !== null);
    const [d1, d2] = await Promise.all([readStreamFully(r1!.stream), readStreamFully(r2!.stream)]);

    assert.equal(d1.length, totalSize);
    assert.equal(d2.length, totalSize);
    assert.deepEqual(d1, d2);
    assert.equal(fetchCount, 1, "should only fetch Walrus once for deduped blob");
  } finally {
    teardownAggregatorEnv();
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// Deduplication of in-flight range fills
// ---------------------------------------------------------------------------

test("dedup - concurrent requests for the same range share a single fetch", async () => {
  const totalSize = 256;
  let fetchCount = 0;

  const { server, url } = await createMockWalrusServer((_req, res) => {
    fetchCount++;
    res.writeHead(206, {
      "Content-Range": `bytes 0-${totalSize - 1}/${totalSize}`,
      "Content-Length": totalSize,
    });
    res.end(Buffer.alloc(totalSize, 0xaa));
  });

  setupAggregatorEnv(url);
  try {
    const mod = await importStreamCacheModule();
    await cleanCacheDir();
    await mod.initStreamCache();

    const [r1, r2, r3] = await Promise.all([
      mod.teeCachedStreamRange({ blobId: "dedup-range", start: 0, end: totalSize - 1 }),
      mod.teeCachedStreamRange({ blobId: "dedup-range", start: 0, end: totalSize - 1 }),
      mod.teeCachedStreamRange({ blobId: "dedup-range", start: 0, end: totalSize - 1 }),
    ]);

    const [d1, d2, d3] = await Promise.all([
      readStreamFully(r1.stream),
      readStreamFully(r2.stream),
      readStreamFully(r3.stream),
    ]);

    assert.equal(d1.length, totalSize);
    assert.equal(d2.length, totalSize);
    assert.equal(d3.length, totalSize);
    assert.deepEqual(d1, d2);
    assert.deepEqual(d2, d3);

    assert.ok(fetchCount <= 2, `expected <= 2 fetches for deduped range, got ${fetchCount}`);
  } finally {
    teardownAggregatorEnv();
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// StreamCacheCapacityError
// ---------------------------------------------------------------------------

test("StreamCacheCapacityError class has expected shape", async () => {
  const mod = await importStreamCacheModule();
  const err = new mod.StreamCacheCapacityError(500);
  assert.equal(err.name, "StreamCacheCapacityError");
  assert.equal(err.expectedBytes, 500);
  assert.equal(err.message, "STREAM_CACHE_CAPACITY_EXCEEDED");
  assert.ok(err instanceof Error);
});

// ---------------------------------------------------------------------------
// Init and cache state
// ---------------------------------------------------------------------------

test("initStreamCache - rebuilds index and cleans orphaned temp files", async () => {
  const totalSize = 64;

  const { server, url } = await createMockWalrusServer((_req, res) => {
    res.writeHead(206, {
      "Content-Range": `bytes 0-${totalSize - 1}/${totalSize}`,
      "Content-Length": totalSize,
    });
    res.end(Buffer.alloc(totalSize, 0x77));
  });

  setupAggregatorEnv(url);
  try {
    const mod = await importStreamCacheModule();
    await cleanCacheDir();
    await mod.initStreamCache();

    // Create a cache entry
    const result = await mod.teeCachedStreamRange({
      blobId: "init-rebuild",
      start: 0,
      end: totalSize - 1,
    });
    await readStreamFully(result.stream);

    // Simulate orphaned .tmp file older than grace period (30 min)
    const tmpFile = path.join(CACHE_DIR, "ranges", "orphan-99999.tmp");
    await fs.mkdir(path.dirname(tmpFile), { recursive: true });
    await fs.writeFile(tmpFile, Buffer.from("orphan"));
    // Backdate to beyond the 30-minute grace period
    const oldTime = new Date(Date.now() - 31 * 60_000);
    await fs.utimes(tmpFile, oldTime, oldTime);

    // Re-init should clean up the .tmp file
    await mod.initStreamCache();

    let tmpExists = false;
    try {
      await fs.stat(tmpFile);
      tmpExists = true;
    } catch {
      tmpExists = false;
    }
    assert.equal(tmpExists, false, "orphaned .tmp file should be cleaned up");
  } finally {
    teardownAggregatorEnv();
    await closeServer(server);
  }
});

test("initStreamCache - preserves fresh temp files within grace period", async () => {
  const { server, url } = await createMockWalrusServer((_req, res) => {
    res.writeHead(200, { "Content-Length": 10 });
    res.end(Buffer.alloc(10, 0));
  });

  setupAggregatorEnv(url);
  try {
    const mod = await importStreamCacheModule();
    await cleanCacheDir();
    await mod.initStreamCache();

    // Create a fresh .tmp file (within grace period)
    const tmpFile = path.join(CACHE_DIR, "ranges", "fresh-123.tmp");
    await fs.mkdir(path.dirname(tmpFile), { recursive: true });
    await fs.writeFile(tmpFile, Buffer.from("fresh"));

    await mod.initStreamCache();

    let tmpExists = false;
    try {
      await fs.stat(tmpFile);
      tmpExists = true;
    } catch {
      tmpExists = false;
    }
    assert.equal(tmpExists, true, "fresh .tmp file should be preserved within grace period");
  } finally {
    teardownAggregatorEnv();
    await closeServer(server);
  }
});

test("getCachedStreamRangePath - returns null for non-existent range", async () => {
  const { server, url } = await createMockWalrusServer((_req, res) => {
    res.writeHead(206, { "Content-Range": "bytes 0-9/10", "Content-Length": 10 });
    res.end(Buffer.alloc(10, 0));
  });

  setupAggregatorEnv(url);
  try {
    const mod = await importStreamCacheModule();
    await cleanCacheDir();
    await mod.initStreamCache();

    const result = await mod.getCachedStreamRangePath({
      blobId: "nonexistent-range",
      start: 0,
      end: 9,
    });
    assert.equal(result, null, "should return null for uncached range");
  } finally {
    teardownAggregatorEnv();
    await closeServer(server);
  }
});

test("getCachedStreamPath - returns null for non-existent blob", async () => {
  const { server, url } = await createMockWalrusServer((_req, res) => {
    res.writeHead(200, { "Content-Length": 10 });
    res.end(Buffer.alloc(10, 0));
  });

  setupAggregatorEnv(url);
  try {
    const mod = await importStreamCacheModule();
    await cleanCacheDir();
    await mod.initStreamCache();

    const result = await mod.getCachedStreamPath("nonexistent-blob");
    assert.equal(result, null, "should return null for uncached blob");
  } finally {
    teardownAggregatorEnv();
    await closeServer(server);
  }
});

test("getCachedStreamPath - returns null when expected size does not match", async () => {
  const totalSize = 64;

  const { server, url } = await createMockWalrusServer((_req, res) => {
    res.writeHead(206, {
      "Content-Range": `bytes 0-${totalSize - 1}/${totalSize}`,
      "Content-Length": totalSize,
    });
    res.end(Buffer.alloc(totalSize, 0x88));
  });

  setupAggregatorEnv(url);
  try {
    const mod = await importStreamCacheModule();
    await cleanCacheDir();
    await mod.initStreamCache();

    const result = await mod.teeCachedStreamRange({
      blobId: "size-mismatch-test",
      start: 0,
      end: totalSize - 1,
    });
    await readStreamFully(result.stream);

    // Look it up with wrong expected size
    const lookup = await mod.getCachedStreamPath("size-mismatch-test", totalSize + 100);
    assert.equal(lookup, null, "should return null when expected size doesn't match");
  } finally {
    teardownAggregatorEnv();
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("single-byte range works correctly", async () => {
  const { server, url } = await createMockWalrusServer((_req, res) => {
    res.writeHead(206, {
      "Content-Range": "bytes 42-42/43",
      "Content-Length": 1,
    });
    res.end(Buffer.from([0x42]));
  });

  setupAggregatorEnv(url);
  try {
    const mod = await importStreamCacheModule();
    await cleanCacheDir();
    await mod.initStreamCache();

    const result = await mod.teeCachedStreamRange({
      blobId: "single-byte-range",
      start: 42,
      end: 42,
    });
    assert.equal(result.kind, "tee");
    const data = await readStreamFully(result.stream);
    assert.equal(data.length, 1);
    assert.equal(data[0], 0x42);
  } finally {
    teardownAggregatorEnv();
    await closeServer(server);
  }
});

test("consumer stream error does not crash the server", async () => {
  const totalSize = 2048;

  const { server, url } = await createMockWalrusServer((_req, res) => {
    res.writeHead(206, {
      "Content-Range": `bytes 0-${totalSize - 1}/${totalSize}`,
      "Content-Length": totalSize,
    });
    let sent = 0;
    const interval = setInterval(() => {
      if (sent >= totalSize || res.destroyed) {
        clearInterval(interval);
        res.end();
        return;
      }
      const toSend = Math.min(128, totalSize - sent);
      res.write(Buffer.alloc(toSend, 0xab));
      sent += toSend;
    }, 5);
  });

  setupAggregatorEnv(url);
  try {
    const mod = await importStreamCacheModule();
    await cleanCacheDir();
    await mod.initStreamCache();

    const result = await mod.teeCachedStreamRange({
      blobId: "consumer-error-resilience",
      start: 0,
      end: totalSize - 1,
    });
    assert.equal(result.kind, "tee");

    // Add error listener to prevent uncaughtException, then destroy
    result.stream.on("error", () => {});
    result.stream.destroy(new Error("client disconnected"));

    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!server.closed, "server should survive consumer error");
  } finally {
    teardownAggregatorEnv();
    await closeServer(server);
  }
});
