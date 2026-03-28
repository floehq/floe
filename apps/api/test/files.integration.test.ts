import test, { afterEach, before } from "node:test";
import assert from "node:assert/strict";

process.env.FLOE_NETWORK = "testnet";
process.env.SUI_PRIVATE_KEY = `[${new Array(32).fill(0).join(",")}]`;
process.env.SUI_PACKAGE_ID = "0x2";
process.env.WALRUS_AGGREGATOR_URL = "http://127.0.0.1:1";
delete process.env.DATABASE_URL;

type FilesRouteModule = typeof import("../src/routes/files.ts");
type PostgresModule = typeof import("../src/state/postgres.ts");
type SuiModule = typeof import("../src/state/sui.ts");

let filesRouteModule: FilesRouteModule;
let postgresModule: PostgresModule;
let suiModule: SuiModule;
let originalGetObject: typeof suiModule.suiClient.getObject;

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

async function createRouteApp() {
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
  };
  const app = {
    get(path: string, handler: (req: any, reply: any) => Promise<unknown> | unknown) {
      handlers.set(`GET ${path}`, handler);
    },
    route(definition: { method: string[]; url: string; handler: (req: any, reply: any) => Promise<unknown> | unknown }) {
      for (const method of definition.method) {
        handlers.set(`${method} ${definition.url}`, definition.handler);
      }
    },
  } as any;

  await filesRouteModule.filesRoutes(app);

  return {
    async inject(params: {
      method: "GET" | "HEAD";
      url: string;
      routePath?: string;
      params?: Record<string, unknown>;
      query?: Record<string, unknown>;
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
  originalGetObject = suiModule.suiClient.getObject.bind(suiModule.suiClient);
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  postgresModule.setPostgresForTests(null, false);
  (suiModule.suiClient as any).getObject = originalGetObject;
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
    true
  );
  (suiModule.suiClient as any).getObject = async () => ({
    data: {
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
    true
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
    true
  );
  (suiModule.suiClient as any).getObject = async () => ({
    data: {
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
    true
  );

  const app = await createRouteApp();
  const fileId = "0x6666666666666666666666666666666666666666666666666666666666666666";

  const getRes = await app.inject({
    method: "GET",
    url: `/v1/files/${fileId}/stream`,
    routePath: "/v1/files/:fileId/stream",
    params: { fileId },
  });
  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.headers["x-floe-metadata-source"], "postgres");
  assert.equal(getRes.headers["x-floe-postgres-state"], "healthy");

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
