import test from "node:test";
import assert from "node:assert/strict";

import { initRedis, closeRedis } from "../src/state/redis.ts";

const needsNativeRedis = process.env.REDIS_URL && process.env.FLOE_REDIS_PROVIDER === "native";

test("native redis adapter supports basic command flow when REDIS_URL is configured", { skip: !needsNativeRedis }, async () => {
  const redis = await initRedis();
  const key = `floe:test:${Date.now()}`;
  await redis.hset(key, { field: "value" });
  assert.deepEqual(await redis.hgetall(key), { field: "value" });
  assert.equal(await redis.hget(key, "field"), "value");
  await redis.sadd(`${key}:set`, "a");
  assert.equal(Number(await redis.scard(`${key}:set`)), 1);
  assert.deepEqual(await redis.smembers(`${key}:set`), ["a"]);
  await redis.set(`${key}:lock`, "token", { ex: 30, nx: true });
  assert.equal(Number(await redis.ttl(`${key}:lock`)) > 0, true);
  await redis.del(key);
  await redis.del(`${key}:set`);
  await redis.del(`${key}:lock`);
  await closeRedis();
});
