import test, { afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

// ---------------------------------------------------------------------------
// Environment setup (must run before any module imports that read env)
// ---------------------------------------------------------------------------
process.env.FLOE_NETWORK = "testnet";
process.env.SUI_PRIVATE_KEY = `[${new Array(32).fill(0).join(",")}]`;
process.env.SUI_PACKAGE_ID = "0x2";
process.env.WALRUS_AGGREGATOR_URL = "http://127.0.0.1:1";
process.env.UPLOAD_TMP_DIR = "/tmp/floe-test-stream-route-abort";
process.env.FLOE_ENFORCE_UPLOAD_OWNER = "false";
process.env.FLOE_SUI_METADATA_FALLBACK = "true";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type FilesRouteModule = typeof import("../src/routes/files.ts") & {
  getBlobExistenceCacheForTests: () => Map<string, number>;
  getWalrusByteStreamForTests: () => (...args: never[]) => AsyncGenerator<Uint8Array>;
};
type SuiModule = typeof import("../src/state/sui.ts");
type ReadModelModule = typeof import("../src/services/files/file.read-model.ts");

let filesRouteModule: FilesRouteModule;
let suiModule: SuiModule;
let readModelModule: ReadModelModule;
let originalGetObject: (...args: never[]) => Promise<unknown>;
const walrusSamples = new Map<string, Uint8Array>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const noopLogger = {
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
        type: "0x2::file::FileMeta",
        fields: buildFileFields(fields),
      },
    },
  });
}

async function createRouteApp(customAuthProvider?: Record<string, unknown>) {
  const handlers = new Map<
    string,
    (req: Record<string, unknown>, reply: Record<string, unknown>) => Promise<unknown> | unknown
  >();
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
    route(definition: {
      method: string[];
      url: string;
      handler: (
        req: Record<string, unknown>,
        reply: Record<string, unknown>,
      ) => Promise<unknown> | unknown;
    }) {
      for (const method of definition.method) {
        handlers.set(`${method} ${definition.url}`, definition.handler);
      }
    },
  } as unknown as Record<string, unknown>;

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
      abortAfterMs?: number;
    }) {
      const routePath = params.routePath ?? params.url;
      const handler = handlers.get(`${params.method} ${routePath}`);
      if (!handler) {
        throw new Error(`Route not registered: ${params.method} ${routePath}`);
      }

      // Use real EventEmitters so abort/close events propagate.
      const reqRaw = new EventEmitter();
      const replyRaw = new EventEmitter();

      const reply = {
        statusCode: 200,
        headers: {} as Record<string, string>,
        payload: undefined as unknown,
        raw: replyRaw,
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
        type(_contentType: string) {
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
        log: noopLogger,
        childLogger: noopLogger,
        id: "test-req-1",
        authContext: { scopes: [] },
        server: { authProvider },
        raw: reqRaw,
      };

      // If abortAfterMs is specified, abort the reply.raw "close" after that delay.
      let abortTimer: ReturnType<typeof setTimeout> | undefined;
      if (params.abortAfterMs !== undefined) {
        abortTimer = setTimeout(() => {
          replyRaw.emit("close");
        }, params.abortAfterMs);
      }

      try {
        const result = await handler(req, reply);
        const payload = reply.payload !== undefined ? reply.payload : result;
        return {
          statusCode: reply.statusCode,
          headers: reply.headers,
          payload,
          json() {
            return payload;
          },
          _reqRaw: reqRaw,
          _replyRaw: replyRaw,
          _abortTimer: abortTimer,
        };
      } catch (err) {
        if (abortTimer) clearTimeout(abortTimer);
        throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test("stream route - HEAD request returns correct headers", async () => {
  await mockSuiFile({
    blob_id: "blob-head-test",
    size_bytes: "4096",
    mime: "video/mp4",
  });

  const app = await createRouteApp();
  const fileId = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const res = await app.inject({
    method: "HEAD",
    url: `/v1/files/${fileId}/stream`,
    routePath: "/v1/files/:fileId/stream",
    params: { fileId },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-length"], "4096");
  assert.equal(res.headers["content-type"], "video/mp4");
  assert.equal(res.headers["etag"], "blob-head-test");
  assert.equal(res.headers["accept-ranges"], "bytes");
});

test("stream route - HEAD request returns 206 for valid range", async () => {
  await mockSuiFile({
    blob_id: "blob-head-range",
    size_bytes: "100",
    mime: "application/octet-stream",
  });

  const app = await createRouteApp();
  const fileId = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const res = await app.inject({
    method: "HEAD",
    url: `/v1/files/${fileId}/stream`,
    routePath: "/v1/files/:fileId/stream",
    params: { fileId },
    headers: { range: "bytes=10-19" },
  });

  assert.equal(res.statusCode, 206);
  assert.equal(res.headers["content-length"], "10");
  assert.equal(res.headers["content-range"], "bytes 10-19/100");
  assert.equal(res.headers["accept-ranges"], "bytes");
  assert.equal(res.headers["etag"], "blob-head-range");
});

test("stream route - returns error for non-existent file", async () => {
  suiModule.getSuiClient().getObject = async () => ({
    data: null,
  });

  const app = await createRouteApp();
  const fileId = "0x1111111111111111111111111111111111111111111111111111111111111111";
  const res = await app.inject({
    method: "GET",
    url: `/v1/files/${fileId}/stream`,
    routePath: "/v1/files/:fileId/stream",
    params: { fileId },
  });

  assert.equal(res.statusCode, 404);
  const body = res.json() as Record<string, unknown>;
  assert.equal(body.error.code, "FILE_NOT_FOUND");
});

test("stream route - client abort does not crash server", async () => {
  const BLOB_DATA = new Uint8Array(4096);
  for (let i = 0; i < BLOB_DATA.length; i++) BLOB_DATA[i] = i & 0xff;

  walrusSamples.set("blob-abort-test", BLOB_DATA);
  await mockSuiFile({
    blob_id: "blob-abort-test",
    size_bytes: "4096",
    mime: "video/mp4",
  });

  // Override global fetch to simulate a slow Walrus aggregator.
  // Each call streams 64 bytes every 50 ms, so 4096 bytes takes ~3.2 s.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    // Only intercept Walrus blob requests; pass through everything else.
    if (!url.includes("/v1/blobs/")) {
      return originalFetch(input, init);
    }

    const blobId = decodeURIComponent(url.split("/").pop() ?? "");
    const body = walrusSamples.get(blobId) ?? BLOB_DATA;
    const requestHeaders =
      input instanceof Request ? input.headers : new Headers(init?.headers ?? undefined);
    const rangeHeader = requestHeaders.get("range");

    // Parse range for partial content support
    let start = 0;
    let end = body.byteLength - 1;
    let status = 200;
    if (rangeHeader) {
      const match = rangeHeader.match(/^bytes=(\d+)-(\d+)$/i);
      if (match) {
        start = Number(match[1]);
        end = Number(match[2]);
        status = 206;
      }
    }
    const slice = body.subarray(start, end + 1);

    // Stream the response slowly: push 64-byte chunks with delays.
    const chunkSize = 64;
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= slice.byteLength) {
          controller.close();
          return;
        }
        const chunkEnd = Math.min(offset + chunkSize, slice.byteLength);
        controller.enqueue(slice.subarray(offset, chunkEnd));
        offset = chunkEnd;
      },
    });

    const headers: Record<string, string> = {
      "content-length": String(slice.byteLength),
      "content-type": "video/mp4",
    };
    if (status === 206) {
      headers["content-range"] = `bytes ${start}-${end}/${body.byteLength}`;
    }

    return new Response(stream, { status, headers });
  }) as typeof fetch;

  let uncaughtError: Error | null = null;
  const onUncaughtException = (err: Error) => {
    uncaughtError = err;
  };
  process.on("uncaughtException", onUncaughtException);

  try {
    const app = await createRouteApp();
    const fileId = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    // Issue the stream request — abort after 200 ms (well before the
    // full 4096 bytes finish streaming).
    const res = await app.inject({
      method: "GET",
      url: `/v1/files/${fileId}/stream`,
      routePath: "/v1/files/:fileId/stream",
      params: { fileId },
      abortAfterMs: 200,
    });

    // The response should have started streaming (200 status, with a stream payload).
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "video/mp4");
    assert.equal(res.headers["content-length"], "4096");
    assert.equal(res.headers["etag"], "blob-abort-test");
    assert.equal(res.headers["accept-ranges"], "bytes");

    // The payload should be a Readable stream (the tee or segment stream).
    assert.ok(res.payload instanceof Readable, "Expected a Readable stream payload");

    // Read some bytes then abort (destroy) mid-stream.
    const reader = res.payload as Readable;
    let bytesRead = 0;
    for await (const chunk of reader) {
      bytesRead += (chunk as Uint8Array).byteLength;
      if (bytesRead >= 128) {
        // Abort mid-stream — destroy the readable to simulate client disconnect.
        reader.destroy();
        break;
      }
    }

    // Wait briefly for async abort handlers to settle.
    await new Promise((r) => setTimeout(r, 300));

    // The server process must NOT have crashed.
    assert.equal(uncaughtError, null, `Server crashed with uncaught exception: ${uncaughtError}`);

    // Verify the server is still functional by making a second request.
    const res2 = await app.inject({
      method: "HEAD",
      url: `/v1/files/${fileId}/stream`,
      routePath: "/v1/files/:fileId/stream",
      params: { fileId },
    });
    assert.equal(res2.statusCode, 200, "Server should still respond after aborted stream");
    assert.equal(res2.headers["content-length"], "4096");
  } finally {
    process.removeListener("uncaughtException", onUncaughtException);
    globalThis.fetch = originalFetch;
  }
});

test("stream route - abort during full-file tee cache does not crash server", async () => {
  const BLOB_DATA = new Uint8Array(1024);
  for (let i = 0; i < BLOB_DATA.length; i++) BLOB_DATA[i] = i & 0xff;

  walrusSamples.set("blob-abort-tee", BLOB_DATA);
  await mockSuiFile({
    blob_id: "blob-abort-tee",
    size_bytes: "1024",
    mime: "application/octet-stream",
  });

  // Slow fetch: 32 bytes per pull
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (!url.includes("/v1/blobs/")) {
      return originalFetch(input, init);
    }

    const blobId = decodeURIComponent(url.split("/").pop() ?? "");
    const body = walrusSamples.get(blobId) ?? BLOB_DATA;
    const requestHeaders =
      input instanceof Request ? input.headers : new Headers(init?.headers ?? undefined);
    const rangeHeader = requestHeaders.get("range");

    let start = 0;
    let end = body.byteLength - 1;
    let status = 200;
    if (rangeHeader) {
      const match = rangeHeader.match(/^bytes=(\d+)-(\d+)$/i);
      if (match) {
        start = Number(match[1]);
        end = Number(match[2]);
        status = 206;
      }
    }
    const slice = body.subarray(start, end + 1);

    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= slice.byteLength) {
          controller.close();
          return;
        }
        const chunkEnd = Math.min(offset + 32, slice.byteLength);
        controller.enqueue(slice.subarray(offset, chunkEnd));
        offset = chunkEnd;
      },
    });

    const headers: Record<string, string> = {
      "content-length": String(slice.byteLength),
      "content-type": "application/octet-stream",
    };
    if (status === 206) {
      headers["content-range"] = `bytes ${start}-${end}/${body.byteLength}`;
    }

    return new Response(stream, { status, headers });
  }) as typeof fetch;

  let uncaughtError: Error | null = null;
  const onUncaughtException = (err: Error) => {
    uncaughtError = err;
  };
  process.on("uncaughtException", onUncaughtException);

  try {
    const app = await createRouteApp();
    const fileId = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

    const res = await app.inject({
      method: "GET",
      url: `/v1/files/${fileId}/stream`,
      routePath: "/v1/files/:fileId/stream",
      params: { fileId },
      abortAfterMs: 100,
    });

    assert.equal(res.statusCode, 200);

    // Read a few bytes then destroy the stream.
    if (res.payload instanceof Readable) {
      let bytes = 0;
      for await (const chunk of res.payload) {
        bytes += (chunk as Uint8Array).byteLength;
        if (bytes >= 64) {
          (res.payload as Readable).destroy();
          break;
        }
      }
    }

    await new Promise((r) => setTimeout(r, 300));
    assert.equal(uncaughtError, null, `Server crashed: ${uncaughtError}`);

    // Confirm server still responds.
    const res2 = await app.inject({
      method: "HEAD",
      url: `/v1/files/${fileId}/stream`,
      routePath: "/v1/files/:fileId/stream",
      params: { fileId },
    });
    assert.equal(res2.statusCode, 200);
  } finally {
    process.removeListener("uncaughtException", onUncaughtException);
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
before(async () => {
  filesRouteModule = await import("../src/routes/files.ts");
  suiModule = await import("../src/state/sui.ts");
  readModelModule = await import("../src/services/files/file.read-model.ts");
  const client = suiModule.getSuiClient();
  originalGetObject = client.getObject.bind(client);

  // Set up a global fetch mock that serves from walrusSamples for blob requests.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (!url.includes("/v1/blobs/")) {
      return realFetch(input, init);
    }

    const blobId = decodeURIComponent(url.split("/").pop() ?? "");
    const body = walrusSamples.get(blobId) ?? Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
    const requestHeaders =
      input instanceof Request ? input.headers : new Headers(init?.headers ?? undefined);
    const rangeHeader = requestHeaders.get("range");

    let start = 0;
    let end = body.byteLength - 1;
    let status = 200;
    if (rangeHeader) {
      const match = rangeHeader.match(/^bytes=(\d+)-(\d+)$/i);
      if (match) {
        start = Number(match[1]);
        end = Number(match[2]);
        status = 206;
      }
    }
    const slice = body.subarray(start, end + 1);

    const headers: Record<string, string> = {
      "content-length": String(slice.byteLength),
    };
    if (status === 206) {
      headers["content-range"] = `bytes ${start}-${end}/${body.byteLength}`;
    }

    return new Response(slice, { status, headers });
  }) as typeof fetch;
});

afterEach(() => {
  suiModule.getSuiClient().getObject = originalGetObject;
  walrusSamples.clear();
  readModelModule.resetFileFieldsMemoryCacheForTests();
  filesRouteModule.getBlobExistenceCacheForTests().clear();
});
