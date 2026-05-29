import test, { afterEach, before } from "node:test";
import assert from "node:assert/strict";

process.env.FLOE_NETWORK = "testnet";
process.env.SUI_PRIVATE_KEY = `[${new Array(32).fill(0).join(",")}]`;
process.env.SUI_PACKAGE_ID = "0x2";
process.env.WALRUS_AGGREGATOR_URL = "http://127.0.0.1:1";
process.env.UPLOAD_TMP_DIR = "/tmp/floe-test-upload";
process.env.FLOE_PUBLIC_BASE_URL = "https://files.example";

type PostgresModule = typeof import("../src/state/postgres.ts");
type ViewRoutesModule = typeof import("../src/routes/view.ts");

let postgresModule: PostgresModule;
let viewRoutesModule: ViewRoutesModule;

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

async function createViewApp() {
  const handlers = new Map<string, (req: any, reply: any) => Promise<unknown> | unknown>();
  const app = {
    get(path: string, handler: (req: any, reply: any) => Promise<unknown> | unknown) {
      handlers.set(`GET ${path}`, handler);
    },
  } as any;

  await viewRoutesModule.default(app);

  return {
    async inject(params: { method: "GET"; url: string; params?: Record<string, unknown> }) {
      const handler = handlers.get(`${params.method} /files/:id`);
      if (!handler) {
        throw new Error("view route not registered");
      }

      const reply = {
        statusCode: 200,
        headers: {} as Record<string, string>,
        payload: undefined as unknown,
        status(statusCode: number) {
          this.statusCode = statusCode;
          return this;
        },
        type(value: string) {
          this.headers["content-type"] = value;
          return this;
        },
        send(payload?: unknown) {
          this.payload = payload;
          return this;
        },
      };
      const req = {
        params: params.params ?? {},
        hostname: "localhost",
        log,
      };
      const result = await handler(req, reply);
      const payload = reply.payload !== undefined ? reply.payload : result;
      return {
        statusCode: reply.statusCode,
        headers: reply.headers,
        payload,
        text() {
          return String(payload);
        },
      };
    },
  };
}

before(async () => {
  postgresModule = await import("../src/state/postgres.ts");
  viewRoutesModule = await import("../src/routes/view.ts");
});

afterEach(() => {
  postgresModule.setPostgresForTests(null, false);
});

test("file view escapes untrusted metadata in html", async () => {
  postgresModule.setPostgresForTests(
    {
      async query() {
        return {
          rows: [
            {
              file_id: "0x1111111111111111111111111111111111111111111111111111111111111111",
              blob_id: "blob-danger",
              blob_object_id: "0x2222222222222222222222222222222222222222222222222222222222222222",
              filename: `<script>alert('x')</script>`,
              checksum: null,
              owner_address: "0x3333333333333333333333333333333333333333333333333333333333333333",
              size_bytes: 1024,
              mime_type: `image/svg+xml" onload="alert(1)`,
              walrus_end_epoch: 10,
              target_chain: `base<script>`,
              anchor_tx_id: `0xdeadbeef<script>`,
              created_at_ms: 1700000000000,
            },
          ],
        };
      },
      async end() {},
    },
    true
  );

  const app = await createViewApp();
  const res = await app.inject({
    method: "GET",
    url: "/files/blob-danger",
    params: { id: "blob-danger" },
  });
  const html = res.text();

  assert.equal(res.statusCode, 200);
  assert.equal(html.includes("<script>alert('x')</script>"), false);
  assert.equal(html.includes("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"), true);
  assert.equal(html.includes(`mime_type`), false);
  assert.equal(html.includes(`image/svg+xml&quot; onload=&quot;alert(1)`), true);
  assert.equal(html.includes(`base&lt;script&gt;`), true);
  assert.equal(html.includes(`0xdeadbeef&lt;script&gt;`), true);
});
