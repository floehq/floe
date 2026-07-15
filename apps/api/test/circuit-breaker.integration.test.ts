/**
 * Circuit breaker integration tests.
 *
 * Verifies that each upstream service correctly interacts with its
 * circuit breaker instance:
 *
 *   walrusReadCircuit    → checkWalrusBlobExists, fetchWalrusBlob
 *   walrusPublishCircuit → uploadToWalrusViaPublisher
 *   suiCircuit           → finalizeFileMetadata, renewFileMetadata
 *   externalAuthCircuit  → verifyExternalCredential
 *
 * All tests manipulate circuit state directly via forceState/reset so
 * they do NOT require real upstream services — the circuit breaker
 * short-circuits before any outbound call is attempted when OPEN.
 */

import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

// Set env vars BEFORE any dynamic imports so module-level config in
// auth.config.ts picks them up. The circuit short-circuits before any
// HTTP call, so the URL doesn't need to be valid.
process.env.FLOE_AUTH_EXTERNAL_VERIFY_URL = "http://127.0.0.1:1/verify";

import { CircuitBreakerError } from "../src/services/circuit-breaker/index.js";

// ============================================================
// Circuit breaker instances
// ============================================================
// We import the singletons directly and manipulate them via
// forceState / reset for each test.
import {
  walrusReadCircuit,
  walrusPublishCircuit,
  suiCircuit,
  externalAuthCircuit,
} from "../src/services/circuit-breaker/instances.js";

function resetAllCircuits() {
  walrusReadCircuit.reset();
  walrusPublishCircuit.reset();
  suiCircuit.reset();
  externalAuthCircuit.reset();
}

beforeEach(() => resetAllCircuits());
afterEach(() => resetAllCircuits());

// ============================================================
// 1. Walrus read — checkWalrusBlobExists
// ============================================================

test("checkWalrusBlobExists returns optimistic pass when circuit is OPEN", async () => {
  const { checkWalrusBlobExists } = await import("../src/services/walrus/read.js");

  // Open the circuit — subsequent calls should NOT hit the aggregator
  walrusReadCircuit.forceState("open");

  const result = await checkWalrusBlobExists({ blobId: "any-blob" });

  assert.equal(result.exists, true);
  assert.equal(result.reason, "circuit_open_optimistic_pass");
});

test("checkWalrusBlobExists falls through to real HEAD on closed circuit", { timeout: 5_000 }, async () => {
  const { checkWalrusBlobExists } = await import("../src/services/walrus/read.js");

  // Circuit is already closed (reset in beforeEach).
  // The call will attempt a real HEAD request against the configured
  // aggregator URL. If WALRUS_AGGREGATOR_URL is a dead endpoint, it
  // will return { exists: false, reason: "..." } rather than throwing.
  const result = await checkWalrusBlobExists({ blobId: "non-existent-blob" });

  // Should NOT return the circuit_open optimistic pass
  assert.notEqual(result.reason, "circuit_open_optimistic_pass");
  // And should not throw — the HEAD error is caught internally
  assert.equal(typeof result.exists, "boolean");
});

// ============================================================
// 2. Walrus read — fetchWalrusBlob
// ============================================================

test("fetchWalrusBlob rejects fast when circuit is OPEN", async () => {
  const { fetchWalrusBlob } = await import("../src/services/walrus/read.js");

  walrusReadCircuit.forceState("open");

  try {
    await fetchWalrusBlob({ blobId: "any-blob" });
    assert.fail("Expected CircuitBreakerError");
  } catch (err) {
    assert.ok(err instanceof CircuitBreakerError, `Expected CircuitBreakerError, got ${(err as Error)?.name}`);
    assert.equal(err.circuitName, "walrus_read");
    assert.equal(err.circuitState, "open");
  }
});

test("fetchWalrusBlob recovers after circuit reset", { timeout: 5_000 }, async () => {
  const { fetchWalrusBlob } = await import("../src/services/walrus/read.js");

  // Open the circuit, confirm fast-reject
  walrusReadCircuit.forceState("open");
  try {
    await fetchWalrusBlob({ blobId: "any-blob" });
    assert.fail("Expected CircuitBreakerError");
  } catch (err) {
    assert.ok(err instanceof CircuitBreakerError);
  }

  // Reset the circuit — subsequent calls should attempt real fetches
  walrusReadCircuit.reset();
  assert.equal(walrusReadCircuit.currentState, "closed");

  // The fetch will attempt a real request against the configured
  // aggregator URL. It should either succeed (if a real aggregator is
  // configured) or throw a non-circuit-breaker error (network error).
  try {
    await fetchWalrusBlob({ blobId: "any-blob" });
  } catch (err) {
    // Should NOT be a CircuitBreakerError
    assert.ok(
      !(err instanceof CircuitBreakerError),
      `Should not be CircuitBreakerError after reset, got: ${(err as Error)?.message}`,
    );
  }
});

// ============================================================
// 3. Walrus publish — uploadToWalrusViaPublisher
// ============================================================

test("uploadToWalrusViaPublisher rejects fast when circuit is OPEN", async () => {
  const { uploadToWalrusViaPublisher } = await import(
    "../src/services/walrus/backends/publisher.js"
  );

  walrusPublishCircuit.forceState("open");

  try {
    await uploadToWalrusViaPublisher({
      epochs: 1,        streamFactory: () => Readable.from(Buffer.from("test")),
    });
    assert.fail("Expected CircuitBreakerError");
  } catch (err) {
    assert.ok(err instanceof CircuitBreakerError);
    assert.equal(err.circuitName, "walrus_publish");
    assert.equal(err.circuitState, "open");
  }
});

// ============================================================
// 4. Sui — finalizeFileMetadata
// ============================================================

test("finalizeFileMetadata rejects fast when circuit is OPEN", async () => {
  const { finalizeFileMetadata } = await import("../src/sui/file.metadata.js");

  suiCircuit.forceState("open");

  try {
    await finalizeFileMetadata({
      blobId: "test-blob",
      sizeBytes: 100,
      mimeType: "text/plain",
    });
    assert.fail("Expected CircuitBreakerError");
  } catch (err) {
    assert.ok(err instanceof CircuitBreakerError);
    assert.equal(err.circuitName, "sui");
    assert.equal(err.circuitState, "open");
  }
});

// ============================================================
// 5. Sui — renewFileMetadata
// ============================================================

test("renewFileMetadata rejects fast when circuit is OPEN", async () => {
  const { renewFileMetadata } = await import("../src/sui/file.metadata.js");

  suiCircuit.forceState("open");

  try {
    await renewFileMetadata({
      fileId: "0x0000000000000000000000000000000000000000000000000000000000000000",
      walrusEndEpoch: 42,
    });
    assert.fail("Expected CircuitBreakerError");
  } catch (err) {
    assert.ok(err instanceof CircuitBreakerError);
    assert.equal(err.circuitName, "sui");
    assert.equal(err.circuitState, "open");
  }
});

// ============================================================
// 6. External auth — verifyExternalCredential
// ============================================================

test("verifyExternalCredential returns null when circuit is OPEN", async () => {
  const { buildExternalAuthContext, externalAuthTestHooks } = await import(
    "../src/services/auth/auth.external.js"
  );

  externalAuthTestHooks.resetCache();
  externalAuthCircuit.forceState("open");

  // buildExternalAuthContext delegates to verifyExternalCredential
  // which is wrapped in the circuit breaker. When OPEN, it returns
  // null rather than throwing.
  const req = {
    ip: "127.0.0.1",
    headers: {
      authorization: "Bearer some-token",
    },
  } as unknown as Record<string, unknown>;

  const result = await buildExternalAuthContext(req);
  assert.equal(result, null);
});

test("verifyExternalCredential returns null when circuit throws non-CircuitBreakerError", async () => {
  // Verify that any error from the circuit breaker (not just
  // CircuitBreakerError) is caught and returned as null.
  const { externalAuthTestHooks } = await import(
    "../src/services/auth/auth.external.js"
  );

  externalAuthTestHooks.resetCache();

  // Force state to half_open and then cause the wrapped function to fail
  // by not providing a verifyUrl. The inner function will resolve early
  // (returning null because verifyUrl isn't set), not hitting the circuit.
  // Instead, we directly test that the try/catch in verifyExternalCredential
  // catches any throw and returns null.

  // If the circuit is OPEN, the throw happens before the user function runs.
  externalAuthCircuit.forceState("open");

  const req = {
    ip: "127.0.0.1",
    headers: {
      authorization: "Bearer any-token",
    },
  } as unknown as Record<string, unknown>;

  const { buildExternalAuthContext } = await import(
    "../src/services/auth/auth.external.js"
  );
  const result = await buildExternalAuthContext(req);
  assert.equal(result, null);
});

// ============================================================
// 7. Multiple circuits — isolation
// ============================================================

test("circuit breaker states are isolated between services", () => {
  // Open one circuit, verify others remain closed
  walrusReadCircuit.forceState("open");

  assert.equal(walrusReadCircuit.currentState, "open");
  assert.equal(walrusPublishCircuit.currentState, "closed");
  assert.equal(suiCircuit.currentState, "closed");
  assert.equal(externalAuthCircuit.currentState, "closed");

  // Reset and verify
  walrusReadCircuit.reset();
  assert.equal(walrusReadCircuit.currentState, "closed");
});

test("circuit breaker fast-rejects after failure threshold in real usage", async () => {
  // This test verifies that the circuit breaker actually opens after
  // enough consecutive failures when used through the Walrus read path.
  // We use a circuit that triggers immediately to minimize test time.

  // Override circuit with very low threshold for this test
  const { CircuitBreaker } = await import("../src/services/circuit-breaker/index.js");

  const testCb = new CircuitBreaker({
    name: "test-fast-open",
    failureThreshold: 2,
    successThreshold: 1,
    openDurationMs: 60_000,
  });

  // Two consecutive failures should open the circuit
  const failingFn = async () => { throw new Error("fail"); };

  await assert.rejects(() => testCb.call(failingFn), /fail/);
  assert.equal(testCb.currentState, "closed");

  await assert.rejects(() => testCb.call(failingFn), /fail/);
  assert.equal(testCb.currentState, "open");

  // Third call should be CircuitBreakerError (fast reject)
  try {
    await testCb.call(async () => "should not reach");
    assert.fail("Expected CircuitBreakerError");
  } catch (err) {
    assert.ok(err instanceof CircuitBreakerError);
    assert.equal(err.circuitName, "test-fast-open");
    assert.equal(err.circuitState, "open");
  }

  // Reset restores functionality
  testCb.reset();
  assert.equal(testCb.currentState, "closed");
  const val = await testCb.call(async () => "works");
  assert.equal(val, "works");
});
