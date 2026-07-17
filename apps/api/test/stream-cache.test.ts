import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";

process.env.FLOE_NETWORK = "testnet";
process.env.SUI_PRIVATE_KEY = `[${new Array(32).fill(0).join(",")}]`;
process.env.SUI_PACKAGE_ID = "0x2";
process.env.UPLOAD_TMP_DIR = "/tmp/floe-test-stream-cache";
process.env.FLOE_ENFORCE_UPLOAD_OWNER = "false";
process.env.FLOE_STREAM_CACHE_MAX_BYTES = "0";
process.env.FLOE_STREAM_CACHE_MIN_FREE_DISK_BYTES = "0";
process.env.FLOE_STREAM_CACHE_TTL_MS = "0";

const CACHE_DIR = path.join("/tmp/floe-test-stream-cache", "_stream_cache");

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

test("teeCachedStreamRange - streams data from Walrus to consumer", async () => {
  const testData = Buffer.from("Hello from Walrus range stream!");
  const totalSize = testData.length;

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
      blobId: "test-blob-range-stream",
      start: 0,
      end: totalSize - 1,
    });

    assert.equal(result.kind, "tee");
    assert.ok("stream" in result);

    const consumed = await readStreamFully(result.stream);
    assert.deepEqual(consumed, testData);
  } finally {
    teardownAggregatorEnv();
    await closeServer(server);
  }
});

test("teeCachedStreamRange - concurrent consumers get same data", async () => {
  let fetchCount = 0;
  const testData = Buffer.from("Concurrent consumer test data payload");
  const totalSize = testData.length;

  const { server, url } = await createMockWalrusServer((_req, res) => {
    fetchCount++;
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

    const result1 = await mod.teeCachedStreamRange({
      blobId: "test-blob-concurrent",
      start: 0,
      end: totalSize - 1,
    });

    const result2 = await mod.teeCachedStreamRange({
      blobId: "test-blob-concurrent",
      start: 0,
      end: totalSize - 1,
    });

    assert.equal(result1.kind, "tee");
    assert.equal(result2.kind, "tee");

    const [data1, data2] = await Promise.all([
      readStreamFully(result1.stream),
      readStreamFully(result2.stream),
    ]);

    assert.deepEqual(data1, testData);
    assert.deepEqual(data2, testData);
    assert.equal(fetchCount, 1);
  } finally {
    teardownAggregatorEnv();
    await closeServer(server);
  }
});

test("teeCachedStreamRange - consumer error does not crash server", async () => {
  const totalSize = 1024;

  const { server, url } = await createMockWalrusServer((_req, res) => {
    res.writeHead(206, {
      "Content-Range": `bytes 0-${totalSize - 1}/${totalSize}`,
      "Content-Length": totalSize,
    });
    const chunk = Buffer.alloc(256, 0xab);
    let sent = 0;
    const interval = setInterval(() => {
      if (sent >= totalSize || res.destroyed) {
        clearInterval(interval);
        res.end();
        return;
      }
      const toSend = Math.min(256, totalSize - sent);
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
      blobId: "test-blob-consumer-error",
      start: 0,
      end: totalSize - 1,
    });

    assert.equal(result.kind, "tee");

    const reader = result.stream;
    const firstChunk = await new Promise<Buffer>((resolve, reject) => {
      reader.once("data", (chunk: Buffer) => resolve(chunk));
      reader.once("error", reject);
    });
    assert.ok(firstChunk.length > 0);

    reader.destroy(new Error("consumer abort"));

    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!server.closed, "server should still be alive");
  } finally {
    teardownAggregatorEnv();
    await closeServer(server);
  }
});

test("teeCachedStreamRange - abort signal destroys stream cleanly", async () => {
  const totalSize = 4096;

  const { server, url } = await createMockWalrusServer((_req, res) => {
    res.writeHead(206, {
      "Content-Range": `bytes 0-${totalSize - 1}/${totalSize}`,
      "Content-Length": totalSize,
    });
    const chunk = Buffer.alloc(128, 0xcd);
    let sent = 0;
    const interval = setInterval(() => {
      if (sent >= totalSize || res.destroyed) {
        clearInterval(interval);
        res.end();
        return;
      }
      const toSend = Math.min(128, totalSize - sent);
      res.write(Buffer.alloc(toSend, 0xcd));
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
      blobId: "test-blob-abort",
      start: 0,
      end: totalSize - 1,
      signal: ac.signal,
    });

    assert.equal(result.kind, "tee");

    ac.abort();

    await new Promise<void>((resolve, reject) => {
      result.stream.on("error", () => resolve());
      result.stream.on("close", resolve);
      result.stream.on("end", resolve);
      setTimeout(resolve, 1000);
    });

    assert.ok(
      result.stream.destroyed || result.stream.readableEnded,
      "stream should be destroyed or ended",
    );
  } finally {
    teardownAggregatorEnv();
    await closeServer(server);
  }
});
