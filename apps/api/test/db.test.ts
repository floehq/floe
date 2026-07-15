import test from "node:test";
import assert from "node:assert/strict";

// ============================================================
// DB Files Repository tests
// ============================================================
test("files repository - getIndexedFile returns null when postgres is not enabled", async () => {
  const mod = await import("../src/db/files.repository.js");
  const result = await mod.getIndexedFile("test-file-id");
  assert.equal(result, null);
});

test("files repository - upsertIndexedFile is noop when postgres is not enabled", async () => {
  const mod = await import("../src/db/files.repository.js");
  // Should not throw
  await mod.upsertIndexedFile({
    fileId: "test",
    blobId: "blob123",
    blobObjectId: null,
    ownerAddress: null,
    sizeBytes: 100,
    mimeType: "video/mp4",
    walrusEndEpoch: null,
    createdAtMs: Date.now(),
    deletedAtMs: null,
  });
});

test("files repository - ensureFilesTable is noop when postgres is not enabled", async () => {
  const mod = await import("../src/db/files.repository.js");
  await mod.ensureFilesTable();
  // Should not throw
});

test("files repository - getIndexedFile returns record with mock pg", async () => {
  const postgres = await import("../src/state/postgres.js");

  // Create a mock pg pool
  const mockPg = {
    query: async (sql: string, _values?: unknown[]) => {
      if (sql.includes("select") && sql.includes("from floe_files")) {
        return {
          rows: [
            {
              file_id: "test-file-1",
              blob_id: "blob-abc-123",
              blob_object_id: "0x1234567890abcdef",
              owner_address: "0xowner1234567890",
              size_bytes: 1024,
              mime_type: "video/mp4",
              walrus_end_epoch: 100,
              created_at_ms: Date.now(),
              deleted_at_ms: null,
            },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    },
    end: async () => {},
  };

  postgres.setPostgresForTests(mockPg as unknown as NonNullable<Parameters<typeof postgres.setPostgresForTests>[0]>, true);

  const mod = await import("../src/db/files.repository.js");
  const result = await mod.getIndexedFile("test-file-1");

  assert.ok(result !== null);
  assert.equal(result.fileId, "test-file-1");
  assert.equal(result.blobId, "blob-abc-123");
  assert.equal(result.blobObjectId, "0x1234567890abcdef");
  assert.equal(result.ownerAddress, "0xowner1234567890");
  assert.equal(result.sizeBytes, 1024);
  assert.equal(result.mimeType, "video/mp4");
  assert.equal(result.walrusEndEpoch, 100);
});

test("files repository - getIndexedFile returns null when no rows returned", async () => {
  const postgres = await import("../src/state/postgres.js");

  const mockPg = {
    query: async () => ({ rows: [], rowCount: 0 }),
    end: async () => {},
  };

  postgres.setPostgresForTests(mockPg as unknown as NonNullable<Parameters<typeof postgres.setPostgresForTests>[0]>, true);

  const mod = await import("../src/db/files.repository.js");
  const result = await mod.getIndexedFile("nonexistent-file");
  assert.equal(result, null);
});

test("files repository - getIndexedFile handles null walrus_end_epoch", async () => {
  const postgres = await import("../src/state/postgres.js");

  const mockPg = {
    query: async () => ({
      rows: [
        {
          file_id: "test-file-2",
          blob_id: "blob-xyz",
          blob_object_id: null,
          owner_address: null,
          size_bytes: 512,
          mime_type: "text/plain",
          walrus_end_epoch: null,
          created_at_ms: 1000000,
          deleted_at_ms: null,
        },
      ],
    }),
    end: async () => {},
  };

  postgres.setPostgresForTests(mockPg as unknown as NonNullable<Parameters<typeof postgres.setPostgresForTests>[0]>, true);

  const mod = await import("../src/db/files.repository.js");
  const result = await mod.getIndexedFile("test-file-2");

  assert.ok(result !== null);
  assert.equal(result.blobObjectId, null);
  assert.equal(result.ownerAddress, null);
  assert.equal(result.walrusEndEpoch, null);
});

test("files repository - upsertIndexedFile calls pg.query with correct params", async () => {
  const postgres = await import("../src/state/postgres.js");

  let queryCalled = false;
  const mockPg = {
    query: async (sql: string, _values?: unknown[]) => {
      queryCalled = true;
      assert.ok(sql.includes("insert into floe_files"));
      assert.equal(_values?.[0], "test-upsert-file");
      assert.equal(_values?.[1], "blob-upsert");
      return { rows: [], rowCount: 0 };
    },
    end: async () => {},
  };

  postgres.setPostgresForTests(mockPg as unknown as NonNullable<Parameters<typeof postgres.setPostgresForTests>[0]>, true);

  const mod = await import("../src/db/files.repository.js");
  await mod.upsertIndexedFile({
    fileId: "test-upsert-file",
    blobId: "blob-upsert",
    blobObjectId: "object-123",
    ownerAddress: "0xowner",
    sizeBytes: 2048,
    mimeType: "application/octet-stream",
    walrusEndEpoch: 50,
    createdAtMs: Date.now(),
    deletedAtMs: null,
  });
  assert.equal(queryCalled, true);
});
