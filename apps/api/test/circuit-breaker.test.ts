import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import { CircuitBreaker, CircuitBreakerError } from "../src/services/circuit-breaker/index.js";

function makeBreaker(opts?: Partial<{
  failureThreshold: number;
  successThreshold: number;
  openDurationMs: number;
}>) {
  return new CircuitBreaker({
    name: "test",
    failureThreshold: opts?.failureThreshold ?? 3,
    successThreshold: opts?.successThreshold ?? 2,
    openDurationMs: opts?.openDurationMs ?? 50_000,
  });
}

test("CircuitBreaker - starts closed", () => {
  const cb = makeBreaker();
  assert.equal(cb.currentState, "closed");
});

test("CircuitBreaker - opens after consecutive failures", async () => {
  const cb = makeBreaker({ failureThreshold: 2 });
  const failing = async () => { throw new Error("boom"); };

  await assert.rejects(() => cb.call(failing), /boom/);
  assert.equal(cb.currentState, "closed");

  await assert.rejects(() => cb.call(failing), /boom/);
  assert.equal(cb.currentState, "open");
});

test("CircuitBreaker - rejects fast when open", async () => {
  const cb = makeBreaker({ failureThreshold: 1, openDurationMs: 60_000 });
  await assert.rejects(() => cb.call(async () => { throw new Error("boom"); }));

  // Circuit is now open — subsequent calls should throw CircuitBreakerError
  try {
    await cb.call(async () => "should not reach");
    assert.fail("Expected CircuitBreakerError");
  } catch (err) {
    assert.ok(err instanceof CircuitBreakerError, "Expected CircuitBreakerError");
    assert.equal(err.circuitName, "test");
    assert.equal(err.circuitState, "open");
  }
});

test("CircuitBreaker - resets success count on success in closed state", async () => {
  const cb = makeBreaker({ failureThreshold: 2 });
  // One failure
  await assert.rejects(() => cb.call(async () => { throw new Error("boom"); }));
  // One success resets failure count
  await cb.call(async () => "ok");
  // Now only 1 failure — circuit should still be closed
  await assert.rejects(() => cb.call(async () => { throw new Error("boom"); }));
  assert.equal(cb.currentState, "closed");
});

test("CircuitBreaker - half-open allows probe and re-opens on failure", async () => {
  const cb = makeBreaker({ failureThreshold: 1, openDurationMs: 50 }); // short open duration
  // Open the circuit
  await assert.rejects(() => cb.call(async () => { throw new Error("boom"); }));
  assert.equal(cb.currentState, "open");

  // Wait for open duration to elapse
  await sleep(100);

  // Half-open probe — failure should re-open
  await assert.rejects(() => cb.call(async () => { throw new Error("boom again"); }));
  assert.equal(cb.currentState, "open");
});

test("CircuitBreaker - half-open succeeds and transitions to closed", async () => {
  const cb = makeBreaker({
    failureThreshold: 1,
    successThreshold: 2,
    openDurationMs: 50,
  });

  // Open the circuit
  await assert.rejects(() => cb.call(async () => { throw new Error("boom"); }));
  assert.equal(cb.currentState, "open");

  // Wait for open duration
  await sleep(100);

  // First success in half-open
  const r1 = await cb.call(async () => "ok1");
  assert.equal(r1, "ok1");
  assert.equal(cb.currentState, "half_open");

  // Second success closes the circuit
  const r2 = await cb.call(async () => "ok2");
  assert.equal(r2, "ok2");
  assert.equal(cb.currentState, "closed");
});

test("CircuitBreaker - forceState changes state", () => {
  const cb = makeBreaker();
  assert.equal(cb.currentState, "closed");

  cb.forceState("open");
  assert.equal(cb.currentState, "open");

  cb.forceState("half_open");
  assert.equal(cb.currentState, "half_open");

  cb.forceState("closed");
  assert.equal(cb.currentState, "closed");
});

test("CircuitBreaker - reset clears failure count", async () => {
  const cb = makeBreaker({ failureThreshold: 2 });
  await assert.rejects(() => cb.call(async () => { throw new Error("boom"); }));
  cb.reset();
  assert.equal(cb.currentState, "closed");

  // Should be able to succeed again
  const r = await cb.call(async () => "ok");
  assert.equal(r, "ok");
});

test("CircuitBreaker - onStateChange fires on transitions", async () => {
  const transitions: Array<{ from: string; to: string }> = [];
  const cb = new CircuitBreaker({
    name: "test",
    failureThreshold: 1,
    successThreshold: 2,
    openDurationMs: 50,
    onStateChange: (from, to) => {
      transitions.push({ from, to });
    },
  });

  await assert.rejects(() => cb.call(async () => { throw new Error("boom"); }));
  assert.deepEqual(transitions, [{ from: "closed", to: "open" }]);

  await sleep(100);
  await cb.call(async () => "ok");
  assert.deepEqual(transitions, [
    { from: "closed", to: "open" },
    { from: "open", to: "half_open" },
  ]);
});

test("CircuitBreaker - onOutcome fires on each call", async () => {
  const outcomes: Array<{ success: boolean; state: string }> = [];
  const cb = new CircuitBreaker({
    name: "test",
    failureThreshold: 2,
    successThreshold: 2,
    openDurationMs: 50_000,
    onOutcome: (params) => {
      outcomes.push({ success: params.success, state: params.state });
    },
  });

  await cb.call(async () => "ok");
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].success, true);
  assert.equal(outcomes[0].state, "closed");

  await assert.rejects(() => cb.call(async () => { throw new Error("boom"); }));
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[1].success, false);
  assert.equal(outcomes[1].state, "closed");
});

test("CircuitBreakerError - carries circuit details", () => {
  const err = new CircuitBreakerError("test", "open");
  assert.equal(err.name, "CircuitBreakerError");
  assert.equal(err.circuitName, "test");
  assert.equal(err.circuitState, "open");
  assert.ok(err.message.includes("test"));
});
