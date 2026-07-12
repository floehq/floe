import test, { afterEach, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

process.env.FLOE_NETWORK = "testnet";
process.env.SUI_PRIVATE_KEY = `[${new Array(32).fill(0).join(",")}]`;
process.env.SUI_PACKAGE_ID = "0x2";
process.env.WALRUS_AGGREGATOR_URL = "http://127.0.0.1:1";
process.env.UPLOAD_TMP_DIR = "/tmp/floe-test-upload";
delete process.env.DATABASE_URL;

type FilesRouteModule = typeof import("../src/routes/files.ts");
type PostgresModule = typeof import("../src/state/postgres.ts");
type SuiModule = typeof import("../src/state/sui.ts");
type StreamCacheModule = typeof import("../src/services/stream/stream.cache.ts");

let filesRouteModule: FilesRouteModule;
let postgresModule: PostgresModule;
let suiModule: SuiModule;
let streamCacheModule: StreamCacheModule;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let originalGetObject: any;
let walrusFetchCallCount = 0;
const walrusSamples = new Map<string, Uint8Array>();

function buildFileFields(
  overrides?: Partial<{
    blob_id: string;
    size_bytes: string;
    mime: string;
    created_at: string;
    owner: string;
    walrus_end_epoch: string;
  }>,
) {
  return {
    blob_id: "blob-default",
    size_bytes: "8",
    mime: "video/mp4",
    created_at: "1700000000000",
    owner: "0x1111111111111111111111111111111111111111111111111111111111111111",
    walrus_end_epoch: "12",
    ...overrides,
  };
}

async function mockSuiFile(fields?: Parameters<typeof buildFileFields>[0]) {
  suiModule.getSuiClient().getObject = async () => ({
    data: {
      type: "0x2::file::FileMeta",
      content: {
        dataType: "moveObject",
        fields: buildFileFields(fields),
      },
    },
  });
}

async function readPayloadBytes(payload: unknown): Promise<number[]> {
  if (!(payload instanceof Readable)) {
    return [];
  }

  const chunks: number[] = [];
  for await (const chunk of payload) {
    chunks.push(...chunk);
  }
  return chunks;
}

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

function parseRangeHeader(
  rangeHeader: string | null | undefined,
  sizeBytes: number,
): { start: number; end: number } | null {
  if (!rangeHeader) return null;
  const match = rangeHeader.match(/^bytes=(\d+)-(\d+)$/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
    return null;
  }
  return {
    start,
    end: Math.min(end, sizeBytes - 1),
  };
}

async function createRouteApp(customAuthProvider?: any) {
  const handlers = new Map<string, (req: any, reply: any) => Promise<unknown> | unknown>();
  const authProvider = {
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
    ...customAuthProvider,
  };
  const app = {
    get(path: string, handler: (req: any, reply: any) => Promise<unknown> | unknown) {
      handlers.set(`GET ${path}`, handler);
    },
    post(path: string, handler: (req: any, reply: any) => Promise<unknown> | unknown) {
      handlers.set(`POST ${path}`, handler);
    },
    route(definition: {
      method: string[];
      url: string;
      handler: (req: any, reply: any) => Promise<unknown> | unknown;
    }) {
      for (const method of definition.method) {
        handlers.set(`${method} ${definition.url}`, definition.handler);
      }
    },
  } as any;

  await filesRouteModule.filesRoutes(app);

  return {
    async inject(params: {
      method: "GET" | "HEAD" | "POST";
      url: string;
      routePath?: string;
      params?: Record<string, unknown>;
      query?: Record<string, unknown>;
      headers?: Record<string, string>;
      body?: unknown;
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
        raw: {
          once() {},
          removeListener() {},
        },
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
        send(payload?: unknown) {
          this.payload = payload;
          return this;
        },
      };
      const req = {
        method: params.method,
        params: params.params ?? {},
        query: params.query ?? {},
        headers: params.headers ?? {},
        body: params.body,
        log,
        server: { authProvider },
        raw: {
          once() {},
          removeListener() {},
        },
      };
      const result = await handler(req, reply);
      const payload = reply.payload !== undefined ? reply.payload : result;
      return {
        statusCode: reply.statusCode,
        headers: reply.headers,
        payload,
        json() {
          return payload;
        },
      };
    },
  };
}

before(async () => {
  filesRouteModule = await import("../src/routes/files.ts");
  postgresModule = await import("../src/state/postgres.ts");
  suiModule = await import("../src/state/sui.ts");
  streamCacheModule = await import("../src/services/stream/stream.cache.ts");
  const client = suiModule.getSuiClient();
  originalGetObject = client.getObject.bind(client);
  walrusFetchCallCount = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    walrusFetchCallCount += 1;
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const blobId = decodeURIComponent(url.split("/").pop() ?? "");
    const body = walrusSamples.get(blobId) ?? Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
    const requestHeaders =
      input instanceof Request ? input.headers : new Headers(init?.headers ?? undefined);
    const parsedRange = parseRangeHeader(requestHeaders.get("range"), body.byteLength);
    if (!parsedRange) {
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(body.byteLength) },
      });
    }

    const rangedBody = body.subarray(parsedRange.start, parsedRange.end + 1);
    return new Response(rangedBody, {
      status: 206,
      headers: {
        "content-range": `bytes ${parsedRange.start}-${parsedRange.end}/${body.byteLength}`,
        "content-length": String(rangedBody.byteLength),
      },
    });
  }) as typeof fetch;
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.FLOE_PUBLIC_STREAM_BASE_URL;
  postgresModule.setPostgresForTests(null, false);
  suiModule.getSuiClient().getObject = originalGetObject;
  walrusSamples.clear();
  return fs.rm(process.env.UPLOAD_TMP_DIR!, { recursive: true, force: true });
});

test("metadata route exposes degraded postgres fallback when Sui is used", async () => {
  process.env.DATABASE_URL = "postgres://127.0.0.1:5432/floe";
  postgresModule.setPostgresForTests(
    {
      async query() {
        throw new Error("postgres down");
      },
      async end() {},
    },
    true,
  );
  suiModule.getSuiClient().getObject = async () => ({
    data: {
      type: "0x2::file::FileMeta",
      content: {
        dataType: "moveObject",
        fields: {
          blob_id: "blob-1",
          size_bytes: "128",
          mime: "video/mp4",
          created_at: "1700000000000",
          owner: "0x1111111111111111111111111111111111111111111111111111111111111111",
          walrus_end_epoch: "12",
        },
      },
    },
  });

  const app = await createRouteApp();
  const fileId = "0x2222222222222222222222222222222222222222222222222222222222222222";
  const res = await app.inject({
    method: "GET",
    url: `/v1/files/${fileId}/metadata`,
    routePath: "/v1/files/:fileId/metadata",
    params: { fileId },
  });
  const body = res.json();

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-floe-metadata-source"], "sui");
  assert.equal(res.headers["x-floe-postgres-state"], "degraded");
  assert.equal(body.fileId, fileId);
  assert.equal(body.sizeBytes, 128);
});

test("metadata route exposes postgres source when indexed lookup succeeds", async () => {
  process.env.DATABASE_URL = "postgres://127.0.0.1:5432/floe";
  postgresModule.setPostgresForTests(
    {
      async query() {
        return {
          rows: [
            {
              file_id: "0x3333333333333333333333333333333333333333333333333333333333333333",
              blob_id: "blob-2",
              owner_address: "0x4444444444444444444444444444444444444444444444444444444444444444",
              size_bytes: 256,
              mime_type: "video/mp4",
              walrus_end_epoch: 25,
              created_at_ms: 1700000000100,
            },
          ],
        };
      },
      async end() {},
    },
    true,
  );

  const app = await createRouteApp();
  const fileId = "0x3333333333333333333333333333333333333333333333333333333333333333";
  const res = await app.inject({
    method: "GET",
    url: `/v1/files/${fileId}/metadata`,
    routePath: "/v1/files/:fileId/metadata",
    params: { fileId },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-floe-metadata-source"], "postgres");
  assert.equal(res.headers["x-floe-postgres-state"], "healthy");
});

test("manifest route exposes degraded postgres fallback headers", async () => {
  process.env.DATABASE_URL = "postgres://127.0.0.1:5432/floe";
  postgresModule.setPostgresForTests(
    {
      async query() {
        throw new Error("postgres down");
      },
      async end() {},
    },
    true,
  );
  suiModule.getSuiClient().getObject = async () => ({
    data: {
      type: "0x2::file::FileMeta",
      content: {
        dataType: "moveObject",
        fields: {
          blob_id: "blob-3",
          size_bytes: "512",
          mime: "video/mp4",
          created_at: "1700000000200",
          owner: "0x1111111111111111111111111111111111111111111111111111111111111111",
          walrus_end_epoch: "18",
        },
      },
    },
  });

  const app = await createRouteApp();
  const fileId = "0x5555555555555555555555555555555555555555555555555555555555555555";
  const res = await app.inject({
    method: "GET",
    url: `/v1/files/${fileId}/manifest`,
    routePath: "/v1/files/:fileId/manifest",
    params: { fileId },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-floe-metadata-source"], "sui");
  assert.equal(res.headers["x-floe-postgres-state"], "degraded");
  assert.equal(res.headers["cache-control"], "public, max-age=31536000, immutable");
});

test("stream routes expose metadata source headers", async () => {
  process.env.DATABASE_URL = "postgres://127.0.0.1:5432/floe";
  postgresModule.setPostgresForTests(
    {
      async query() {
        return {
          rows: [
            {
              file_id: "0x6666666666666666666666666666666666666666666666666666666666666666",
              blob_id: "blob-4",
              owner_address: "0x4444444444444444444444444444444444444444444444444444444444444444",
              size_bytes: 256,
              mime_type: "video/mp4",
              walrus_end_epoch: 31,
              created_at_ms: 1700000000300,
            },
          ],
        };
      },
      async end() {},
    },
    true,
  );

  const app = await createRouteApp();
  const fileId = "0x6666666666666666666666666666666666666666666666666666666666666666";

  // Set up matching walrus sample so the tee cache fill doesn't truncate
  walrusSamples.set(
    "blob-4",
    Uint8Array.from(new Array(256).fill(0).map((_, i) => i & 0xff)),
  );

  const getRes = await app.inject({
    method: "GET",
    url: `/v1/files/${fileId}/stream`,
    routePath: "/v1/files/:fileId/stream",
    params: { fileId },
  });
  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.headers["x-floe-metadata-source"], "postgres");
  assert.equal(getRes.headers["x-floe-postgres-state"], "healthy");

  // Drain the tee stream (if any) so the background cache write completes
  // before afterEach removes the tmp directory.
  if (getRes.payload instanceof Readable) {
    for await (const _ of getRes.payload) {
      // drain
    }
  }

  const headRes = await app.inject({
    method: "HEAD",
    url: `/v1/files/${fileId}/stream`,
    routePath: "/v1/files/:fileId/stream",
    params: { fileId },
  });
  assert.equal(headRes.statusCode, 200);
  assert.equal(headRes.headers["x-floe-metadata-source"], "memory");
  assert.equal(headRes.headers["x-floe-postgres-state"], "healthy");
});

test("chooseStreamReadPlan uses larger full reads and conservative ranged reads", () => {
  const smallFull = filesRouteModule.chooseStreamReadPlan({
    sizeBytes: 8 * 1024 * 1024,
    hasRangeHeader: false,
  });
  const largeFull = filesRouteModule.chooseStreamReadPlan({
    sizeBytes: 64 * 1024 * 1024,
    hasRangeHeader: false,
  });
  const ranged = filesRouteModule.chooseStreamReadPlan({
    sizeBytes: 2 * 1024 * 1024,
    hasRangeHeader: true,
  });

  assert.equal(smallFull.initialSegmentBytes, 8 * 1024 * 1024);
  assert.equal(largeFull.initialSegmentBytes, 32 * 1024 * 1024);
  assert.equal(ranged.initialSegmentBytes, 8 * 1024 * 1024);
});

test("shouldCacheFullObject caches only bounded small files", () => {
  assert.equal(streamCacheModule.shouldCacheFullObject(8 * 1024 * 1024), true);
  assert.equal(streamCacheModule.shouldCacheFullObject(64 * 1024 * 1024), false);
});

test("ensureCachedStreamRange persists exact bytes for a cached segment", async () => {
  const blobId = "range-cache-blob";
  walrusSamples.set(blobId, Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));

  const cachedPath = await streamCacheModule.ensureCachedStreamRange({
    blobId,
    start: 2,
    end: 6,
  });
  const bytes = await fs.readFile(cachedPath);

  assert.deepEqual([...bytes], [2, 3, 4, 5, 6]);
});

test("getCachedStreamPath evicts truncated full-cache files before they false-hit", async () => {
  const blobId = "full-cache-invalid";
  const manualPath = path.join(
    process.env.UPLOAD_TMP_DIR!,
    "_stream_cache",
    "full",
    `${blobId}.blob`,
  );
  await fs.mkdir(path.dirname(manualPath), { recursive: true });
  await fs.writeFile(manualPath, Buffer.from([0, 1, 2]));

  const resolved = await streamCacheModule.getCachedStreamPath(blobId, 6);

  assert.equal(resolved, null);
  assert.equal(await fs.stat(manualPath).catch(() => null), null);
});

test("stream route rejects invalid ranges with 416 and content-range size", async () => {
  await mockSuiFile({
    blob_id: "blob-invalid-range",
    size_bytes: "10",
  });
  walrusSamples.set("blob-invalid-range", Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));

  const app = await createRouteApp();
  const fileId = "0x8888888888888888888888888888888888888888888888888888888888888888";
  const res = await app.inject({
    method: "GET",
    url: `/v1/files/${fileId}/stream`,
    routePath: "/v1/files/:fileId/stream",
    params: { fileId },
    headers: { range: "bytes=20-30" },
  });

  assert.equal(res.statusCode, 416);
  assert.equal(res.headers["content-range"], "bytes */10");
  assert.equal(res.json().error.code, "INVALID_RANGE");
});

test("stream route serves suffix ranges", async () => {
  await mockSuiFile({
    blob_id: "blob-suffix-range",
    size_bytes: "10",
  });
  walrusSamples.set("blob-suffix-range", Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));

  const app = await createRouteApp();
  const fileId = "0x9999999999999999999999999999999999999999999999999999999999999999";
  const res = await app.inject({
    method: "GET",
    url: `/v1/files/${fileId}/stream`,
    routePath: "/v1/files/:fileId/stream",
    params: { fileId },
    headers: { range: "bytes=-3" },
  });

  assert.equal(res.statusCode, 206);
  assert.equal(res.headers["content-range"], "bytes 7-9/10");
  assert.equal(res.headers["content-length"], "3");
  assert.deepEqual(await readPayloadBytes(res.payload), [7, 8, 9]);
});

test("stream route serves open-ended ranges", async () => {
  await mockSuiFile({
    blob_id: "blob-open-range",
    size_bytes: "10",
  });
  walrusSamples.set("blob-open-range", Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));

  const app = await createRouteApp();
  const fileId = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const res = await app.inject({
    method: "GET",
    url: `/v1/files/${fileId}/stream`,
    routePath: "/v1/files/:fileId/stream",
    params: { fileId },
    headers: { range: "bytes=4-" },
  });

  assert.equal(res.statusCode, 206);
  assert.equal(res.headers["content-range"], "bytes 4-9/10");
  assert.equal(res.headers["content-length"], "6");
  assert.deepEqual(await readPayloadBytes(res.payload), [4, 5, 6, 7, 8, 9]);
});

test("head stream route reflects valid range headers without streaming a body", async () => {
  await mockSuiFile({
    blob_id: "blob-head-range",
    size_bytes: "10",
  });

  const app = await createRouteApp();
  const fileId = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const res = await app.inject({
    method: "HEAD",
    url: `/v1/files/${fileId}/stream`,
    routePath: "/v1/files/:fileId/stream",
    params: { fileId },
    headers: { range: "bytes=2-5" },
  });

  assert.equal(res.statusCode, 206);
  assert.equal(res.headers["content-range"], "bytes 2-5/10");
  assert.equal(res.headers["content-length"], "4");
  assert.equal((res.json() as any).payload, undefined);
});

test("metadata and manifest expose public streamUrl when configured", async () => {
  process.env.FLOE_PUBLIC_STREAM_BASE_URL = "https://cdn.example.com/floe/";
  suiModule.getSuiClient().getObject = async () => ({
    data: {
      type: "0x2::file::FileMeta",
      content: {
        dataType: "moveObject",
        fields: {
          blob_id: "blob-public-url",
          size_bytes: "128",
          mime: "video/mp4",
          created_at: "1700000000000",
          owner: "0x1111111111111111111111111111111111111111111111111111111111111111",
          walrus_end_epoch: "12",
        },
      },
    },
  });

  const app = await createRouteApp();
  const fileId = "0x7777777777777777777777777777777777777777777777777777777777777777";
  const metadataRes = await app.inject({
    method: "GET",
    url: `/v1/files/${fileId}/metadata`,
    routePath: "/v1/files/:fileId/metadata",
    params: { fileId },
  });
  const manifestRes = await app.inject({
    method: "GET",
    url: `/v1/files/${fileId}/manifest`,
    routePath: "/v1/files/:fileId/manifest",
    params: { fileId },
  });

  assert.equal(
    metadataRes.json().streamUrl,
    `https://cdn.example.com/floe/v1/files/${fileId}/stream`,
  );
  assert.equal(
    manifestRes.json().streamUrl,
    `https://cdn.example.com/floe/v1/files/${fileId}/stream`,
  );
});

test("metadata rejects authenticated keys missing files:read scope", async () => {
  await mockSuiFile();
  const app = await createRouteApp({
    async authorizeFileAccess() {
      return {
        allowed: false,
        code: "INSUFFICIENT_SCOPE",
        message: "API key is missing required scope: files:read",
      };
    },
  });

  const res = await app.inject({
    method: "GET",
    url: "/v1/files/0x2222222222222222222222222222222222222222222222222222222222222222/metadata",
    routePath: "/v1/files/:fileId/metadata",
    params: { fileId: "0x2222222222222222222222222222222222222222222222222222222222222222" },
  });
  const body = res.json() as any;

  assert.equal(res.statusCode, 403);
  assert.equal(body.error.code, "INSUFFICIENT_SCOPE");
  assert.equal(body.error.message.includes("files:read"), true);
});

test("metadata auth precheck rejects before file lookup", async () => {
  let suiLookups = 0;
  suiModule.getSuiClient().getObject = async () => {
    suiLookups += 1;
    return {
      data: {
        type: "0x2::file::FileMeta",
        content: {
          dataType: "moveObject",
          fields: buildFileFields(),
        },
      },
    };
  };

  const app = await createRouteApp({
    async authorizeFileAccess({ fileOwner }: { fileOwner?: string | null }) {
      if (!fileOwner) {
        return {
          allowed: false,
          code: "AUTH_REQUIRED",
          message: "Authenticated access is required",
        };
      }
      return { allowed: true };
    },
  });

  const fileId = "0x3333333333333333333333333333333333333333333333333333333333333333";
  const res = await app.inject({
    method: "GET",
    url: `/v1/files/${fileId}/metadata`,
    routePath: "/v1/files/:fileId/metadata",
    params: { fileId },
  });
  const body = res.json() as any;

  assert.equal(res.statusCode, 401);
  assert.equal(body.error.code, "AUTH_REQUIRED");
  assert.equal(suiLookups, 0);
  assert.equal(res.headers["cache-control"], undefined);
});

test("metadata owner mismatch is masked as file not found", async () => {
  await mockSuiFile();
  const app = await createRouteApp({
    async authorizeFileAccess({ fileOwner }: { fileOwner?: string | null }) {
      if (!fileOwner) {
        return { allowed: true };
      }
      return {
        allowed: false,
        code: "OWNER_MISMATCH",
        message: "File owner mismatch",
      };
    },
  });

  const fileId = "0x4444444444444444444444444444444444444444444444444444444444444444";
  const res = await app.inject({
    method: "GET",
    url: `/v1/files/${fileId}/metadata`,
    routePath: "/v1/files/:fileId/metadata",
    params: { fileId },
  });
  const body = res.json() as any;

  assert.equal(res.statusCode, 404);
  assert.equal(body.error.code, "FILE_NOT_FOUND");
});

test("metadata invalid metadata does not inherit public cache headers", async () => {
  await mockSuiFile({ size_bytes: "not-a-number" });
  const app = await createRouteApp();
  const fileId = "0x5555555555555555555555555555555555555555555555555555555555555556";
  const res = await app.inject({
    method: "GET",
    url: `/v1/files/${fileId}/metadata`,
    routePath: "/v1/files/:fileId/metadata",
    params: { fileId },
  });
  const body = res.json() as any;

  assert.equal(res.statusCode, 502);
  assert.equal(body.error.code, "INVALID_FILE_METADATA");
  assert.equal(res.headers["cache-control"], undefined);
});

test("metadata rejects move objects outside the trusted file package", async () => {
  suiModule.getSuiClient().getObject = async () => ({
    data: {
      type: "0x2::other::FileMeta",
      content: {
        dataType: "moveObject",
        fields: buildFileFields(),
      },
    },
  });
  const app = await createRouteApp();
  const fileId = "0x5555555555555555555555555555555555555555555555555555555555555557";
  const res = await app.inject({
    method: "GET",
    url: `/v1/files/${fileId}/metadata`,
    routePath: "/v1/files/:fileId/metadata",
    params: { fileId },
  });
  const body = res.json() as any;

  assert.equal(res.statusCode, 404);
  assert.equal(body.error.code, "FILE_NOT_FOUND");
});

test("stream auth denial does not inherit public cache headers", async () => {
  const app = await createRouteApp({
    async authorizeFileAccess({ fileOwner }: { fileOwner?: string | null }) {
      if (!fileOwner) {
        return {
          allowed: false,
          code: "AUTH_REQUIRED",
          message: "Authenticated access is required",
        };
      }
      return { allowed: true };
    },
  });

  const fileId = "0x6666666666666666666666666666666666666666666666666666666666666667";
  const res = await app.inject({
    method: "GET",
    url: `/v1/files/${fileId}/stream`,
    routePath: "/v1/files/:fileId/stream",
    params: { fileId },
  });
  const body = res.json() as any;

  assert.equal(res.statusCode, 401);
  assert.equal(body.error.code, "AUTH_REQUIRED");
  assert.equal(res.headers["cache-control"], undefined);
});

// ============================================================
// Tee cache fill tests
// ============================================================

test("teeCachedStreamBlob serves two concurrent consumers with one Walrus fetch", async () => {
  const blobId = "tee-concurrent-1";
  const sizeBytes = 100;
  const data = Uint8Array.from(new Array(sizeBytes).fill(0).map((_, i) => i & 0xff));
  walrusSamples.set(blobId, data);

  const preCount = walrusFetchCallCount;

  // Both consumers call teeCachedStreamBlob concurrently
  const [resultA, resultB] = await Promise.all([
    streamCacheModule.teeCachedStreamBlob({ blobId, sizeBytes }),
    streamCacheModule.teeCachedStreamBlob({ blobId, sizeBytes }),
  ]);

  // Both results should be "tee" (cache miss, concurrent session)
  assert.ok(resultA);
  assert.ok(resultB);
  assert.equal(resultA!.kind, "tee");
  assert.equal(resultB!.kind, "tee");

  // Both streams should yield the same correct data.
  // Draining the streams also implicitly waits for the background write
  // (cs.end() only fires after the write completes).
  const bytesA: number[] = [];
  for await (const chunk of (resultA as { kind: "tee"; stream: Readable }).stream) {
    bytesA.push(...(chunk as Uint8Array));
  }
  const bytesB: number[] = [];
  for await (const chunk of (resultB as { kind: "tee"; stream: Readable }).stream) {
    bytesB.push(...(chunk as Uint8Array));
  }

  // Exactly one Walrus fetch across both concurrent consumers
  assert.equal(walrusFetchCallCount - preCount, 1);

  assert.equal(bytesA.length, sizeBytes);
  assert.equal(bytesB.length, sizeBytes);
  assert.deepEqual(bytesA, bytesB);
  // Both should contain the correct data
  assert.equal(bytesA[0], 0);
  assert.equal(bytesA[sizeBytes - 1], (sizeBytes - 1) & 0xff);
});

test("teeCachedStreamBlob errors consumer on truncated Walrus response", async () => {
  const blobId = "tee-truncated";
  // Provide only 10 bytes but request 100
  walrusSamples.set(blobId, Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));

  const result = await streamCacheModule.teeCachedStreamBlob({
    blobId,
    sizeBytes: 100,
  });
  assert.ok(result);
  assert.equal(result!.kind, "tee");

  const stream = (result as { kind: "tee"; stream: Readable }).stream;
  const chunks: Uint8Array[] = [];
  let caughtError: Error | null = null;

  try {
    for await (const chunk of stream) {
      chunks.push(chunk as Uint8Array);
    }
  } catch (err) {
    caughtError = err instanceof Error ? err : new Error(String(err));
  }

  // The stream should have received the truncated data (10 bytes) but then
  // errored when the write detected truncation (expected 100, got 10).
  const totalBytes = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  assert.equal(totalBytes, 10);
  assert.ok(caughtError, "Stream should have errored due to truncation");
  assert.ok(
    caughtError!.message.includes("STREAM_CACHE_FULL_TRUNCATED"),
    `Expected truncation error, got: ${caughtError!.message}`,
  );
});

test("teeCachedStreamBlob returns cache_hit after tee completes", async () => {
  const blobId = "tee-then-cache";
  const sizeBytes = 50;
  const data = Uint8Array.from(new Array(sizeBytes).fill(0).map((_, i) => i & 0xff));
  walrusSamples.set(blobId, data);

  // First call: tee
  const first = await streamCacheModule.teeCachedStreamBlob({ blobId, sizeBytes });
  assert.ok(first);
  assert.equal(first!.kind, "tee");

  // Drain the tee stream to allow the write to complete
  const bytes: number[] = [];
  for await (const chunk of (first as { kind: "tee"; stream: Readable }).stream) {
    bytes.push(...(chunk as Uint8Array));
  }
  assert.equal(bytes.length, sizeBytes);

  // Second call: should be cache_hit (cache already filled)
  const second = await streamCacheModule.teeCachedStreamBlob({ blobId, sizeBytes });
  assert.ok(second);
  assert.equal(second!.kind, "cache_hit");
  // The cache path should be the blob's stream cache file
  assert.ok((second as { kind: "cache_hit"; cachePath: string }).cachePath.includes(blobId));
});

// ============================================================
// HTTP caching / conditional request tests
// ============================================================

test("stream conditional GET with matching If-None-Match returns 304 without Walrus fetch", async () => {
  await mockSuiFile({ blob_id: "blob-304-match" });
  const app = await createRouteApp();
  const fileId = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

  const preCount = walrusFetchCallCount;
  const res = await app.inject({
    method: "GET",
    url: `/v1/files/${fileId}/stream`,
    routePath: "/v1/files/:fileId/stream",
    params: { fileId },
    headers: { "if-none-match": "blob-304-match" },
  });

  assert.equal(res.statusCode, 304);
  // No body for 304
  const bodyBytes = await readPayloadBytes(res.payload);
  assert.equal(bodyBytes.length, 0);
  // Zero new fetch calls means checkWalrusBlobExists was never invoked
  assert.equal(walrusFetchCallCount - preCount, 0);
});

test("stream conditional GET with Range + matching If-Range returns 206", async () => {
  await mockSuiFile({
    blob_id: "blob-ifrange-match",
    size_bytes: "10",
  });
  walrusSamples.set(
    "blob-ifrange-match",
    Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
  );

  const app = await createRouteApp();
  const fileId = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
  const res = await app.inject({
    method: "GET",
    url: `/v1/files/${fileId}/stream`,
    routePath: "/v1/files/:fileId/stream",
    params: { fileId },
    headers: {
      range: "bytes=2-5",
      "if-range": "blob-ifrange-match",
    },
  });

  assert.equal(res.statusCode, 206);
  assert.equal(res.headers["content-range"], "bytes 2-5/10");
  assert.equal(res.headers["content-length"], "4");
  assert.deepEqual(await readPayloadBytes(res.payload), [2, 3, 4, 5]);
});

test("stream conditional GET with Range + stale If-Range falls through to full 200", async () => {
  await mockSuiFile({
    blob_id: "blob-ifrange-stale",
    size_bytes: "10",
  });
  walrusSamples.set(
    "blob-ifrange-stale",
    Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
  );

  const app = await createRouteApp();
  const fileId = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const res = await app.inject({
    method: "GET",
    url: `/v1/files/${fileId}/stream`,
    routePath: "/v1/files/:fileId/stream",
    params: { fileId },
    headers: {
      range: "bytes=2-5",
      "if-range": "stale-etag-value",
    },
  });

  // Stale If-Range → ignore Range, serve full 200
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-length"], "10");
  const bytes = await readPayloadBytes(res.payload);
  assert.equal(bytes.length, 10);
});

test("stream conditional GET with non-matching If-None-Match falls through to normal 200", async () => {
  await mockSuiFile({
    blob_id: "blob-304-miss",
    size_bytes: "10",
  });
  walrusSamples.set(
    "blob-304-miss",
    Uint8Array.from([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]),
  );

  const app = await createRouteApp();
  const fileId = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  const res = await app.inject({
    method: "GET",
    url: `/v1/files/${fileId}/stream`,
    routePath: "/v1/files/:fileId/stream",
    params: { fileId },
    headers: { "if-none-match": "non-matching-etag" },
  });

  // Non-matching If-None-Match → normal 200
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-length"], "10");
  const bytes = await readPayloadBytes(res.payload);
  assert.equal(bytes.length, 10);
});
