import test, { after, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const redisPort = 16380 + Math.floor(Math.random() * 1000);
const redisUrl = `redis://127.0.0.1:${redisPort}`;
const uploadTmpDir = path.join(os.tmpdir(), `floe-finalize-integration-${process.pid}`);

process.env.FLOE_REDIS_PROVIDER = "native";
process.env.REDIS_URL = redisUrl;
process.env.FLOE_CHUNK_STORE_MODE = "disk";
process.env.UPLOAD_TMP_DIR = uploadTmpDir;
process.env.FLOE_FINALIZE_RETRY_MS = "200";
process.env.FLOE_FINALIZE_RETRY_MAX_MS = "1000";
process.env.FLOE_FINALIZE_RETRYABLE_FAILURE_BASE_MS = "200";
process.env.FLOE_FINALIZE_RETRYABLE_FAILURE_MAX_MS = "1000";
process.env.FLOE_FINALIZE_RETRYABLE_FAILURE_MAX_ATTEMPTS = "2";
process.env.FLOE_FINALIZE_QUEUE_STUCK_AGE_MS = "1000";
process.env.FLOE_FINALIZE_TIMEOUT_MS = "1000";
process.env.WALRUS_AGGREGATOR_URL = "http://127.0.0.1:1";
process.env.FLOE_WALRUS_STORE_MODE = "sdk";
process.env.FLOE_WALRUS_SDK_BASE_URL = "http://127.0.0.1:1";
process.env.FLOE_NETWORK = "testnet";
process.env.SUI_PRIVATE_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.FLOE_METRICS_TOKEN = "ops-test-token";
delete process.env.DATABASE_URL;

type RedisModule = typeof import("../src/state/redis.ts");
type PostgresModule = typeof import("../src/state/postgres.ts");
type SessionModule = typeof import("../src/services/uploads/session.ts");
type QueueModule = typeof import("../src/services/uploads/finalize.queue.ts");
type KeysModule = typeof import("../src/state/keys.ts");
type UploadRoutesModule = typeof import("../src/routes/uploads.ts");
type HealthRouteModule = typeof import("../src/routes/health.ts");

let redisProcess: ChildProcess | null = null;
let redisModule: RedisModule;
let postgresModule: PostgresModule;
let sessionModule: SessionModule;
let queueModule: QueueModule;
let keysModule: KeysModule;
let uploadRoutesModule: UploadRoutesModule;
let healthRouteModule: HealthRouteModule;

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

function makeRedisMethodFailureStub(originalRedis: any, methods: string[]) {
  const failing = new Set(methods);
  return new Proxy(originalRedis, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && failing.has(prop)) {
        return async () => {
          throw new Error("redis unavailable");
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as any;
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

async function createRouteApp() {
  const handlers = new Map<string, (req: any, reply: any) => Promise<unknown> | unknown>();
  const authProvider = {
    resolveIdentity() {
      return {
        authenticated: false,
        subject: "integration-test",
        method: "public",
        owner: null,
      };
    },
    async authorizeUploadAccess() {
      return { allowed: true };
    },
    async authorizeFileAccess() {
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
  await healthRouteModule.default(app);

  return {
    async inject(params: {
      method: "GET" | "POST" | "PUT" | "DELETE";
      url: string;
      routePath?: string;
      params?: Record<string, unknown>;
      query?: Record<string, unknown>;
      body?: unknown;
      headers?: Record<string, string>;
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
  await redis.del(`${uploadKeys.meta(uploadId)}:lock`);
  await fs.rm(path.join(uploadTmpDir, uploadId), { recursive: true, force: true }).catch(() => {});
  await fs.rm(path.join(uploadTmpDir, `${uploadId}.bin`), { force: true }).catch(() => {});
}

async function cleanupQueueState() {
  const redis = redisModule.getRedis();
  const { uploadKeys } = keysModule;
  await redis.del(uploadKeys.finalizeQueue());
  await redis.del(uploadKeys.finalizePending());
  await redis.del(uploadKeys.finalizePendingSince());
}

async function seedUpload(params?: { totalChunks?: number }) {
  const uploadId = randomUUID();
  const totalChunks = params?.totalChunks ?? 2;
  await sessionModule.createSession({
    uploadId,
    filename: "video.mp4",
    contentType: "video/mp4",
    sizeBytes: totalChunks * 4,
    chunkSize: 4,
    totalChunks,
    epochs: 1,
  });
  return uploadId;
}

async function markUploadReadyForFinalize(uploadId: string, totalChunks = 2) {
  const redis = redisModule.getRedis();
  const { uploadKeys } = keysModule;
  await redis.hset(uploadKeys.meta(uploadId), {
    status: "finalizing",
    finalizingQueuedAt: String(Date.now() - 25),
  });
  for (let idx = 0; idx < totalChunks; idx++) {
    await redis.sadd(uploadKeys.chunks(uploadId), String(idx));
  }
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
  postgresModule = await import("../src/state/postgres.ts");
  sessionModule = await import("../src/services/uploads/session.ts");
  queueModule = await import("../src/services/uploads/finalize.queue.ts");
  keysModule = await import("../src/state/keys.ts");
  uploadRoutesModule = await import("../src/routes/uploads.ts");
  healthRouteModule = await import("../src/routes/health.ts");

  await redisModule.initRedis();
});

afterEach(async () => {
  healthRouteModule?.healthRouteTestHooks?.resetCache?.();
  queueModule?.finalizeQueueTestHooks?.reset();
  if (redisModule) {
    await cleanupQueueState();
  }
});

after(async () => {
  healthRouteModule?.healthRouteTestHooks?.resetCache?.();
  queueModule?.finalizeQueueTestHooks?.reset();
  if (redisModule) {
    await cleanupQueueState().catch(() => {});
    await redisModule.closeRedis().catch(() => {});
  }
  if (redisProcess && !redisProcess.killed) {
    redisProcess.kill("SIGTERM");
  }
  await fs.rm(uploadTmpDir, { recursive: true, force: true }).catch(() => {});
});

test("runFinalizeJob requeues retryable transient failures through the real worker path", async () => {
  const uploadId = await seedUpload();
  try {
    await markUploadReadyForFinalize(uploadId);
    await queueModule.finalizeQueueTestHooks.forceEnqueue(uploadId);

    const scheduled: Array<{ uploadId: string; delayMs: number }> = [];
    queueModule.finalizeQueueTestHooks.setProcessFinalize(async () => {
      const err = new Error("WALRUS_UPLOAD_FAILED: upstream unavailable") as Error & { finalizeStage?: string };
      err.finalizeStage = "walrus_publish";
      throw err;
    });
    queueModule.finalizeQueueTestHooks.setScheduleRetry(async (nextUploadId, _log, delayMs) => {
      scheduled.push({ uploadId: nextUploadId, delayMs });
      await queueModule.finalizeQueueTestHooks.forceEnqueue(nextUploadId);
    });

    await queueModule.finalizeQueueTestHooks.runNextQueuedJob(log);

    const redis = redisModule.getRedis();
    const { uploadKeys } = keysModule;
    const meta = await redis.hgetall<Record<string, string>>(uploadKeys.meta(uploadId));
    const stats = await queueModule.getUploadFinalizeQueueStats();

    assert.equal(meta.status, "finalizing");
    assert.equal(meta.failedReasonCode, "walrus_upload_failed");
    assert.equal(meta.failedRetryable, "1");
    assert.equal(meta.finalizeAttemptState, "retryable_failure");
    assert.equal(meta.failedStage, "walrus_publish");
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0]?.uploadId, uploadId);
    assert.equal(stats.depth, 1);
    assert.equal(stats.pendingUnique, 0);
  } finally {
    await cleanupUpload(uploadId);
  }
});

test("runFinalizeJob stops retrying after the configured retry ceiling", async () => {
  const uploadId = await seedUpload();
  try {
    await markUploadReadyForFinalize(uploadId);
    const redis = redisModule.getRedis();
    const { uploadKeys } = keysModule;
    await redis.hset(uploadKeys.meta(uploadId), {
      finalizeAttempts: "2",
    });
    await queueModule.finalizeQueueTestHooks.forceEnqueue(uploadId);

    let scheduled = 0;
    queueModule.finalizeQueueTestHooks.setProcessFinalize(async () => {
      throw new Error("WALRUS temporary outage");
    });
    queueModule.finalizeQueueTestHooks.setScheduleRetry(async () => {
      scheduled += 1;
    });

    await queueModule.finalizeQueueTestHooks.runNextQueuedJob(log);

    const meta = await redis.hgetall<Record<string, string>>(uploadKeys.meta(uploadId));
    const stats = await queueModule.getUploadFinalizeQueueStats();

    assert.equal(scheduled, 0);
    assert.equal(meta.status, "failed");
    assert.equal(meta.failedReasonCode, "walrus_unavailable");
    assert.equal(meta.failedRetryable, "1");
    assert.equal(meta.finalizeAttemptState, undefined);
    assert.equal(stats.depth, 0);
    assert.equal(stats.pendingUnique, 0);
  } finally {
    await cleanupUpload(uploadId);
  }
});

test("runFinalizeJob requeues lock contention through the real worker path", async () => {
  const uploadId = await seedUpload();
  try {
    await markUploadReadyForFinalize(uploadId);
    await queueModule.finalizeQueueTestHooks.forceEnqueue(uploadId);

    const scheduled: number[] = [];
    queueModule.finalizeQueueTestHooks.setProcessFinalize(async () => {
      throw new Error("UPLOAD_FINALIZATION_IN_PROGRESS");
    });
    queueModule.finalizeQueueTestHooks.setScheduleRetry(async (nextUploadId, _log, delayMs) => {
      scheduled.push(delayMs);
      await queueModule.finalizeQueueTestHooks.forceEnqueue(nextUploadId);
    });

    await queueModule.finalizeQueueTestHooks.runNextQueuedJob(log);

    const redis = redisModule.getRedis();
    const { uploadKeys } = keysModule;
    const meta = await redis.hgetall<Record<string, string>>(uploadKeys.meta(uploadId));
    const stats = await queueModule.getUploadFinalizeQueueStats();

    assert.equal(meta.status, "finalizing");
    assert.equal(meta.failedReasonCode, "lock_in_progress");
    assert.equal(meta.failedRetryable, "1");
    assert.equal(scheduled.length, 1);
    assert.equal(stats.depth, 1);
    assert.equal(stats.pendingUnique, 0);
  } finally {
    await cleanupUpload(uploadId);
  }
});

test("runFinalizeJob treats already completed uploads idempotently on retry", async () => {
  const uploadId = await seedUpload();
  try {
    const redis = redisModule.getRedis();
    const { uploadKeys } = keysModule;
    await redis.hset(uploadKeys.meta(uploadId), {
      status: "completed",
      fileId: "0xfile",
      blobId: "0xblob",
      sizeBytes: "8",
    });
    await redis.del(uploadKeys.session(uploadId));
    await queueModule.finalizeQueueTestHooks.forceEnqueue(uploadId);

    await queueModule.finalizeQueueTestHooks.runNextQueuedJob(log);

    const meta = await redis.hgetall<Record<string, string>>(uploadKeys.meta(uploadId));
    const stats = await queueModule.getUploadFinalizeQueueStats();

    assert.equal(meta.status, "completed");
    assert.equal(meta.fileId, "0xfile");
    assert.equal(stats.depth, 0);
    assert.equal(stats.pendingUnique, 0);
  } finally {
    await cleanupUpload(uploadId);
  }
});

test("recoverFinalizingUploads also requeues retryable-failed uploads from pre-recovery state", async () => {
  const uploadId = await seedUpload();
  try {
    const redis = redisModule.getRedis();
    const { uploadKeys } = keysModule;
    await redis.hset(uploadKeys.meta(uploadId), {
      status: "failed",
      failedRetryable: "1",
      finalizeAttemptState: "retryable_failure",
    });
    await queueModule.finalizeQueueTestHooks.recoverFinalizingUploads(log);

    const pendingIds = await redis.smembers<string[]>(uploadKeys.finalizePending());
    assert.equal(pendingIds.includes(uploadId), true);
  } finally {
    await cleanupUpload(uploadId);
  }
});

test("recoverFinalizingUploads requeues only finalizing uploads and cleans stale queue entries", async () => {
  const finalizingUploadId = await seedUpload();
  const completedUploadId = await seedUpload();
  const failedUploadId = await seedUpload();
  try {
    const redis = redisModule.getRedis();
    const { uploadKeys } = keysModule;

    await redis.hset(uploadKeys.meta(finalizingUploadId), { status: "finalizing" });
    await redis.hset(uploadKeys.meta(completedUploadId), { status: "completed", fileId: "0x1", blobId: "0x2" });
    await redis.hset(uploadKeys.meta(failedUploadId), { status: "failed" });

    await queueModule.finalizeQueueTestHooks.forceEnqueue(finalizingUploadId);
    await queueModule.finalizeQueueTestHooks.forceEnqueue(completedUploadId);
    await queueModule.finalizeQueueTestHooks.forceEnqueue(failedUploadId);

    const recovery = await queueModule.finalizeQueueTestHooks.recoverFinalizingUploads(log);

    const pendingFinalizing = await redis.smembers<string[]>(uploadKeys.finalizePending());
    const queueDepth = Number(await redis.llen(uploadKeys.finalizeQueue()));

    assert.equal(recovery.scanned, 3);
    assert.equal(recovery.recovered, 1);
    assert.equal(recovery.cleaned, 2);
    assert.equal(pendingFinalizing.includes(finalizingUploadId), true);
    assert.equal(pendingFinalizing.includes(completedUploadId), false);
    assert.equal(pendingFinalizing.includes(failedUploadId), false);
    assert.equal(queueDepth >= 1, true);
  } finally {
    await cleanupUpload(finalizingUploadId);
    await cleanupUpload(completedUploadId);
    await cleanupUpload(failedUploadId);
  }
});

test("upload status and complete routes expose finalize warnings and retry fields", async () => {
  const uploadId = await seedUpload();
  const app = await createRouteApp();
  try {
    const redis = redisModule.getRedis();
    const { uploadKeys } = keysModule;
    const warningAt = Date.now();
    await redis.hset(uploadKeys.meta(uploadId), {
      status: "finalizing",
      finalizeWarning: "post_commit_cleanup_failed",
      finalizeWarningAt: String(warningAt),
      failedReasonCode: "walrus_unavailable",
      failedRetryable: "1",
      failedStage: "walrus_publish",
      finalizeAttemptState: "retryable_failure",
      lastFinalizeRetryDelayMs: "5",
      finalizingQueuedAt: String(Date.now() - 25),
    });
    await redis.del(uploadKeys.session(uploadId));

    const statusRes = await app.inject({
      method: "GET",
      url: `/v1/uploads/${uploadId}/status`,
      routePath: "/v1/uploads/:uploadId/status",
      params: { uploadId },
    });
    const completeRes = await app.inject({
      method: "POST",
      url: `/v1/uploads/${uploadId}/complete`,
      routePath: "/v1/uploads/:uploadId/complete",
      params: { uploadId },
    });

    assert.equal(statusRes.statusCode, 200);
    assert.equal(completeRes.statusCode, 202);

    const statusBody = statusRes.json();
    const completeBody = completeRes.json();

    assert.equal(statusBody.finalizeWarning, "post_commit_cleanup_failed");
    assert.equal(statusBody.finalizeWarningAt, warningAt);
    assert.equal(statusBody.failedReasonCode, "walrus_unavailable");
    assert.equal(statusBody.failedRetryable, true);
    assert.equal(completeBody.finalizeWarning, "post_commit_cleanup_failed");
    assert.equal(completeBody.finalizeAttemptState, "retryable_failure");
    assert.equal(completeBody.lastFinalizeRetryDelayMs, 5);
  } finally {
    await cleanupUpload(uploadId);
  }
});

test("runFinalizeJob turns timeout into retryable recovery instead of holding the worker slot", async () => {
  const uploadId = await seedUpload();
  try {
    await markUploadReadyForFinalize(uploadId);
    await queueModule.finalizeQueueTestHooks.forceEnqueue(uploadId);

    const scheduled: Array<{ uploadId: string; delayMs: number }> = [];
    queueModule.finalizeQueueTestHooks.setProcessFinalize(async () => {
      await sleep(1200);
    });
    queueModule.finalizeQueueTestHooks.setScheduleRetry(async (nextUploadId, _log, delayMs) => {
      scheduled.push({ uploadId: nextUploadId, delayMs });
    });

    const startedAt = Date.now();
    await queueModule.finalizeQueueTestHooks.runNextQueuedJob(log);
    const elapsedMs = Date.now() - startedAt;

    const redis = redisModule.getRedis();
    const { uploadKeys } = keysModule;
    const meta = await redis.hgetall<Record<string, string>>(uploadKeys.meta(uploadId));

    assert.equal(elapsedMs < 1150, true);
    assert.equal(meta.status, "finalizing");
    assert.equal(meta.failedReasonCode, "timeout");
    assert.equal(meta.failedRetryable, "1");
    assert.equal(meta.finalizeAttemptState, "retryable_failure");
    assert.equal(scheduled.length, 1);
  } finally {
    await cleanupUpload(uploadId);
  }
});

test("stopUploadFinalizeWorker clears scheduled retry timers", async () => {
  const uploadId = await seedUpload();
  try {
    await markUploadReadyForFinalize(uploadId);
    await queueModule.startUploadFinalizeWorker(log);
    await queueModule.finalizeQueueTestHooks.forceEnqueue(uploadId);

    queueModule.finalizeQueueTestHooks.setProcessFinalize(async () => {
      throw new Error("WALRUS temporary outage");
    });

    await queueModule.finalizeQueueTestHooks.runNextQueuedJob(log);
    assert.equal(queueModule.finalizeQueueTestHooks.getRetryTimerCount() > 0, true);

    await queueModule.stopUploadFinalizeWorker();
    assert.equal(queueModule.finalizeQueueTestHooks.getRetryTimerCount(), 0);

    await sleep(300);
    const stats = await queueModule.getUploadFinalizeQueueStats();
    assert.equal(stats.depth, 0);
  } finally {
    await cleanupUpload(uploadId);
  }
});

test("enqueueUploadFinalize enforces queue backpressure atomically under concurrency", async () => {
  const firstUploadId = await seedUpload();
  const secondUploadId = await seedUpload();
  try {
    queueModule.finalizeQueueTestHooks.setQueueMaxDepth(1);
    queueModule.finalizeQueueTestHooks.setAutoDrain(false);

    const [first, second] = await Promise.all([
      queueModule.enqueueUploadFinalize({ uploadId: firstUploadId, log }),
      queueModule.enqueueUploadFinalize({ uploadId: secondUploadId, log }),
    ]);

    const results = [first, second];
    const enqueuedCount = results.filter((result) => result.enqueued).length;
    const rejectedCount = results.filter((result) => result.rejectedByBackpressure).length;
    const stats = await queueModule.getUploadFinalizeQueueStats();

    assert.equal(enqueuedCount, 1);
    assert.equal(rejectedCount, 1);
    assert.equal(stats.depth, 1);
    assert.equal(stats.pendingUnique, 1);
  } finally {
    await cleanupUpload(firstUploadId);
    await cleanupUpload(secondUploadId);
  }
});

test("health route reports stalled finalize backlog as degraded", async () => {
  const uploadId = await seedUpload();
  const app = await createRouteApp();
  try {
    const redis = redisModule.getRedis();
    const { uploadKeys } = keysModule;
    await redis.hset(uploadKeys.meta(uploadId), { status: "finalizing" });
    await queueModule.finalizeQueueTestHooks.forceEnqueue(uploadId);
    await redis.eval(
      'redis.call("ZADD", KEYS[1], ARGV[2], ARGV[1]); return 1',
      [uploadKeys.finalizePendingSince()],
      [uploadId, String(Date.now() - 5_000)]
    );

    const res = await app.inject({ method: "GET", url: "/health", routePath: "/health" });
    const body = res.json();

    assert.equal(res.statusCode, 503);
    assert.equal(body.ready, false);
    assert.equal(body.degraded, true);
    assert.equal(body.checks.finalizeQueue.depth, 1);
    assert.equal(String(body.checks.finalizeQueueWarning).startsWith("finalize queue oldest age"), true);
  } finally {
    await cleanupUpload(uploadId);
  }
});

test("livez stays cheap and reports process liveness", async () => {
  const app = await createRouteApp();

  const res = await app.inject({ method: "GET", url: "/livez", routePath: "/livez" });
  const body = res.json();

  assert.equal(res.statusCode, 200);
  assert.equal(body.status, "UP");
  assert.equal(body.service, "floe-api-v1");
  assert.equal(body.role, "full");
});

test("health route exposes node role capabilities", async () => {
  const app = await createRouteApp();

  const res = await app.inject({ method: "GET", url: "/health", routePath: "/health" });
  const body = res.json();

  assert.equal(res.statusCode, 200);
  assert.equal(body.role, "full");
  assert.deepEqual(body.capabilities, {
    uploads: true,
    files: true,
    ops: true,
    finalizeWorker: true,
  });
  assert.equal(body.walrus.readers.count >= 1, true);
  assert.equal(typeof body.walrus.readers.primary, "string");
  assert.equal(body.walrus.writers.mode, "sdk");
  assert.equal(body.walrus.writers.count >= 1, true);
  assert.equal(typeof body.walrus.writers.primary, "string");
});

test("health route caches dependency probes across back-to-back requests", async () => {
  const originalRedis = redisModule.getRedis();
  let pingCalls = 0;
  redisModule.setRedisForTests({
    ...originalRedis,
    ping: async () => {
      pingCalls += 1;
      return "PONG";
    },
  } as any);

  const app = await createRouteApp();
  try {
    const first = await app.inject({ method: "GET", url: "/health", routePath: "/health" });
    const second = await app.inject({ method: "GET", url: "/health", routePath: "/health" });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(pingCalls, 1);
  } finally {
    redisModule.setRedisForTests(originalRedis);
    healthRouteModule.healthRouteTestHooks.resetCache();
  }
});

test("health route reports optional postgres outage as degraded but ready", async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://127.0.0.1:1/floe";
  postgresModule.setPostgresForTests(null, false);

  const app = await createRouteApp();
  try {
    const res = await app.inject({ method: "GET", url: "/health", routePath: "/health" });
    const body = res.json();

    assert.equal(res.statusCode, 200);
    assert.equal(body.status, "DEGRADED");
    assert.equal(body.ready, true);
    assert.equal(body.degraded, true);
    assert.equal(body.checks.postgres.configured, true);
    assert.equal(body.checks.postgres.required, false);
    assert.equal(body.checks.postgres.status, "degraded");
  } finally {
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    postgresModule.setPostgresForTests(null, false);
  }
});

test("create upload returns retryable 503 when redis is unavailable", async () => {
  const originalRedis = redisModule.getRedis();
  redisModule.setRedisForTests(makeRedisMethodFailureStub(originalRedis, ["eval"]));

  const app = await createRouteApp();
  try {
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

    assert.equal(res.statusCode, 503);
    assert.equal(res.headers["retry-after"], "5");
    assert.equal(body.error.code, "DEPENDENCY_UNAVAILABLE");
    assert.equal(body.error.retryable, true);
    assert.equal(body.error.details.dependency, "redis");
  } finally {
    redisModule.setRedisForTests(originalRedis);
  }
});

test("upload routes return retryable 503 when redis is unavailable", async () => {
  const uploadId = await seedUpload({ totalChunks: 2 });
  const originalRedis = redisModule.getRedis();
  redisModule.setRedisForTests(makeRedisMethodFailureStub(originalRedis, ["hget", "hgetall"]));

  const app = await createRouteApp();
  try {
    const cases = [
      {
        method: "PUT" as const,
        routePath: "/v1/uploads/:uploadId/chunk/:index",
        params: { uploadId, index: "0" },
        headers: { "x-chunk-sha256": "abc" },
      },
      {
        method: "GET" as const,
        routePath: "/v1/uploads/:uploadId/status",
        params: { uploadId },
      },
      {
        method: "POST" as const,
        routePath: "/v1/uploads/:uploadId/complete",
        params: { uploadId },
      },
      {
        method: "DELETE" as const,
        routePath: "/v1/uploads/:uploadId",
        params: { uploadId },
      },
    ];

    for (const testCase of cases) {
      const res = await app.inject({
        method: testCase.method,
        url: testCase.routePath.replace(":uploadId", uploadId),
        routePath: testCase.routePath,
        params: testCase.params,
        headers: testCase.headers,
      });
      const body = res.json();

      assert.equal(res.statusCode, 503);
      assert.equal(res.headers["retry-after"], "5");
      assert.equal(body.error.code, "DEPENDENCY_UNAVAILABLE");
      assert.equal(body.error.retryable, true);
      assert.equal(body.error.details.dependency, "redis");
    }
  } finally {
    redisModule.setRedisForTests(originalRedis);
    await cleanupUpload(uploadId);
  }
});

test("ops upload route returns operator snapshot for an upload", async () => {
  const uploadId = await seedUpload({ totalChunks: 3 });
  const app = await createRouteApp();
  try {
    const redis = redisModule.getRedis();
    const { uploadKeys } = keysModule;
    await redis.sadd(uploadKeys.chunks(uploadId), "0");
    await redis.sadd(uploadKeys.chunks(uploadId), "2");
    await redis.hset(uploadKeys.meta(uploadId), {
      status: "finalizing",
      finalizeAttemptState: "retryable_failure",
    });
    await queueModule.finalizeQueueTestHooks.forceEnqueue(uploadId);

    const res = await app.inject({
      method: "GET",
      url: `/ops/uploads/${uploadId}`,
      routePath: "/ops/uploads/:uploadId",
      params: { uploadId },
      headers: { "x-metrics-token": "ops-test-token" },
    });
    const body = res.json();

    assert.equal(res.statusCode, 200);
    assert.equal(body.uploadId, uploadId);
    assert.equal(body.dependencies.redis.status, "healthy");
    assert.equal(body.chunks.receivedCount, 2);
    assert.equal("receivedIndexes" in body.chunks, false);
    assert.equal(body.finalize.pending, true);
    assert.equal(body.meta.status, "finalizing");
    assert.equal(body.summary.phase, "finalize_retrying");
    assert.equal(body.summary.issue, "retryable_finalize_failure");
    assert.equal(body.summary.recommendedAction, "wait_for_finalize");
    assert.equal(body.summary.chunkProgress.missingChunkCount, 1);
    assert.equal(body.summary.failure.reasonCode, null);
    assert.equal(body.summary.finalize.stalled, false);

    const withIndexes = await app.inject({
      method: "GET",
      url: `/ops/uploads/${uploadId}`,
      routePath: "/ops/uploads/:uploadId",
      params: { uploadId },
      query: { includeReceivedIndexes: "1" },
      headers: { "x-metrics-token": "ops-test-token" },
    });
    assert.deepEqual(withIndexes.json().chunks.receivedIndexes, [0, 2]);
  } finally {
    await cleanupUpload(uploadId);
  }
});

test("ops upload route summarizes incomplete uploading sessions for operators", async () => {
  const uploadId = await seedUpload({ totalChunks: 4 });
  const app = await createRouteApp();
  try {
    const redis = redisModule.getRedis();
    const { uploadKeys } = keysModule;
    await redis.sadd(uploadKeys.chunks(uploadId), "0");
    await redis.sadd(uploadKeys.chunks(uploadId), "1");

    const res = await app.inject({
      method: "GET",
      url: `/ops/uploads/${uploadId}`,
      routePath: "/ops/uploads/:uploadId",
      params: { uploadId },
      headers: { "x-metrics-token": "ops-test-token" },
    });
    const body = res.json();

    assert.equal(res.statusCode, 200);
    assert.equal(body.summary.status, "uploading");
    assert.equal(body.summary.phase, "uploading");
    assert.equal(body.summary.issue, "missing_chunks");
    assert.equal(body.summary.recommendedAction, "resume_upload");
    assert.equal(body.summary.chunkProgress.totalChunks, 4);
    assert.equal(body.summary.chunkProgress.receivedCount, 2);
    assert.equal(body.summary.chunkProgress.missingChunkCount, 2);
    assert.equal(body.summary.chunkProgress.uploadComplete, false);
  } finally {
    await cleanupUpload(uploadId);
  }
});

test("ops upload route distinguishes active finalize lock from queued work", async () => {
  const uploadId = await seedUpload({ totalChunks: 2 });
  const app = await createRouteApp();
  try {
    const redis = redisModule.getRedis();
    const { uploadKeys } = keysModule;
    await redis.hset(uploadKeys.meta(uploadId), {
      status: "finalizing",
      finalizeAttemptState: "running",
    });
    await redis.set(`${uploadKeys.meta(uploadId)}:lock`, "worker-1", { ex: 30 });

    const res = await app.inject({
      method: "GET",
      url: `/ops/uploads/${uploadId}`,
      routePath: "/ops/uploads/:uploadId",
      params: { uploadId },
      headers: { "x-metrics-token": "ops-test-token" },
    });
    const body = res.json();

    assert.equal(res.statusCode, 200);
    assert.equal(body.summary.phase, "finalize_active");
    assert.equal(body.summary.recommendedAction, "wait_for_finalize");
    assert.equal(body.summary.finalize.activeLock, true);
    assert.equal(body.finalize.activeLock, true);
    assert.equal(body.finalize.lockTtlSeconds > 0, true);
    assert.equal(body.summary.finalize.stalled, false);
  } finally {
    await cleanupUpload(uploadId);
  }
});

test("ops upload route flags stalled finalization with dependency-focused action", async () => {
  const uploadId = await seedUpload({ totalChunks: 2 });
  const app = await createRouteApp();
  try {
    const redis = redisModule.getRedis();
    const { uploadKeys } = keysModule;
    const now = Date.now();
    await redis.hset(uploadKeys.meta(uploadId), {
      status: "finalizing",
      finalizeAttemptState: "running",
      finalizingQueuedAt: String(now - 5_000),
      finalizeLastProgressAt: String(now - 2_500),
      failedReasonCode: "walrus_unavailable",
      failedRetryable: "1",
      failedStage: "walrus_publish",
      lastFinalizeRetryAt: String(now - 1_000),
      lastFinalizeRetryDelayMs: "1500",
    });
    await queueModule.finalizeQueueTestHooks.forceEnqueue(uploadId);

    const res = await app.inject({
      method: "GET",
      url: `/ops/uploads/${uploadId}`,
      routePath: "/ops/uploads/:uploadId",
      params: { uploadId },
      headers: { "x-metrics-token": "ops-test-token" },
    });
    const body = res.json();

    assert.equal(res.statusCode, 200);
    assert.equal(body.summary.phase, "finalize_queued");
    assert.equal(body.summary.issue, "finalize_stalled");
    assert.equal(body.summary.recommendedAction, "inspect_dependencies");
    assert.equal(body.summary.finalize.stalled, true);
    assert.equal(body.summary.failure.reasonCode, "walrus_unavailable");
    assert.equal(body.summary.failure.stage, "walrus_publish");
    assert.equal(body.summary.failure.retryable, true);
    assert.equal(body.summary.failure.retryDelayMs, 1500);
    assert.equal(body.summary.timing.lastProgressAgeMs >= 2_000, true);
    assert.equal(body.summary.timing.queuedAgeMs >= 4_000, true);
  } finally {
    await cleanupUpload(uploadId);
  }
});

test("ops upload route enforces auth and error handling", async () => {
  const uploadId = await seedUpload();
  const app = await createRouteApp();
  const originalRedis = redisModule.getRedis();
  try {
    const unauthorized = await app.inject({
      method: "GET",
      url: `/ops/uploads/${uploadId}`,
      routePath: "/ops/uploads/:uploadId",
      params: { uploadId },
    });
    assert.equal(unauthorized.statusCode, 401);

    const invalidId = await app.inject({
      method: "GET",
      url: "/ops/uploads/not-a-uuid",
      routePath: "/ops/uploads/:uploadId",
      params: { uploadId: "not-a-uuid" },
      headers: { "x-metrics-token": "ops-test-token" },
    });
    assert.equal(invalidId.statusCode, 400);

    const notFound = await app.inject({
      method: "GET",
      url: `/ops/uploads/${randomUUID()}`,
      routePath: "/ops/uploads/:uploadId",
      params: { uploadId: randomUUID() },
      headers: { "x-metrics-token": "ops-test-token" },
    });
    assert.equal(notFound.statusCode, 404);

    redisModule.setRedisForTests({
      ping: async () => {
        throw new Error("redis unavailable");
      },
    } as any);
    const unavailable = await app.inject({
      method: "GET",
      url: `/ops/uploads/${uploadId}`,
      routePath: "/ops/uploads/:uploadId",
      params: { uploadId },
      headers: { "x-metrics-token": "ops-test-token" },
    });
    const body = unavailable.json();
    assert.equal(unavailable.statusCode, 503);
    assert.equal(body.error.code, "DEPENDENCY_UNAVAILABLE");
  } finally {
    redisModule.setRedisForTests(originalRedis);
    await cleanupUpload(uploadId);
  }
});

test("health route reports required postgres outage as down", async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousRequired = process.env.FLOE_POSTGRES_REQUIRED;
  process.env.DATABASE_URL = "postgres://127.0.0.1:1/floe";
  process.env.FLOE_POSTGRES_REQUIRED = "1";
  postgresModule.setPostgresForTests(null, false);

  const app = await createRouteApp();
  try {
    const res = await app.inject({ method: "GET", url: "/health", routePath: "/health" });
    const body = res.json();

    assert.equal(res.statusCode, 503);
    assert.equal(body.status, "DOWN");
    assert.equal(body.ready, false);
    assert.equal(body.checks.postgres.required, true);
    assert.equal(body.checks.postgres.status, "unavailable");
  } finally {
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    if (previousRequired === undefined) {
      delete process.env.FLOE_POSTGRES_REQUIRED;
    } else {
      process.env.FLOE_POSTGRES_REQUIRED = previousRequired;
    }
    postgresModule.setPostgresForTests(null, false);
  }
});
