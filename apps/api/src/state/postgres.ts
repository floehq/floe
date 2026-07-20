import { parseBoolEnv, parsePositiveIntEnv } from "../utils/parseEnv.js";
import { createRequire } from "module";
import type { FastifyBaseLogger } from "fastify";

const _require = createRequire(import.meta.url);

export type PgPoolClient = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;
  release: (err?: Error | boolean) => void;
};

type PgPool = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;
  connect: () => Promise<PgPoolClient>;
  end: () => Promise<void>;
};

let pool: PgPool | null = null;
let enabled = false;

function databaseUrl(): string {
  return (process.env.DATABASE_URL ?? "").trim();
}

export function isPostgresConfigured(): boolean {
  return databaseUrl().length > 0;
}

export function isPostgresEnabled(): boolean {
  return enabled && !!pool;
}

export function isPostgresRequired(): boolean {
  return parseBoolEnv("FLOE_POSTGRES_REQUIRED", false);
}

async function loadPgPool(connectionString: string): Promise<PgPool> {
  let pg: Record<string, unknown>;
  try {
    pg = _require("pg") as Record<string, unknown>;
  } catch {
    throw new Error("Postgres driver not found. Run: npm install pg --workspace=apps/api");
  }

  const PoolCtor = (pg.Pool ?? (pg.default as Record<string, unknown> | undefined)?.Pool) as
    | (new (config: Record<string, unknown>) => PgPool)
    | undefined;
  if (!PoolCtor) {
    throw new Error("Invalid pg module: Pool constructor not found");
  }

  const max = parsePositiveIntEnv("FLOE_POSTGRES_POOL_MAX", 10);
  const idleTimeoutMillis = parsePositiveIntEnv("FLOE_POSTGRES_IDLE_TIMEOUT_MS", 30_000, 1000);
  const connectionTimeoutMillis = parsePositiveIntEnv(
    "FLOE_POSTGRES_CONNECT_TIMEOUT_MS",
    10_000,
    1000,
  );
  const statementTimeoutMs = parsePositiveIntEnv(
    "FLOE_POSTGRES_STATEMENT_TIMEOUT_MS",
    30_000,
    1000,
  );

  let effectiveConnectionString = connectionString;
  const separator = connectionString.includes("?") ? "&" : "?";
  effectiveConnectionString += `${separator}statement_timeout=${statementTimeoutMs}`;

  return new PoolCtor({
    connectionString: effectiveConnectionString,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
  }) as PgPool;
}

export async function initPostgres(log?: FastifyBaseLogger): Promise<PgPool | null> {
  if (pool && enabled) return pool;
  const url = databaseUrl();
  if (!url) {
    enabled = false;
    pool = null;
    return null;
  }

  try {
    const client = await loadPgPool(url);
    await client.query("select 1");
    pool = client;
    enabled = true;
    log?.info("Postgres initialized");
    return pool;
  } catch (err) {
    pool = null;
    enabled = false;
    if (isPostgresRequired()) {
      throw err;
    }
    log?.warn({ err }, "Postgres unavailable; continuing without read-model index");
    return null;
  }
}

export function getPostgres(): PgPool | null {
  if (!enabled || !pool) return null;
  return pool;
}

export async function closePostgres(): Promise<void> {
  if (!pool) return;
  await pool.end().catch((err) => console.warn(`[Postgres] Pool shutdown failed: ${err.message}`));
  pool = null;
  enabled = false;
}

export function setPostgresForTests(client: PgPool | null, nextEnabled = !!client): void {
  pool = client;
  enabled = nextEnabled && !!client;
}

export async function checkPostgresHealth(): Promise<{
  enabled: boolean;
  ok: boolean | null;
  latencyMs: number | null;
}> {
  if (!databaseUrl()) {
    return {
      enabled: false,
      ok: null,
      latencyMs: null,
    };
  }

  if (!enabled || !pool) {
    return {
      enabled: false,
      ok: false,
      latencyMs: null,
    };
  }

  const start = Date.now();
  try {
    await pool.query("select 1");
    return {
      enabled: true,
      ok: true,
      latencyMs: Date.now() - start,
    };
  } catch {
    return {
      enabled: true,
      ok: false,
      latencyMs: Date.now() - start,
    };
  }
}
