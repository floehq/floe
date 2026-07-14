import {
  checkPostgresHealth,
  isPostgresConfigured,
  isPostgresRequired,
} from "../../state/postgres.js";
import { getRedis } from "../../state/redis.js";
import { WalrusEnv } from "../../config/walrus.config.js";
import { getWalrusPool } from "../walrus/read.js";

const WALRUS_HEALTH_TIMEOUT_MS = 5_000;

export type DependencyState = "healthy" | "degraded" | "unavailable" | "disabled";

export type RedisDependencyHealth = {
  ok: boolean;
  latencyMs: number | null;
  status: DependencyState;
  timestamp: string;
};

export type PostgresDependencyHealth = {
  configured: boolean;
  enabled: boolean;
  required: boolean;
  ok: boolean | null;
  latencyMs: number | null;
  status: DependencyState;
};

export type WalrusDependencyHealth = {
  configured: boolean;
  ok: boolean | null;
  latencyMs: number | null;
  status: "healthy" | "degraded" | "unavailable" | "disabled";
  primaryUrl: string | null;
};

export async function checkWalrusDependencyHealth(): Promise<WalrusDependencyHealth> {
  const urls = WalrusEnv.aggregatorUrls;
  if (urls.length === 0) {
    return {
      configured: false,
      ok: null,
      latencyMs: null,
      status: "disabled",
      primaryUrl: null,
    };
  }

  const primaryUrl = urls[0];
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WALRUS_HEALTH_TIMEOUT_MS);
    try {
      const res = await fetch(primaryUrl + "/v1", {
        method: "HEAD",
        signal: controller.signal,
        dispatcher: getWalrusPool() as any,
      });
      const ok = res.status >= 200 && res.status < 500;
      return {
        configured: true,
        ok,
        latencyMs: Date.now() - start,
        status: ok ? "healthy" : "degraded",
        primaryUrl,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return {
      configured: true,
      ok: false,
      latencyMs: Date.now() - start,
      status: "unavailable",
      primaryUrl,
    };
  }
}

export { checkS3Health } from "../../state/s3.js";

export async function checkRedisDependencyHealth(): Promise<RedisDependencyHealth> {
  const timestamp = new Date().toISOString();
  const start = Date.now();

  try {
    const redis = getRedis();
    await redis.ping();
    return {
      ok: true,
      latencyMs: Date.now() - start,
      status: "healthy",
      timestamp,
    };
  } catch {
    return {
      ok: false,
      latencyMs: null,
      status: "unavailable",
      timestamp,
    };
  }
}

export async function checkPostgresDependencyHealth(): Promise<PostgresDependencyHealth> {
  const configured = isPostgresConfigured();
  const required = isPostgresRequired();

  if (!configured) {
    return {
      configured: false,
      enabled: false,
      required,
      ok: null,
      latencyMs: null,
      status: "disabled",
    };
  }

  const postgres = await checkPostgresHealth();
  if (postgres.ok === true) {
    return {
      configured: true,
      enabled: postgres.enabled,
      required,
      ok: true,
      latencyMs: postgres.latencyMs,
      status: "healthy",
    };
  }

  return {
    configured: true,
    enabled: postgres.enabled,
    required,
    ok: postgres.ok,
    latencyMs: postgres.latencyMs,
    status: required ? "unavailable" : "degraded",
  };
}
