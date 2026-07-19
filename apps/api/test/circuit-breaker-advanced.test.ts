import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import {
  CircuitBreaker,
  CircuitBreakerError,
} from "../src/services/circuit-breaker/index.js";

function makeBreaker(
  opts?: Partial<{
    failureThreshold: number;
    successThreshold: number;
    openDurationMs: number;
    onStateChange: (prev: string, next: string, name: string) => void;
    onOutcome: (params: {
      name: string;
      state: string;
      success: boolean;
      durationMs: number;
    }) => void;
  }>,
) {
  return new CircuitBreaker({
    name: "test",
    failureThreshold: opts?.failureThreshold ?? 3,
    successThreshold: opts?.successThreshold ?? 2,
    openDurationMs: opts?.openDurationMs ?? 50_000,
    onStateChange: opts?.onStateChange,
    onOutcome: opts?.onOutcome,
  });
}

// ---------------------------------------------------------------------------
// State transition lifecycle: CLOSED → OPEN → HALF_OPEN → CLOSED
// ---------------------------------------------------------------------------

test("full lifecycle: CLOSED → OPEN → HALF_OPEN → CLOSED", async () => {
  const transitions: string[] = [];
  const cb = makeBreaker({
    failureThreshold: 2,
    successThreshold: 1,
    openDurationMs: 30,
    onStateChange: (_prev, next) => transitions.push(next),
  });

  assert.equal(cb.currentState, "closed");

  // Two failures → OPEN
  await assert.rejects(() =>
    cb.call(async () => {
      throw new Error("f1");
    }),
  );
  await assert.rejects(() =>
    cb.call(async () => {
      throw new Error("f2");
    }),
  );
  assert.equal(cb.currentState, "open");
  assert.deepEqual(transitions, ["open"]);

  // Still within open window → fast reject
  await assert.rejects(
    () => cb.call(async () => "nope"),
    (err: unknown) => err instanceof CircuitBreakerError,
  );
  assert.equal(transitions.length, 1);

  // Wait for open window to expire
  await sleep(50);

  // Next call should transition to half_open and execute the probe
  const r = await cb.call(async () => "probe-ok");
  assert.equal(r, "probe-ok");
  assert.deepEqual(transitions, ["open", "half_open", "closed"]);
  assert.equal(cb.currentState, "closed");
});

test("HALF_OPEN → OPEN on probe failure", async () => {
  const cb = makeBreaker({
    failureThreshold: 1,
    successThreshold: 2,
    openDurationMs: 30,
  });

  await assert.rejects(() =>
    cb.call(async () => {
      throw new Error("boom");
    }),
  );
  assert.equal(cb.currentState, "open");

  await sleep(50);

  // Probe fails → re-opens
  await assert.rejects(() =>
    cb.call(async () => {
      throw new Error("probe-fail");
    }),
  );
  assert.equal(cb.currentState, "open");
});

// ---------------------------------------------------------------------------
// Mutex / probe lock: concurrent HALF_OPEN calls serialize
// ---------------------------------------------------------------------------

test("concurrent probes during HALF_OPEN: subsequent calls serialize behind the lock", async () => {
  const cb = makeBreaker({
    failureThreshold: 1,
    successThreshold: 10, // won't close quickly
    openDurationMs: 30,
  });

  // Open the circuit
  await assert.rejects(() =>
    cb.call(async () => {
      throw new Error("boom");
    }),
  );
  assert.equal(cb.currentState, "open");

  await sleep(50);

  // First call grabs the probe lock and holds it for a bit
  const firstCallDone: Promise<string> = cb.call(async () => {
    await sleep(50);
    return "first";
  });

  // Wait a tiny bit so the first call has entered and created the lock
  await sleep(5);

  // These subsequent calls should block on probeLock while first runs
  const executionOrder: number[] = [];

  const secondCall = cb.call(async () => {
    executionOrder.push(2);
    await sleep(30);
    return "second";
  });
  const thirdCall = cb.call(async () => {
    executionOrder.push(3);
    await sleep(30);
    return "third";
  });

  await Promise.all([firstCallDone, secondCall, thirdCall]);

  // Calls 2 and 3 should have run sequentially (2 before 3)
  assert.deepEqual(executionOrder, [2, 3]);
});

test("concurrent probes during HALF_OPEN: late callers get rejected after probe fails", async () => {
  const cb = makeBreaker({
    failureThreshold: 1,
    successThreshold: 2,
    openDurationMs: 30,
  });

  // Open circuit
  await assert.rejects(() =>
    cb.call(async () => {
      throw new Error("boom");
    }),
  );

  await sleep(50);

  // First call grabs the probe lock and will fail
  const firstFail = cb.call(async () => {
    await sleep(30);
    throw new Error("probe-fail");
  });

  // Wait for first call to create the probeLock
  await sleep(5);

  // Second call should block on probeLock, then see state=open and reject
  const secondCall = cb
    .call(async () => "should-not-run")
    .catch((err: unknown) => {
      if (err instanceof CircuitBreakerError) return "CircuitBreakerError";
      throw err;
    });

  const [, secondResult] = await Promise.all([firstFail.catch(() => {}), secondCall]);
  assert.equal(secondResult, "CircuitBreakerError");
  assert.equal(cb.currentState, "open");
});

// ---------------------------------------------------------------------------
// HALF_OPEN with concurrent probes only allows one probe through
// ---------------------------------------------------------------------------

test("only one probe runs; subsequent calls during half_open wait then re-check state", async () => {
  const cb = makeBreaker({
    failureThreshold: 1,
    successThreshold: 10, // won't close quickly
    openDurationMs: 30,
  });

  await assert.rejects(() =>
    cb.call(async () => {
      throw new Error("boom");
    }),
  );

  await sleep(50);

  const executionOrder: number[] = [];
  let probeIndex = 0;

  const trackedProbe = async (id: number) => {
    executionOrder.push(id);
    await sleep(30);
    return id;
  };

  // Fire 3 calls; first one becomes the probe, others queue on probeLock
  const p1 = cb.call(() => trackedProbe(1));
  const p2 = cb.call(() => trackedProbe(2));
  const p3 = cb.call(() => trackedProbe(3));

  const results = await Promise.all([p1, p2, p3]);

  // All three succeeded (first probe success doesn't close since threshold=10)
  assert.deepEqual(results, [1, 2, 3]);
  // But they should have executed sequentially: 1, then 2, then 3
  assert.deepEqual(executionOrder, [1, 2, 3]);
});

// ---------------------------------------------------------------------------
// Failure counting and reset behavior
// ---------------------------------------------------------------------------

test("failure count resets on any success in CLOSED state", async () => {
  const cb = makeBreaker({ failureThreshold: 5 });

  // 3 failures — below threshold
  for (let i = 0; i < 3; i++) {
    await assert.rejects(() =>
      cb.call(async () => {
        throw new Error("fail");
      }),
    );
  }
  assert.equal(cb.currentState, "closed");

  // Success resets failure count
  await cb.call(async () => "ok");

  // 4 more failures without reaching threshold (count was reset)
  for (let i = 0; i < 4; i++) {
    await assert.rejects(() =>
      cb.call(async () => {
        throw new Error("fail");
      }),
    );
  }
  assert.equal(cb.currentState, "closed", "Should still be closed after reset");
});

test("success count resets on any failure in HALF_OPEN state", async () => {
  const cb = makeBreaker({
    failureThreshold: 1,
    successThreshold: 3,
    openDurationMs: 30,
  });

  // Open
  await assert.rejects(() =>
    cb.call(async () => {
      throw new Error("boom");
    }),
  );
  await sleep(50);

  // 2 successes in half_open
  await cb.call(async () => "ok1");
  assert.equal(cb.currentState, "half_open");
  await cb.call(async () => "ok2");
  assert.equal(cb.currentState, "half_open");

  // Failure resets success count and re-opens
  await assert.rejects(() =>
    cb.call(async () => {
      throw new Error("fail");
    }),
  );
  assert.equal(cb.currentState, "open");
});

test("reset() clears all counters and returns to closed", async () => {
  const cb = makeBreaker({ failureThreshold: 2 });

  await assert.rejects(() =>
    cb.call(async () => {
      throw new Error("fail");
    }),
  );
  await assert.rejects(() =>
    cb.call(async () => {
      throw new Error("fail");
    }),
  );
  assert.equal(cb.currentState, "open");

  cb.reset();
  assert.equal(cb.currentState, "closed");

  // Should tolerate 1 failure without opening (threshold is 2)
  await assert.rejects(() =>
    cb.call(async () => {
      throw new Error("fail");
    }),
  );
  assert.equal(cb.currentState, "closed");
});

// ---------------------------------------------------------------------------
// failureRate
// ---------------------------------------------------------------------------

test("failureRate returns 0 when no calls have been made", () => {
  const cb = makeBreaker();
  assert.equal(cb.failureRate, 0);
});

test("failureRate tracks correctly across outcomes", async () => {
  const cb = makeBreaker({ failureThreshold: 100 });

  // Two successes → sc=2, fc=0 → rate = 0
  await cb.call(async () => "ok");
  await cb.call(async () => "ok");
  assert.equal(cb.failureRate, 0);

  // One failure resets successCount → fc=1, sc=0 → rate = 1
  await assert.rejects(() =>
    cb.call(async () => {
      throw new Error("fail");
    }),
  );
  assert.equal(cb.failureRate, 1);

  // One success resets failureCount → sc=1, fc=0 → rate = 0
  await cb.call(async () => "ok");
  assert.equal(cb.failureRate, 0);
});

// ---------------------------------------------------------------------------
// OPEN state fast-reject does not call fn
// ---------------------------------------------------------------------------

test("OPEN state never invokes the wrapped function", async () => {
  const cb = makeBreaker({ failureThreshold: 1, openDurationMs: 60_000 });
  let callCount = 0;

  await assert.rejects(() =>
    cb.call(async () => {
      callCount++;
      throw new Error("boom");
    }),
  );
  assert.equal(callCount, 1);

  // Circuit is open — fn must not be called
  await assert.rejects(
    () =>
      cb.call(async () => {
        callCount++;
        return "nope";
      }),
    (err: unknown) => err instanceof CircuitBreakerError,
  );
  assert.equal(callCount, 1, "Function should not be called while circuit is open");
});
