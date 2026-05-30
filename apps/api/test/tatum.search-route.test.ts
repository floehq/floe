import test from "node:test";
import assert from "node:assert/strict";

process.env.FLOE_NETWORK = "testnet";
process.env.SUI_PRIVATE_KEY = `[${new Array(32).fill(0).join(",")}]`;
process.env.SUI_PACKAGE_ID = "0x2";

const { createTatumSearchRoutes } = await import("../src/routes/tatum.js");

function createApp() {
  const handlers = new Map<string, (req: any, reply: any) => Promise<unknown> | unknown>();
  const app = {
    get(path: string, handler: (req: any, reply: any) => Promise<unknown> | unknown) {
      handlers.set(`GET ${path}`, handler);
    },
  } as any;

  return {
    app,
    async inject(params: {
      method: "GET";
      url: string;
      routePath?: string;
      query?: Record<string, string | undefined>;
    }) {
      const routePath = params.routePath ?? params.url;
      const handler = handlers.get(`${params.method} ${routePath}`);
      if (!handler) {
        throw new Error(`Route not registered: ${params.method} ${routePath}`);
      }
      const reply = {
        statusCode: 200,
        payload: undefined as unknown,
        code(statusCode: number) {
          this.statusCode = statusCode;
          return this;
        },
        send(payload: unknown) {
          this.payload = payload;
          return this;
        },
      };
      const req = {
        query: params.query ?? {},
        log: {
          error() {},
        },
      };
      const result = await handler(req, reply);
      const payload = reply.payload !== undefined ? reply.payload : result;
      return {
        statusCode: reply.statusCode,
        json() {
          return payload;
        },
      };
    },
  };
}

test("search route marks Tatum-backed owner queries", async () => {
  let searchCalls = 0;
  const { app, inject } = createApp();
  await createTatumSearchRoutes({
    async searchGlobalFiles(query) {
      searchCalls++;
      assert.equal(query.owner, "0xabc");
      assert.equal(query.limit, 12);
      return {
        data: [
          {
            objectId: "0x1",
            version: "1",
            digest: "digest",
            type: "0x2::file::FileMeta",
            owner: "0xabc",
            content: { blob_id: "blob-1" },
          },
        ],
        nextCursor: null,
        hasNextPage: false,
      };
    },
    async listDiscoveryFiles() {
      throw new Error("fallback should not be used");
    },
  })(app);

  const res = await inject({
    method: "GET",
    url: "/v1/search",
    routePath: "/v1/search",
    query: {
      owner: "0xabc",
      limit: "12",
    },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(searchCalls, 1);
  const body = res.json() as any;
  assert.equal(body.source, "tatum-gateway");
  assert.equal(body.rpcProvider, "tatum");
  assert.equal(body.data.length, 1);
});
