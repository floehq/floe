import test from "node:test";
import assert from "node:assert/strict";

import { AuthRateLimitConfig } from "../src/config/auth.config.ts";
import {
  checkTieredRateLimit,
  clearLocalRateLimitLeaseCacheForTests,
  getLocalRateLimitLeaseCacheSizeForTests,
} from "../src/services/auth/auth.rate-limit.ts";
import { setRedisForTests } from "../src/state/redis.ts";
import type { RedisClient } from "../src/state/redis.types.ts";

function makeIdentity() {
  return {
    authenticated: false,
    method: "public" as const,
    subject: "public:test-client",
    scopes: [],
    tier: "public" as const,
  };
}

function withMockedNow<T>(value: number, fn: () => Promise<T> | T): Promise<T> | T {
  const originalNow = Date.now;
  Date.now = () => value;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

function makeRedisEvalStub() {
  const counts = new Map<string, number>();
  const calls: Array<{ keys: string[]; args: string[] }> = [];
  let waitForEval: Promise<void> | null = null;

  const client = {
    eval: async (_script: string, keys: string[], args: string[]) => {
      calls.push({ keys, args });
      if (waitForEval) {
        await waitForEval;
      }
      const key = keys[0];
      const current = counts.get(key) ?? 0;
      if (args.length >= 3) {
        const leaseSize = Number(args[1] ?? 1);
        const limit = Number(args[2] ?? 0);
        const reserve = Math.min(leaseSize, Math.max(0, limit - current));
        const next = current + reserve;
        counts.set(key, next);
        return [next, reserve];
      }
      const incr = Number(args[1] ?? 1);
      const next = current + incr;
      counts.set(key, next);
      return next;
    },
  } as Partial<RedisClient>;

  return {
    client: client as RedisClient,
    calls,
    blockEval() {
      let release!: () => void;
      waitForEval = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        waitForEval = null;
        release();
      };
    },
  };
}

test("file read rate limits reuse a local lease before hitting Redis again", async () => {
  const redis = makeRedisEvalStub();
  const originalLease = { ...AuthRateLimitConfig.localLeaseSize };

  setRedisForTests(redis.client);
  clearLocalRateLimitLeaseCacheForTests();
  Object.assign(AuthRateLimitConfig.localLeaseSize as Record<string, number>, {
    file_meta_read: 3,
    file_stream_read: 2,
  });

  try {
    const identity = makeIdentity();

    const first = await checkTieredRateLimit({ scope: "file_meta_read", identity });
    const second = await checkTieredRateLimit({ scope: "file_meta_read", identity });
    const third = await checkTieredRateLimit({ scope: "file_meta_read", identity });
    const fourth = await checkTieredRateLimit({ scope: "file_meta_read", identity });

    assert.equal(first.allowed, true);
    assert.equal(second.allowed, true);
    assert.equal(third.allowed, true);
    assert.equal(fourth.allowed, true);
    assert.deepEqual(
      [first.current, second.current, third.current, fourth.current],
      [1, 2, 3, 4]
    );
    assert.equal(redis.calls.length, 2);
    assert.deepEqual(redis.calls.map((call) => Number(call.args[1])), [3, 3]);
  } finally {
    Object.assign(AuthRateLimitConfig.localLeaseSize as Record<string, number>, originalLease);
    clearLocalRateLimitLeaseCacheForTests();
    setRedisForTests(null);
  }
});

test("concurrent file reads share one in-flight lease fetch instead of over-reserving", async () => {
  const redis = makeRedisEvalStub();
  const originalLease = { ...AuthRateLimitConfig.localLeaseSize };
  const releaseEval = redis.blockEval();

  setRedisForTests(redis.client);
  clearLocalRateLimitLeaseCacheForTests();
  Object.assign(AuthRateLimitConfig.localLeaseSize as Record<string, number>, {
    file_meta_read: 3,
    file_stream_read: 2,
  });

  try {
    const identity = makeIdentity();
    const burst = Array.from({ length: 4 }, () =>
      checkTieredRateLimit({ scope: "file_meta_read", identity })
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(redis.calls.length, 1);

    releaseEval();
    const results = await Promise.all(burst);

    assert.deepEqual(
      results.map((result) => result.allowed),
      [true, true, true, true]
    );
    assert.deepEqual(
      results.map((result) => result.current),
      [1, 2, 3, 4]
    );
    assert.equal(redis.calls.length, 2);
  } finally {
    Object.assign(AuthRateLimitConfig.localLeaseSize as Record<string, number>, originalLease);
    clearLocalRateLimitLeaseCacheForTests();
    setRedisForTests(null);
  }
});

test("lease reservations never over-reserve past the configured limit", async () => {
  const redis = makeRedisEvalStub();
  const originalLease = { ...AuthRateLimitConfig.localLeaseSize };
  const originalLimit = AuthRateLimitConfig.limits.file_meta_read.public;

  setRedisForTests(redis.client);
  clearLocalRateLimitLeaseCacheForTests();
  Object.assign(AuthRateLimitConfig.localLeaseSize as Record<string, number>, {
    file_meta_read: 5,
    file_stream_read: 2,
  });
  AuthRateLimitConfig.limits.file_meta_read.public = 2;

  try {
    const identity = makeIdentity();

    const first = await checkTieredRateLimit({ scope: "file_meta_read", identity });
    const second = await checkTieredRateLimit({ scope: "file_meta_read", identity });
    const third = await checkTieredRateLimit({ scope: "file_meta_read", identity });

    assert.equal(first.allowed, true);
    assert.equal(second.allowed, true);
    assert.equal(third.allowed, false);
    assert.deepEqual(redis.calls.map((call) => Number(call.args[1])), [5, 5]);
  } finally {
    Object.assign(AuthRateLimitConfig.localLeaseSize as Record<string, number>, originalLease);
    AuthRateLimitConfig.limits.file_meta_read.public = originalLimit;
    clearLocalRateLimitLeaseCacheForTests();
    setRedisForTests(null);
  }
});

test("stale local lease entries are pruned when requests advance to a new bucket", async () => {
  const redis = makeRedisEvalStub();
  const originalLease = { ...AuthRateLimitConfig.localLeaseSize };
  const originalWindow = AuthRateLimitConfig.windowSeconds;

  setRedisForTests(redis.client);
  clearLocalRateLimitLeaseCacheForTests();
  Object.assign(AuthRateLimitConfig.localLeaseSize as Record<string, number>, {
    file_meta_read: 2,
    file_stream_read: 2,
  });
  (AuthRateLimitConfig as { windowSeconds: number }).windowSeconds = 1;

  try {
    await withMockedNow(1_000, async () => {
      await checkTieredRateLimit({
        scope: "file_meta_read",
        identity: { ...makeIdentity(), subject: "public:one" },
      });
    });
    assert.equal(getLocalRateLimitLeaseCacheSizeForTests(), 1);

    await withMockedNow(3_000, async () => {
      await checkTieredRateLimit({
        scope: "file_meta_read",
        identity: { ...makeIdentity(), subject: "public:two" },
      });
    });
    assert.equal(getLocalRateLimitLeaseCacheSizeForTests(), 1);
  } finally {
    Object.assign(AuthRateLimitConfig.localLeaseSize as Record<string, number>, originalLease);
    (AuthRateLimitConfig as { windowSeconds: number }).windowSeconds = originalWindow;
    clearLocalRateLimitLeaseCacheForTests();
    setRedisForTests(null);
  }
});
