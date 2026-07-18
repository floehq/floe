// ============================================================
// Node imports (no Floe deps — safe to import statically)
// ============================================================
import test, { after, afterEach, before, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// ============================================================
// Env vars MUST be set before any Floe module is loaded
// ============================================================
const testTmpDir = `/tmp/floe-test-finalize-${process.pid}`;

process.env.FLOE_CHUNK_STORE_MODE = "disk";
process.env.UPLOAD_TMP_DIR = testTmpDir;
process.env.FLOE_NETWORK = "testnet";
process.env.SUI_PRIVATE_KEY = `[${new Array(32).fill(0).join(",")}]`;
process.env.SUI_PACKAGE_ID = "0x2::package::module";
process.env.FLOE_WALRUS_STORE_MODE = "cli";
process.env.FLOE_WALRUS_CLI_BIN = "walrus";
process.env.FLOE_UPLOAD_SESSION_TTL_MS = "3600000";
process.env.FLOE_CHUNK_MIN_BYTES = "1";
process.env.FLOE_CHUNK_DEFAULT_BYTES = "4";
process.env.FLOE_CHUNK_MAX_BYTES = "8";
process.env.FLOE_MAX_FILE_SIZE_BYTES = "10737418240";
process.env.FLOE_MAX_TOTAL_CHUNKS = "200000";

// ============================================================
// Floe module placeholders (loaded dynamically in before())
// ============================================================
let finalizeUpload: any;
let setRedisForTests: any;
let uploadKeys: any;

// ============================================================
// Dynamic imports AFTER env vars are set
// ============================================================
before(async () => {
  const redisMod = await import("../src/state/redis.js");
  setRedisForTests = redisMod.setRedisForTests;

  const keysMod = await import("../src/state/keys.js");
  uploadKeys = keysMod.uploadKeys;

  const finalizeMod = await import("../src/services/uploads/finalize.service.js");
  finalizeUpload = finalizeMod.finalizeUpload;
});

// ============================================================
// Helpers
// ============================================================
const log = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
  child() {
    return this;
  },
} as any;

function createMockRedis() {
  const hashes = new Map<string, Map<string, string>>();
  const sets = new Map<string, Set<string>>();
  const strings = new Map<string, string>();

  const redis = {
    async smembers(key: string) {
      return [...(sets.get(key) ?? [])];
    },
    async sismember(key: string, value: string) {
      return sets.get(key)?.has(value) ? 1 : 0;
    },
    async sadd(key: string, ...values: string[]) {
      if (!sets.has(key)) sets.set(key, new Set());
      for (const v of values) sets.get(key)!.add(v);
      return values.length;
    },
    async srem(key: string, ...values: string[]) {
      const s = sets.get(key);
      if (!s) return 0;
      let removed = 0;
      for (const v of values) {
        if (s.delete(v)) removed++;
      }
      return removed;
    },
    async hgetall(key: string) {
      const h = hashes.get(key);
      if (!h) return null;
      return Object.fromEntries(h);
    },
    async hset(key: string, fields: Record<string, string>) {
      if (!hashes.has(key)) hashes.set(key, new Map());
      const h = hashes.get(key)!;
      for (const [k, v] of Object.entries(fields)) h.set(k, v);
      return Object.keys(fields).length;
    },
    async set(key: string, value: string, opts?: { nx?: boolean; ex?: number }) {
      if (opts?.nx && strings.has(key)) return null;
      strings.set(key, value);
      return "OK";
    },
    async eval(script: string, keys: string[], args: string[]) {
      const lockKey = keys[0];
      const lockToken = args[0];
      const current = strings.get(lockKey);
      if (current === lockToken) {
        if (script.includes("EXPIRE")) return 1;
        if (script.includes("DEL")) {
          strings.delete(lockKey);
          return 1;
        }
      }
      return 0;
    },
    async del(...keys: string[]) {
      let count = 0;
      for (const k of keys) {
        if (strings.delete(k)) count++;
        if (hashes.delete(k)) count++;
        if (sets.delete(k)) count++;
      }
      return count;
    },
    multi() {
      const ops: Array<() => Promise<any>> = [];
      const self = {
        hset(k: string, f: Record<string, string>) {
          ops.push(async () => {
            if (!hashes.has(k)) hashes.set(k, new Map());
            const h = hashes.get(k)!;
            for (const [fk, fv] of Object.entries(f)) h.set(fk, fv);
            return Object.keys(f).length;
          });
          return self;
        },
        sadd(k: string, ...vals: string[]) {
          ops.push(async () => {
            if (!sets.has(k)) sets.set(k, new Set());
            for (const v of vals) sets.get(k)!.add(v);
            return vals.length;
          });
          return self;
        },
        srem(k: string, ...vals: string[]) {
          ops.push(async () => {
            const s = sets.get(k);
            if (!s) return 0;
            let r = 0;
            for (const v of vals)
              if (s.delete(v)) r++;
            return r;
          });
          return self;
        },
        del(...keys: string[]) {
          ops.push(async () => {
            let c = 0;
            for (const k of keys) {
              if (strings.delete(k)) c++;
              if (hashes.delete(k)) c++;
              if (sets.delete(k)) c++;
            }
            return c;
          });
          return self;
        },
        async exec() {
          const results = [];
          for (const op of ops) {
            try {
              results.push([null, await op()]);
            } catch (err) {
              results.push([err, null]);
            }
          }
          return results;
        },
      };
      return self;
    },
  };

  return redis as any;
}

function makeSession(overrides?: Record<string, any>) {
  return {
    uploadId: `test-${crypto.randomUUID()}`,
    filename: "test.bin",
    contentType: "application/octet-stream",
    sizeBytes: 8,
    chunkSize: 4,
    totalChunks: 2,
    receivedChunks: [0, 1],
    resolvedEpochs: 5,
    status: "uploading",
    createdAt: Date.now(),
    expiresAt: Date.now() + 3600000,
    ...overrides,
  };
}

async function writeChunks(uploadId: string, totalChunks: number, data?: Buffer[]) {
  const dir = path.join(testTmpDir, uploadId);
  await fs.mkdir(dir, { recursive: true });
  for (let i = 0; i < totalChunks; i++) {
    await fs.writeFile(path.join(dir, String(i)), data?.[i] ?? Buffer.from(`c${i}    `));
  }
}

async function registerChunks(redis: any, uploadId: string, totalChunks: number) {
  for (let i = 0; i < totalChunks; i++) {
    await redis.sadd(uploadKeys.chunks(uploadId), String(i));
  }
}

/** Helper: drain a Readable stream to completion (used by mock streamFactory callers) */
async function drainStream(stream: any) {
  for await (const _ of stream) {}
}

// ============================================================
// Setup / Teardown
// ============================================================
afterEach(() => {
  mock.restoreAll();
});

after(async () => {
  await fs.rm(testTmpDir, { recursive: true, force: true }).catch(() => {});
});

// ============================================================
// Tests
// ============================================================

test("fast path — returns cached result when status is already completed", async () => {
  const redis = createMockRedis();
  setRedisForTests(redis);

  const session = makeSession({ uploadId: "completed-upload" });
  const metaKey = uploadKeys.meta(session.uploadId);

  await redis.hset(metaKey, {
    status: "completed",
    fileId: "0xfile123",
    blobId: "blob-abc",
    sizeBytes: "8",
    walrusEndEpoch: "10",
    finalizeTotalMs: "500",
    finalizeVerifyMs: "10",
    finalizeWalrusMs: "200",
    finalizeSuiMs: "150",
    finalizeRedisMs: "100",
    finalizeCleanupMs: "40",
  });

  const result = await finalizeUpload(session, { log });

  assert.equal(result.fileId, "0xfile123");
  assert.equal(result.blobId, "blob-abc");
  assert.equal(result.sizeBytes, 8);
  assert.equal(result.status, "ready");
  assert.equal(result.walrusEndEpoch, 10);
  assert.equal(result.finalize.totalMs, 500);
});

test("lock contention — throws UPLOAD_FINALIZATION_IN_PROGRESS", async () => {
  const redis = createMockRedis();
  setRedisForTests(redis);

  const session = makeSession({ uploadId: "lock-test" });
  const metaKey = uploadKeys.meta(session.uploadId);
  const lockKey = `${metaKey}:lock`;

  await redis.set(lockKey, "other-token");
  await redis.hset(metaKey, { status: "uploading" });

  await assert.rejects(
    () => finalizeUpload(session, { log }),
    (err: Error) => {
      assert.equal(err.message, "UPLOAD_FINALIZATION_IN_PROGRESS");
      return true;
    },
  );
});

test("missing chunks — throws MISSING_CHUNKS with stage annotation", async () => {
  const redis = createMockRedis();
  setRedisForTests(redis);

  const session = makeSession({ uploadId: "missing-chunks", totalChunks: 3 });
  await redis.sadd(uploadKeys.chunks(session.uploadId), "0", "1");

  try {
    await finalizeUpload(session, { log });
    assert.fail("should have thrown");
  } catch (err: any) {
    assert.equal(err.message, "MISSING_CHUNKS");
    assert.equal(err.finalizeStage, "verify_chunks");
  }
});

test("stage annotation — errors always carry finalizeStage", async () => {
  const redis = createMockRedis();
  setRedisForTests(redis);

  const session = makeSession({ uploadId: "stage-test", totalChunks: 2 });
  await redis.sadd(uploadKeys.chunks(session.uploadId), "0");

  try {
    await finalizeUpload(session, { log });
    assert.fail("should have thrown");
  } catch (err: any) {
    assert.equal(err.finalizeStage, "verify_chunks");
  }
});

test("walrus upload failure — throws WALRUS_UPLOAD_FAILED when blobId is null", async () => {
  const redis = createMockRedis();
  setRedisForTests(redis);

  const session = makeSession({ uploadId: "walrus-null" });
  await registerChunks(redis, session.uploadId, session.totalChunks);
  await writeChunks(session.uploadId, session.totalChunks);

  const deps = {
    uploadToWalrusWithMetrics: async (params: any) => {
      await drainStream(params.streamFactory());
      return { blobId: null, source: "unknown" as const };
    },
    findFileByChecksum: async () => null,
  };

  try {
    await finalizeUpload(session, { log }, deps);
    assert.fail("should have thrown");
  } catch (err: any) {
    assert.ok(err.message.includes("WALRUS_UPLOAD_FAILED"));
  }
});

test("checksum mismatch — throws when computed != provided", async () => {
  const redis = createMockRedis();
  setRedisForTests(redis);

  const chunk0 = Buffer.from("AAAA");
  const chunk1 = Buffer.from("BBBB");
  const session = makeSession({ uploadId: "checksum-mismatch", checksum: "0".repeat(64) });

  await registerChunks(redis, session.uploadId, session.totalChunks);
  await writeChunks(session.uploadId, session.totalChunks, [chunk0, chunk1]);

  const deps = {
    uploadToWalrusWithMetrics: async (params: any) => {
      await drainStream(params.streamFactory());
      return { blobId: "blob-cm", source: "newly_created" as const, endEpoch: 10 };
    },
    findFileByChecksum: async () => null,
  };

  try {
    await finalizeUpload(session, { log }, deps);
    assert.fail("should have thrown");
  } catch (err: any) {
    assert.equal(err.message, "CHECKSUM_MISMATCH");
    assert.equal(err.finalizeStage, "walrus_publish");
  }
});

test("sui finalize failure — throws with sui_finalize stage", async () => {
  const redis = createMockRedis();
  setRedisForTests(redis);

  const session = makeSession({ uploadId: "sui-fail" });
  await registerChunks(redis, session.uploadId, session.totalChunks);
  await writeChunks(session.uploadId, session.totalChunks);

  const deps = {
    uploadToWalrusWithMetrics: async (params: any) => {
      await drainStream(params.streamFactory());
      return { blobId: "blob-sf", source: "newly_created" as const, endEpoch: 10 };
    },
    findFileByChecksum: async () => null,
    finalizeFileMetadata: async () => {
      throw new Error("SUI_RPC_TIMEOUT");
    },
  };

  try {
    await finalizeUpload(session, { log }, deps);
    assert.fail("should have thrown");
  } catch (err: any) {
    assert.ok(err.message.includes("SUI_RPC_TIMEOUT"));
    assert.equal(err.finalizeStage, "sui_finalize");
  }
});

test("redis transaction failure — throws REDIS_FINALIZE_TRANSACTION_FAILED", async () => {
  const redis = createMockRedis();
  setRedisForTests(redis);

  const session = makeSession({ uploadId: "redis-tx-fail" });
  await registerChunks(redis, session.uploadId, session.totalChunks);
  await writeChunks(session.uploadId, session.totalChunks);

  const deps = {
    uploadToWalrusWithMetrics: async (params: any) => {
      await drainStream(params.streamFactory());
      return { blobId: "blob-rtx", source: "newly_created" as const, endEpoch: 10 };
    },
    findFileByChecksum: async () => null,
    finalizeFileMetadata: async () => ({
      fileId: "0xfile-rtx",
    }),
  };

  const origMulti = redis.multi.bind(redis);
  redis.multi = () => {
    const base = origMulti();
    base.exec = async () => null;
    return base;
  };

  try {
    await finalizeUpload(session, { log }, deps);
    assert.fail("should have thrown");
  } catch (err: any) {
    assert.equal(err.message, "REDIS_FINALIZE_TRANSACTION_FAILED");
  }
});

test("WALRUS_RETENTION_TOO_LOW — already_certified with unknown epoch", async () => {
  const redis = createMockRedis();
  setRedisForTests(redis);

  const session = makeSession({ uploadId: "retention-low" });
  await registerChunks(redis, session.uploadId, session.totalChunks);
  await writeChunks(session.uploadId, session.totalChunks);

  const deps = {
    uploadToWalrusWithMetrics: async (params: any) => {
      await drainStream(params.streamFactory());
      return { blobId: "blob-rl", source: "already_certified" as const };
    },
    findFileByChecksum: async () => null,
  };

  try {
    await finalizeUpload(session, { log }, deps);
    assert.fail("should have thrown");
  } catch (err: any) {
    assert.ok(err.message.includes("WALRUS_RETENTION_TOO_LOW"));
  }
});

test("happy path — full finalization succeeds through all stages", async () => {
  const redis = createMockRedis();
  setRedisForTests(redis);

  const session = makeSession({ uploadId: "happy-path" });
  await registerChunks(redis, session.uploadId, session.totalChunks);
  await writeChunks(session.uploadId, session.totalChunks);

  const deps = {
    uploadToWalrusWithMetrics: async (params: any) => {
      await drainStream(params.streamFactory());
      return { blobId: "blob-hp", source: "newly_created" as const, endEpoch: 10 };
    },
    findFileByChecksum: async () => null,
    finalizeFileMetadata: async () => ({
      fileId: "0xfile-hp",
    }),
    upsertIndexedFile: async () => {},
    upsertBlobObjectMapping: async () => {},
  };

  const result = await finalizeUpload(session, { log }, deps);

  assert.equal(result.fileId, "0xfile-hp");
  assert.equal(result.blobId, "blob-hp");
  assert.equal(result.sizeBytes, 8);
  assert.equal(result.status, "ready");
  assert.equal(result.walrusEndEpoch, 10);
  assert.equal(result.walrusSource, "newly_created");
  assert.ok(result.finalize.totalMs >= 0);
  assert.ok(result.finalize.stageDurationsMs.verify_chunks >= 0);
  assert.ok(result.finalize.stageDurationsMs.walrus_publish >= 0);
  assert.ok(result.finalize.stageDurationsMs.sui_finalize >= 0);
  assert.ok(result.finalize.stageDurationsMs.redis_commit >= 0);
  assert.ok(result.finalize.stageDurationsMs.cleanup >= 0);

  const meta = await redis.hgetall(uploadKeys.meta(session.uploadId));
  assert.equal(meta?.status, "completed");
  assert.equal(meta?.fileId, "0xfile-hp");
  assert.equal(meta?.blobId, "blob-hp");
  assert.equal(meta?.finalizeStage, "completed");
});

test("failure persistence — retryable error keeps status as finalizing", async () => {
  const redis = createMockRedis();
  setRedisForTests(redis);

  const session = makeSession({ uploadId: "retryable-fail" });
  await registerChunks(redis, session.uploadId, session.totalChunks);
  await writeChunks(session.uploadId, session.totalChunks);

  const deps = {
    uploadToWalrusWithMetrics: async () => {
      throw new Error("WALRUS_UPLOAD_FAILED: 503 upstream");
    },
    findFileByChecksum: async () => null,
  };

  try {
    await finalizeUpload(session, { log }, deps);
    assert.fail("should have thrown");
  } catch {}

  const meta = await redis.hgetall(uploadKeys.meta(session.uploadId));
  assert.ok(meta);
  assert.equal(meta.status, "finalizing");
  assert.equal(meta.failedStage, "walrus_publish");
  assert.equal(meta.failedRetryable, "1");
  assert.equal(meta.finalizeAttemptState, "retryable_failure");
});

test("failure persistence — non-retryable error sets status to failed", async () => {
  const redis = createMockRedis();
  setRedisForTests(redis);

  const session = makeSession({ uploadId: "terminal-fail" });
  await redis.sadd(uploadKeys.chunks(session.uploadId), "0");

  try {
    await finalizeUpload(session, { log });
    assert.fail("should have thrown");
  } catch {}

  const meta = await redis.hgetall(uploadKeys.meta(session.uploadId));
  assert.ok(meta);
  assert.equal(meta.status, "failed");
  assert.equal(meta.failedStage, "verify_chunks");
  assert.equal(meta.failedRetryable, "0");
  assert.equal(meta.finalizeAttemptState, "terminal_failure");
});

test("post-commit PG error is swallowed — finalize still succeeds", async () => {
  const redis = createMockRedis();
  setRedisForTests(redis);

  const session = makeSession({ uploadId: "pg-error" });
  await registerChunks(redis, session.uploadId, session.totalChunks);
  await writeChunks(session.uploadId, session.totalChunks);

  const deps = {
    uploadToWalrusWithMetrics: async (params: any) => {
      await drainStream(params.streamFactory());
      return { blobId: "blob-pg", source: "newly_created" as const, endEpoch: 10 };
    },
    findFileByChecksum: async () => null,
    finalizeFileMetadata: async () => ({
      fileId: "0xfile-pg",
    }),
    upsertIndexedFile: async () => {
      throw new Error("PG_CONNECTION_REFUSED");
    },
    upsertBlobObjectMapping: async () => {
      throw new Error("PG_CONNECTION_REFUSED");
    },
  };

  const result = await finalizeUpload(session, { log }, deps);

  assert.equal(result.fileId, "0xfile-pg");
  assert.equal(result.blobId, "blob-pg");
  assert.equal(result.status, "ready");
});

test("reuse path — skips walrus upload when checksum matches", async () => {
  const redis = createMockRedis();
  setRedisForTests(redis);

  const chunk0 = Buffer.from("REUSE_DATA_0");
  const chunk1 = Buffer.from("REUSE_DATA_1");
  const computedChecksum = crypto
    .createHash("sha256")
    .update(Buffer.concat([chunk0, chunk1]))
    .digest("hex");

  const session = makeSession({ uploadId: "reuse-blob", checksum: computedChecksum });
  await registerChunks(redis, session.uploadId, session.totalChunks);
  await writeChunks(session.uploadId, session.totalChunks, [chunk0, chunk1]);

  const deps = {
    findFileByChecksum: async () => ({
      fileId: "0xexisting",
      blobId: "existing-blob-id",
      blobObjectId: "0xobj123",
      checksum: computedChecksum,
      ownerAddress: null,
      sizeBytes: session.sizeBytes,
      mimeType: "application/octet-stream",
      walrusEndEpoch: 20,
      createdAtMs: Date.now(),
    }),
    getCurrentWalrusEpoch: async () => 15,
    getWalrusBlobState: async () => ({ endEpoch: 20 }),
    finalizeFileMetadata: async () => ({
      fileId: "0xfile-reuse",
    }),
    upsertIndexedFile: async () => {},
    upsertBlobObjectMapping: async () => {},
  };

  const result = await finalizeUpload(session, { log }, deps);

  assert.equal(result.blobId, "existing-blob-id");
  assert.equal(result.walrusSource, "already_certified");
  assert.equal(result.walrusEndEpoch, 20);
  assert.equal(result.status, "ready");
});

test("reuse with checksum mismatch — falls through to upload path", async () => {
  const redis = createMockRedis();
  setRedisForTests(redis);

  const chunk0 = Buffer.from("DATA_A");
  const chunk1 = Buffer.from("DATA_B");
  const session = makeSession({ uploadId: "reuse-mismatch", checksum: "f".repeat(64) });

  await registerChunks(redis, session.uploadId, session.totalChunks);
  await writeChunks(session.uploadId, session.totalChunks, [chunk0, chunk1]);

  const deps = {
    findFileByChecksum: async () => ({
      fileId: "0xexisting",
      blobId: "existing-blob-mismatch",
      blobObjectId: "0xobj456",
      checksum: "f".repeat(64),
      ownerAddress: null,
      sizeBytes: session.sizeBytes,
      mimeType: "application/octet-stream",
      walrusEndEpoch: 20,
      createdAtMs: Date.now(),
    }),
    getCurrentWalrusEpoch: async () => 15,
    getWalrusBlobState: async () => ({ endEpoch: 20 }),
    uploadToWalrusWithMetrics: async (params: any) => {
      await drainStream(params.streamFactory());
      return { blobId: "blob-new-upload", source: "newly_created" as const, endEpoch: 10 };
    },
    finalizeFileMetadata: async () => ({
      fileId: "0xfile-fallthrough",
    }),
    upsertIndexedFile: async () => {},
    upsertBlobObjectMapping: async () => {},
  };

  try {
    await finalizeUpload(session, { log }, deps);
    assert.fail("should have thrown");
  } catch (err: any) {
    assert.equal(err.message, "CHECKSUM_MISMATCH");
    assert.equal(err.finalizeStage, "walrus_publish");
  }
});

test("lock released in finally after success", async () => {
  const redis = createMockRedis();
  setRedisForTests(redis);

  const session = makeSession({ uploadId: "lock-release-ok" });
  await registerChunks(redis, session.uploadId, session.totalChunks);
  await writeChunks(session.uploadId, session.totalChunks);

  const deps = {
    uploadToWalrusWithMetrics: async (params: any) => {
      await drainStream(params.streamFactory());
      return { blobId: "blob-lr", source: "newly_created" as const, endEpoch: 10 };
    },
    findFileByChecksum: async () => null,
    finalizeFileMetadata: async () => ({
      fileId: "0xfile-lr",
    }),
    upsertIndexedFile: async () => {},
    upsertBlobObjectMapping: async () => {},
  };

  await finalizeUpload(session, { log }, deps);

  const lockKey = `${uploadKeys.meta(session.uploadId)}:lock`;
  const lockVal = await redis.eval(
    'if redis.call("GET", KEYS[1]) == ARGV[1] then return 1 end return 0',
    [lockKey],
    ["any-token"],
  );
  assert.equal(Number(lockVal), 0);
});

test("lock released in finally after failure", async () => {
  const redis = createMockRedis();
  setRedisForTests(redis);

  const session = makeSession({ uploadId: "lock-release-fail" });
  await registerChunks(redis, session.uploadId, session.totalChunks);
  // No chunk files on disk — will fail in walrus_publish

  const deps = {
    uploadToWalrusWithMetrics: async () => {
      throw new Error("ENOENT: no such file");
    },
    findFileByChecksum: async () => null,
  };

  try {
    await finalizeUpload(session, { log }, deps);
    assert.fail("should have thrown");
  } catch {}

  const lockKey = `${uploadKeys.meta(session.uploadId)}:lock`;
  const lockVal = await redis.eval(
    'if redis.call("GET", KEYS[1]) == ARGV[1] then return 1 end return 0',
    [lockKey],
    ["any-token"],
  );
  assert.equal(Number(lockVal), 0);
});

test("idempotent re-check — meta shows completed after lock acquisition", async () => {
  const redis = createMockRedis();
  setRedisForTests(redis);

  const session = makeSession({ uploadId: "idempotent-recheck" });
  const metaKey = uploadKeys.meta(session.uploadId);

  await redis.hset(metaKey, { status: "uploading" });

  let hgetallCount = 0;
  const origHgetall = redis.hgetall.bind(redis);
  redis.hgetall = async (key: string) => {
    if (key === metaKey) {
      hgetallCount++;
      if (hgetallCount >= 2) {
        return {
          status: "completed",
          fileId: "0xidempotent",
          blobId: "blob-idem",
          sizeBytes: "8",
          finalizeTotalMs: "100",
          finalizeVerifyMs: "10",
          finalizeWalrusMs: "20",
          finalizeSuiMs: "30",
          finalizeRedisMs: "25",
          finalizeCleanupMs: "15",
        };
      }
    }
    return origHgetall(key);
  };

  const result = await finalizeUpload(session, { log });

  assert.equal(result.fileId, "0xidempotent");
  assert.equal(result.blobId, "blob-idem");
  assert.equal(result.status, "ready");
});

test("cleanup — chunks and temp bin file removed on success", async () => {
  const redis = createMockRedis();
  setRedisForTests(redis);

  const session = makeSession({ uploadId: "cleanup-test" });
  await registerChunks(redis, session.uploadId, session.totalChunks);
  await writeChunks(session.uploadId, session.totalChunks);

  const binPath = path.join(testTmpDir, `${session.uploadId}.bin`);
  await fs.writeFile(binPath, "temp data");

  const deps = {
    uploadToWalrusWithMetrics: async (params: any) => {
      await drainStream(params.streamFactory());
      return { blobId: "blob-cl", source: "newly_created" as const, endEpoch: 10 };
    },
    findFileByChecksum: async () => null,
    finalizeFileMetadata: async () => ({
      fileId: "0xfile-cl",
    }),
    upsertIndexedFile: async () => {},
    upsertBlobObjectMapping: async () => {},
  };

  await finalizeUpload(session, { log }, deps);

  const dirExists = await fs
    .stat(path.join(testTmpDir, session.uploadId))
    .then(() => true, () => false);
  assert.equal(dirExists, false, "chunk directory cleaned up");

  const binExists = await fs.stat(binPath).then(() => true, () => false);
  assert.equal(binExists, false, ".bin file cleaned up");
});
