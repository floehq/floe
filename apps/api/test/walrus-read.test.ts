import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fetchWalrusBlob, warmWalrusConnections } from "../src/services/walrus/read.js";
import { walrusReadCircuit } from "../src/services/circuit-breaker/instances.js";

function createMockServer(
  handler: http.RequestListener,
): Promise<{ server: http.Server; port: number; url: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get server address"));
        return;
      }
      resolve({ server, port: addr.port, url: `http://127.0.0.1:${addr.port}` });
    });
    server.on("error", reject);
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ============================================================
// fetchWalrusBlob edge cases
// ============================================================

test("fetchWalrusBlob - throws AbortError when signal already aborted", async () => {
  walrusReadCircuit.reset();
  const { server, url } = await createMockServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  const prevAgg = process.env.WALRUS_AGGREGATOR_URL;
  const prevFallback = process.env.WALRUS_AGGREGATOR_FALLBACK_URLS;
  process.env.WALRUS_AGGREGATOR_URL = url;
  process.env.WALRUS_AGGREGATOR_FALLBACK_URLS = "";
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => fetchWalrusBlob({ blobId: "test-blob", signal: controller.signal }),
      (err: Error) => {
        assert.equal(err.name, "AbortError");
        return true;
      },
    );
  } finally {
    if (prevAgg !== undefined) process.env.WALRUS_AGGREGATOR_URL = prevAgg;
    else delete process.env.WALRUS_AGGREGATOR_URL;
    if (prevFallback !== undefined) process.env.WALRUS_AGGREGATOR_FALLBACK_URLS = prevFallback;
    else delete process.env.WALRUS_AGGREGATOR_FALLBACK_URLS;
    await closeServer(server);
  }
});

test("fetchWalrusBlob - succeeds with valid aggregator", async () => {
  walrusReadCircuit.reset();
  const { server, url } = await createMockServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.end("blob-data-123");
  });
  const prevAgg = process.env.WALRUS_AGGREGATOR_URL;
  const prevFallback = process.env.WALRUS_AGGREGATOR_FALLBACK_URLS;
  process.env.WALRUS_AGGREGATOR_URL = url;
  process.env.WALRUS_AGGREGATOR_FALLBACK_URLS = "";
  try {
    const result = await fetchWalrusBlob({ blobId: "test-blob" });
    assert.equal(result.res.status, 200);
    assert.equal(result.aggregatorUrl, url);
    const body = await result.res.text();
    assert.equal(body, "blob-data-123");
  } finally {
    if (prevAgg !== undefined) process.env.WALRUS_AGGREGATOR_URL = prevAgg;
    else delete process.env.WALRUS_AGGREGATOR_URL;
    if (prevFallback !== undefined) process.env.WALRUS_AGGREGATOR_FALLBACK_URLS = prevFallback;
    else delete process.env.WALRUS_AGGREGATOR_FALLBACK_URLS;
    await closeServer(server);
  }
});

test("fetchWalrusBlob - retries on 5xx then succeeds", { timeout: 15_000 }, async () => {
  walrusReadCircuit.reset();
  let requestCount = 0;
  const { server, url } = await createMockServer((_req, res) => {
    requestCount++;
    if (requestCount <= 2) {
      res.writeHead(503);
      res.end("service unavailable");
    } else {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end("blob-data");
    }
  });
  const prevAgg = process.env.WALRUS_AGGREGATOR_URL;
  const prevFallback = process.env.WALRUS_AGGREGATOR_FALLBACK_URLS;
  process.env.WALRUS_AGGREGATOR_URL = url;
  process.env.WALRUS_AGGREGATOR_FALLBACK_URLS = "";
  try {
    const result = await fetchWalrusBlob({ blobId: "test-blob" });
    assert.equal(result.res.status, 200);
    assert.equal(requestCount, 3, "should retry twice then succeed on third attempt");
  } finally {
    if (prevAgg !== undefined) process.env.WALRUS_AGGREGATOR_URL = prevAgg;
    else delete process.env.WALRUS_AGGREGATOR_URL;
    if (prevFallback !== undefined) process.env.WALRUS_AGGREGATOR_FALLBACK_URLS = prevFallback;
    else delete process.env.WALRUS_AGGREGATOR_FALLBACK_URLS;
    await closeServer(server);
  }
});

test(
  "fetchWalrusBlob - abort during retry stops further attempts",
  { timeout: 10_000 },
  async () => {
    walrusReadCircuit.reset();
    let requestCount = 0;
    const { server, url } = await createMockServer((_req, res) => {
      requestCount++;
      res.writeHead(503);
      res.end("service unavailable");
    });
    const prevAgg = process.env.WALRUS_AGGREGATOR_URL;
    const prevFallback = process.env.WALRUS_AGGREGATOR_FALLBACK_URLS;
    process.env.WALRUS_AGGREGATOR_URL = url;
    process.env.WALRUS_AGGREGATOR_FALLBACK_URLS = "";
    const controller = new AbortController();
    try {
      const abortTimer = setTimeout(() => controller.abort(), 100);
      await assert.rejects(
        () => fetchWalrusBlob({ blobId: "test-blob", signal: controller.signal }),
        (err: Error) => {
          assert.equal(err.name, "AbortError");
          return true;
        },
      );
      clearTimeout(abortTimer);
      assert.ok(requestCount <= 2, `Expected <=2 requests before abort, got ${requestCount}`);
    } finally {
      if (prevAgg !== undefined) process.env.WALRUS_AGGREGATOR_URL = prevAgg;
      else delete process.env.WALRUS_AGGREGATOR_URL;
      if (prevFallback !== undefined) process.env.WALRUS_AGGREGATOR_FALLBACK_URLS = prevFallback;
      else delete process.env.WALRUS_AGGREGATOR_FALLBACK_URLS;
      await closeServer(server);
    }
  },
);

// ============================================================
// warmWalrusConnections edge cases
// ============================================================

test("warmWalrusConnections - completes without error when env not set", async () => {
  const prevAgg = process.env.WALRUS_AGGREGATOR_URL;
  const prevFallback = process.env.WALRUS_AGGREGATOR_FALLBACK_URLS;
  delete process.env.WALRUS_AGGREGATOR_URL;
  delete process.env.WALRUS_AGGREGATOR_FALLBACK_URLS;
  try {
    await warmWalrusConnections();
  } finally {
    if (prevAgg !== undefined) process.env.WALRUS_AGGREGATOR_URL = prevAgg;
    if (prevFallback !== undefined) process.env.WALRUS_AGGREGATOR_FALLBACK_URLS = prevFallback;
  }
});

test("warmWalrusConnections - completes even when aggregator unreachable", async () => {
  const { server, url } = await createMockServer((_req, res) => {
    res.socket?.destroy();
  });
  const prevAgg = process.env.WALRUS_AGGREGATOR_URL;
  const prevFallback = process.env.WALRUS_AGGREGATOR_FALLBACK_URLS;
  process.env.WALRUS_AGGREGATOR_URL = url;
  process.env.WALRUS_AGGREGATOR_FALLBACK_URLS = "";
  try {
    await warmWalrusConnections();
  } finally {
    if (prevAgg !== undefined) process.env.WALRUS_AGGREGATOR_URL = prevAgg;
    else delete process.env.WALRUS_AGGREGATOR_URL;
    if (prevFallback !== undefined) process.env.WALRUS_AGGREGATOR_FALLBACK_URLS = prevFallback;
    else delete process.env.WALRUS_AGGREGATOR_FALLBACK_URLS;
    await closeServer(server);
  }
});

test("warmWalrusConnections - completes within timeout", { timeout: 15_000 }, async () => {
  const { server, url } = await createMockServer((_req, _res) => {
    // Never respond — let the client's 5s abort timeout fire.
  });
  const prevAgg = process.env.WALRUS_AGGREGATOR_URL;
  const prevFallback = process.env.WALRUS_AGGREGATOR_FALLBACK_URLS;
  process.env.WALRUS_AGGREGATOR_URL = url;
  process.env.WALRUS_AGGREGATOR_FALLBACK_URLS = "";
  try {
    const start = Date.now();
    await warmWalrusConnections();
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 10_000, `Expected <10s, got ${elapsed}ms`);
  } finally {
    if (prevAgg !== undefined) process.env.WALRUS_AGGREGATOR_URL = prevAgg;
    else delete process.env.WALRUS_AGGREGATOR_URL;
    if (prevFallback !== undefined) process.env.WALRUS_AGGREGATOR_FALLBACK_URLS = prevFallback;
    else delete process.env.WALRUS_AGGREGATOR_FALLBACK_URLS;
    await closeServer(server);
  }
});
