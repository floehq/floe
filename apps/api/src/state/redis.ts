import { NativeRedisClient } from "./redis.native.js";
import type { RedisClient } from "./redis.types.js";

let redis: RedisClient | null = null;

type RedisProvider = "upstash" | "native";

function resolveRedisProvider(): RedisProvider {
  const explicit = (process.env.FLOE_REDIS_PROVIDER ?? "").trim().toLowerCase();
  if (explicit === "upstash" || explicit === "native") {
    return explicit;
  }
  if (process.env.REDIS_URL) {
    return "native";
  }
  return "upstash";
}

async function createUpstashClient(): Promise<RedisClient> {
  const { Redis: UpstashRedis } = await import("@upstash/redis");
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error(
      "Upstash Redis env vars missing (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)"
    );
  }

  const client = new UpstashRedis({
    url,
    token,
    retry: {
      retries: 3,
      backoff: (attempt) => Math.min(100 * 2 ** attempt, 1000),
    },
  }) as unknown as RedisClient;

  await client.ping();
  return client;
}

async function createNativeClient(): Promise<RedisClient> {
  const url = (process.env.REDIS_URL ?? "").trim();
  if (!url) {
    throw new Error("REDIS_URL is required when FLOE_REDIS_PROVIDER=native");
  }
  const client = new NativeRedisClient({ url });
  await client.connect();
  await client.ping();
  return client;
}

export async function initRedis(): Promise<RedisClient> {
  if (redis) return redis;
  redis = resolveRedisProvider() === "native"
    ? await createNativeClient()
    : await createUpstashClient();
  return redis;
}

export function getRedis(): RedisClient {
  if (!redis) {
    throw new Error(
      "Redis not initialized. initRedis() must be awaited during startup."
    );
  }
  return redis;
}

export async function closeRedis(): Promise<void> {
  if (!redis) return;
  await redis.close?.().catch(() => {});
  redis = null;
}

export function setRedisForTests(client: RedisClient | null): void {
  redis = client;
}
