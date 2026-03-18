import type { FastifyBaseLogger } from "fastify";

type PgPool = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>;
  end: () => Promise<void>;
};

let pool: PgPool | null = null;
let enabled = false;

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "1" || raw.toLowerCase() === "true") return true;
  if (raw === "0" || raw.toLowerCase() === "false") return false;
  throw new Error(`${name} must be one of: 1, 0, true, false`);
}

function parsePositiveIntEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return n;
}

function databaseUrl(): string {
  return (process.env.DATABASE_URL ?? "").trim();
}

export function isPostgresConfigured(): boolean {
  return databaseUrl().length > 0;
}

export function isPostgresEnabled(): boolean {
  return enabled && !!pool;
}

function isPostgresRequired(): boolean {
  return parseBoolEnv("FLOE_POSTGRES_REQUIRED", false);
}

async function loadPgPool(connectionString: string): Promise<PgPool> {
  const dynamicImport = new Function("s", "return import(s)") as (
    specifier: string
  ) => Promise<any>;
  const pg = await dynamicImport("pg").catch(() => null);
  if (!pg) {
    throw new Error("Postgres driver not found. Run: npm install pg --workspace=apps/api");
  }

  const PoolCtor = pg.Pool ?? pg.default?.Pool;
  if (!PoolCtor) {
    throw new Error("Invalid pg module: Pool constructor not found");
  }

  const max = parsePositiveIntEnv("FLOE_POSTGRES_POOL_MAX", 10);
  const idleTimeoutMillis = parsePositiveIntEnv("FLOE_POSTGRES_IDLE_TIMEOUT_MS", 30_000, 1000);
  const connectionTimeoutMillis = parsePositiveIntEnv(
    "FLOE_POSTGRES_CONNECT_TIMEOUT_MS",
    10_000,
    1000
  );

  return new PoolCtor({
    connectionString,
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
  await pool.end().catch(() => {});
  pool = null;
  enabled = false;
}

export async function checkPostgresHealth(): Promise<{
  enabled: boolean;
  ok: boolean | null;
  latencyMs: number | null;
}> {
  if (!enabled || !pool) {
    return {
      enabled: false,
      ok: null,
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
