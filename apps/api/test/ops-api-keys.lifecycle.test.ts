process.env.FLOE_API_KEY_STORE = "env";

import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { setApiKeyStore } from "../src/services/auth/auth.api-key.js";
import type { ApiKeyStore } from "../src/services/auth/auth.api-key-store.js";
import opsApiKeysRoutes from "../src/routes/ops-api-keys.js";

function mockStore(overrides: Partial<ApiKeyStore> = {}): ApiKeyStore {
  return {
    supportsLifecycle: true,
    async findByHash() {
      return null;
    },
    async findById() {
      return null;
    },
    async listActive() {
      return [];
    },
    async create() {
      return { id: "new-key", secret: "floe_new_secret", createdAt: new Date() };
    },
    async revoke() {
      return true;
    },
    async rotate() {
      return { id: "rotated", secret: "floe_rotated_secret", rotatedAt: new Date() };
    },
    ...overrides,
  };
}

async function buildApp(storeOverride?: ApiKeyStore) {
  const store = storeOverride ?? mockStore();
  setApiKeyStore(store);
  const app = Fastify({ logger: false });

  const authProvider = {
    async authorizeOpsAccess() {
      return { allowed: true as const };
    },
  };
  app.decorate("authProvider", authProvider);

  app.addHook("onRequest", async (req: Record<string, unknown>) => {
    (req as { childLogger: unknown }).childLogger = (req as { log: unknown }).log;
  });

  await app.register(opsApiKeysRoutes);
  return { app, store };
}

test.afterEach(() => {
  setApiKeyStore(null);
});

test("POST /ops/api-keys returns 400 when scopes is missing", async () => {
  const { app } = await buildApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/ops/api-keys",
      payload: { owner: "test-owner" },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.error.code, "INVALID_REQUEST_BODY");
    assert.ok(body.error.message.includes("scopes"));
  } finally {
    await app.close();
  }
});

test("POST /ops/api-keys returns 400 when scopes is empty array", async () => {
  const { app } = await buildApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/ops/api-keys",
      payload: { scopes: [] },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "INVALID_REQUEST_BODY");
  } finally {
    await app.close();
  }
});

test("POST /ops/api-keys returns 400 when scopes is not an array", async () => {
  const { app } = await buildApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/ops/api-keys",
      payload: { scopes: "uploads:write" },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "INVALID_REQUEST_BODY");
  } finally {
    await app.close();
  }
});

test("POST /ops/api-keys returns 400 when scopes contains no valid strings", async () => {
  const { app } = await buildApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/ops/api-keys",
      payload: { scopes: [123, null, true] },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "INVALID_REQUEST_BODY");
  } finally {
    await app.close();
  }
});

test("POST /ops/api-keys succeeds with valid scopes", async () => {
  const { app } = await buildApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/ops/api-keys",
      payload: { scopes: ["uploads:write", "files:read"] },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().id, "new-key");
    assert.deepEqual(res.json().scopes, ["uploads:write", "files:read"]);
  } finally {
    await app.close();
  }
});

test("POST /ops/api-keys returns 501 when store does not support lifecycle", async () => {
  const { app } = await buildApp(mockStore({ supportsLifecycle: false }));
  try {
    const res = await app.inject({
      method: "POST",
      url: "/ops/api-keys",
      payload: { scopes: ["*"] },
    });
    assert.equal(res.statusCode, 501);
    assert.equal(res.json().error.code, "DEPENDENCY_UNAVAILABLE");
    assert.ok(res.json().error.message.includes("FLOE_API_KEY_STORE=postgres"));
  } finally {
    await app.close();
  }
});

test("DELETE /ops/api-keys/:keyId returns 501 when store does not support lifecycle", async () => {
  const { app } = await buildApp(mockStore({ supportsLifecycle: false }));
  try {
    const res = await app.inject({
      method: "DELETE",
      url: "/ops/api-keys/some-key",
    });
    assert.equal(res.statusCode, 501);
    assert.equal(res.json().error.code, "DEPENDENCY_UNAVAILABLE");
  } finally {
    await app.close();
  }
});

test("POST /ops/api-keys/:keyId/rotate returns 501 when store does not support lifecycle", async () => {
  const { app } = await buildApp(mockStore({ supportsLifecycle: false }));
  try {
    const res = await app.inject({
      method: "POST",
      url: "/ops/api-keys/some-key/rotate",
    });
    assert.equal(res.statusCode, 501);
    assert.equal(res.json().error.code, "DEPENDENCY_UNAVAILABLE");
  } finally {
    await app.close();
  }
});

test("GET /ops/api-keys works regardless of supportsLifecycle flag", async () => {
  const { app } = await buildApp(
    mockStore({
      supportsLifecycle: false,
      async listActive() {
        return [
          {
            id: "env-key",
            secretHash: Buffer.alloc(32),
            scopes: ["*"],
            tier: "authenticated" as const,
          },
        ];
      },
    }),
  );
  try {
    const res = await app.inject({ method: "GET", url: "/ops/api-keys" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().count, 1);
    assert.equal(res.json().keys[0].id, "env-key");
  } finally {
    await app.close();
  }
});
