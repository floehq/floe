import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

process.env.FLOE_ACCESS_POLICY = "hybrid";
process.env.FLOE_AUTH_PROVIDER = "local";
process.env.FLOE_API_KEY_STORE = "env";
process.env.FLOE_ENFORCE_UPLOAD_OWNER = "false";
process.env.FLOE_API_KEYS_JSON = JSON.stringify([
  {
    id: "upload-read-only",
    secret: "upload-read-only-secret",
    owner: "0x1111111111111111111111111111111111111111111111111111111111111111",
    scopes: ["uploads:read"],
    tier: "authenticated",
  },
  {
    id: "all-access",
    secret: "all-access-secret",
    owner: "0x1111111111111111111111111111111111111111111111111111111111111111",
    scopes: ["*"],
    tier: "authenticated",
  },
  {
    id: "mykeyid",
    secret: "floe_mykeyid_thisismysecretvalue",
    scopes: ["files:read"],
    tier: "authenticated",
  },
]);

const { resolveRequestIdentity } = await import("../src/services/auth/auth.identity.ts");
const { AuthApiKeyConfig, AuthExternalConfig, AuthProviderConfig, AuthTokenConfig } = await import(
  "../src/config/auth.config.ts"
);
const { signDelegatedAuthTokenForTests } = await import("../src/services/auth/auth.token.ts");
const { externalAuthTestHooks } = await import("../src/services/auth/auth.external.ts");

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
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "local";
  (AuthTokenConfig as Record<string, unknown>)["secret"] = undefined;
  (AuthTokenConfig as Record<string, unknown>)["issuer"] = undefined;
  (AuthTokenConfig as Record<string, unknown>)["audience"] = undefined;
  (AuthExternalConfig as Record<string, unknown>)["verifyUrl"] = undefined;
  (AuthExternalConfig as Record<string, unknown>)["sharedSecret"] = undefined;
  (AuthExternalConfig as Record<string, unknown>)["authToken"] = undefined;
  (AuthExternalConfig as Record<string, unknown>)["timeoutMs"] = 2000;
  (AuthExternalConfig as Record<string, unknown>)["cacheTtlMs"] = 5000;
  (AuthExternalConfig as Record<string, unknown>)["trustHeaders"] = false;
  (AuthExternalConfig as Record<string, unknown>)["defaultExpiresAt"] = undefined;
  (AuthApiKeyConfig as Record<string, unknown>)["keys"] = JSON.parse(
    process.env.FLOE_API_KEYS_JSON!,
  );
  globalThis.fetch = originalFetch;
  externalAuthTestHooks.resetCache();
});

// ---------------------------------------------------------------------------
// none provider
// ---------------------------------------------------------------------------

test("none provider returns public identity regardless of credentials", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "none";

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: {
        authorization: "Bearer some-token",
        "x-api-key": "all-access-secret",
      },
    });
    const body = res.json();
    assert.equal(body.authenticated, false);
    assert.equal(body.provider, "none");
    assert.equal(body.method, "public");
    assert.equal(body.tier, "public");
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// local provider
// ---------------------------------------------------------------------------

test("local provider resolves api key via x-api-key header", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "local";

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { "x-api-key": "upload-read-only-secret" },
    });
    const body = res.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.provider, "local");
    assert.equal(body.method, "api_key");
    assert.equal(body.subjectType, "api_key");
    assert.equal(body.subjectId, "upload-read-only");
    assert.equal(body.subject, "api_key:upload-read-only");
    assert.deepEqual(body.scopes, ["uploads:read"]);
    assert.equal(body.credentialType, "api_key");
  } finally {
    await app.close();
  }
});

test("local provider resolves bearer token credentials via authorization header", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "local";

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { authorization: "Bearer all-access-secret" },
    });
    const body = res.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.provider, "local");
    assert.equal(body.credentialType, "bearer");
    assert.equal(body.keyId, "all-access");
  } finally {
    await app.close();
  }
});

test("local provider falls back to public when no credentials are present", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "local";

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({ method: "GET", url: "/" });
    const body = res.json();
    assert.equal(body.authenticated, false);
    assert.equal(body.provider, "none");
    assert.equal(body.method, "public");
  } finally {
    await app.close();
  }
});

test("local provider falls back to public when API key is not found", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "local";

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { "x-api-key": "nonexistent-secret" },
    });
    const body = res.json();
    assert.equal(body.authenticated, false);
    assert.equal(body.provider, "none");
    assert.equal(body.method, "public");
  } finally {
    await app.close();
  }
});

test("local provider resolves floe_ formatted keys", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "local";

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { "x-api-key": "floe_mykeyid_thisismysecretvalue" },
    });
    const body = res.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.provider, "local");
    assert.equal(body.keyId, "mykeyid");
    assert.deepEqual(body.scopes, ["files:read"]);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// token provider
// ---------------------------------------------------------------------------

test("token provider resolves valid bearer tokens", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "token";
  (AuthTokenConfig as Record<string, unknown>)["secret"] = "identity-token-secret";
  const token = signDelegatedAuthTokenForTests(
    {
      sub: "user_42",
      subjectType: "user",
      scopes: ["uploads:read", "files:read"],
      tier: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 120,
    },
    "identity-token-secret",
  );

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.provider, "token");
    assert.equal(body.method, "token");
    assert.equal(body.subjectType, "user");
    assert.equal(body.subjectId, "user_42");
    assert.equal(body.subject, "user:user_42");
    assert.deepEqual(body.scopes, ["uploads:read", "files:read"]);
    assert.equal(body.credentialType, "bearer");
  } finally {
    await app.close();
  }
});

test("token provider defaults subjectType to user when not specified", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "token";
  (AuthTokenConfig as Record<string, unknown>)["secret"] = "identity-token-secret";
  const token = signDelegatedAuthTokenForTests(
    {
      sub: "subject_no_type",
      scopes: ["files:read"],
      tier: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 60,
    },
    "identity-token-secret",
  );

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json();
    assert.equal(body.subjectType, "user");
    assert.equal(body.subject, "user:subject_no_type");
  } finally {
    await app.close();
  }
});

test("token provider propagates keyId, orgId, projectId, ownerAddress, walletAddress", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "token";
  (AuthTokenConfig as Record<string, unknown>)["secret"] = "identity-token-secret";
  const token = signDelegatedAuthTokenForTests(
    {
      sub: "svc_full",
      subjectType: "service",
      keyId: "key_99",
      orgId: "org_abc",
      projectId: "proj_xyz",
      scopes: ["*"],
      ownerAddress: "0xaaa",
      walletAddress: "0xbbb",
      tier: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 60,
    },
    "identity-token-secret",
  );

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json();
    assert.equal(body.keyId, "key_99");
    assert.equal(body.orgId, "org_abc");
    assert.equal(body.projectId, "proj_xyz");
    assert.equal(body.ownerAddress, "0xaaa");
    assert.equal(body.owner, "0xaaa");
    assert.equal(body.walletAddress, "0xbbb");
  } finally {
    await app.close();
  }
});

test("token provider falls back to public when no credentials are present", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "token";
  (AuthTokenConfig as Record<string, unknown>)["secret"] = "identity-token-secret";

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({ method: "GET", url: "/" });
    const body = res.json();
    assert.equal(body.authenticated, false);
    assert.equal(body.provider, "none");
    assert.equal(body.method, "public");
  } finally {
    await app.close();
  }
});

test("token provider falls back to public when secret is not configured", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "token";
  (AuthTokenConfig as Record<string, unknown>)["secret"] = undefined;
  const token = signDelegatedAuthTokenForTests(
    {
      sub: "svc_no_secret",
      scopes: ["files:read"],
      tier: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 60,
    },
    "does-not-matter",
  );

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json();
    assert.equal(body.authenticated, false);
    assert.equal(body.provider, "none");
    assert.equal(body.method, "public");
  } finally {
    await app.close();
  }
});

test("token provider ignores x-api-key header and falls back to public", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "token";
  (AuthTokenConfig as Record<string, unknown>)["secret"] = "identity-token-secret";

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { "x-api-key": "all-access-secret" },
    });
    const body = res.json();
    assert.equal(body.authenticated, false);
    assert.equal(body.method, "public");
  } finally {
    await app.close();
  }
});

test("token provider rejects token with wrong signature as public", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "token";
  (AuthTokenConfig as Record<string, unknown>)["secret"] = "identity-token-secret";

  const tokenSignedWrong = signDelegatedAuthTokenForTests(
    {
      sub: "svc_wrong_sig",
      scopes: ["files:read"],
      tier: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 60,
    },
    "different-secret",
  );

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { authorization: `Bearer ${tokenSignedWrong}` },
    });
    const body = res.json();
    assert.equal(body.authenticated, false);
    assert.equal(body.provider, "none");
  } finally {
    await app.close();
  }
});

test("token provider rejects token with invalid subjectType", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "token";
  (AuthTokenConfig as Record<string, unknown>)["secret"] = "identity-token-secret";
  const token = signDelegatedAuthTokenForTests(
    {
      sub: "svc_invalid_type",
      subjectType: "invalid_type" as "user",
      scopes: ["files:read"],
      tier: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 60,
    },
    "identity-token-secret",
  );

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json();
    assert.equal(body.authenticated, false);
    assert.equal(body.provider, "none");
  } finally {
    await app.close();
  }
});

test("token provider rejects token with empty scopes as public", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "token";
  (AuthTokenConfig as Record<string, unknown>)["secret"] = "identity-token-secret";
  const token = signDelegatedAuthTokenForTests(
    {
      sub: "svc_empty_scopes",
      scopes: [],
      tier: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 60,
    },
    "identity-token-secret",
  );

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json();
    assert.equal(body.authenticated, false);
    assert.equal(body.provider, "none");
  } finally {
    await app.close();
  }
});

test("token provider rejects token with non-array scopes as public", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "token";
  (AuthTokenConfig as Record<string, unknown>)["secret"] = "identity-token-secret";
  const token = signDelegatedAuthTokenForTests(
    {
      sub: "svc_bad_scopes",
      scopes: "not-an-array" as unknown as string[],
      tier: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 60,
    },
    "identity-token-secret",
  );

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json();
    assert.equal(body.authenticated, false);
    assert.equal(body.provider, "none");
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// external provider
// ---------------------------------------------------------------------------

test("external provider verifies remote normalized auth context and caches positive results", async () => {
  let verifyCalls = 0;
  const receivedRequests: Array<{ headers: Headers; body: string }> = [];
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "external";
  (AuthExternalConfig as Record<string, unknown>)["verifyUrl"] =
    "https://auth.floe-private.test/verify";
  (AuthExternalConfig as Record<string, unknown>)["sharedSecret"] = "shared-secret";
  (AuthExternalConfig as Record<string, unknown>)["cacheTtlMs"] = 5_000;
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
      },
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
  (AuthProviderConfig as Record<string, unknown>).kind = "external";
  (AuthExternalConfig as Record<string, unknown>).verifyUrl =
    "https://auth.floe-private.test/verify";
  (AuthExternalConfig as Record<string, unknown>).sharedSecret = "shared-secret";
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
      },
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
    {
      valid: false,
      subjectType: "api_key",
      subjectId: "unknown",
      orgId: "",
      projectId: "",
      scopes: [],
      tier: "unknown",
      reason: "revoked",
    },
    {
      valid: false,
      subjectType: "api_key",
      subjectId: "unknown",
      orgId: "",
      projectId: "",
      scopes: [],
      tier: "unknown",
      reason: "invalid",
    },
  ];
  let callIndex = 0;
  (AuthProviderConfig as Record<string, unknown>).kind = "external";
  (AuthExternalConfig as Record<string, unknown>).verifyUrl =
    "https://auth.floe-private.test/verify";
  (AuthExternalConfig as Record<string, unknown>).sharedSecret = "shared-secret";
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

  (AuthProviderConfig as Record<string, unknown>).kind = "external";
  (AuthExternalConfig as Record<string, unknown>).verifyUrl =
    "https://auth.floe-private.test/verify";
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
  (AuthProviderConfig as Record<string, unknown>).kind = "external";
  (AuthExternalConfig as Record<string, unknown>).verifyUrl =
    "https://auth.floe-private.test/verify";
  (AuthExternalConfig as Record<string, unknown>).cacheTtlMs = 60_000;
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
      },
    );
  };

  const req = {
    headers: { authorization: "Bearer short-lived" },
    ip: "127.0.0.1",
  } as Record<string, unknown>;

  const first = await resolveRequestIdentity(req);
  assert.equal(first.subjectId, "svc_1");

  req.authContext = undefined;
  await new Promise((resolve) => setTimeout(resolve, 40));

  const second = await resolveRequestIdentity(req);
  assert.equal(second.subjectId, "svc_2");
  assert.equal(verifyCalls, 2);
});

test("external provider falls back to public when no credentials are present", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "external";
  (AuthExternalConfig as Record<string, unknown>)["verifyUrl"] =
    "https://auth.floe-private.test/verify";

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({ method: "GET", url: "/" });
    const body = res.json();
    assert.equal(body.authenticated, false);
    assert.equal(body.method, "public");
  } finally {
    await app.close();
  }
});

test("external provider falls back to public when verifyUrl is not configured", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "external";
  (AuthExternalConfig as Record<string, unknown>)["verifyUrl"] = undefined;

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { authorization: "Bearer some-credential" },
    });
    const body = res.json();
    assert.equal(body.authenticated, false);
    assert.equal(body.method, "public");
  } finally {
    await app.close();
  }
});

test("external provider falls back to public on non-200 verifier response", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "external";
  (AuthExternalConfig as Record<string, unknown>)["verifyUrl"] =
    "https://auth.floe-private.test/verify";
  globalThis.fetch = async () => new Response("Internal Server Error", { status: 500 });

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { authorization: "Bearer some-credential" },
    });
    const body = res.json();
    assert.equal(body.authenticated, false);
    assert.equal(body.method, "public");
  } finally {
    await app.close();
  }
});

test("external provider falls back to public on network error", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "external";
  (AuthExternalConfig as Record<string, unknown>)["verifyUrl"] =
    "https://auth.floe-private.test/verify";
  (AuthExternalConfig as Record<string, unknown>)["timeoutMs"] = 200;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { authorization: "Bearer some-credential" },
    });
    const body = res.json();
    assert.equal(body.authenticated, false);
    assert.equal(body.method, "public");
  } finally {
    await app.close();
  }
});

test("external provider falls back to public on timeout", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "external";
  (AuthExternalConfig as Record<string, unknown>)["verifyUrl"] =
    "https://auth.floe-private.test/verify";
  (AuthExternalConfig as Record<string, unknown>)["timeoutMs"] = 1;
  globalThis.fetch = async (_url, init) => {
    const signal = init?.signal as AbortSignal | undefined;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const timer = setTimeout(() => {
        resolve(
          new Response(
            JSON.stringify({
              valid: true,
              subjectId: "svc",
              scopes: ["x"],
              tier: "authenticated",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }, 500);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  };

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { authorization: "Bearer slow-credential" },
    });
    const body = res.json();
    assert.equal(body.authenticated, false);
    assert.equal(body.method, "public");
  } finally {
    await app.close();
  }
});

test("external provider falls back to public when verifier returns non-JSON body", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "external";
  (AuthExternalConfig as Record<string, unknown>)["verifyUrl"] =
    "https://auth.floe-private.test/verify";
  globalThis.fetch = async () =>
    new Response("html error page", {
      status: 200,
      headers: { "content-type": "text/html" },
    });

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { authorization: "Bearer bad-content" },
    });
    const body = res.json();
    assert.equal(body.authenticated, false);
    assert.equal(body.method, "public");
  } finally {
    await app.close();
  }
});

test("external provider falls back to public when verifier returns already-expired credential", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "external";
  (AuthExternalConfig as Record<string, unknown>)["verifyUrl"] =
    "https://auth.floe-private.test/verify";
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        valid: true,
        subjectId: "svc_expired",
        scopes: ["files:read"],
        tier: "authenticated",
        expiresAt: new Date(Date.now() - 10_000).toISOString(),
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { authorization: "Bearer expired-cred" },
    });
    const body = res.json();
    assert.equal(body.authenticated, false);
    assert.equal(body.method, "public");
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// external provider: trustHeaders mode
// ---------------------------------------------------------------------------

test("external provider trustHeaders mode reads identity from x-floe-auth-* headers", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "external";
  (AuthExternalConfig as Record<string, unknown>)["trustHeaders"] = true;

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: {
        "x-floe-auth-subject-id": "trusted_user_123",
        "x-floe-auth-subject-type": "user",
        "x-floe-auth-key-id": "key_trust",
        "x-floe-auth-org-id": "org_trust",
        "x-floe-auth-project-id": "proj_trust",
        "x-floe-auth-scopes": "uploads:read,files:read",
        "x-floe-auth-tier": "authenticated",
        "x-floe-auth-expires-at": new Date(Date.now() + 60_000).toISOString(),
      },
    });
    const body = res.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.provider, "external");
    assert.equal(body.subjectId, "trusted_user_123");
    assert.equal(body.subjectType, "user");
    assert.equal(body.keyId, "key_trust");
    assert.equal(body.orgId, "org_trust");
    assert.equal(body.projectId, "proj_trust");
    assert.deepEqual(body.scopes, ["uploads:read", "files:read"]);
  } finally {
    await app.close();
  }
});

test("external provider trustHeaders falls back to public when subject-id is missing", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "external";
  (AuthExternalConfig as Record<string, unknown>)["trustHeaders"] = true;

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: {
        "x-floe-auth-scopes": "files:read",
      },
    });
    const body = res.json();
    assert.equal(body.authenticated, false);
    assert.equal(body.method, "public");
  } finally {
    await app.close();
  }
});

test("external provider trustHeaders falls back to public when expires-at is in the past", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "external";
  (AuthExternalConfig as Record<string, unknown>)["trustHeaders"] = true;

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: {
        "x-floe-auth-subject-id": "expired_trusted",
        "x-floe-auth-expires-at": new Date(Date.now() - 10_000).toISOString(),
      },
    });
    const body = res.json();
    assert.equal(body.authenticated, false);
    assert.equal(body.method, "public");
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// request memoization
// ---------------------------------------------------------------------------

test("resolveRequestIdentity memoizes result on the request object", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "local";

  const app = Fastify();
  app.get("/", async (req) => {
    const first = await resolveRequestIdentity(req);
    const second = await resolveRequestIdentity(req);
    return { first, second };
  });

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { "x-api-key": "upload-read-only-secret" },
    });
    const body = res.json();
    assert.equal(body.first.subjectId, body.second.subjectId);
    assert.equal(body.first.subject, body.second.subject);
  } finally {
    await app.close();
  }
});

test("resolveRequestIdentity memoizes external auth on the request", async () => {
  let verifyCalls = 0;
  (AuthProviderConfig as Record<string, unknown>).kind = "external";
  (AuthExternalConfig as Record<string, unknown>).verifyUrl =
    "https://auth.floe-private.test/verify";
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
      },
    );
  };

  const req = {
    headers: { authorization: "Bearer request-cached" },
    ip: "127.0.0.1",
  } as Record<string, unknown>;

  const first = await resolveRequestIdentity(req);
  const second = await resolveRequestIdentity(req);

  assert.equal(first.subject, "service:svc_cached");
  assert.equal(second.subject, "service:svc_cached");
  assert.equal(verifyCalls, 1);
});

// ---------------------------------------------------------------------------
// proxy trust + identity
// ---------------------------------------------------------------------------

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

test("public identity falls back to 'unknown' when IP is missing", async () => {
  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({ method: "GET", url: "/" });
    const body = res.json();
    assert.equal(body.authenticated, false);
    assert.equal(body.method, "public");
    assert.ok(body.subjectId);
    assert.equal(body.subject, `public:${body.subjectId}`);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// bearer precedence
// ---------------------------------------------------------------------------

test("authorization bearer takes precedence over x-api-key", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "token";
  (AuthTokenConfig as Record<string, unknown>)["secret"] = "identity-token-secret";
  const token = signDelegatedAuthTokenForTests(
    {
      sub: "svc_1",
      subjectType: "service",
      scopes: ["uploads:write"],
      tier: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 60,
    },
    "identity-token-secret",
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
    (AuthProviderConfig as Record<string, unknown>)["kind"] = "local";
    (AuthTokenConfig as Record<string, unknown>)["secret"] = undefined;
    await app.close();
  }
});

test("token provider rejects expired, malformed, and bad-signature tokens as public", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "token";
  (AuthTokenConfig as Record<string, unknown>)["secret"] = "identity-token-secret";
  const expired = signDelegatedAuthTokenForTests(
    {
      sub: "svc_1",
      subjectType: "service",
      scopes: ["uploads:write"],
      tier: "authenticated",
      exp: Math.floor(Date.now() / 1000) - 10,
    },
    "identity-token-secret",
  );
  const badSignature = `${expired.split(".")[0]}.bad-signature`;

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    for (const authorization of [
      `Bearer ${expired}`,
      "Bearer not-a-valid-token",
      `Bearer ${badSignature}`,
    ]) {
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
    (AuthProviderConfig as Record<string, unknown>)["kind"] = "local";
    (AuthTokenConfig as Record<string, unknown>)["secret"] = undefined;
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// unknown provider kind (default switch case)
// ---------------------------------------------------------------------------

test("unknown provider kind falls back to public identity", async () => {
  (AuthProviderConfig as Record<string, unknown>)["kind"] = "something_invalid";

  const app = Fastify();
  app.get("/", async (req) => resolveRequestIdentity(req));

  try {
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { "x-api-key": "all-access-secret" },
    });
    const body = res.json();
    assert.equal(body.authenticated, false);
    assert.equal(body.method, "public");
  } finally {
    (AuthProviderConfig as Record<string, unknown>)["kind"] = "local";
    await app.close();
  }
});
