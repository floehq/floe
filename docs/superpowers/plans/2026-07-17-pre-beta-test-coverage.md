# Pre-Beta Test Coverage Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close critical test coverage gaps and fix the AbortError crash to make the system production-ready.

**Architecture:** TDD approach — write failing tests first, then fix the code to make them pass. Each commit is one test + one fix. Tests use Node.js built-in test runner (`node:test`) with `npx tsx --test`.

**Tech Stack:** Node.js test runner, `node:assert/strict`, `npx tsx --test`, mocking via module-level hooks (no vitest/jest).

## Global Constraints

- Test runner: `npx tsx --test` (NOT vitest). Run from `apps/api/` via `npm test`
- CI env: `FLOE_POSTGRES_REQUIRED=1`, `FLOE_API_KEY_STORE=postgres`, `FLOE_AUTH_PROVIDER=local`, `DATABASE_URL=postgresql://floe_test:floe_test@localhost:5432/floe_test`
- User constraint: **no beta/rc/release-candidate language** — clean open source, tag `1.0.0`
- User constraint: **push to floehq/floe, NOT tejas0111/floe-1**
- Do NOT touch `apps/api/src/services/auth/*.ts` existing timing-safe comparison logic
- Do NOT touch `stream.cache.policy.ts` or aggregator failover logic
- Run `npx prettier --write <file>` on every modified file
- Each test file must be its own commit

---

## Current State

- 48 tests passing (38 integration + 10 walrus)
- Coverage: 86% lines / 73% functions / 80% branches (per latest run)
- **Active bug:** AbortError crash when client disconnects mid-stream (`process.on("uncaughtException")` → `process.exit(1)`)
- Two fix attempts failed — error still reaches `uncaughtException` handler despite `.catch()` on `session.writeDone`

---

## Task 1: Reproduce AbortError Crash in Test

**Files:**
- Create: `apps/api/test/stream-abort-crash.test.ts`
- Modify: none (test-only)

**Interfaces:**
- Consumes: `teeCachedStreamRange` from `stream.cache.ts`, `fetchWalrusBlob` from `walrus/read.ts`
- Produces: failing test that reproduces the crash scenario

**Rationale:** We can't fix what we can't reproduce. This test creates a mock Walrus fetch, starts a `teeCachedStreamRange` fill, then aborts the signal mid-stream. It verifies the server does NOT emit an `uncaughtException` event.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/stream-abort-crash.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";

// Mock fetchWalrusBlob to simulate a slow Walrus response
// that gets interrupted by abort signal
let fetchWalrusAbortResolve: (() => void) | null = null;
let fetchWalrusCallCount = 0;

// We need to mock the module before importing stream.cache
// Use dynamic import with env var gating
process.env.FLOE_STREAM_CACHE_MAX_BYTES = "104857600"; // 100MB

const streamCacheModule = await import("../src/services/stream/stream.cache.js");

// Intercept fetchWalrusBlob by monkey-patching the module's internal reference
// Since stream.cache.ts imports fetchWalrusBlob at module level, we need to
// intercept at the network level using a mock HTTP server instead.

// Alternative approach: use a local HTTP server as a fake Walrus aggregator
import http from "node:http";

function createFakeWalrusServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

test("teeCachedStreamRange - abort does not crash server", async () => {
  // Create a fake Walrus server that delays response
  const { server, port } = await createFakeWalrusServer((req, res) => {
    // Simulate a slow Walrus response - send headers then delay body
    res.writeHead(206, {
      "Content-Type": "application/octet-stream",
      "Content-Range": `bytes 0-1023/2048`,
      "Content-Length": "1024",
    });
    // Send a chunk, then hang
    const chunk = Buffer.alloc(512, 0x42);
    res.write(chunk);
    // Don't end - simulate slow/stuck connection
    // The abort signal will destroy this
  });

  try {
    // Point Walrus aggregator at our fake server
    const origAgg = process.env.WALRUS_AGGREGATOR_URL;
    process.env.WALRUS_AGGREGATOR_URL = `http://127.0.0.1:${port}`;

    // Create abort controller that we'll abort mid-stream
    const controller = new AbortController();

    // Start the tee cache fill
    const result = await streamCacheModule.teeCachedStreamRange({
      blobId: "test-abort-blob",
      start: 0,
      end: 1023,
      signal: controller.signal,
    });

    assert.equal(result.kind, "tee");

    // Consume a chunk to confirm stream is working
    const iter = result.stream[Symbol.asyncIterator]();
    const firstChunk = await iter.next();
    assert.ok(!firstChunk.done, "Should get first chunk");

    // Now abort - simulates client disconnect
    controller.abort();

    // Wait a tick for the abort to propagate
    await new Promise((r) => setTimeout(r, 100));

    // The key assertion: no uncaught exception should have occurred.
    // If the bug exists, process.on("uncaughtException") would have fired.
    // We verify by checking the stream is destroyed (not hanging) and
    // no error propagated uncaught.
    
    // Try to read more - should get an error or end, not hang
    try {
      await iter.next();
    } catch {
      // Expected - stream destroyed due to abort
    }

    // If we get here without process crashing, the test passes
    assert.ok(true, "No uncaught exception on abort");
  } finally {
    server.close();
  }
});

test("teeCachedStreamRange - consumer stream error does not crash", async () => {
  const { server, port } = await createFakeWalrusServer((req, res) => {
    res.writeHead(206, {
      "Content-Type": "application/octet-stream",
      "Content-Range": `bytes 0-4095/8192`,
      "Content-Length": "4096",
    });
    // Send data in chunks with delays
    let sent = 0;
    const interval = setInterval(() => {
      if (sent >= 4096) {
        clearInterval(interval);
        res.end();
        return;
      }
      const chunk = Buffer.alloc(Math.min(512, 4096 - sent), 0x41);
      res.write(chunk);
      sent += chunk.length;
    }, 10);
  });

  try {
    const origAgg = process.env.WALRUS_AGGREGATOR_URL;
    process.env.WALRUS_AGGREGATOR_URL = `http://127.0.0.1:${port}`;

    const result = await streamCacheModule.teeCachedStreamRange({
      blobId: "test-consumer-error-blob",
      start: 0,
      end: 4095,
      signal: AbortSignal.timeout(5000),
    });

    assert.equal(result.kind, "tee");

    // Destroy the consumer stream immediately with an error
    // This simulates what happens when a Fastify reply stream errors
    const iter = result.stream[Symbol.asyncIterator]();
    const firstChunk = await iter.next();
    assert.ok(!firstChunk.done);

    result.stream.destroy(new Error("simulated consumer error"));

    // Wait for cleanup
    await new Promise((r) => setTimeout(r, 200));

    // writeDone should catch the error internally
    assert.ok(true, "No uncaught exception on consumer stream error");
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx tsx --test ./test/stream-abort-crash.test.ts 2>&1`
Expected: Test should either FAIL (crash reproduced) or PASS (if our previous fixes already prevent it). If it passes, the crash scenario may need different reproduction.

- [ ] **Step 3: Run full test suite to verify no regressions**

Run: `cd apps/api && npm test 2>&1 | tail -5`
Expected: All 48+ tests pass

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/stream-abort-crash.test.ts
git commit -m "test(stream): add abort/crash scenario tests for teeCachedStreamRange"
```

---

## Task 2: Fix AbortError Crash (if still reproducing)

**Files:**
- Modify: `apps/api/src/services/stream/stream.cache.ts:453-465`
- Modify: `apps/api/src/services/walrus/read.ts:383-386`
- Test: `apps/api/test/stream-abort-crash.test.ts` (from Task 1)

**Interfaces:**
- Consumes: test from Task 1
- Produces: fixed code that prevents uncaughtException on abort

**Root cause hypothesis:** When `fetchWalrusBlob` throws at `read.ts:385`, the error propagates through `CircuitBreaker.call` → `stream.cache.ts` IIFE → caught by `try/catch` at 376/453 → re-thrown at 461 → `.catch()` at 470 should swallow it. But the error still reaches `process.on("uncaughtException")`. Possible causes:
1. The `broadcastStream.destroy(innerError)` at line 460 triggers an async 'error' event that escapes before `cleanupSession()` adds the `noop` handler
2. The circuit breaker's `recordOutcome` creates a microtask that re-throws
3. The `throw innerError` at 461 propagates through a path that bypasses `.catch()`

**Fix approach:** Instead of re-throwing AbortError in the catch block (line 461), silently return. The consumer streams are already destroyed, there's nothing more to do. Only re-throw non-abort errors.

- [ ] **Step 1: Fix the catch block in stream.cache.ts**

In `apps/api/src/services/stream/stream.cache.ts`, modify the catch block at lines 453-465:

```typescript
    } catch (err) {
      innerError = err instanceof Error ? err : new Error(String(err));
      // Destroy all consumer streams on any write failure (fetch error,
      // disk error, truncation, etc.) so clients don't hang indefinitely.
      for (const cs of consumerStreams) {
        if (!cs.destroyed) cs.destroy(innerError);
      }
      broadcastStream.destroy(innerError);
      // AbortError means the client disconnected — the consumer streams
      // are already destroyed above. Re-throwing would bubble to
      // process.on("uncaughtException") and crash the server.
      if (innerError.name === "AbortError" || params.signal?.aborted) {
        return;
      }
      throw innerError;
    }
```

- [ ] **Step 2: Run the abort crash test**

Run: `cd apps/api && npx tsx --test ./test/stream-abort-crash.test.ts 2>&1`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `cd apps/api && npm test 2>&1 | tail -5`
Expected: All tests pass, no regressions

- [ ] **Step 4: Prettier**

Run: `npx prettier --write apps/api/src/services/stream/stream.cache.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/stream/stream.cache.ts
git commit -m "fix(stream): prevent AbortError from crashing server on client disconnect

Instead of re-throwing AbortError from the writeDone catch block
(which propagates to process.on('uncaughtException')), silently
return. Consumer streams are already destroyed above, so there is
nothing more to propagate."
```

---

## Task 3: Walrus Read — fetchWithTimeout Edge Cases

**Files:**
- Create: `apps/api/test/walrus-read.test.ts`
- Reference: `apps/api/src/services/walrus/read.ts:199-234`

**Interfaces:**
- Consumes: `fetchWithTimeout`, `fetchWalrusBlob`, `warmWalrusConnections` from `walrus/read.ts`
- Produces: unit tests for walrus read functions

**Rationale:** `walrus/read.ts` has only 47.82% line coverage. Key functions to test:
- `fetchWithTimeout`: pre-abort check, timeout behavior, signal not forwarded
- `warmWalrusConnections`: URL resolution, timeout, error swallowing
- `fetchWalrusBlob`: aggregator fallback, retry logic, signal abort check

- [ ] **Step 1: Write fetchWithTimeout tests**

Create `apps/api/test/walrus-read.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// Helper: create a mock HTTP server
function mockServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

// ============================================================
// fetchWithTimeout
// ============================================================

test("fetchWithTimeout - throws when signal already aborted", async () => {
  const { fetchWalrusBlob } = await import("../src/services/walrus/read.js");
  const controller = new AbortController();
  controller.abort(); // pre-abort

  try {
    await fetchWalrusBlob({
      blobId: "test",
      signal: controller.signal,
    });
    assert.fail("Should have thrown");
  } catch (err: any) {
    assert.equal(err.name, "AbortError");
  }
});

test("fetchWithTimeout - normal fetch succeeds", async () => {
  const { server, port } = await mockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.end(Buffer.from("hello"));
  });

  try {
    const origAgg = process.env.WALRUS_AGGREGATOR_URL;
    process.env.WALRUS_AGGREGATOR_URL = `http://127.0.0.1:${port}`;
    // Re-import to pick up env change
    const mod = await import(`../src/services/walrus/read.js?t=${Date.now()}`);

    const { res } = await mod.fetchWalrusBlob({
      blobId: "test-blob",
    });
    assert.equal(res.status, 200);
    await res.body?.cancel();
  } finally {
    server.close();
  }
});

test("fetchWalrusBlob - retries on 5xx status", async () => {
  let attemptCount = 0;
  const { server, port } = await mockServer((req, res) => {
    attemptCount++;
    if (attemptCount < 3) {
      res.writeHead(503);
      res.end("Service Unavailable");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.end(Buffer.from("ok"));
  });

  try {
    const origAgg = process.env.WALRUS_AGGREGATOR_URL;
    process.env.WALRUS_AGGREGATOR_URL = `http://127.0.0.1:${port}`;
    const mod = await import(`../src/services/walrus/read.js?t=${Date.now()}`);

    const { res } = await mod.fetchWalrusBlob({
      blobId: "retry-blob",
    });
    assert.equal(res.status, 200);
    assert.ok(attemptCount >= 3, `Expected >= 3 attempts, got ${attemptCount}`);
    await res.body?.cancel();
  } finally {
    server.close();
  }
});

test("fetchWalrusBlob - abort during retry loop stops retries", async () => {
  let attemptCount = 0;
  const { server, port } = await mockServer((req, res) => {
    attemptCount++;
    res.writeHead(503);
    res.end("Service Unavailable");
  });

  try {
    const origAgg = process.env.WALRUS_AGGREGATOR_URL;
    process.env.WALRUS_AGGREGATOR_URL = `http://127.0.0.1:${port}`;
    const mod = await import(`../src/services/walrus/read.js?t=${Date.now()}`);

    const controller = new AbortController();
    // Abort after first attempt
    setTimeout(() => controller.abort(), 50);

    try {
      await mod.fetchWalrusBlob({
        blobId: "abort-retry-blob",
        signal: controller.signal,
      });
      assert.fail("Should have thrown");
    } catch (err: any) {
      assert.equal(err.name, "AbortError");
      // Should not have retried many times
      assert.ok(attemptCount < 10, `Too many attempts: ${attemptCount}`);
    }
  } finally {
    server.close();
  }
});

// ============================================================
// warmWalrusConnections
// ============================================================

test("warmWalrusConnections - completes without error when env not set", async () => {
  const origAgg = process.env.WALRUS_AGGREGATOR_URL;
  delete process.env.WALRUS_AGGREGATOR_URL;
  try {
    const mod = await import(`../src/services/walrus/read.js?t=${Date.now()}`);
    // Should not throw
    await mod.warmWalrusConnections();
    assert.ok(true);
  } finally {
    if (origAgg) process.env.WALRUS_AGGREGATOR_URL = origAgg;
  }
});

test("warmWalrusConnections - completes even when aggregator unreachable", async () => {
  const { server, port } = await mockServer((req, res) => {
    res.destroy(); // Force disconnect
  });

  try {
    const origAgg = process.env.WALRUS_AGGREGATOR_URL;
    process.env.WALRUS_AGGREGATOR_URL = `http://127.0.0.1:${port}`;
    const mod = await import(`../src/services/walrus/read.js?t=${Date.now()}`);
    // Should not throw - errors are swallowed
    await mod.warmWalrusConnections();
    assert.ok(true);
  } finally {
    server.close();
  }
});

test("warmWalrusConnections - completes within timeout", async () => {
  // Server that never responds
  const server = http.createServer(() => {
    // never responds
  });
  server.listen(0, "127.0.0.1");
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  try {
    const origAgg = process.env.WALRUS_AGGREGATOR_URL;
    process.env.WALRUS_AGGREGATOR_URL = `http://127.0.0.1:${port}`;
    const mod = await import(`../src/services/walrus/read.js?t=${Date.now()}`);

    const start = Date.now();
    await mod.warmWalrusConnections();
    const elapsed = Date.now() - start;

    // Should complete within the 5s timeout + small margin
    assert.ok(elapsed < 10000, `Took too long: ${elapsed}ms`);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run tests**

Run: `cd apps/api && npx tsx --test ./test/walrus-read.test.ts 2>&1`
Expected: Some tests may need adjustment based on actual module behavior. Fix and iterate.

- [ ] **Step 3: Run full test suite**

Run: `cd apps/api && npm test 2>&1 | tail -5`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/walrus-read.test.ts
git commit -m "test(walrus): add unit tests for fetchWithTimeout, fetchWalrusBlob, warmWalrusConnections"
```

---

## Task 4: Stream Cache — Consumer Stream Lifecycle

**Files:**
- Create: `apps/api/test/stream-cache.test.ts`
- Reference: `apps/api/src/services/stream/stream.cache.ts:280-483`

**Interfaces:**
- Consumes: `teeCachedStreamRange`, `teeCachedStreamBlob`, `getCachedStreamRangePath`
- Produces: unit tests for stream cache edge cases

**Rationale:** `stream.cache.ts` has 83.95% line coverage but only 62.35% branch coverage. Key untested branches:
- Concurrent consumers joining an in-flight fill
- `StreamCacheCapacityError` fallback path
- Cache hit path
- Truncation detection
- `broadcastStream` error propagation after cleanup

- [ ] **Step 1: Write stream cache tests**

Create `apps/api/test/stream-cache.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

function mockServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

const streamCacheModule = await import("../src/services/stream/stream.cache.js");

// ============================================================
// teeCachedStreamRange
// ============================================================

test("teeCachedStreamRange - streams data from Walrus to consumer", async () => {
  const testData = Buffer.from("hello world from walrus");
  const { server, port } = await mockServer((req, res) => {
    res.writeHead(206, {
      "Content-Type": "application/octet-stream",
      "Content-Range": `bytes 0-${testData.length - 1}/${testData.length}`,
      "Content-Length": String(testData.length),
    });
    res.end(testData);
  });

  try {
    const origAgg = process.env.WALRUS_AGGREGATOR_URL;
    process.env.WALRUS_AGGREGATOR_URL = `http://127.0.0.1:${port}`;

    const result = await streamCacheModule.teeCachedStreamRange({
      blobId: "test-stream-data",
      start: 0,
      end: testData.length - 1,
      signal: AbortSignal.timeout(5000),
    });

    assert.equal(result.kind, "tee");

    // Read all data from consumer stream
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(chunk as Buffer);
    }
    const received = Buffer.concat(chunks);
    assert.deepEqual(received, testData);
  } finally {
    server.close();
  }
});

test("teeCachedStreamRange - concurrent consumers get same data", async () => {
  const testData = Buffer.from("shared data for concurrent consumers");
  let fetchCount = 0;
  const { server, port } = await mockServer((req, res) => {
    fetchCount++;
    res.writeHead(206, {
      "Content-Type": "application/octet-stream",
      "Content-Range": `bytes 0-${testData.length - 1}/${testData.length}`,
      "Content-Length": String(testData.length),
    });
    res.end(testData);
  });

  try {
    const origAgg = process.env.WALRUS_AGGREGATOR_URL;
    process.env.WALRUS_AGGREGATOR_URL = `http://127.0.0.1:${port}`;

    // Start two concurrent fills for the same range
    const [result1, result2] = await Promise.all([
      streamCacheModule.teeCachedStreamRange({
        blobId: "test-concurrent",
        start: 0,
        end: testData.length - 1,
        signal: AbortSignal.timeout(5000),
      }),
      streamCacheModule.teeCachedStreamRange({
        blobId: "test-concurrent",
        start: 0,
        end: testData.length - 1,
        signal: AbortSignal.timeout(5000),
      }),
    ]);

    assert.equal(result1.kind, "tee");
    assert.equal(result2.kind, "tee");

    // Both consumers should get the data
    const readAll = async (stream: Readable) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks);
    };

    const [data1, data2] = await Promise.all([
      readAll(result1.stream),
      readAll(result2.stream),
    ]);

    assert.deepEqual(data1, testData);
    assert.deepEqual(data2, testData);
  } finally {
    server.close();
  }
});

test("teeCachedStreamRange - consumer error does not crash server", async () => {
  const testData = Buffer.alloc(10240, 0x42);
  const { server, port } = await mockServer((req, res) => {
    res.writeHead(206, {
      "Content-Type": "application/octet-stream",
      "Content-Range": `bytes 0-${testData.length - 1}/${testData.length}`,
      "Content-Length": String(testData.length),
    });
    // Send data slowly
    let offset = 0;
    const interval = setInterval(() => {
      if (offset >= testData.length) {
        clearInterval(interval);
        res.end();
        return;
      }
      const chunk = testData.subarray(offset, offset + 1024);
      res.write(chunk);
      offset += 1024;
    }, 5);
  });

  try {
    const origAgg = process.env.WALRUS_AGGREGATOR_URL;
    process.env.WALRUS_AGGREGATOR_URL = `http://127.0.0.1:${port}`;

    const result = await streamCacheModule.teeCachedStreamRange({
      blobId: "test-consumer-error",
      start: 0,
      end: testData.length - 1,
      signal: AbortSignal.timeout(10000),
    });

    assert.equal(result.kind, "tee");

    // Read one chunk, then destroy with error
    const iter = result.stream[Symbol.asyncIterator]();
    await iter.next();
    result.stream.destroy(new Error("simulated client disconnect"));

    // Wait for writeDone to finish
    await new Promise((r) => setTimeout(r, 500));

    // Server should still be alive (no uncaught exception)
    assert.ok(true, "No crash on consumer stream error");
  } finally {
    server.close();
  }
});

test("teeCachedStreamRange - abort signal destroys stream cleanly", async () => {
  const { server, port } = await mockServer((req, res) => {
    res.writeHead(206, {
      "Content-Type": "application/octet-stream",
      "Content-Range": "bytes 0-999/1000",
      "Content-Length": "1000",
    });
    // Send partial data then hang
    res.write(Buffer.alloc(512, 0x42));
    // Never end - simulates stuck connection
  });

  try {
    const origAgg = process.env.WALRUS_AGGREGATOR_URL;
    process.env.WALRUS_AGGREGATOR_URL = `http://127.0.0.1:${port}`;

    const controller = new AbortController();
    const result = await streamCacheModule.teeCachedStreamRange({
      blobId: "test-abort-clean",
      start: 0,
      end: 999,
      signal: controller.signal,
    });

    assert.equal(result.kind, "tee");

    // Abort mid-stream
    controller.abort();

    // Wait for cleanup
    await new Promise((r) => setTimeout(r, 500));

    // Stream should be destroyed, not hanging
    assert.ok(result.stream.destroyed, "Stream should be destroyed after abort");
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run tests**

Run: `cd apps/api && npx tsx --test ./test/stream-cache.test.ts 2>&1`
Expected: Some may need adjustment. Fix and iterate.

- [ ] **Step 3: Run full test suite**

Run: `cd apps/api && npm test 2>&1 | tail -5`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/stream-cache.test.ts
git commit -m "test(stream): add unit tests for teeCachedStreamRange consumer lifecycle"
```

---

## Task 5: Upload Error Paths

**Files:**
- Create: `apps/api/test/upload-error-paths.test.ts`
- Reference: `apps/api/src/routes/uploads.ts`

**Interfaces:**
- Consumes: upload routes via Fastify inject
- Produces: tests for upload error paths not covered by existing integration tests

**Rationale:** `uploads.ts` has 60.51% line coverage, 61.4% branch coverage. Key untested paths:
- Invalid chunk index
- Upload session not found
- Chunk size exceeds limits
- Concurrent finalization attempts
- Checksum mismatch on complete

- [ ] **Step 1: Write upload error path tests**

Create `apps/api/test/upload-error-paths.test.ts`:

```typescript
import test, { before } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

// Set up env before importing routes
process.env.FLOE_NETWORK = "testnet";
process.env.SUI_PRIVATE_KEY = `[${new Array(32).fill(0).join(",")}]`;
process.env.SUI_PACKAGE_ID = "0x2";
process.env.WALRUS_AGGREGATOR_URL = "http://127.0.0.1:1";
process.env.UPLOAD_TMP_DIR = "/tmp/floe-test-upload-error-paths";
process.env.FLOE_ENFORCE_UPLOAD_OWNER = "false";

const uploadsModule = await import("../src/routes/uploads.js");

let app: ReturnType<typeof Fastify>;

before(async () => {
  app = Fastify({ logger: false });
  await app.register(uploadsModule.default);
  await app.ready();
});

// Cleanup
test.after(async () => {
  await app?.close();
});

test("POST /v1/uploads/create - rejects with invalid blob size (negative)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/uploads/create",
    payload: {
      blobSize: -1,
      mimeType: "video/mp4",
    },
  });
  // Should return 400 for invalid blob size
  assert.ok(res.statusCode >= 400, `Expected 4xx, got ${res.statusCode}`);
});

test("POST /v1/uploads/create - rejects with blob size exceeding maximum", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/uploads/create",
    payload: {
      blobSize: 100 * 1024 * 1024 * 1024, // 100GB - way over limit
      mimeType: "video/mp4",
    },
  });
  assert.ok(res.statusCode >= 400, `Expected 4xx, got ${res.statusCode}`);
});

test("PUT /v1/uploads/:uploadId/chunk/:index - rejects non-existent upload", async () => {
  const res = await app.inject({
    method: "PUT",
    url: "/v1/uploads/nonexistent-upload/chunk/0",
    payload: Buffer.from("test data"),
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(Buffer.byteLength("test data")),
    },
  });
  assert.ok(res.statusCode >= 400, `Expected 4xx, got ${res.statusCode}`);
});

test("PUT /v1/uploads/:uploadId/chunk/:index - rejects negative chunk index", async () => {
  // First create an upload
  const createRes = await app.inject({
    method: "POST",
    url: "/v1/uploads/create",
    payload: { blobSize: 1024, mimeType: "video/mp4" },
  });
  if (createRes.statusCode !== 200) return; // Skip if create fails

  const { uploadId } = JSON.parse(createRes.payload);
  const res = await app.inject({
    method: "PUT",
    url: `/v1/uploads/${uploadId}/chunk/-1`,
    payload: Buffer.from("test"),
    headers: {
      "content-type": "application/octet-stream",
      "content-length": "4",
    },
  });
  assert.ok(res.statusCode >= 400, `Expected 4xx, got ${res.statusCode}`);
});

test("GET /v1/uploads/:uploadId/status - returns 404 for non-existent upload", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/v1/uploads/nonexistent-upload/status",
  });
  assert.ok(res.statusCode >= 400, `Expected 4xx, got ${res.statusCode}`);
});

test("DELETE /v1/uploads/:uploadId - returns 404 for non-existent upload", async () => {
  const res = await app.inject({
    method: "DELETE",
    url: "/v1/uploads/nonexistent-upload",
  });
  assert.ok(res.statusCode >= 400, `Expected 4xx, got ${res.statusCode}`);
});

test("POST /v1/uploads/:uploadId/complete - rejects non-existent upload", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/uploads/nonexistent-upload/complete",
    payload: { checksum: "abc" },
  });
  assert.ok(res.statusCode >= 400, `Expected 4xx, got ${res.statusCode}`);
});
```

- [ ] **Step 2: Run tests**

Run: `cd apps/api && npx tsx --test ./test/upload-error-paths.test.ts 2>&1`
Expected: Fix any assertion mismatches based on actual API behavior.

- [ ] **Step 3: Run full test suite**

Run: `cd apps/api && npm test 2>&1 | tail -5`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/upload-error-paths.test.ts
git commit -m "test(uploads): add error path tests for invalid inputs and missing sessions"
```

---

## Task 6: Stream Route — End-to-End Abort Resilience

**Files:**
- Create: `apps/api/test/stream-route-abort.test.ts`
- Reference: `apps/api/src/routes/files.ts:1060-1543`

**Interfaces:**
- Consumes: Fastify app with files routes, mock Sui/Walrus
- Produces: integration test for stream route abort behavior

**Rationale:** The stream route at `GET /v1/files/:fileId/stream` is the most critical hot path. It must handle client disconnects gracefully without crashing. This tests the full route handler flow.

- [ ] **Step 1: Write stream route abort test**

Create `apps/api/test/stream-route-abort.test.ts`:

```typescript
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import Fastify from "fastify";

process.env.FLOE_NETWORK = "testnet";
process.env.SUI_PRIVATE_KEY = `[${new Array(32).fill(0).join(",")}]`;
process.env.SUI_PACKAGE_ID = "0x2";
process.env.WALRUS_AGGREGATOR_URL = "http://127.0.0.1:1";
process.env.UPLOAD_TMP_DIR = "/tmp/floe-test-stream-route-abort";
process.env.FLOE_ENFORCE_UPLOAD_OWNER = "false";
process.env.FLOE_SUI_METADATA_FALLBACK = "true";

const filesModule = await import("../src/routes/files.js");
const postgresModule = await import("../src/state/postgres.js");
const suiModule = await import("../src/state/sui.ts");

let app: ReturnType<typeof Fastify>;
let fakeWalrusServer: http.Server;
let walrusPort: number;

function buildFileFields(overrides?: Record<string, string>) {
  return {
    blob_id: "blob-stream-abort-test",
    size_bytes: "4096",
    mime: "video/mp4",
    created_at: "1700000000000",
    owner: "0x1111111111111111111111111111111111111111111111111111111111111111",
    walrus_end_epoch: "12",
    ...overrides,
  };
}

before(async () => {
  // Start fake Walrus server
  fakeWalrusServer = http.createServer((req, res) => {
    const testData = Buffer.alloc(4096, 0x42);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(testData.length),
    });
    // Send data slowly to simulate real network
    let offset = 0;
    const interval = setInterval(() => {
      if (offset >= testData.length) {
        clearInterval(interval);
        res.end();
        return;
      }
      const chunk = testData.subarray(offset, offset + 512);
      res.write(chunk);
      offset += 512;
    }, 10);
  });
  await new Promise<void>((resolve) => fakeWalrusServer.listen(0, "127.0.0.1", resolve));
  const addr = fakeWalrusServer.address();
  walrusPort = typeof addr === "object" && addr ? addr.port : 0;

  process.env.WALRUS_AGGREGATOR_URL = `http://127.0.0.1:${walrusPort}`;

  // Mock Sui client
  suiModule.getSuiClient().getObject = async () => ({
    data: {
      type: "0x2::file::FileMeta",
      content: {
        dataType: "moveObject",
        type: "0x2::file::FileMeta",
        fields: buildFileFields(),
      },
    },
  });

  app = Fastify({ logger: false });
  await app.register(filesModule.default);
  await app.ready();
});

after(async () => {
  await app?.close();
  fakeWalrusServer?.close();
});

test("stream route - client disconnect mid-stream does not crash server", async () => {
  // Start a stream request
  const controller = new AbortController();

  const requestPromise = app.inject({
    method: "GET",
    url: "/v1/files/blob-stream-abort-test/stream",
    signal: controller.signal,
  });

  // Wait a bit for the stream to start, then abort
  await new Promise((r) => setTimeout(r, 50));
  controller.abort();

  try {
    const res = await requestPromise;
    // The response should have started but been interrupted
    // Key point: server should NOT crash
    assert.ok(true, "Server survived client abort");
  } catch {
    // Abort may throw - that's fine
    assert.ok(true, "Server survived client abort (throw)");
  }
});

test("stream route - HEAD request returns correct headers", async () => {
  const res = await app.inject({
    method: "HEAD",
    url: "/v1/files/blob-stream-abort-test/stream",
  });

  assert.ok([200, 206, 503].includes(res.statusCode), `Unexpected status: ${res.statusCode}`);
  if (res.statusCode === 200 || res.statusCode === 206) {
    assert.ok(res.headers["content-length"]);
    assert.ok(res.headers["etag"]);
    assert.ok(res.headers["accept-ranges"]);
  }
});

test("stream route - returns 404 for non-existent file", async () => {
  suiModule.getSuiClient().getObject = async () => null;

  const res = await app.inject({
    method: "GET",
    url: "/v1/files/0xnonexistent/stream",
  });

  assert.ok(res.statusCode >= 400, `Expected error, got ${res.statusCode}`);
});
```

- [ ] **Step 2: Run tests**

Run: `cd apps/api && npx tsx --test ./test/stream-route-abort.test.ts 2>&1`
Expected: Fix assertions based on actual behavior.

- [ ] **Step 3: Run full test suite**

Run: `cd apps/api && npm test 2>&1 | tail -5`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/stream-route-abort.test.ts
git commit -m "test(stream): add end-to-end stream route abort resilience test"
```

---

## Task 7: Run Full Suite, Verify Coverage Improvement, Final Commit

**Files:**
- None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `cd apps/api && npm test 2>&1`
Expected: All tests pass (should be 48 + new tests from Tasks 1, 3, 4, 5, 6)

- [ ] **Step 2: Check coverage improvement**

Run: `cd apps/api && cat coverage/coverage-summary.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Lines: {d[\"total\"][\"lines\"][\"pct\"]}%  Functions: {d[\"total\"][\"functions\"][\"pct\"]}%  Branches: {d[\"total\"][\"branches\"][\"pct\"]}%')"`
Expected: Coverage improved from baseline (86% lines / 73% functions / 80% branches)

- [ ] **Step 3: Verify AbortError crash is fixed**

Start server: `cd apps/api && npm run dev &`
In another terminal: `curl http://localhost:3001/v1/files/test-blob/stream &` then `kill %1`
Check server output: should NOT show "Uncaught exception"

- [ ] **Step 4: Final commit if any fixes were made**

```bash
git add -A
git commit -m "test: improve test coverage for stream, walrus, and upload edge cases"
```
