import test, { after, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const redisPort = 17380 + Math.floor(Math.random() * 1000);
const redisUrl = `redis://127.0.0.1:${redisPort}`;
const uploadTmpDir = path.join(os.tmpdir(), `floe-upload-integration-${process.pid}`);

process.env.FLOE_REDIS_PROVIDER = "native";
process.env.REDIS_URL = redisUrl;
process.env.FLOE_CHUNK_STORE_MODE = "disk";
process.env.UPLOAD_TMP_DIR = uploadTmpDir;
process.env.FLOE_CHUNK_MIN_BYTES = "1";
process.env.FLOE_CHUNK_DEFAULT_BYTES = "4";
process.env.FLOE_CHUNK_MAX_BYTES = "8";
process.env.FLOE_UPLOAD_SESSION_TTL_MS = "2000";
process.env.WALRUS_AGGREGATOR_URL = "http://127.0.0.1:1";
delete process.env.DATABASE_URL;

type RedisModule = typeof import("../src/state/redis.ts");
type UploadConfigModule = typeof import("../src/config/uploads.config.ts");
type SessionModule = typeof import("../src/services/uploads/session.ts");
type UploadRoutesModule = typeof import("../src/routes/uploads.ts");
type KeysModule = typeof import("../src/state/keys.ts");
type StoreIndexModule = typeof import("../src/store/index.ts");
let redisProcess: ChildProcess | null = null;
let redisModule: RedisModule;
let uploadConfigModule: UploadConfigModule;
let sessionModule: SessionModule;
let uploadRoutesModule: UploadRoutesModule;
let keysModule: KeysModule;
let storeIndexModule: StoreIndexModule;

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRedis(port: number) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await sleep(50);
  }
  throw new Error(`redis-server did not start on port ${port}`);
}

function makeFilePart(buf: Buffer) {
  return {
    type: "file",
    file: Readable.from(buf),
  };
}

async function createRouteApp(customAuthProvider?: any) {
  const handlers = new Map<string, (req: any, reply: any) => Promise<unknown> | unknown>();
  const authProvider = {
    async authorizeUploadAccess() {
      return { allowed: true };
    },
    async checkRateLimit() {
      return {
        allowed: true,
        current: 1,
        limit: 1000,
        windowSeconds: 60,
        identity: {
          authenticated: false,
          subject: "integration-test",
          method: "public",
          owner: null,
        },
      };
    },
    ...customAuthProvider,
  };
  const app = {
    get(path: string, handler: (req: any, reply: any) => Promise<unknown> | unknown) {
      handlers.set(`GET ${path}`, handler);
    },
    post(path: string, handler: (req: any, reply: any) => Promise<unknown> | unknown) {
      handlers.set(`POST ${path}`, handler);
    },
    put(path: string, handler: (req: any, reply: any) => Promise<unknown> | unknown) {
      handlers.set(`PUT ${path}`, handler);
    },
    delete(path: string, handler: (req: any, reply: any) => Promise<unknown> | unknown) {
      handlers.set(`DELETE ${path}`, handler);
    },
  } as any;

  await uploadRoutesModule.default(app);

  return {
    async inject(params: {
      method: "GET" | "POST" | "PUT" | "DELETE";
      url: string;
      routePath?: string;
      params?: Record<string, unknown>;
      query?: Record<string, unknown>;
      body?: unknown;
      headers?: Record<string, string>;
      filePart?: ReturnType<typeof makeFilePart>;
    }) {
      const routePath = params.routePath ?? params.url;
      const handler = handlers.get(`${params.method} ${routePath}`);
      if (!handler) {
        throw new Error(`Route not registered: ${params.method} ${routePath}`);
      }
      const reply = {
        statusCode: 200,
        headers: {} as Record<string, string>,
        payload: undefined as unknown,
        code(statusCode: number) {
          this.statusCode = statusCode;
          return this;
        },
        status(statusCode: number) {
          this.statusCode = statusCode;
          return this;
        },
        header(name: string, value: string) {
          this.headers[name.toLowerCase()] = value;
          return this;
        },
        send(payload: unknown) {
          this.payload = payload;
          return this;
        },
      };
      const req = {
        params: params.params ?? {},
        query: params.query ?? {},
        body: params.body,
        headers: params.headers ?? {},
        log,
        server: { authProvider },
        async file() {
          return params.filePart ?? null;
        },
      };
      const result = await handler(req, reply);
      const payload = reply.payload !== undefined ? reply.payload : result;
      return {
        statusCode: reply.statusCode,
        headers: reply.headers,
        json() {
          return payload;
        },
      };
    },
  };
}

async function cleanupUpload(uploadId: string) {
  const redis = redisModule.getRedis();
  const { uploadKeys } = keysModule;
  await redis.del(uploadKeys.session(uploadId));
  await redis.del(uploadKeys.meta(uploadId));
  await redis.del(uploadKeys.chunks(uploadId));
  await redis.srem(uploadKeys.gcIndex(), uploadId);
  await redis.srem(uploadKeys.activeIndex(), uploadId);
  await redis.srem(uploadKeys.finalizePending(), uploadId);
  await redis.zrem(uploadKeys.finalizePendingSince(), uploadId);
  await redis.lrem(uploadKeys.finalizeQueue(), 0, uploadId);
  await fs.rm(path.join(uploadTmpDir, uploadId), { recursive: true, force: true }).catch(() => {});
  await fs.rm(path.join(uploadTmpDir, `${uploadId}.bin`), { force: true }).catch(() => {});
}

async function seedUpload(params?: { totalChunks?: number; chunkSize?: number; sizeBytes?: number }) {
  const uploadId = randomUUID();
  const totalChunks = params?.totalChunks ?? 2;
  const chunkSize = params?.chunkSize ?? 4;
  const sizeBytes = params?.sizeBytes ?? totalChunks * chunkSize;
  await sessionModule.createSession({
    uploadId,
    filename: "video.mp4",
    contentType: "video/mp4",
    sizeBytes,
    chunkSize,
    totalChunks,
    epochs: 1,
  });
  return uploadId;
}

before(async () => {
  await fs.mkdir(uploadTmpDir, { recursive: true });
  redisProcess = spawn(
    "redis-server",
    ["--port", String(redisPort), "--save", "", "--appendonly", "no"],
    { stdio: "ignore" }
  );
  await waitForRedis(redisPort);

  redisModule = await import("../src/state/redis.ts");
  uploadConfigModule = await import("../src/config/uploads.config.ts");
  sessionModule = await import("../src/services/uploads/session.ts");
  uploadRoutesModule = await import("../src/routes/uploads.ts");
  keysModule = await import("../src/state/keys.ts");
  storeIndexModule = await import("../src/store/index.ts");

  await redisModule.initRedis();
});

test("create rejects authenticated keys missing uploads:write scope", async () => {
  const app = await createRouteApp({
    async authorizeUploadAccess() {
      return {
        allowed: false,
        code: "INSUFFICIENT_SCOPE",
        message: "API key is missing required scope: uploads:write",
      };
    },
  });

  const res = await app.inject({
    method: "POST",
    url: "/v1/uploads/create",
    routePath: "/v1/uploads/create",
    body: {
      filename: "video.mp4",
      contentType: "video/mp4",
      sizeBytes: 8,
    },
  });
  const body = res.json();

  assert.equal(res.statusCode, 403);
  assert.equal(body.error.code, "INSUFFICIENT_SCOPE");
  assert.equal(body.error.message.includes("uploads:write"), true);
});

afterEach(async () => {
  const redis = redisModule.getRedis();
  const { uploadKeys } = keysModule;
  const [gcIds, activeIds] = await Promise.all([
    redis.smembers<string[]>(uploadKeys.gcIndex()),
    redis.smembers<string[]>(uploadKeys.activeIndex()),
  ]);
  await Promise.all(
    [...new Set([...gcIds, ...activeIds])].map((uploadId) => cleanupUpload(uploadId))
  );
});

after(async () => {
  await redisModule.closeRedis().catch(() => {});
  if (redisProcess && !redisProcess.killed) {
    redisProcess.kill("SIGTERM");
  }
  await fs.rm(uploadTmpDir, { recursive: true, force: true }).catch(() => {});
});

test("chunk upload refreshes session ttl and activity metadata", async () => {
  const uploadId = await seedUpload();
  const app = await createRouteApp();
  const chunk = Buffer.from("test");
  const expectedHash = createHash("sha256").update(chunk).digest("hex");
  try {
    const redis = redisModule.getRedis();
    const { uploadKeys } = keysModule;
    const beforeTtl = Number(await redis.ttl(uploadKeys.session(uploadId)));
    await sleep(1100);

    const res = await app.inject({
      method: "PUT",
      url: `/v1/uploads/${uploadId}/chunk/0`,
      routePath: "/v1/uploads/:uploadId/chunk/:index",
      params: { uploadId, index: "0" },
      headers: { "x-chunk-sha256": expectedHash },
      filePart: makeFilePart(chunk),
    });
    const body = res.json();

    const afterTtl = Number(await redis.ttl(uploadKeys.session(uploadId)));
    const meta = await redis.hgetall<Record<string, string>>(uploadKeys.meta(uploadId));
    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(afterTtl >= beforeTtl - 1, true);
    assert.equal(meta.lastChunkIndex, "0");
    assert.equal(Number(meta.lastChunkAt) > 0, true);
    assert.equal(Number(meta.updatedAt) >= Number(meta.lastChunkAt), true);
  } finally {
    await cleanupUpload(uploadId);
  }
});

test("duplicate chunk retry is idempotent and refreshes activity", async () => {
  const uploadId = await seedUpload();
  const app = await createRouteApp();
  const chunk = Buffer.from("test");
  const expectedHash = createHash("sha256").update(chunk).digest("hex");
  try {
    const redis = redisModule.getRedis();
    const { uploadKeys } = keysModule;
    const first = await app.inject({
      method: "PUT",
      url: `/v1/uploads/${uploadId}/chunk/0`,
      routePath: "/v1/uploads/:uploadId/chunk/:index",
      params: { uploadId, index: "0" },
      headers: { "x-chunk-sha256": expectedHash },
      filePart: makeFilePart(chunk),
    });
    const firstMeta = await redis.hgetall<Record<string, string>>(uploadKeys.meta(uploadId));
    await sleep(50);

    const second = await app.inject({
      method: "PUT",
      url: `/v1/uploads/${uploadId}/chunk/0`,
      routePath: "/v1/uploads/:uploadId/chunk/:index",
      params: { uploadId, index: "0" },
      headers: { "x-chunk-sha256": expectedHash },
      filePart: makeFilePart(chunk),
    });
    const secondBody = second.json();
    const secondMeta = await redis.hgetall<Record<string, string>>(uploadKeys.meta(uploadId));
    const chunks = await redis.smembers<string[]>(uploadKeys.chunks(uploadId));

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(secondBody.reused, true);
    assert.deepEqual(chunks, ["0"]);
    assert.equal(Number(secondMeta.lastChunkAt) >= Number(firstMeta.lastChunkAt), true);
  } finally {
    await cleanupUpload(uploadId);
  }
});

test("status and complete reconcile chunk membership from chunk store", async () => {
  const uploadId = await seedUpload();
  const app = await createRouteApp();
  const chunkA = Buffer.from("test");
  const chunkB = Buffer.from("done");
  try {
    const redis = redisModule.getRedis();
    const { uploadKeys } = keysModule;
    await fs.mkdir(path.join(uploadTmpDir, uploadId), { recursive: true });
    await fs.writeFile(path.join(uploadTmpDir, uploadId, "0"), chunkA);
    await fs.writeFile(path.join(uploadTmpDir, uploadId, "1"), chunkB);
    await redis.del(uploadKeys.chunks(uploadId));

    const statusRes = await app.inject({
      method: "GET",
      url: `/v1/uploads/${uploadId}/status`,
      routePath: "/v1/uploads/:uploadId/status",
      params: { uploadId },
    });
    const statusBody = statusRes.json();
    assert.equal(statusRes.statusCode, 200);
    assert.deepEqual(statusBody.receivedChunks, [0, 1]);
    assert.equal(statusBody.receivedChunkCount, 2);

    const reconciled = await redis.smembers<string[]>(uploadKeys.chunks(uploadId));
    assert.deepEqual(reconciled.sort(), ["0", "1"]);

    const completeRes = await app.inject({
      method: "POST",
      url: `/v1/uploads/${uploadId}/complete`,
      routePath: "/v1/uploads/:uploadId/complete",
      params: { uploadId },
    });
    const completeBody = completeRes.json();

    assert.equal(completeRes.statusCode, 202);
    assert.equal(completeBody.status, "finalizing");
  } finally {
    await cleanupUpload(uploadId);
  }
});

test("status marks stale uploads as expired from expiresAt", async () => {
  const uploadId = await seedUpload();
  const app = await createRouteApp();
  try {
    const redis = redisModule.getRedis();
    const { uploadKeys } = keysModule;
    await redis.hset(uploadKeys.meta(uploadId), {
      expiresAt: String(Date.now() - 1000),
      status: "uploading",
    });
    await redis.hset(uploadKeys.session(uploadId), {
      expiresAt: String(Date.now() - 1000),
      status: "uploading",
    });

    const res = await app.inject({
      method: "GET",
      url: `/v1/uploads/${uploadId}/status`,
      routePath: "/v1/uploads/:uploadId/status",
      params: { uploadId },
    });
    const body = res.json();
    const meta = await redis.hgetall<Record<string, string>>(uploadKeys.meta(uploadId));

    assert.equal(res.statusCode, 200);
    assert.equal(body.status, "expired");
    assert.equal(meta.status, "expired");
    assert.equal(Number(meta.expiredAt) > 0, true);
  } finally {
    await cleanupUpload(uploadId);
  }
});

test("expired uploads release active capacity before GC cleanup runs", async () => {
  const originalMaxActiveUploads = uploadConfigModule.UploadConfig.maxActiveUploads;
  uploadConfigModule.UploadConfig.maxActiveUploads = 1;
  const uploadId = await seedUpload();
  const app = await createRouteApp();

  try {
    const redis = redisModule.getRedis();
    const { uploadKeys } = keysModule;
    await redis.hset(uploadKeys.meta(uploadId), {
      expiresAt: String(Date.now() - 1000),
      status: "uploading",
    });
    await redis.hset(uploadKeys.session(uploadId), {
      expiresAt: String(Date.now() - 1000),
      status: "uploading",
    });

    const expired = await app.inject({
      method: "GET",
      url: `/v1/uploads/${uploadId}/status`,
      routePath: "/v1/uploads/:uploadId/status",
      params: { uploadId },
    });
    assert.equal(expired.statusCode, 200);
    assert.equal(expired.json().status, "expired");
    assert.equal(await redis.sismember(uploadKeys.gcIndex(), uploadId), 1);
    assert.equal(await redis.sismember(uploadKeys.activeIndex(), uploadId), 0);

    const created = await app.inject({
      method: "POST",
      url: "/v1/uploads/create",
      routePath: "/v1/uploads/create",
      body: {
        filename: "next.mp4",
        contentType: "video/mp4",
        sizeBytes: 8,
      },
    });

    assert.equal(created.statusCode, 201);
  } finally {
    uploadConfigModule.UploadConfig.maxActiveUploads = originalMaxActiveUploads;
  }
});

test("complete rejects expired uploads cleanly", async () => {
  const uploadId = await seedUpload();
  const app = await createRouteApp();
  try {
    const redis = redisModule.getRedis();
    const { uploadKeys } = keysModule;
    await redis.hset(uploadKeys.meta(uploadId), {
      expiresAt: String(Date.now() - 1000),
      status: "uploading",
    });
    await redis.hset(uploadKeys.session(uploadId), {
      expiresAt: String(Date.now() - 1000),
      status: "uploading",
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/uploads/${uploadId}/complete`,
      routePath: "/v1/uploads/:uploadId/complete",
      params: { uploadId },
    });
    const body = res.json();

    assert.equal(res.statusCode, 409);
    assert.equal(body.error.code, "UPLOAD_EXPIRED");
  } finally {
    await cleanupUpload(uploadId);
  }
});

test("cancel returns expired when upload already timed out", async () => {
  const uploadId = await seedUpload();
  const app = await createRouteApp();
  try {
    const redis = redisModule.getRedis();
    const { uploadKeys } = keysModule;
    await redis.hset(uploadKeys.meta(uploadId), {
      expiresAt: String(Date.now() - 1000),
      status: "uploading",
    });
    await redis.hset(uploadKeys.session(uploadId), {
      expiresAt: String(Date.now() - 1000),
      status: "uploading",
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/uploads/${uploadId}`,
      routePath: "/v1/uploads/:uploadId",
      params: { uploadId },
    });
    const body = res.json();

    assert.equal(res.statusCode, 200);
    assert.equal(body.status, "expired");
  } finally {
    await cleanupUpload(uploadId);
  }
});

test("cancel returns retry-after when finalization is in progress", async () => {
  const uploadId = await seedUpload();
  const app = await createRouteApp();
  try {
    const redis = redisModule.getRedis();
    const { uploadKeys } = keysModule;
    await redis.hset(uploadKeys.meta(uploadId), {
      status: "finalizing",
    });
    await redis.set(`${uploadKeys.meta(uploadId)}:lock`, "worker-1");

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/uploads/${uploadId}`,
      routePath: "/v1/uploads/:uploadId",
      params: { uploadId },
    });
    const body = res.json();

    assert.equal(res.statusCode, 409);
    assert.equal(res.headers["retry-after"], "2");
    assert.equal(body.error.code, "UPLOAD_FINALIZATION_IN_PROGRESS");
    assert.equal(body.error.retryable, false);
  } finally {
    await cleanupUpload(uploadId);
  }
});

test("cancel returns retry-after when finalization is queued before lock acquisition", async () => {
  const uploadId = await seedUpload();
  const app = await createRouteApp();
  try {
    const redis = redisModule.getRedis();
    const { uploadKeys } = keysModule;
    await redis.hset(uploadKeys.meta(uploadId), {
      status: "finalizing",
      finalizingQueuedAt: String(Date.now()),
    });
    await redis.sadd(uploadKeys.finalizePending(), uploadId);

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/uploads/${uploadId}`,
      routePath: "/v1/uploads/:uploadId",
      params: { uploadId },
    });
    const body = res.json();

    assert.equal(res.statusCode, 409);
    assert.equal(res.headers["retry-after"], "2");
    assert.equal(body.error.code, "UPLOAD_FINALIZATION_IN_PROGRESS");
    assert.equal(await redis.exists(uploadKeys.session(uploadId)), 1);
    assert.equal(await redis.sismember(uploadKeys.finalizePending(), uploadId), 1);
  } finally {
    await cleanupUpload(uploadId);
  }
});

test("cancel cleans up partial upload artifacts and session state", async () => {
  const uploadId = await seedUpload();
  const app = await createRouteApp();
  const chunk = Buffer.from("test");
  try {
    const redis = redisModule.getRedis();
    const { uploadKeys } = keysModule;
    await fs.mkdir(path.join(uploadTmpDir, uploadId), { recursive: true });
    await fs.writeFile(path.join(uploadTmpDir, uploadId, "0"), chunk);
    await redis.sadd(uploadKeys.chunks(uploadId), "0");

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/uploads/${uploadId}`,
      routePath: "/v1/uploads/:uploadId",
      params: { uploadId },
    });
    const body = res.json();

    assert.equal(res.statusCode, 200);
    assert.equal(body.status, "canceled");
    assert.equal(await fs.stat(path.join(uploadTmpDir, uploadId, "0")).catch(() => null), null);
    assert.equal(await redis.exists(uploadKeys.session(uploadId)), 0);
    assert.equal(await redis.exists(uploadKeys.chunks(uploadId)), 0);
  } finally {
    await cleanupUpload(uploadId);
  }
});

test("status returns retryable 503 when chunk store reconciliation fails", async () => {
  const uploadId = await seedUpload();
  const app = await createRouteApp();
  const originalListChunks = storeIndexModule.chunkStore.listChunks.bind(storeIndexModule.chunkStore);
  try {
    storeIndexModule.chunkStore.listChunks = async () => {
      throw new Error("disk unavailable");
    };

    const res = await app.inject({
      method: "GET",
      url: `/v1/uploads/${uploadId}/status`,
      routePath: "/v1/uploads/:uploadId/status",
      params: { uploadId },
    });
    const body = res.json();

    assert.equal(res.statusCode, 503);
    assert.equal(res.headers["retry-after"], "5");
    assert.equal(body.error.code, "CHUNK_STORE_UNAVAILABLE");
    assert.equal(body.error.retryable, true);
  } finally {
    storeIndexModule.chunkStore.listChunks = originalListChunks;
    await cleanupUpload(uploadId);
  }
});

test("complete returns retry-after on retryable chunk reconciliation failure", async () => {
  const uploadId = await seedUpload();
  const app = await createRouteApp();
  const originalListChunks = storeIndexModule.chunkStore.listChunks.bind(storeIndexModule.chunkStore);
  try {
    storeIndexModule.chunkStore.listChunks = async () => {
      throw new Error("disk unavailable");
    };

    const res = await app.inject({
      method: "POST",
      url: `/v1/uploads/${uploadId}/complete`,
      routePath: "/v1/uploads/:uploadId/complete",
      params: { uploadId },
    });
    const body = res.json();

    assert.equal(res.statusCode, 503);
    assert.equal(res.headers["retry-after"], "5");
    assert.equal(body.error.code, "CHUNK_STORE_UNAVAILABLE");
    assert.equal(body.error.retryable, true);
  } finally {
    storeIndexModule.chunkStore.listChunks = originalListChunks;
    await cleanupUpload(uploadId);
  }
});

test("complete returns stable finalizing shape when upload is already finalizing", async () => {
  const uploadId = await seedUpload();
  const app = await createRouteApp();
  try {
    const redis = redisModule.getRedis();
    const { uploadKeys } = keysModule;
    await redis.hset(uploadKeys.meta(uploadId), {
      status: "finalizing",
      finalizeAttemptState: "running",
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/uploads/${uploadId}/complete`,
      routePath: "/v1/uploads/:uploadId/complete",
      params: { uploadId },
    });
    const body = res.json();

    assert.equal(res.statusCode, 202);
    assert.equal(body.uploadId, uploadId);
    assert.equal(body.status, "finalizing");
    assert.equal(body.enqueued, false);
    assert.equal(typeof body.pollAfterMs, "number");
    assert.equal(body.finalizeAttemptState, "running");
  } finally {
    await cleanupUpload(uploadId);
  }
});

test("complete returns stable finalizing shape when only meta remains", async () => {
  const uploadId = await seedUpload();
  const app = await createRouteApp();
  try {
    const redis = redisModule.getRedis();
    const { uploadKeys } = keysModule;
    await redis.del(uploadKeys.session(uploadId));
    await redis.hset(uploadKeys.meta(uploadId), {
      status: "finalizing",
      finalizeAttemptState: "retryable_failure",
      failedReasonCode: "walrus_unavailable",
      failedRetryable: "1",
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/uploads/${uploadId}/complete`,
      routePath: "/v1/uploads/:uploadId/complete",
      params: { uploadId },
    });
    const body = res.json();

    assert.equal(res.statusCode, 202);
    assert.equal(body.uploadId, uploadId);
    assert.equal(body.status, "finalizing");
    assert.equal(body.enqueued, false);
    assert.equal(body.finalizeAttemptState, "retryable_failure");
    assert.equal(body.failedReasonCode, "walrus_unavailable");
    assert.equal(body.failedRetryable, true);
  } finally {
    await cleanupUpload(uploadId);
  }
});

test("cancel keeps gc tracking when terminal artifact cleanup fails", async () => {
  const uploadId = await seedUpload();
  const app = await createRouteApp();
  const originalCleanup = storeIndexModule.chunkStore.cleanup.bind(storeIndexModule.chunkStore);
  try {
    const redis = redisModule.getRedis();
    const { uploadKeys } = keysModule;
    await redis.del(uploadKeys.session(uploadId));
    await redis.hset(uploadKeys.meta(uploadId), {
      status: "failed",
    });

    storeIndexModule.chunkStore.cleanup = async () => {
      throw new Error("cleanup failed");
    };

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/uploads/${uploadId}`,
      routePath: "/v1/uploads/:uploadId",
      params: { uploadId },
    });
    const body = res.json();

    assert.equal(res.statusCode, 200);
    assert.equal(body.status, "failed");
    assert.equal(await redis.sismember(uploadKeys.gcIndex(), uploadId), 1);
  } finally {
    storeIndexModule.chunkStore.cleanup = originalCleanup;
    await cleanupUpload(uploadId);
  }
});
