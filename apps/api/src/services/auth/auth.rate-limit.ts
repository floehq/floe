import { getRedis } from "../../state/redis.js";
import {
  AuthRateLimitConfig,
  type RateLimitScope,
} from "../../config/auth.config.js";
import type { RequestIdentity } from "./auth.identity.js";

function windowBucket(nowMs: number, windowSeconds: number): number {
  return Math.floor(nowMs / (windowSeconds * 1000));
}

function selectLimit(scope: RateLimitScope, identity: RequestIdentity): number {
  return AuthRateLimitConfig.limits[scope][identity.tier];
}

export interface RateLimitDecision {
  allowed: boolean;
  current: number;
  limit: number;
  windowSeconds: number;
  identity: RequestIdentity;
}

export async function checkTieredRateLimit(params: {
  scope: RateLimitScope;
  identity: RequestIdentity;
}): Promise<RateLimitDecision> {
  const identity = params.identity;
  const windowSeconds = AuthRateLimitConfig.windowSeconds;
  const limit = selectLimit(params.scope, identity);
  const bucket = windowBucket(Date.now(), windowSeconds);
  const key = `floe:v1:ratelimit:${params.scope}:${bucket}:${identity.subject}`;
  const redis = getRedis();

  const script = `
    local key = KEYS[1]
    local ttl = tonumber(ARGV[1])
    local current = redis.call("INCR", key)
    if current == 1 then
      redis.call("EXPIRE", key, ttl)
    end
    return current
  `;

  const currentRaw = await redis.eval(script, [key], [String(windowSeconds)]);
  const current = Number(currentRaw);
  const allowed = Number.isFinite(current) && current <= limit;

  return {
    allowed,
    current: Number.isFinite(current) ? current : limit + 1,
    limit,
    windowSeconds,
    identity,
  };
}
