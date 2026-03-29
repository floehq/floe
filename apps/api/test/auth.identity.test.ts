import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

import { resolveRequestIdentity } from "../src/services/auth/auth.identity.ts";

async function injectIdentity(trustProxy: boolean) {
  const app = Fastify({ trustProxy });
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      remoteAddress: "10.0.0.5",
      headers: {
        "x-forwarded-for": "198.51.100.10",
      },
    });
    return res.json();
  } finally {
    await app.close();
  }
}

test("public identity ignores x-forwarded-for when proxy trust is disabled", async () => {
  const body = await injectIdentity(false);

  assert.equal(body.authenticated, false);
  assert.equal(body.method, "public");
  assert.equal(body.subject, "public:10.0.0.5");
});

test("public identity uses x-forwarded-for when proxy trust is enabled", async () => {
  const body = await injectIdentity(true);

  assert.equal(body.authenticated, false);
  assert.equal(body.method, "public");
  assert.equal(body.subject, "public:198.51.100.10");
});
