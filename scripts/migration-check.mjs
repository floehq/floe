#!/usr/bin/env node

/**
 * Migration check — run DB migrations against a clean Postgres instance
 * and verify expected tables exist.
 *
 * Usage: node scripts/migration-check.mjs
 *
 * Requires DATABASE_URL and FLOE_POSTGRES_REQUIRED=1 in the environment.
 * Exits with code 0 on success, 1 on failure.
 */

const { execSync } = await import("child_process");
const { createRequire } = await import("module");
const _require = createRequire(import.meta.url);

// Load the Postgres module via tsx to handle TypeScript
const cmd = new URL("../apps/api/src/state/postgres.ts", import.meta.url).pathname;
const { initPostgres, getPostgres, closePostgres } = await import(cmd);

const filesRepoPath = new URL("../apps/api/src/db/files.repository.ts", import.meta.url).pathname;
const { ensureFilesTable } = await import(filesRepoPath);

const apiKeyPgPath = new URL(
  "../apps/api/src/services/auth/auth.api-key.pg.ts",
  import.meta.url,
).pathname;
const { ensureApiKeysTable } = await import(apiKeyPgPath);

if (!process.env.DATABASE_URL?.trim()) {
  console.error("FATAL: DATABASE_URL is required");
  process.exit(1);
}

try {
  console.log("Initializing Postgres connection...");
  await initPostgres();

  const pg = getPostgres();
  if (!pg) {
    console.error("FATAL: Postgres connection failed");
    process.exit(1);
  }

  console.log("Running ensureFilesTable migration...");
  await ensureFilesTable();

  console.log("Running ensureApiKeysTable migration...");
  await ensureApiKeysTable();

  // Verify expected tables
  const tables = await pg.query(
    `select table_name from information_schema.tables
     where table_schema = $1 and table_name like $2`,
    ["public", "floe_%"],
  );
  const names = tables.rows.map((r) => r.table_name).sort();
  console.log("Tables found:", names.join(", "));

  const expected = ["floe_api_keys", "floe_files", "floe_migrations"];
  // floe_blob_objects is created by migration v2
  const optional = ["floe_blob_objects"];

  for (const name of expected) {
    if (!names.includes(name)) {
      console.error(`MISSING expected table: ${name}`);
      process.exit(1);
    }
  }

  for (const name of optional) {
    if (names.includes(name)) {
      console.log(`Optional table present: ${name}`);
    }
  }

  console.log("Migration check: PASS");
} catch (err) {
  console.error("Migration check: FAIL", err);
  process.exit(1);
} finally {
  await closePostgres().catch(() => {});
}
