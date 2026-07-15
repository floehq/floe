/**
 * Postgres-backed API key store — integration test.
 *
 * Connects to a real Postgres instance (via DATABASE_URL),
 * creates the floe_api_keys table, inserts test keys, and
 * exercises the full CRUD-adjacent read path.
 *
 * Skipped when DATABASE_URL is not set.
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const PG_STORE_PATH = "../src/services/auth/auth.api-key.pg.js";
const STATE_PATH = "../src/state/postgres.js";

test(
  "PostgresApiKeyStore integration — real Postgres lifecycle",
  { timeout: 15_000 },
  async (t) => {
    if (!process.env.DATABASE_URL?.trim()) {
      return t.skip("DATABASE_URL not set");
    }

    const postgresModule = await import(STATE_PATH);
    const pgPool = await postgresModule.initPostgres();
    assert.ok(pgPool, "Postgres pool should initialize");

    // Create the table
    const { ensureApiKeysTable, PostgresApiKeyStore } = await import(PG_STORE_PATH);
    await ensureApiKeysTable();

    // Verify table exists
    const tables = await pgPool.query(`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_name = 'floe_api_keys'
  `);
    assert.ok(tables.rows.length > 0, "floe_api_keys table should exist");

    // Insert a test key directly via SQL
    const testId = `integration-test-${crypto.randomUUID().slice(0, 8)}`;
    const testSecret = `sk_int_${crypto.randomBytes(16).toString("hex")}`;
    const testHash = crypto.createHash("sha256").update(testSecret).digest("hex");
    const testOwner = "0xf35568c562fd25dccd58e4e9240d8a6f864de0a9854ddd1f7d8aa6ff5f9722a4";
    const testScopes = ["uploads:write", "files:read"];

    await pgPool.query(
      `insert into floe_api_keys (id, secret_hash, owner, scopes, tier)
     values ($1, $2, $3, $4, $5)`,
      [testId, testHash, testOwner, testScopes, "authenticated"],
    );

    const store = new PostgresApiKeyStore();

    // findByHash
    const byHash = await store.findByHash(Buffer.from(testHash, "hex"));
    assert.ok(byHash !== null, "findByHash should find inserted key");
    assert.equal(byHash.id, testId);
    assert.equal(byHash.secretHash.toString("hex"), testHash);
    assert.equal(byHash.owner, testOwner);
    assert.deepEqual(byHash.scopes.sort(), testScopes.sort());
    assert.equal(byHash.tier, "authenticated");

    // findById
    const byId = await store.findById(testId);
    assert.ok(byId !== null, "findById should find inserted key");
    assert.equal(byId.id, testId);
    assert.equal(byId.tier, "authenticated");

    // listActive
    const active = await store.listActive();
    const found = active.find((k) => k.id === testId);
    assert.ok(found, "listActive should include the inserted key");
    assert.equal(found.secretHash.toString("hex"), testHash);

    // Cleanup: remove the test key
    await pgPool.query("delete from floe_api_keys where id = $1", [testId]);

    // Verify deletion
    const afterDelete = await store.findById(testId);
    assert.equal(afterDelete, null, "findById should return null after deletion");

    // Cleanup the table (drop only our test table to leave other tests unaffected)
    await pgPool.query("drop table if exists floe_api_keys cascade");
    await pgPool.query("drop index if exists floe_api_keys_secret_hash_idx cascade");
    await pgPool.query("drop index if exists floe_api_keys_active_idx cascade");

    await postgresModule.closePostgres();
  },
);
