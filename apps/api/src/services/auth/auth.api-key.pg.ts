import crypto from "node:crypto";

import type { RateLimitTier } from "../../config/auth.config.js";
import { getPostgres } from "../../state/postgres.js";
import { type ApiKeyStore, type StoredApiKey } from "./auth.api-key-store.js";

/**
 * Postgres-backed API key store.
 * Reads from the floe_api_keys table — never stores plaintext secrets,
 * only SHA-256 hashes.
 *
 * Create/revoke operations are NOT provided here; the SaaS layer or a
 * later admin API writes to this table directly.
 */
export class PostgresApiKeyStore implements ApiKeyStore {
  /**
   * Legacy lookup by full SHA-256 hash of the entire credential.
   * Prefer findById for new deployments to avoid the timing side-channel
   * of SQL-level hash comparison.
   */
  async findByHash(hash: Buffer): Promise<StoredApiKey | null> {
    const pg = getPostgres();
    if (!pg) return null;

    const hex = hash.toString("hex");
    const out = await pg.query(
      `
        select
          id,
          secret_hash,
          owner,
          scopes,
          tier
        from floe_api_keys
        where secret_hash = $1 and revoked_at is null
        limit 1
      `,
      [hex],
    );

    const row = out.rows[0];
    if (!row) return null;

    const storedHash = Buffer.from(String(row.secret_hash), "hex");
    if (storedHash.length !== 32) return null;

    return {
      id: String(row.id),
      secretHash: storedHash,
      owner: row.owner ? String(row.owner) : undefined,
      scopes: parseScopes(row.scopes),
      tier: parseTier(row.tier),
    };
  }

  /**
   * Look up a key by its public id (PK lookup).
   * The caller independently verifies the secret hash via
   * crypto.timingSafeEqual — this avoids the timing side-channel of
   * comparing hashes inside the SQL query.
   */
  async findById(id: string): Promise<StoredApiKey | null> {
    const pg = getPostgres();
    if (!pg) return null;

    const out = await pg.query(
      `
        select
          id,
          secret_hash,
          owner,
          scopes,
          tier
        from floe_api_keys
        where id = $1 and revoked_at is null
        limit 1
      `,
      [id],
    );

    const row = out.rows[0];
    if (!row) return null;

    const storedHash = Buffer.from(String(row.secret_hash), "hex");
    if (storedHash.length !== 32) return null;

    return {
      id: String(row.id),
      secretHash: storedHash,
      owner: row.owner ? String(row.owner) : undefined,
      scopes: parseScopes(row.scopes),
      tier: parseTier(row.tier),
    };
  }

  async listActive(): Promise<StoredApiKey[]> {
    const pg = getPostgres();
    if (!pg) return [];

    const out = await pg.query(
      `
        select
          id,
          secret_hash,
          owner,
          scopes,
          tier
        from floe_api_keys
        where revoked_at is null
        order by created_at asc
      `,
    );

    return out.rows
      .filter((row: any) => {
        const hash = String(row.secret_hash ?? "");
        if (!hash) return false;
        const buf = Buffer.from(hash, "hex");
        return buf.length === 32;
      })
      .map((row: any) => ({
        id: String(row.id),
        secretHash: Buffer.from(String(row.secret_hash), "hex"),
        owner: row.owner ? String(row.owner) : undefined,
        scopes: parseScopes(row.scopes),
        tier: parseTier(row.tier),
      }));
  }
}

function parseScopes(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => v.trim());
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    // Handle comma-separated or JSON-encoded arrays
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parseScopes(parsed);
    } catch {
      return raw
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function parseTier(raw: unknown): RateLimitTier {
  return String(raw ?? "")
    .trim()
    .toLowerCase() === "public"
    ? "public"
    : "authenticated";
}

/**
 * Ensure the floe_api_keys table exists.
 * Call during startup when FLOE_API_KEY_STORE=postgres.
 */
export async function ensureApiKeysTable(): Promise<void> {
  const pg = getPostgres();
  if (!pg) return;

  await pg.query(`
    create table if not exists floe_api_keys (
      id text primary key,
      secret_hash text not null,
      owner text null,
      scopes text[] not null default '{}',
      tier text not null default 'authenticated',
      created_at timestamptz not null default now(),
      revoked_at timestamptz null
    );
  `);

  await pg.query(`
    create index if not exists floe_api_keys_secret_hash_idx
    on floe_api_keys (secret_hash);
  `);

  await pg.query(`
    create index if not exists floe_api_keys_active_idx
    on floe_api_keys (revoked_at)
    where revoked_at is null;
  `);
}
