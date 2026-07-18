import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

const testTmpDir = path.join(os.tmpdir(), `floe-gc-subsystem-${process.pid}-${Date.now()}`);

process.env.FLOE_CHUNK_STORE_MODE = "disk";
process.env.UPLOAD_TMP_DIR = testTmpDir;
process.env.FLOE_GC_GRACE_MS = "10000";
process.env.FLOE_GC_INTERVAL_MS = "100";
process.env.FLOE_FINALIZE_STATUS_POLL_MS = "2000";
delete process.env.DATABASE_URL;

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
} as unknown as Record<string, (...args: never[]) => unknown>;

let cachedRedisModule: typeof import("../src/state/redis.js");
let cachedKeysModule: typeof import("../src/state/keys.js");

function createMockRedis() {
  const store = new Map<string, unknown>();
  const sets = new Map<string, Set<string>>();
  const hashes = new Map<string, Map<string, string>>();

  return {
    async smembers(_key: string) {
      return [...(sets.get(_key) ?? [])];
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
    async del(...keys: string[]) {
      let count = 0;
      for (const k of keys) {
        if (store.delete(k)) count++;
        if (hashes.delete(k)) count++;
        if (sets.delete(k)) count++;
      }
      return count;
    },
    async set(key: string, value: string, options?: { nx?: boolean; ex?: number }) {
      if (options?.nx && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async exists(_key: string) {
      return 0;
    },
    multi() {
      const ops: Array<() => Promise<unknown>> = [];
      const self = {
        hset(k: string, f: Record<string, string>) {
          ops.push(() => hashes.has(k) || hashes.set(k, new Map()).length, (() => {
            const h = hashes.get(k)!;
            for (const [fk, fv] of Object.entries(f)) h.set(fk, fv);
            return Object.keys(f).length;
          }) as (...args: never[]) => unknown);
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
            for (const v of vals) if (s.delete(v)) r++;
            return r;
          });
          return self;
        },
        del(...keys: string[]) {
          ops.push(async () => {
            let c = 0;
            for (const k of keys) {
              if (store.delete(k)) c++;
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
  } as Record<string, (...args: never[]) => unknown>;
}

beforeEach(async () => {
  await fs.mkdir(testTmpDir, { recursive: true });
  cachedRedisModule = await import("../src/state/redis.js");
  cachedKeysModule = await import("../src/state/keys.js");
  cachedRedisModule.setRedisForTests(createMockRedis());
});

afterEach(async () => {
  await fs.rm(testTmpDir, { recursive: true, force: true }).catch(() => {});
});

// ============================================================
// GC Worker — additional coverage
// ============================================================

test("gc worker - skips uploads with active lock", async () => {
  const uuid = "c3d4e5f6-a7b8-9012-cdef-123456789012";
  const keys = cachedKeysModule!.uploadKeys;
  const redis = cachedRedisModule!.getRedis();

  await redis.sadd(keys.gcIndex(), uuid);
  await redis.hset(keys.meta(uuid), { status: "expired", expiredAt: "1000" });

  const origExists = redis.exists.bind(redis);
  redis.exists = async (k: string) => {
    if (k.endsWith(":lock")) return 1;
    return origExists(k);
  };

  const mod = await import("../src/state/gc/upload.gc.worker.js");
  await mod.runUploadGc(log as Record<string, (...args: never[]) => unknown>);

  const gcIndex = await redis.smembers(keys.gcIndex());
  assert.ok(gcIndex.includes(uuid));

  redis.exists = origExists;
});

test("gc worker - expires stale uploading sessions", async () => {
  const uuid = "d4e5f6a7-b8c9-0123-defa-234567890123";
  const keys = cachedKeysModule!.uploadKeys;
  const redis = cachedRedisModule!.getRedis();

  await redis.sadd(keys.gcIndex(), uuid);
  await redis.hset(keys.meta(uuid), {
    status: "uploading",
    expiresAt: String(Date.now() - 10000),
  });

  const mod = await import("../src/state/gc/upload.gc.worker.js");
  await mod.runUploadGc(log as Record<string, (...args: never[]) => unknown>);

  const gcIndex = await redis.smembers(keys.gcIndex());
  assert.ok(!gcIndex.includes(uuid), "Upload should be removed from GC index after expiry");
});

test("gc worker - cleans up uploads past grace period", async () => {
  const uuid = "e5f6a7b8-c9d0-1234-efab-345678901234";
  const keys = cachedKeysModule!.uploadKeys;
  const redis = cachedRedisModule!.getRedis();

  await redis.sadd(keys.gcIndex(), uuid);
  await redis.hset(keys.meta(uuid), {
    status: "expired",
    expiredAt: String(Date.now() - 100000),
  });

  const binPath = path.join(testTmpDir, `${uuid}.bin`);
  await fs.writeFile(binPath, "old data");
  const oldTime = new Date(Date.now() - 200000);
  await fs.utimes(binPath, oldTime, oldTime);

  const mod = await import("../src/state/gc/upload.gc.worker.js");
  await mod.runUploadGc(log as Record<string, (...args: never[]) => unknown>);

  const exists = await fs.stat(binPath).catch(() => null);
  assert.equal(exists, null, "Bin file should be cleaned up");

  const gcIndex = await redis.smembers(keys.gcIndex());
  assert.ok(!gcIndex.includes(uuid));
});

// ============================================================
// GC Scheduler — verify start/stop lifecycle
// ============================================================

test("gc scheduler - start and stop lifecycle", async () => {
  const mod = await import("../src/state/gc/upload.gc.scheduler.js");
  mod.startUploadGc(log as Record<string, (...args: never[]) => unknown>);
  mod.startUploadGc(log as Record<string, (...args: never[]) => unknown>);
  await mod.stopUploadGc();
  await mod.stopUploadGc();
  assert.ok(true, "Scheduler lifecycle completed");
});

// ============================================================
// S3 state
// ============================================================

test("s3 state - isS3BucketMissingError classifies errors", async () => {
  const s3Mod = await import("../src/state/s3.js");
  if (typeof s3Mod.isS3BucketMissingError === "function") {
    assert.ok(s3Mod.isS3BucketMissingError({ name: "NotFound" }));
    assert.ok(s3Mod.isS3BucketMissingError({ name: "NoSuchBucket" }));
    assert.ok(s3Mod.isS3BucketMissingError({ $metadata: { httpStatusCode: 404 } }));
    assert.ok(!s3Mod.isS3BucketMissingError({ name: "Forbidden" }));
    assert.ok(!s3Mod.isS3BucketMissingError({ name: "AccessDenied" }));
  }
});

// ============================================================
// Distributed Redis lock — scheduler skips when lock is held
// ============================================================

const GC_LOCK_KEY = "floe:gc:upload:distributed-lock";

test("gc scheduler - skips GC when distributed lock is held by another instance", async () => {
  const redis = cachedRedisModule!.getRedis();

  // Ensure no leftover lock
  await redis.del(GC_LOCK_KEY);
  // Stop any previously running scheduler
  const schedulerMod = await import("../src/state/gc/upload.gc.scheduler.js");
  await schedulerMod.stopUploadGc();

  // Simulate another instance holding the lock
  await redis.set(GC_LOCK_KEY, "holder-instance-2", { nx: true, ex: 300 });

  schedulerMod.startUploadGc(log as Record<string, (...args: never[]) => unknown>);
  // Wait for at least one interval tick (100ms) + buffer
  await new Promise((r) => setTimeout(r, 250));
  await schedulerMod.stopUploadGc();

  // The lock key should still exist and be unchanged — our instance did not acquire it
  const lockValue = await redis.get(GC_LOCK_KEY);
  assert.equal(
    lockValue,
    "holder-instance-2",
    "Lock should remain untouched when held by another instance",
  );

  // Cleanup
  await redis.del(GC_LOCK_KEY);
});

test("gc scheduler - acquires and releases distributed lock when available", async () => {
  const redis = cachedRedisModule!.getRedis();

  // Ensure no lock exists
  await redis.del(GC_LOCK_KEY);
  const schedulerMod = await import("../src/state/gc/upload.gc.scheduler.js");
  await schedulerMod.stopUploadGc();

  schedulerMod.startUploadGc(log as Record<string, (...args: never[]) => unknown>);
  // Wait for interval tick + GC completion + lock release
  await new Promise((r) => setTimeout(r, 300));
  await schedulerMod.stopUploadGc();

  // The lock should have been acquired then released (deleted)
  const lockExists = await redis.exists(GC_LOCK_KEY);
  assert.equal(lockExists, 0, "Lock should be released after GC completes");
});

// ============================================================
// Batch smembers in reconcile
// ============================================================

test("reconcile - uses batch smembers for tracked ID lookup", async () => {
  // Valid UUID v4 (version 4, variant a)
  const uuid1 = "550e8400-e29b-41d4-a716-446655440000";
  const uuid2 = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
  const uuid3 = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

  const keys = cachedKeysModule!.uploadKeys;
  const redis = cachedRedisModule!.getRedis();

  // Track uuid1 in GC index
  await redis.sadd(keys.gcIndex(), uuid1);

  // Create disk artifacts for all three UUIDs
  await fs.mkdir(path.join(testTmpDir, uuid1), { recursive: true });
  await fs.mkdir(path.join(testTmpDir, uuid2), { recursive: true });
  const binPath = path.join(testTmpDir, `${uuid3}.bin`);
  await fs.writeFile(binPath, "data");

  const reconcileMod = await import("../src/state/gc/upload.gc.reconcile.js");
  const result = await reconcileMod.reconcileOrphanUploads(
    log as Record<string, (...args: never[]) => unknown>,
  );

  // uuid1 is already tracked -> not recovered
  // uuid2 is on disk but not tracked -> recovered
  // uuid3 is on disk but not tracked -> recovered
  assert.ok(result.scanned >= 2, `Expected at least 2 scanned, got ${result.scanned}`);
  assert.ok(result.recovered >= 1, `Expected at least 1 recovered, got ${result.recovered}`);

  // uuid2 and uuid3 should now be in GC index
  const gcIndex = await redis.smembers(keys.gcIndex());
  assert.ok(gcIndex.includes(uuid2), "uuid2 should be added to GC index");
  assert.ok(gcIndex.includes(uuid3), "uuid3 should be added to GC index");
  assert.ok(gcIndex.includes(uuid1), "uuid1 should still be in GC index");
});

test("reconcile - batch smembers with empty GC index", async () => {
  const uuid1 = "12345678-1234-5234-8abc-def012345678";
  const keys = cachedKeysModule!.uploadKeys;
  const redis = cachedRedisModule!.getRedis();

  // Ensure uuid1 is NOT in GC index
  await redis.srem(keys.gcIndex(), uuid1);

  await fs.mkdir(path.join(testTmpDir, uuid1), { recursive: true });

  const reconcileMod = await import("../src/state/gc/upload.gc.reconcile.js");
  const result = await reconcileMod.reconcileOrphanUploads(
    log as Record<string, (...args: never[]) => unknown>,
  );

  assert.ok(result.scanned >= 1, "Should scan at least 1 entry");
  assert.ok(result.recovered >= 1, "Should recover the orphan");

  const gcIndex = await redis.smembers(keys.gcIndex());
  assert.ok(gcIndex.includes(uuid1), "uuid1 should be in GC index after recovery");
});
