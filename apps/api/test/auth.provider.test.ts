import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.FLOE_ACCESS_POLICY = "hybrid";
process.env.FLOE_AUTH_PROVIDER = "local";
process.env.FLOE_API_KEYS_JSON = JSON.stringify([
  {
    id: "upload-read-only",
    secret: "upload-read-only-secret",
    owner: "0x1111111111111111111111111111111111111111111111111111111111111111",
    scopes: ["uploads:read"],
    tier: "authenticated",
  },
  {
    id: "file-read-only",
    secret: "file-read-only-secret",
    owner: "0x1111111111111111111111111111111111111111111111111111111111111111",
    scopes: ["files:read"],
    tier: "authenticated",
  },
  {
    id: "all-access",
    secret: "all-access-secret",
    owner: "0x1111111111111111111111111111111111111111111111111111111111111111",
    scopes: ["*"],
    tier: "authenticated",
  },
]);

const { AuthModeConfig } = await import("../src/config/auth.config.ts");
const { AuthProviderConfig } = await import("../src/config/auth.config.ts");
const { AuthTokenConfig } = await import("../src/config/auth.config.ts");
const { AuthExternalConfig } = await import("../src/config/auth.config.ts");
const { AuthApiKeyConfig } = await import("../src/config/auth.config.ts");
const { createDefaultAuthProvider } = await import("../src/services/auth/auth.provider.ts");
const { signDelegatedAuthTokenForTests } = await import("../src/services/auth/auth.token.ts");
const { externalAuthTestHooks } = await import("../src/services/auth/auth.external.ts");

const provider = createDefaultAuthProvider();
const originalFetch = globalThis.fetch;

function makeReq(headers: Record<string, string> = {}) {
  return {
    headers,
    ip: "127.0.0.1",
  } as any;
}

afterEach(() => {
  (AuthModeConfig as any).mode = "hybrid";
  (AuthProviderConfig as any).kind = "local";
  (AuthTokenConfig as any).secret = undefined;
  (AuthExternalConfig as any).verifyUrl = undefined;
  (AuthExternalConfig as any).sharedSecret = undefined;
  (AuthExternalConfig as any).cacheTtlMs = 5000;
  (AuthApiKeyConfig as any).keys = JSON.parse(process.env.FLOE_API_KEYS_JSON!);
  globalThis.fetch = originalFetch;
  externalAuthTestHooks.resetCache();
});

test("upload routes require uploads:write for mutating actions", async () => {
  const req = makeReq({ "x-api-key": "upload-read-only-secret" });

  const result = await provider.authorizeUploadAccess({
    req,
    action: "create",
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "INSUFFICIENT_SCOPE");
});

test("upload status accepts uploads:read", async () => {
  const req = makeReq({ "x-api-key": "upload-read-only-secret" });

  const result = await provider.authorizeUploadAccess({
    req,
    action: "status",
  });

  assert.deepEqual(result, { allowed: true });
});

test("file reads require files:read", async () => {
  const req = makeReq({ "x-api-key": "upload-read-only-secret" });

  const result = await provider.authorizeFileAccess({
    req,
    action: "metadata",
    fileId: "0x2",
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "INSUFFICIENT_SCOPE");
});

test("hybrid mode keeps file reads public without an API key", async () => {
  const req = makeReq();

  const result = await provider.authorizeFileAccess({
    req,
    action: "metadata",
    fileId: "0x2",
  });

  assert.deepEqual(result, { allowed: true });
});

test("public mode allows unauthenticated upload mutations", async () => {
  (AuthModeConfig as any).mode = "public";
  const req = makeReq();

  const result = await provider.authorizeUploadAccess({
    req,
    action: "create",
  });

  assert.deepEqual(result, { allowed: true });
});

test("private mode still requires authentication for file reads", async () => {
  (AuthModeConfig as any).mode = "private";
  const req = makeReq();

  const result = await provider.authorizeFileAccess({
    req,
    action: "stream",
    fileId: "0x2",
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "AUTH_REQUIRED");
});

test("wildcard scopes retain full access", async () => {
  const req = makeReq({ "x-api-key": "all-access-secret" });

  const upload = await provider.authorizeUploadAccess({
    req,
    action: "cancel",
  });
  const file = await provider.authorizeFileAccess({
    req,
    action: "stream",
    fileId: "0x2",
  });

  assert.deepEqual(upload, { allowed: true });
  assert.deepEqual(file, { allowed: true });
});

test("none provider remains valid for public deployments", async () => {
  (AuthModeConfig as any).mode = "public";
  (AuthProviderConfig as any).kind = "none";

  const result = await provider.authorizeUploadAccess({
    req: makeReq(),
    action: "create",
  });

  assert.deepEqual(result, { allowed: true });
});

test("token provider accepts signed delegated bearer tokens", async () => {
  (AuthModeConfig as any).mode = "private";
  (AuthProviderConfig as any).kind = "token";
  (AuthTokenConfig as any).secret = "test-token-secret";
  const token = signDelegatedAuthTokenForTests(
    {
      sub: "user_123",
      subjectType: "user",
      scopes: ["uploads:read", "files:read"],
      tier: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 60,
    },
    "test-token-secret"
  );

  const result = await provider.authorizeUploadAccess({
    req: makeReq({ authorization: `Bearer ${token}` }),
    action: "status",
  });

  assert.deepEqual(result, { allowed: true });
});

test("ops access requires authenticated scope even in public mode", async () => {
  (AuthModeConfig as any).mode = "public";

  const result = await provider.authorizeOpsAccess({
    req: makeReq(),
    action: "upload_read",
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "AUTH_REQUIRED");
});

test("ops read accepts ops:read and admin:uploads scopes", async () => {
  (AuthApiKeyConfig as any).keys = [
    {
      id: "ops-reader",
      secret: "ops-reader-secret",
      scopes: ["ops:read"],
      tier: "authenticated",
    },
    {
      id: "uploads-admin",
      secret: "uploads-admin-secret",
      scopes: ["admin:uploads"],
      tier: "authenticated",
    },
  ];

  const opsReader = await provider.authorizeOpsAccess({
    req: makeReq({ "x-api-key": "ops-reader-secret" }),
    action: "upload_read",
  });
  const uploadsAdmin = await provider.authorizeOpsAccess({
    req: makeReq({ "x-api-key": "uploads-admin-secret" }),
    action: "upload_read",
  });

  assert.deepEqual(opsReader, { allowed: true });
  assert.deepEqual(uploadsAdmin, { allowed: true });
});

test("ops admin requires admin:uploads", async () => {
  (AuthApiKeyConfig as any).keys = [
    {
      id: "ops-reader",
      secret: "ops-reader-secret",
      scopes: ["ops:read"],
      tier: "authenticated",
    },
    {
      id: "uploads-admin",
      secret: "uploads-admin-secret",
      scopes: ["admin:uploads"],
      tier: "authenticated",
    },
  ];

  const opsReader = await provider.authorizeOpsAccess({
    req: makeReq({ "x-api-key": "ops-reader-secret" }),
    action: "upload_admin",
  });
  const uploadsAdmin = await provider.authorizeOpsAccess({
    req: makeReq({ "x-api-key": "uploads-admin-secret" }),
    action: "upload_admin",
  });

  assert.equal(opsReader.allowed, false);
  assert.equal(opsReader.code, "INSUFFICIENT_SCOPE");
  assert.deepEqual(uploadsAdmin, { allowed: true });
});

test("external provider fails closed for protected routes when verification fails", async () => {
  (AuthModeConfig as any).mode = "private";
  (AuthProviderConfig as any).kind = "external";
  (AuthExternalConfig as any).verifyUrl = "http://127.0.0.1:9/verify";
  (AuthExternalConfig as any).timeoutMs = 50;

  const result = await provider.authorizeUploadAccess({
    req: makeReq({ authorization: "Bearer external-credential" }),
    action: "create",
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "AUTH_REQUIRED");
});

test("external provider fails closed for revoked SaaS api keys on protected routes", async () => {
  (AuthModeConfig as any).mode = "private";
  (AuthProviderConfig as any).kind = "external";
  (AuthExternalConfig as any).verifyUrl = "https://auth.floe-private.test/verify";
  (AuthExternalConfig as any).sharedSecret = "shared-secret";
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        valid: false,
        subjectType: "api_key",
        subjectId: "unknown",
        orgId: "",
        projectId: "",
        scopes: [],
        tier: "unknown",
        reason: "revoked",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );

  const result = await provider.authorizeUploadAccess({
    req: makeReq({ "x-api-key": "fk_revoked_123" }),
    action: "create",
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "AUTH_REQUIRED");
});

test("token provider missing scope is denied by route authorization", async () => {
  (AuthModeConfig as any).mode = "private";
  (AuthProviderConfig as any).kind = "token";
  (AuthTokenConfig as any).secret = "test-token-secret";
  const token = signDelegatedAuthTokenForTests(
    {
      sub: "user_123",
      subjectType: "user",
      scopes: ["uploads:read"],
      tier: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 60,
    },
    "test-token-secret"
  );

  const result = await provider.authorizeFileAccess({
    req: makeReq({ authorization: `Bearer ${token}` }),
    action: "metadata",
    fileId: "0x2",
  });

  assert.equal(result.allowed, false);
  assert.equal(result.code, "INSUFFICIENT_SCOPE");
});
