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

type LeaseScope = "file_meta_read" | "file_stream_read";
type LocalLeaseState = {
  bucket: number;
  remaining: number;
  current: number;
  denied: boolean;
  touchedAt: number;
};

const localLeaseCache = new Map<string, LocalLeaseState>();
const localLeaseInflight = new Map<string, { bucket: number; promise: Promise<RateLimitDecision> }>();
const LOCAL_LEASE_CACHE_MAX_ENTRIES = 10_000;

function getLeaseSize(scope: RateLimitScope): number | null {
  if (scope === "file_meta_read") {
    return AuthRateLimitConfig.localLeaseSize.file_meta_read ?? null;
  }
  if (scope === "file_stream_read") {
    return AuthRateLimitConfig.localLeaseSize.file_stream_read ?? null;
  }
  return null;
}

function localLeaseKey(scope: LeaseScope, subject: string): string {
  return `${scope}:${subject}`;
}

function pruneLocalLeaseCache(currentBucket: number) {
  for (const [key, value] of localLeaseCache) {
    if (value.bucket !== currentBucket) {
      localLeaseCache.delete(key);
    }
  }

  if (localLeaseCache.size <= LOCAL_LEASE_CACHE_MAX_ENTRIES) return;

  const overflow = localLeaseCache.size - LOCAL_LEASE_CACHE_MAX_ENTRIES;
  const oldest = [...localLeaseCache.entries()]
    .sort((a, b) => a[1].touchedAt - b[1].touchedAt)
    .slice(0, overflow);
  for (const [key] of oldest) {
    localLeaseCache.delete(key);
  }
}

function tryConsumeLocalLease(params: {
  scope: LeaseScope;
  identity: RequestIdentity;
  limit: number;
  bucket: number;
  windowSeconds: number;
}): RateLimitDecision | null {
  const key = localLeaseKey(params.scope, params.identity.subject);
  const hit = localLeaseCache.get(key);
  if (!hit || hit.bucket !== params.bucket) {
    if (hit && hit.bucket !== params.bucket) {
      localLeaseCache.delete(key);
    }
    return null;
  }
  hit.touchedAt = Date.now();

  if (hit.denied) {
    return {
      allowed: false,
      current: Math.max(hit.current, params.limit + 1),
      limit: params.limit,
      windowSeconds: params.windowSeconds,
      identity: params.identity,
    };
  }

  if (hit.remaining <= 0) {
    return null;
  }

  hit.remaining -= 1;
  hit.current += 1;
  return {
    allowed: true,
    current: hit.current,
    limit: params.limit,
    windowSeconds: params.windowSeconds,
    identity: params.identity,
  };
}

async function leaseRemoteAllowance(params: {
  scope: LeaseScope;
  identity: RequestIdentity;
  limit: number;
  bucket: number;
  windowSeconds: number;
}): Promise<RateLimitDecision> {
  const leaseSize = Math.max(1, getLeaseSize(params.scope) ?? 1);
  const key = `floe:v1:ratelimit:${params.scope}:${params.bucket}:${params.identity.subject}`;
  const redis = getRedis();
  const script = `
    local key = KEYS[1]
    local ttl = tonumber(ARGV[1])
    local leaseSize = tonumber(ARGV[2])
    local limit = tonumber(ARGV[3])
    local current = tonumber(redis.call("GET", key) or "0")
    local remaining = math.max(0, limit - current)
    local reserved = math.min(leaseSize, remaining)
    if reserved > 0 then
      current = redis.call("INCRBY", key, reserved)
      if current == reserved then
        redis.call("EXPIRE", key, ttl)
      end
    end
    return { current, reserved }
  `;

  const result = await redis.eval(script, [key], [
    String(params.windowSeconds),
    String(leaseSize),
    String(params.limit),
  ]);
  const [currentRaw, reservedRaw] = Array.isArray(result) ? result : [result, 0];
  const current = Number(currentRaw);
  const reserved = Number(reservedRaw);
  const firstInLease = reserved > 0 ? current - reserved + 1 : params.limit + 1;

  localLeaseCache.set(localLeaseKey(params.scope, params.identity.subject), {
    bucket: params.bucket,
    remaining: Math.max(0, reserved - 1),
    current: firstInLease,
    denied: reserved === 0,
    touchedAt: Date.now(),
  });
  pruneLocalLeaseCache(params.bucket);

  return {
    allowed: reserved > 0,
    current: reserved > 0 ? firstInLease : Math.max(current, params.limit + 1),
    limit: params.limit,
    windowSeconds: params.windowSeconds,
    identity: params.identity,
  };
}

export function clearLocalRateLimitLeaseCacheForTests() {
  localLeaseCache.clear();
  localLeaseInflight.clear();
}

export function getLocalRateLimitLeaseCacheSizeForTests() {
  return localLeaseCache.size;
}

export async function checkTieredRateLimit(params: {
  scope: RateLimitScope;
  identity: RequestIdentity;
}): Promise<RateLimitDecision> {
  const identity = params.identity;
  const windowSeconds = AuthRateLimitConfig.windowSeconds;
  const limit = selectLimit(params.scope, identity);
  const bucket = windowBucket(Date.now(), windowSeconds);
  const leaseSize = getLeaseSize(params.scope);

  if (
    leaseSize &&
    leaseSize > 1 &&
    (params.scope === "file_meta_read" || params.scope === "file_stream_read")
  ) {
    const leaseScope: LeaseScope = params.scope;
    const key = localLeaseKey(leaseScope, identity.subject);
    pruneLocalLeaseCache(bucket);

    while (true) {
      const local = tryConsumeLocalLease({
        scope: leaseScope,
        identity,
        limit,
        bucket,
        windowSeconds,
      });
      if (local) {
        return local;
      }

      const inflight = localLeaseInflight.get(key);
      if (inflight && inflight.bucket === bucket) {
        await inflight.promise;
        continue;
      }

      const promise = leaseRemoteAllowance({
        scope: leaseScope,
        identity,
        limit,
        bucket,
        windowSeconds,
      });
      localLeaseInflight.set(key, { bucket, promise });
      try {
        return await promise;
      } finally {
        const active = localLeaseInflight.get(key);
        if (active?.promise === promise) {
          localLeaseInflight.delete(key);
        }
      }
    }
  }

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
