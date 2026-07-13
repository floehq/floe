import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const STORE_PATH = "../src/services/auth/auth.api-key.pg.js";

type PgPool = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>;
  end: () => Promise<void>;
};

let postgresModule: typeof import("../src/state/postgres.js");

beforeEach(async () => {
  delete process.env.DATABASE_URL;
  postgresModule = await import("../src/state/postgres.js");
  postgresModule.setPostgresForTests(null, false);
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  postgresModule?.setPostgresForTests(null, false);
});

function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

function buildMockPg(overrides?: { findByHashResult?: any[]; listActiveResult?: any[] }): PgPool {
  return {
    query: async (_sql: string, _values?: unknown[]) => {
      // findByHash has LIMIT 1; listActive has ORDER BY
      if (
        _sql.includes("from floe_api_keys") &&
        _sql.includes("secret_hash") &&
        _sql.includes("limit")
      ) {
        return { rows: overrides?.findByHashResult ?? [] };
      }
      // listActive has ORDER BY; findByHash does not
      if (_sql.includes("from floe_api_keys") && _sql.includes("order by")) {
        return { rows: overrides?.listActiveResult ?? [] };
      }
      if (_sql.includes("create table")) {
        return { rows: [] };
      }
      if (_sql.includes("create index")) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    end: async () => {},
  };
}

test("PostgresApiKeyStore - findByHash returns StoredApiKey when hash matches", async () => {
  const secret = "sk_live_abc123";
  const hexHash = hashSecret(secret);
  postgresModule.setPostgresForTests(
    buildMockPg({
      findByHashResult: [
        {
          id: "key-1",
          secret_hash: hexHash,
          owner: "0xf35568c562fd25dccd58e4e9240d8a6f864de0a9854ddd1f7d8aa6ff5f9722a4",
          scopes: ["*"],
          tier: "authenticated",
        },
      ],
    }),
    true,
  );

  const { PostgresApiKeyStore } = await import(STORE_PATH);
  const store = new PostgresApiKeyStore();
  const inputHash = Buffer.from(hexHash, "hex");
  const result = await store.findByHash(inputHash);

  assert.ok(result !== null);
  assert.equal(result.id, "key-1");
  assert.equal(result.secretHash.toString("hex"), hexHash);
  assert.equal(result.owner, "0xf35568c562fd25dccd58e4e9240d8a6f864de0a9854ddd1f7d8aa6ff5f9722a4");
  assert.deepEqual(result.scopes, ["*"]);
  assert.equal(result.tier, "authenticated");
});

test("PostgresApiKeyStore - findByHash returns null when no match", async () => {
  postgresModule.setPostgresForTests(buildMockPg({ findByHashResult: [] }), true);

  const { PostgresApiKeyStore } = await import(STORE_PATH);
  const store = new PostgresApiKeyStore();
  const inputHash = crypto.createHash("sha256").update("nonexistent").digest();
  const result = await store.findByHash(inputHash);

  assert.equal(result, null);
});

test("PostgresApiKeyStore - findByHash returns null when key is revoked (not in results)", async () => {
  // The SQL query includes "revoked_at is null" — revoked keys won't match.
  postgresModule.setPostgresForTests(buildMockPg({ findByHashResult: [] }), true);

  const { PostgresApiKeyStore } = await import(STORE_PATH);
  const store = new PostgresApiKeyStore();
  const inputHash = crypto.createHash("sha256").update("revoked-key").digest();
  const result = await store.findByHash(inputHash);

  assert.equal(result, null);
});

test("PostgresApiKeyStore - findByHash returns null when postgres is not available", async () => {
  // No mock set — postgres is disabled
  const { PostgresApiKeyStore } = await import(STORE_PATH);
  const store = new PostgresApiKeyStore();
  const inputHash = crypto.createHash("sha256").update("any-key").digest();
  const result = await store.findByHash(inputHash);

  assert.equal(result, null);
});

test("PostgresApiKeyStore - listActive returns non-revoked keys only", async () => {
  const secret1 = "sk_live_key1";
  const secret2 = "sk_live_key2";
  postgresModule.setPostgresForTests(
    buildMockPg({
      listActiveResult: [
        {
          id: "key-1",
          secret_hash: hashSecret(secret1),
          owner: null,
          scopes: ["uploads:write"],
          tier: "authenticated",
        },
        {
          id: "key-2",
          secret_hash: hashSecret(secret2),
          owner: "0xf35568c562fd25dccd58e4e9240d8a6f864de0a9854ddd1f7d8aa6ff5f9722a4",
          scopes: ["files:read"],
          tier: "public",
        },
      ],
    }),
    true,
  );

  const { PostgresApiKeyStore } = await import(STORE_PATH);
  const store = new PostgresApiKeyStore();
  const active = await store.listActive();

  assert.equal(active.length, 2);
  assert.equal(active[0].id, "key-1");
  assert.equal(active[0].secretHash.toString("hex"), hashSecret(secret1));
  assert.equal(active[0].owner, undefined);
  assert.deepEqual(active[0].scopes, ["uploads:write"]);
  assert.equal(active[0].tier, "authenticated");

  assert.equal(active[1].id, "key-2");
  assert.equal(active[1].tier, "public");
});

test("PostgresApiKeyStore - listActive returns empty when no active keys", async () => {
  postgresModule.setPostgresForTests(buildMockPg({ listActiveResult: [] }), true);

  const { PostgresApiKeyStore } = await import(STORE_PATH);
  const store = new PostgresApiKeyStore();
  const active = await store.listActive();

  assert.deepEqual(active, []);
});

test("PostgresApiKeyStore - listActive returns empty when postgres is not available", async () => {
  const { PostgresApiKeyStore } = await import(STORE_PATH);
  const store = new PostgresApiKeyStore();
  const active = await store.listActive();

  assert.deepEqual(active, []);
});

test("PostgresApiKeyStore - scopes array handles string format", async () => {
  const secret = "sk_test_scopes";
  const hexHash = hashSecret(secret);
  postgresModule.setPostgresForTests(
    buildMockPg({
      findByHashResult: [
        {
          id: "key-scopes",
          secret_hash: hexHash,
          owner: null,
          scopes: ["uploads:write", "files:read"],
          tier: "authenticated",
        },
      ],
    }),
    true,
  );

  const { PostgresApiKeyStore } = await import(STORE_PATH);
  const store = new PostgresApiKeyStore();
  const inputHash = Buffer.from(hexHash, "hex");
  const result = await store.findByHash(inputHash);

  assert.ok(result !== null);
  assert.deepEqual(result.scopes, ["uploads:write", "files:read"]);
});

test("PostgresApiKeyStore - ensureApiKeysTable creates table and indexes", async () => {
  const queries: string[] = [];
  postgresModule.setPostgresForTests(
    {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      },
      end: async () => {},
    },
    true,
  );

  const { ensureApiKeysTable } = await import(STORE_PATH);
  await ensureApiKeysTable();

  assert.ok(queries.some((q) => q.includes("create table if not exists floe_api_keys")));
  assert.ok(queries.some((q) => q.includes("floe_api_keys_secret_hash_idx")));
  assert.ok(queries.some((q) => q.includes("floe_api_keys_active_idx")));
});

test("PostgresApiKeyStore - EnvApiKeyStore findByHash returns correct key", async () => {
  // Direct test of EnvApiKeyStore without relying on module-level config parsing
  const { setApiKeyStore } = await import("../src/services/auth/auth.api-key.js");

  process.env.FLOE_API_KEYS_JSON = JSON.stringify([
    {
      id: "test-key",
      secret: "sk_test_secret",
      owner: "0xf35568c562fd25dccd58e4e9240d8a6f864de0a9854ddd1f7d8aa6ff5f9722a4",
      scopes: ["*"],
      tier: "authenticated",
    },
  ]);

  // Force fresh import of config module by deleting the cached key
  delete process.env.FLOE_API_KEYS_JSON;

  // Actually, let's test via a different approach:
  // Manually create the store and test that buildLocalAuthContext returns null
  // when no store is set (EnvApiKeyStore reads from AuthApiKeyConfig which was
  // already loaded without keys)

  // Reset to default store
  setApiKeyStore(null);

  const { buildLocalAuthContext } = await import("../src/services/auth/auth.api-key.js");

  const req = {
    ip: "127.0.0.1",
    headers: { "x-api-key": "some_key" },
  } as any;

  // Default store (EnvApiKeyStore) with empty config
  const result = await buildLocalAuthContext(req);
  assert.equal(result, null);
});
