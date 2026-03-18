import { Redis } from "@upstash/redis";

let redis: Redis | null = null;

export async function initRedis(): Promise<Redis> {
  if (redis) return redis;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error(
      "Upstash Redis env vars missing (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)"
    );
  }

  const client = new Redis({
    url,
    token,
    retry: {
      retries: 3,
      backoff: (attempt) => Math.min(100 * 2 ** attempt, 1000),
    },
  });

  await client.ping();

  redis = client;
  return redis;
}

export function getRedis(): Redis {
  if (!redis) {
    throw new Error(
      "Redis not initialized. initRedis() must be awaited during startup."
    );
  }
  return redis;
}

