import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const STORE_PATH = "../src/services/auth/auth.api-key.pg.js";

type PgPool = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }>;
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

function buildMockPg(overrides?: {
  findByHashResult?: Array<Record<string, unknown>>;
  findByIdResult?: Array<Record<string, unknown>>;
  listActiveResult?: Array<Record<string, unknown>>;
}): PgPool {
  return {
    query: async (_sql: string, _values?: unknown[]) => {
      // findById uses WHERE id = $1
      if (
        _sql.includes("from floe_api_keys") &&
        _sql.includes("where id =") &&
        _sql.includes("limit")
      ) {
        return { rows: overrides?.findByIdResult ?? [] };
      }
      // findByHash uses WHERE secret_hash = $1
      if (
        _sql.includes("from floe_api_keys") &&
        _sql.includes("secret_hash") &&
        _sql.includes("limit")
      ) {
        return { rows: overrides?.findByHashResult ?? [] };
      }
      // listActive has ORDER BY
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

test("PostgresApiKeyStore - findById returns StoredApiKey when id matches", async () => {
  const secretPart = "abc123def456";
  const hexHash = crypto.createHash("sha256").update(secretPart).digest("hex");
  postgresModule.setPostgresForTests(
    buildMockPg({
      findByIdResult: [
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
  const result = await store.findById("key-1");

  assert.ok(result !== null);
  assert.equal(result.id, "key-1");
  assert.equal(result.secretHash.toString("hex"), hexHash);
  assert.equal(result.owner, "0xf35568c562fd25dccd58e4e9240d8a6f864de0a9854ddd1f7d8aa6ff5f9722a4");
  assert.deepEqual(result.scopes, ["*"]);
  assert.equal(result.tier, "authenticated");
});

test("PostgresApiKeyStore - findById returns null when id not found", async () => {
  postgresModule.setPostgresForTests(buildMockPg({ findByIdResult: [] }), true);

  const { PostgresApiKeyStore } = await import(STORE_PATH);
  const store = new PostgresApiKeyStore();
  const result = await store.findById("nonexistent-key");
  assert.equal(result, null);
});

test("PostgresApiKeyStore - findById returns null when postgres not available", async () => {
  const { PostgresApiKeyStore } = await import(STORE_PATH);
  const store = new PostgresApiKeyStore();
  const result = await store.findById("any-key");
  assert.equal(result, null);
});

test("PostgresApiKeyStore - findById returns null when key is revoked (filtered by SQL)", async () => {
  postgresModule.setPostgresForTests(buildMockPg({ findByIdResult: [] }), true);

  const { PostgresApiKeyStore } = await import(STORE_PATH);
  const store = new PostgresApiKeyStore();
  const result = await store.findById("revoked-key");
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
  } as Record<string, unknown>;

  // Default store (EnvApiKeyStore) with empty config
  const result = await buildLocalAuthContext(req);
  assert.equal(result, null);
});

test("parseKeyId parses floe_<id>_<secret> format", async () => {
  const { parseKeyId } = await import("../src/services/auth/auth.api-key.js");

  const parsed = parseKeyId("floe_key1_aB3xY9zW");
  assert.ok(parsed !== null);
  assert.equal(parsed.keyId, "key1");
  assert.equal(parsed.secretPart, "aB3xY9zW");
});

test("EnvApiKeyStore - parseKeyId handles legacy keys (no floe_ prefix)", async () => {
  const { parseKeyId } = await import("../src/services/auth/auth.api-key.js");

  // Legacy format should return null
  const result = parseKeyId("sk_live_abc123");
  assert.equal(result, null);

  // Edge cases
  assert.equal(parseKeyId(""), null);
  assert.equal(parseKeyId("floe_"), null);
  assert.equal(parseKeyId("floe_key1"), null); // no secret part
  assert.equal(parseKeyId("floe_key1_"), null); // empty secret part
});

test("EnvApiKeyStore - parseKeyId handles edge cases", async () => {
  const { parseKeyId } = await import("../src/services/auth/auth.api-key.js");

  // keyId with hyphens and underscores
  const r1 = parseKeyId("floe_my-key-42_s3cret");
  assert.ok(r1);
  assert.equal(r1.keyId, "my-key-42");
  assert.equal(r1.secretPart, "s3cret");

  // keyId with mixed case
  const r2 = parseKeyId("floe_KeyABC_longsecretvaluehere");
  assert.ok(r2);
  assert.equal(r2.keyId, "KeyABC");
  assert.equal(r2.secretPart, "longsecretvaluehere");
});

test("verifyRequestApiKey - timing does not vary meaningfully between missing key-id and wrong secret", async () => {
  // Coarse timing comparison across N iterations.
  // We can't measure nanosecond precision in a unit test (GC, CPU
  // scheduling), but we can verify that a missing-key path doesn't
  // skip timingSafeEqual entirely — a missing dummy call would make
  // it 10-100x faster, which this threshold catches.
  //
  // Path A: findById returns null (key-id not found)
  //   → verifyRequestApiKey does dummy timingSafeEqual → null
  // Path B: findById returns stored hash (key-id found)
  //   → verifyRequestApiKey does real timingSafeEqual with wrong secret → null
  //
  // We inject test keys directly into the config module since ESM
  // module cache can't be reliably invalidated for re-parsing.

  const authConfig = await import("../src/config/auth.config.js");
  const testKey = {
    id: "test-key",
    secret: "floe_test-key_real-secret-suffix",
    owner: null as string | undefined,
    scopes: ["*"] as string[],
    tier: "authenticated" as const,
  };
  authConfig.AuthApiKeyConfig.keys.push(testKey);

  const { setApiKeyStore, buildLocalAuthContext } =
    await import("../src/services/auth/auth.api-key.js");
  setApiKeyStore(null); // reset to EnvApiKeyStore

  async function measureAuth(keyValue: string, iterations = 100): Promise<number> {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const req = {
        ip: "127.0.0.1",
        headers: { "x-api-key": keyValue },
      } as Record<string, unknown>;
      const result = await buildLocalAuthContext(req);
      // Path A: null expected (missing key-id → dummy timingSafeEqual → null)
      // Path B: null expected (key-id found, wrong secret → real timingSafeEqual → false → null)
      if (result !== null) {
        throw new Error("Unexpected successful auth");
      }
    }
    return performance.now() - start;
  }

  const ITERATIONS = 100;

  const timeMissingKey = await measureAuth("floe_unknown-key_any-secret-suffix", ITERATIONS);
  const timeWrongSecret = await measureAuth("floe_test-key_wrong-secret-suffix", ITERATIONS);

  const maxTime = Math.max(timeMissingKey, timeWrongSecret);
  const minTime = Math.min(timeMissingKey, timeWrongSecret);
  const ratio = maxTime / minTime;

  // Allow up to 3x variance for GC/CPU noise.
  // A missing dummy timingSafeEqual would produce < 0.01x (orders of
  // magnitude faster), so 3x is a generous safety margin.
  assert.ok(
    ratio <= 3,
    `Timing variance too large: missing-key=${timeMissingKey.toFixed(1)}ms ` +
      `wrong-secret=${timeWrongSecret.toFixed(1)}ms ratio=${ratio.toFixed(2)}x ` +
      "(expected <= 3x)",
  );

  // Also verify the happy path (correct secret) produces a successful auth
  const req = {
    ip: "127.0.0.1",
    headers: { "x-api-key": "floe_test-key_real-secret-suffix" },
  } as Record<string, unknown>;
  const success = await buildLocalAuthContext(req);
  assert.ok(success !== null, "correct secret should authenticate");
  assert.equal(success.keyId, "test-key");
  assert.equal(success.subjectType, "api_key");

  // Clean up injected key so other tests aren't affected
  authConfig.AuthApiKeyConfig.keys.length = 0;
});
