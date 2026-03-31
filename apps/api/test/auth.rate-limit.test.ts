import test from "node:test";
import assert from "node:assert/strict";

import { AuthRateLimitConfig } from "../src/config/auth.config.ts";
import {
  checkTieredRateLimit,
  clearLocalRateLimitLeaseCacheForTests,
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

function makeRedisEvalStub() {
  const counts = new Map<string, number>();
  const calls: Array<{ keys: string[]; args: string[] }> = [];

  const client = {
    eval: async (_script: string, keys: string[], args: string[]) => {
      calls.push({ keys, args });
      const key = keys[0];
      const incr = Number(args[1] ?? 1);
      const next = (counts.get(key) ?? 0) + incr;
      counts.set(key, next);
      return next;
    },
  } as Partial<RedisClient>;

  return {
    client: client as RedisClient,
    calls,
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
