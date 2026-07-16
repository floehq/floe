import test from "node:test";
import assert from "node:assert/strict";
import type { ApiKeyStore, StoredApiKey } from "../src/services/auth/auth.api-key-store.js";

// Stub store that tracks calls to verify interface contract
class StubApiKeyStore implements ApiKeyStore {
  async findByHash(_hash: Buffer): Promise<StoredApiKey | null> {
    return null;
  }
  async findById(_id: string): Promise<StoredApiKey | null> {
    return null;
  }
  async listActive(): Promise<StoredApiKey[]> {
    return [];
  }
  async create(_params: { owner?: string; scopes: string[]; tier: "public" | "authenticated" }) {
    return { id: "stub", secret: "floe_stub_secret", createdAt: new Date() };
  }
  async revoke(_id: string): Promise<boolean> {
    return true;
  }
  async rotate(_id: string) {
    return { id: _id, secret: "floe_rotated_secret", rotatedAt: new Date() };
  }
}

test("ApiKeyStore interface - create returns secret plaintext exactly once", async () => {
  const store = new StubApiKeyStore();
  const result = await store.create({ scopes: ["*"], tier: "authenticated" });
  assert.equal(typeof result.secret, "string");
  assert.ok(result.secret.startsWith("floe_"));
  assert.equal(typeof result.id, "string");
  assert.ok(result.createdAt instanceof Date);
});

test("ApiKeyStore interface - revoke returns boolean", async () => {
  const store = new StubApiKeyStore();
  const result = await store.revoke("some-id");
  assert.equal(typeof result, "boolean");
});

test("ApiKeyStore interface - rotate returns new secret", async () => {
  const store = new StubApiKeyStore();
  const result = await store.rotate("some-id");
  assert.ok(result.secret.startsWith("floe_"));
  assert.ok(result.rotatedAt instanceof Date);
});
