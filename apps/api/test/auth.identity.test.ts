import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

import { resolveRequestIdentity } from "../src/services/auth/auth.identity.ts";
import {
  AuthExternalConfig,
  AuthProviderConfig,
  AuthTokenConfig,
} from "../src/config/auth.config.ts";
import { signDelegatedAuthTokenForTests } from "../src/services/auth/auth.token.ts";
import { externalAuthTestHooks } from "../src/services/auth/auth.external.ts";

const originalFetch = globalThis.fetch;

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

afterEach(() => {
  (AuthProviderConfig as any).kind = "local";
  (AuthTokenConfig as any).secret = undefined;
  (AuthExternalConfig as any).verifyUrl = undefined;
  (AuthExternalConfig as any).sharedSecret = undefined;
  (AuthExternalConfig as any).authToken = undefined;
  (AuthExternalConfig as any).timeoutMs = 2000;
  (AuthExternalConfig as any).cacheTtlMs = 5000;
  globalThis.fetch = originalFetch;
  externalAuthTestHooks.resetCache();
});

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

test("authorization bearer takes precedence over x-api-key", async () => {
  (AuthProviderConfig as any).kind = "token";
  (AuthTokenConfig as any).secret = "identity-token-secret";
  const token = signDelegatedAuthTokenForTests(
    {
      sub: "svc_1",
      subjectType: "service",
      scopes: ["uploads:write"],
      tier: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 60,
    },
    "identity-token-secret"
  );

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: {
        authorization: `Bearer ${token}`,
        "x-api-key": "upload-read-only-secret",
      },
    });
    const body = res.json();

    assert.equal(body.provider, "token");
    assert.equal(body.credentialType, "bearer");
    assert.equal(body.subject, "service:svc_1");
  } finally {
    (AuthProviderConfig as any).kind = "local";
    (AuthTokenConfig as any).secret = undefined;
    await app.close();
  }
});

test("token provider rejects expired, malformed, and bad-signature tokens as public", async () => {
  (AuthProviderConfig as any).kind = "token";
  (AuthTokenConfig as any).secret = "identity-token-secret";
  const expired = signDelegatedAuthTokenForTests(
    {
      sub: "svc_1",
      subjectType: "service",
      scopes: ["uploads:write"],
      tier: "authenticated",
      exp: Math.floor(Date.now() / 1000) - 10,
    },
    "identity-token-secret"
  );
  const badSignature = `${expired.split(".")[0]}.bad-signature`;

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    for (const authorization of [`Bearer ${expired}`, "Bearer not-a-valid-token", `Bearer ${badSignature}`]) {
      const res = await app.inject({
        method: "GET",
        url: "/",
        headers: { authorization },
      });
      const body = res.json();
      assert.equal(body.authenticated, false);
      assert.equal(body.provider, "none");
    }
  } finally {
    (AuthProviderConfig as any).kind = "local";
    (AuthTokenConfig as any).secret = undefined;
    await app.close();
  }
});

test("external provider verifies remote normalized auth context and caches positive results", async () => {
  let verifyCalls = 0;
  const receivedRequests: Array<{ headers: Headers; body: string }> = [];
  (AuthProviderConfig as any).kind = "external";
  (AuthExternalConfig as any).verifyUrl = "https://auth.floe-private.test/verify";
  (AuthExternalConfig as any).sharedSecret = "shared-secret";
  (AuthExternalConfig as any).cacheTtlMs = 5_000;
  externalAuthTestHooks.resetCache();
  globalThis.fetch = async (input, init) => {
    verifyCalls += 1;
    receivedRequests.push({
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ""),
    });
    return new Response(
      JSON.stringify({
        valid: true,
        subjectType: "api_key",
        subjectId: "key_123",
        keyId: "key_123",
        orgId: "org_123",
        projectId: "proj_456",
        scopes: ["ops:read", "files:read"],
        tier: "pro",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const headers = { authorization: "Bearer external-credential" };
    const first = await app.inject({ method: "GET", url: "/", headers });
    const second = await app.inject({ method: "GET", url: "/", headers });

    assert.equal(first.json().provider, "external");
    assert.equal(first.json().subjectType, "api_key");
    assert.equal(first.json().keyId, "key_123");
    assert.equal(first.json().orgId, "org_123");
    assert.equal(first.json().projectId, "proj_456");
    assert.deepEqual(first.json().scopes, ["ops:read", "files:read"]);
    assert.equal(second.json().provider, "external");
    assert.equal(verifyCalls, 1);
    assert.equal(receivedRequests.length, 1);
    assert.equal(receivedRequests[0]?.headers.get("x-floe-shared-secret"), "shared-secret");
    assert.deepEqual(JSON.parse(receivedRequests[0]!.body), {
      delegatedToken: "external-credential",
    });
  } finally {
    await app.close();
  }
});

test("external provider accepts SaaS-issued api keys and propagates org, project, and scopes", async () => {
  const receivedRequests: Array<{ headers: Headers; body: string }> = [];
  (AuthProviderConfig as any).kind = "external";
  (AuthExternalConfig as any).verifyUrl = "https://auth.floe-private.test/verify";
  (AuthExternalConfig as any).sharedSecret = "shared-secret";
  globalThis.fetch = async (_input, init) => {
    receivedRequests.push({
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ""),
    });
    return new Response(
      JSON.stringify({
        valid: true,
        subjectType: "api_key",
        subjectId: "key_live_123",
        keyId: "key_live_123",
        orgId: "org_live",
        projectId: "project_live",
        scopes: ["uploads:write", "files:read"],
        ownerAddress: "team@acme.com",
        walletAddress: "0xabc",
        tier: "pro",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { "x-api-key": "fk_live_123" },
    });
    const body = res.json();
    assert.equal(body.provider, "external");
    assert.equal(body.subjectType, "api_key");
    assert.equal(body.subjectId, "key_live_123");
    assert.equal(body.keyId, "key_live_123");
    assert.equal(body.orgId, "org_live");
    assert.equal(body.projectId, "project_live");
    assert.deepEqual(body.scopes, ["uploads:write", "files:read"]);
    assert.equal(body.ownerAddress, "team@acme.com");
    assert.equal(body.walletAddress, "0xabc");
    assert.equal(body.credentialType, "api_key");
    assert.equal(body.tier, "authenticated");
    assert.equal(receivedRequests[0]?.headers.get("x-floe-shared-secret"), "shared-secret");
    assert.deepEqual(JSON.parse(receivedRequests[0]!.body), {
      apiKey: "fk_live_123",
    });
  } finally {
    await app.close();
  }
});

test("external provider treats revoked and invalid SaaS verifier responses as unauthenticated", async () => {
  const responses = [
    { valid: false, subjectType: "api_key", subjectId: "unknown", orgId: "", projectId: "", scopes: [], tier: "unknown", reason: "revoked" },
    { valid: false, subjectType: "api_key", subjectId: "unknown", orgId: "", projectId: "", scopes: [], tier: "unknown", reason: "invalid" },
  ];
  let callIndex = 0;
  (AuthProviderConfig as any).kind = "external";
  (AuthExternalConfig as any).verifyUrl = "https://auth.floe-private.test/verify";
  (AuthExternalConfig as any).sharedSecret = "shared-secret";
  globalThis.fetch = async () =>
    new Response(JSON.stringify(responses[callIndex++] ?? responses[responses.length - 1]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    for (const headerValue of ["revoked-key", "invalid-key"]) {
      const res = await app.inject({
        method: "GET",
        url: "/",
        headers: { "x-api-key": headerValue },
      });
      const body = res.json();
      assert.equal(body.authenticated, false);
      assert.equal(body.provider, "none");
      assert.deepEqual(body.scopes, []);
    }
  } finally {
    await app.close();
  }
});

test("external provider treats malformed verifier payloads as unauthenticated", async () => {
  const responses = [
    { valid: true, subjectType: "service", scopes: ["files:read"] },
    { authenticated: true, subjectId: "", scopes: ["files:read"] },
    "not-an-object",
  ];
  let callIndex = 0;

  (AuthProviderConfig as any).kind = "external";
  (AuthExternalConfig as any).verifyUrl = "https://auth.floe-private.test/verify";
  globalThis.fetch = async () =>
    new Response(JSON.stringify(responses[callIndex++] ?? responses[responses.length - 1]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    for (const headerValue of ["bad-1", "bad-2", "bad-3"]) {
      const res = await app.inject({
        method: "GET",
        url: "/",
        headers: { authorization: `Bearer ${headerValue}` },
      });
      const body = res.json();
      assert.equal(body.authenticated, false);
      assert.equal(body.provider, "none");
    }
  } finally {
    await app.close();
  }
});

test("external provider does not cache credentials past verifier expiry", async () => {
  let verifyCalls = 0;
  (AuthProviderConfig as any).kind = "external";
  (AuthExternalConfig as any).verifyUrl = "https://auth.floe-private.test/verify";
  (AuthExternalConfig as any).cacheTtlMs = 60_000;
  globalThis.fetch = async () => {
    verifyCalls += 1;
    return new Response(
      JSON.stringify({
        valid: true,
        subjectType: "service",
        subjectId: `svc_${verifyCalls}`,
        scopes: ["files:read"],
        tier: "authenticated",
        expiresAt: new Date(Date.now() + 20).toISOString(),
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };

  const req = {
    headers: { authorization: "Bearer short-lived" },
    ip: "127.0.0.1",
  } as any;

  const first = await resolveRequestIdentity(req);
  assert.equal(first.subjectId, "svc_1");

  req.authContext = undefined;
  await new Promise((resolve) => setTimeout(resolve, 40));

  const second = await resolveRequestIdentity(req);
  assert.equal(second.subjectId, "svc_2");
  assert.equal(verifyCalls, 2);
});

test("resolveRequestIdentity memoizes external auth on the request", async () => {
  let verifyCalls = 0;
  (AuthProviderConfig as any).kind = "external";
  (AuthExternalConfig as any).verifyUrl = "https://auth.floe-private.test/verify";
  globalThis.fetch = async () => {
    verifyCalls += 1;
    return new Response(
      JSON.stringify({
        valid: true,
        subjectType: "service",
        subjectId: "svc_cached",
        scopes: ["files:read"],
        tier: "authenticated",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };

  const req = {
    headers: { authorization: "Bearer request-cached" },
    ip: "127.0.0.1",
  } as any;

  const first = await resolveRequestIdentity(req);
  const second = await resolveRequestIdentity(req);

  assert.equal(first.subject, "service:svc_cached");
  assert.equal(second.subject, "service:svc_cached");
  assert.equal(verifyCalls, 1);
});
