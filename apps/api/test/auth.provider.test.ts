import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.FLOE_AUTH_MODE = "hybrid";
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
const { createDefaultAuthProvider } = await import("../src/services/auth/auth.provider.ts");

const provider = createDefaultAuthProvider();

function makeReq(headers: Record<string, string> = {}) {
  return {
    headers,
    ip: "127.0.0.1",
  } as any;
}

afterEach(() => {
  (AuthModeConfig as any).mode = "hybrid";
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
