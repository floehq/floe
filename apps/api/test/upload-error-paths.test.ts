import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const redisPort = 18380 + Math.floor(Math.random() * 1000);
const redisUrl = `redis://127.0.0.1:${redisPort}`;
const uploadTmpDir = path.join(os.tmpdir(), `floe-upload-error-paths-${process.pid}`);

process.env.FLOE_REDIS_PROVIDER = "native";
process.env.REDIS_URL = redisUrl;
process.env.FLOE_CHUNK_STORE_MODE = "disk";
process.env.UPLOAD_TMP_DIR = uploadTmpDir;
process.env.FLOE_CHUNK_MIN_BYTES = "1";
process.env.FLOE_CHUNK_DEFAULT_BYTES = "4";
process.env.FLOE_CHUNK_MAX_BYTES = "8";
process.env.FLOE_UPLOAD_SESSION_TTL_MS = "2000";
process.env.WALRUS_AGGREGATOR_URL = "http://127.0.0.1:1";
process.env.FLOE_FINALIZE_STATUS_POLL_MS = "2000";
process.env.FLOE_API_KEY_STORE = "env";
process.env.FLOE_NETWORK = "testnet";
process.env.SUI_PRIVATE_KEY = `[${new Array(32).fill(0).join(",")}]`;
process.env.SUI_PACKAGE_ID = "0x2";
process.env.FLOE_ENFORCE_UPLOAD_OWNER = "false";

type RedisModule = typeof import("../src/state/redis.ts");
type SessionModule = typeof import("../src/services/uploads/session.ts");
type UploadRoutesModule = typeof import("../src/routes/uploads.ts");
type KeysModule = typeof import("../src/state/keys.ts");
type StoreIndexModule = typeof import("../src/store/index.ts");

let redisProcess: ChildProcess | null = null;
let redisModule: RedisModule;
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
} as unknown as Record<string, (...args: never[]) => unknown>;

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

async function createRouteApp(customAuthProvider?: Record<string, unknown>) {
  const handlers = new Map<
    string,
    (req: Record<string, unknown>, reply: Record<string, unknown>) => Promise<unknown> | unknown
  >();
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
          subject: "error-paths-test",
          method: "public",
          owner: null,
        },
      };
    },
    ...customAuthProvider,
  };
  function resolveHandler(optsOrHandler: unknown, maybeHandler?: unknown): unknown {
    return maybeHandler ?? optsOrHandler;
  }
  const app = {
    get(path: string, optsOrHandler: unknown, maybeHandler?: unknown) {
      handlers.set(`GET ${path}`, resolveHandler(optsOrHandler, maybeHandler));
    },
    post(path: string, optsOrHandler: unknown, maybeHandler?: unknown) {
      handlers.set(`POST ${path}`, resolveHandler(optsOrHandler, maybeHandler));
    },
    put(path: string, optsOrHandler: unknown, maybeHandler?: unknown) {
      handlers.set(`PUT ${path}`, resolveHandler(optsOrHandler, maybeHandler));
    },
    delete(path: string, optsOrHandler: unknown, maybeHandler?: unknown) {
      handlers.set(`DELETE ${path}`, resolveHandler(optsOrHandler, maybeHandler));
    },
  } as unknown as Record<string, unknown>;

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
        childLogger: log,
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

async function seedUpload(params?: {
  totalChunks?: number;
  chunkSize?: number;
  sizeBytes?: number;
}) {
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
    { stdio: "ignore" },
  );
  await waitForRedis(redisPort);

  redisModule = await import("../src/state/redis.ts");
  sessionModule = await import("../src/services/uploads/session.ts");
  uploadRoutesModule = await import("../src/routes/uploads.ts");
  keysModule = await import("../src/state/keys.ts");
  storeIndexModule = await import("../src/store/index.ts");

  await redisModule.initRedis();
});

after(async () => {
  if (redisProcess) {
    redisProcess.kill();
    redisProcess = null;
  }
  await fs.rm(uploadTmpDir, { recursive: true, force: true }).catch(() => {});
});

test("POST /v1/uploads/create - rejects negative blob size", async () => {
  const app = await createRouteApp();

  const res = await app.inject({
    method: "POST",
    url: "/v1/uploads/create",
    routePath: "/v1/uploads/create",
    body: {
      filename: "test.bin",
      contentType: "application/octet-stream",
      sizeBytes: -1,
    },
  });
  const body = res.json() as { error: { code: string; message: string } };

  assert.equal(res.statusCode, 400);
  assert.equal(body.error.code, "INVALID_FILE_SIZE");
  assert.match(body.error.message, /sizeBytes must be positive/i);
});

test("POST /v1/uploads/create - rejects blob size exceeding maximum", async () => {
  const app = await createRouteApp();

  const res = await app.inject({
    method: "POST",
    url: "/v1/uploads/create",
    routePath: "/v1/uploads/create",
    body: {
      filename: "huge.bin",
      contentType: "application/octet-stream",
      sizeBytes: 1e20,
    },
  });
  const body = res.json() as { error: { code: string; message: string } };

  assert.equal(res.statusCode, 413);
  assert.equal(body.error.code, "FILE_TOO_LARGE");
  assert.match(body.error.message, /maxFileSizeBytes/i);
});

test("PUT /v1/uploads/:uploadId/chunk/:index - rejects non-existent upload", async () => {
  const app = await createRouteApp();
  const fakeId = randomUUID();

  const res = await app.inject({
    method: "PUT",
    url: `/v1/uploads/${fakeId}/chunk/0`,
    routePath: "/v1/uploads/:uploadId/chunk/:index",
    params: { uploadId: fakeId, index: "0" },
    headers: { "x-chunk-sha256": "a".repeat(64) },
    filePart: makeFilePart(Buffer.from("data")),
  });
  const body = res.json() as { error: { code: string; message: string } };

  assert.equal(res.statusCode, 404);
  assert.equal(body.error.code, "UPLOAD_NOT_FOUND");
});

test("PUT /v1/uploads/:uploadId/chunk/:index - rejects negative chunk index", async () => {
  const app = await createRouteApp();
  const uploadId = await seedUpload({ totalChunks: 2, chunkSize: 4, sizeBytes: 8 });

  const res = await app.inject({
    method: "PUT",
    url: `/v1/uploads/${uploadId}/chunk/-1`,
    routePath: "/v1/uploads/:uploadId/chunk/:index",
    params: { uploadId, index: "-1" },
    headers: { "x-chunk-sha256": "a".repeat(64) },
    filePart: makeFilePart(Buffer.from("data")),
  });
  const body = res.json() as { error: { code: string; message: string } };

  assert.equal(res.statusCode, 400);
  assert.equal(body.error.code, "INVALID_CHUNK");
});

test("GET /v1/uploads/:uploadId/status - returns error for non-existent upload", async () => {
  const app = await createRouteApp();
  const fakeId = randomUUID();

  const res = await app.inject({
    method: "GET",
    url: `/v1/uploads/${fakeId}/status`,
    routePath: "/v1/uploads/:uploadId/status",
    params: { uploadId: fakeId },
  });
  const body = res.json() as { error: { code: string; message: string } };

  assert.equal(res.statusCode, 404);
  assert.equal(body.error.code, "UPLOAD_NOT_FOUND");
});

test("DELETE /v1/uploads/:uploadId - returns error for non-existent upload", async () => {
  const app = await createRouteApp();
  const fakeId = randomUUID();

  const res = await app.inject({
    method: "DELETE",
    url: `/v1/uploads/${fakeId}`,
    routePath: "/v1/uploads/:uploadId",
    params: { uploadId: fakeId },
  });
  const body = res.json() as { error: { code: string; message: string } };

  assert.equal(res.statusCode, 404);
  assert.equal(body.error.code, "UPLOAD_NOT_FOUND");
});

test("POST /v1/uploads/:uploadId/complete - rejects non-existent upload", async () => {
  const app = await createRouteApp();
  const fakeId = randomUUID();

  const res = await app.inject({
    method: "POST",
    url: `/v1/uploads/${fakeId}/complete`,
    routePath: "/v1/uploads/:uploadId/complete",
    params: { uploadId: fakeId },
  });
  const body = res.json() as { error: { code: string; message: string } };

  assert.equal(res.statusCode, 404);
  assert.equal(body.error.code, "UPLOAD_NOT_FOUND");
});
