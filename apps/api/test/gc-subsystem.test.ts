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
  const store = new Map<string, any>();
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
    async exists(_key: string) {
      return 0;
    },
    multi() {
      const ops: Array<() => Promise<any>> = [];
      const self = {
        hset(k: string, f: Record<string, string>) {
          ops.push(() => hashes.has(k) || hashes.set(k, new Map()).length, (() => {
            const h = hashes.get(k)!;
            for (const [fk, fv] of Object.entries(f)) h.set(fk, fv);
            return Object.keys(f).length;
          }) as any);
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
  } as any;
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
  await mod.runUploadGc(log as any);

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
  await mod.runUploadGc(log as any);

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
  await mod.runUploadGc(log as any);

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
  mod.startUploadGc(log as any);
  mod.startUploadGc(log as any);
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
