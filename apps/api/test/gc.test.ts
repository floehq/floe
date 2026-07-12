import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

const testTmpDir = path.join(os.tmpdir(), `floe-gc-test-${process.pid}-${Date.now()}`);

process.env.FLOE_CHUNK_STORE_MODE = "disk";
process.env.UPLOAD_TMP_DIR = testTmpDir;
process.env.FLOE_GC_GRACE_MS = "10000";
process.env.FLOE_GC_INTERVAL_MS = "100";

// The .env file sets FLOE_FINALIZE_STATUS_POLL_MS=5000; override to avoid integration bleed
process.env.FLOE_FINALIZE_STATUS_POLL_MS = "2000";

// Drop DATABASE_URL — we don't want Postgres interactions bleeding from other cached imports
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
} as any;

// Global reference to the redis module so all cache-busted GC modules use the same instance.
// We import it ONCE without cache-busting so setRedisForTests propagates to all consumers.
let cachedRedisModule: any = null;
let cachedKeysModule: any = null;

beforeEach(async () => {
  await fs.mkdir(testTmpDir, { recursive: true });
  if (!cachedRedisModule) {
    cachedRedisModule = await import("../src/state/redis.js");
    cachedKeysModule = await import("../src/state/keys.js");
  }
  cachedRedisModule.setRedisForTests(createMockRedis());
});

afterEach(async () => {
  await fs.rm(testTmpDir, { recursive: true, force: true }).catch(() => {});
});

function mockRedis() {
  return cachedRedisModule!.getRedis();
}
function keys() {
  return cachedKeysModule!.uploadKeys;
}

// ============================================================
// GC Scheduler tests
// ============================================================
test("gc scheduler - startUploadGc starts the interval", async () => {
  const mod = await import("../src/state/gc/upload.gc.scheduler.js");
  mod.startUploadGc(log);
  // Calling start again should be idempotent
  mod.startUploadGc(log);
  await mod.stopUploadGc();
});

test("gc scheduler - stopUploadGc without start is a noop", async () => {
  const mod = await import("../src/state/gc/upload.gc.scheduler.js");
  await mod.stopUploadGc();
  // Should not throw
});

// ============================================================
// GC Worker tests
// ============================================================
test("gc worker - no-op when gcIndex is empty", async () => {
  const mod = await import("../src/state/gc/upload.gc.worker.js");
  await mod.runUploadGc(log);
  // Should not throw
});

test("gc worker - removes uploads with no status and no session", async () => {
  const redis = mockRedis();
  await redis.sadd(keys().gcIndex(), "test-no-status");

  const mod = await import("../src/state/gc/upload.gc.worker.js");
  await mod.runUploadGc(log);

  const ids = await redis.smembers(keys().gcIndex());
  assert.equal(ids.includes("test-no-status"), false);
});

test("gc worker - expires uploading session past expiresAt", async () => {
  const redis = mockRedis();
  const uploadId = "a0000000-0000-0000-0000-000000000001";
  await redis.sadd(keys().gcIndex(), uploadId);
  await redis.hset(keys().meta(uploadId), {
    status: "uploading",
    expiresAt: String(Date.now() - 1000),
  });
  // Create a directory so the grace-period skip is safe
  await fs.mkdir(path.join(testTmpDir, uploadId), { recursive: true });

  const mod = await import("../src/state/gc/upload.gc.worker.js");
  await mod.runUploadGc(log);

  const meta = await redis.hgetall(keys().meta(uploadId));
  assert.equal(meta.status, "expired");
  assert.ok(Number(meta.expiredAt) > 0);
});

test("gc worker - expires finalizing session past expiresAt", async () => {
  const redis = mockRedis();
  const uploadId = "a0000000-0000-0000-0000-000000000002";
  await redis.sadd(keys().gcIndex(), uploadId);
  await redis.hset(keys().meta(uploadId), {
    status: "finalizing",
    expiresAt: String(Date.now() - 1000),
  });
  // Create a directory so the grace-period skip is safe
  await fs.mkdir(path.join(testTmpDir, uploadId), { recursive: true });

  const mod = await import("../src/state/gc/upload.gc.worker.js");
  await mod.runUploadGc(log);

  const meta = await redis.hgetall(keys().meta(uploadId));
  assert.equal(meta.status, "expired");
});

test("gc worker - skips uploads with active lock", async () => {
  const redis = mockRedis();
  const uploadId = "a0000000-0000-0000-0000-000000000003";
  await redis.sadd(keys().gcIndex(), uploadId);
  await redis.hset(keys().meta(uploadId), {
    status: "failed",
    expiresAt: String(Date.now() - 100000),
  });
  await redis.set(`${keys().meta(uploadId)}:lock`, "worker-1");

  const mod = await import("../src/state/gc/upload.gc.worker.js");
  await mod.runUploadGc(log);

  const meta = await redis.hgetall(keys().meta(uploadId));
  assert.equal(meta.status, "failed");
});

test("gc worker - skips uploads within grace period", async () => {
  const redis = mockRedis();
  const uploadId = "a0000000-0000-0000-0000-000000000004";
  await redis.sadd(keys().gcIndex(), uploadId);
  await redis.hset(keys().meta(uploadId), {
    status: "canceled",
    canceledAt: String(Date.now()),
    expiresAt: String(Date.now() - 1000),
  });
  await fs.mkdir(path.join(testTmpDir, uploadId), { recursive: true });

  const mod = await import("../src/state/gc/upload.gc.worker.js");
  await mod.runUploadGc(log);

  const meta = await redis.hgetall(keys().meta(uploadId));
  assert.equal(meta.status, "canceled");
});

test("gc worker - cleans up eligible uploads", async () => {
  const redis = mockRedis();
  const uploadId = "a0000000-0000-0000-0000-000000000005";
  await redis.sadd(keys().gcIndex(), uploadId);
  await redis.hset(keys().meta(uploadId), {
    status: "canceled",
    canceledAt: String(Date.now() - 60000),
    expiresAt: String(Date.now() - 60000),
  });

  const mod = await import("../src/state/gc/upload.gc.worker.js");
  await mod.runUploadGc(log);

  const ids = await redis.smembers(keys().gcIndex());
  assert.equal(ids.includes(uploadId), false);
});

// ============================================================
// GC Reconcile tests
// ============================================================
test("gc reconcile - no-op for s3 backend", async () => {
  const prev = process.env.FLOE_CHUNK_STORE_MODE;
  process.env.FLOE_CHUNK_STORE_MODE = "s3";
  try {
    const mod = await import("../src/state/gc/upload.gc.reconcile.js");
    const result = await mod.reconcileOrphanUploads(log);
    assert.equal(result.recovered, 0);
    assert.equal(result.scanned, 0);
  } finally {
    if (prev !== undefined) process.env.FLOE_CHUNK_STORE_MODE = prev;
    else delete process.env.FLOE_CHUNK_STORE_MODE;
  }
});

test("gc reconcile - no-op when tmp dir is empty", async () => {
  const mod = await import("../src/state/gc/upload.gc.reconcile.js");
  const result = await mod.reconcileOrphanUploads(log);
  assert.equal(result.recovered, 0);
  assert.equal(result.scanned, 0);
});

test("gc reconcile - recovers orphan chunk dir", async () => {
  const redis = mockRedis();
  const uploadId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  await fs.mkdir(path.join(testTmpDir, uploadId), { recursive: true });

  const mod = await import("../src/state/gc/upload.gc.reconcile.js");
  const result = await mod.reconcileOrphanUploads(log);

  assert.equal(result.scanned, 1);
  assert.equal(result.recovered, 1);
  const tracked = await redis.sismember(keys().gcIndex(), uploadId);
  assert.equal(tracked, 1);
});

test("gc reconcile - recovers orphan final bin", async () => {
  const uploadId = "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff";
  await fs.writeFile(path.join(testTmpDir, `${uploadId}.bin`), "test");

  const mod = await import("../src/state/gc/upload.gc.reconcile.js");
  const result = await mod.reconcileOrphanUploads(log);

  assert.equal(result.scanned, 1);
  assert.equal(result.recovered, 1);
});

test("gc reconcile - skips already tracked uploads", async () => {
  const redis = mockRedis();
  const uploadId = "aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa";
  await fs.mkdir(path.join(testTmpDir, uploadId), { recursive: true });
  await redis.sadd(keys().gcIndex(), uploadId);

  const mod = await import("../src/state/gc/upload.gc.reconcile.js");
  const result = await mod.reconcileOrphanUploads(log);

  assert.equal(result.scanned, 1);
  assert.equal(result.recovered, 0);
});

test("gc reconcile - skips non-uuid entries", async () => {
  await fs.mkdir(path.join(testTmpDir, "not-a-uuid"), { recursive: true });

  const mod = await import("../src/state/gc/upload.gc.reconcile.js");
  const result = await mod.reconcileOrphanUploads(log);

  assert.equal(result.scanned, 0);
  assert.equal(result.recovered, 0);
});

// ============================================================
// Helpers
// ============================================================
function createMockRedis() {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const hashes = new Map<string, Map<string, string>>();

  return {
    ping: async () => "PONG",
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    },
    del: async (...keys: string[]) => {
      let count = 0;
      for (const key of keys) {
        if (store.delete(key) || hashes.delete(key)) count++;
        sets.delete(key);
      }
      return count;
    },
    exists: async (key: string) => (store.has(key) || hashes.has(key) || sets.has(key) ? 1 : 0),
    hgetall: async (key: string) => {
      const h = hashes.get(key);
      if (!h) return {} as Record<string, string>;
      return Object.fromEntries(h) as Record<string, string>;
    },
    hget: async (key: string, field: string) => {
      const h = hashes.get(key);
      return h?.get(field) ?? null;
    },
    hset: async (key: string, kv: Record<string, unknown>) => {
      if (!hashes.has(key)) hashes.set(key, new Map());
      const h = hashes.get(key)!;
      for (const [k, v] of Object.entries(kv)) h.set(k, String(v));
      return Object.keys(kv).length;
    },
    smembers: async (key: string) => {
      const s = sets.get(key);
      return s ? [...s] : [];
    },
    sadd: async (key: string, member: string) => {
      if (!sets.has(key)) sets.set(key, new Set());
      sets.get(key)!.add(member);
      return 1;
    },
    srem: async (key: string, member: string) => {
      const s = sets.get(key);
      if (!s) return 0;
      return s.delete(member) ? 1 : 0;
    },
    sismember: async (key: string, member: string) => {
      const s = sets.get(key);
      return s?.has(member) ? 1 : 0;
    },
    scard: async (key: string) => sets.get(key)?.size ?? 0,
    multi: () => {
      const ops: Array<{ method: string; args: any[] }> = [];
      const self = {
        hset: (key: string, kv: Record<string, unknown>) => {
          ops.push({ method: "hset", args: [key, kv] });
          return self;
        },
        del: (key: string) => {
          ops.push({ method: "del", args: [key] });
          return self;
        },
        sadd: (key: string, member: string) => {
          ops.push({ method: "sadd", args: [key, member] });
          return self;
        },
        srem: (key: string, member: string) => {
          ops.push({ method: "srem", args: [key, member] });
          return self;
        },
        exec: async () => {
          for (const op of ops) {
            if (op.method === "hset") {
              const [key, kv] = op.args as [string, Record<string, unknown>];
              if (!hashes.has(key)) hashes.set(key, new Map());
              for (const [k, v] of Object.entries(kv)) hashes.get(key)!.set(k, String(v));
            } else if (op.method === "del") {
              const [key] = op.args as [string];
              hashes.delete(key);
              sets.delete(key);
            } else if (op.method === "sadd") {
              const [key, member] = op.args as [string, string];
              if (!sets.has(key)) sets.set(key, new Set());
              sets.get(key)!.add(member);
            } else if (op.method === "srem") {
              const [key, member] = op.args as [string, string];
              sets.get(key)?.delete(member);
            }
          }
          return ["OK"];
        },
      };
      return self;
    },
    close: async () => {},
    ttl: async () => -1,
    llen: async () => 0,
    rpop: async () => null,
    lrem: async () => 0,
    zrem: async () => 0,
    hincrby: async () => 0,
    expire: async () => 0,
    eval: async () => null,
    execMulti: async () => [],
  };
}
