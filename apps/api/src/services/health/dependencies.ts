import {
  checkPostgresHealth,
  isPostgresConfigured,
  isPostgresRequired,
} from "../../state/postgres.js";
import { getRedis } from "../../state/redis.js";

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
