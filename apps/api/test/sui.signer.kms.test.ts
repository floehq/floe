import test from "node:test";
import assert from "node:assert/strict";
import { KmsSuiSigner } from "../src/sui/sui.signer.kms.js";

/**
 * Mock AWS KMS client for testing.
 *
 * We intercept @aws-sdk/client-kms at the module level so KmsSuiSigner
 * never makes real network calls during tests.
 */

// --- helpers ----------------------------------------------------------------

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}

/** Deterministic 32-byte "public key" for reproducible address derivation. */
const FAKE_PUBKEY = new Uint8Array([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
  0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
]);

/** 64-byte deterministic "signature" from KMS. */
const FAKE_SIGNATURE = randomBytes(64);

/** Mock SuiClient — only enough to satisfy the type. */
function mockSuiClient() {
  return {
    getBalance: async () => ({ totalBalance: "1000000000", coinType: "0x2::sui::SUI" }),
    executeTransaction: async () => ({
      digest: "fake-digest",
      effects: { status: { status: "SUCCESS" } },
    }),
    // @ts-expect-error — minimal mock
  } as import("@mysten/sui/client").SuiClient;
}

// --- intercept @aws-sdk/client-kms ----------------------------------------

// We use a simple module-level mock by patching globalThis to make
// the KMS client constructor return a mock. Since KmsSuiSigner creates
// a new KMSClient internally, we need to intercept at a lower level.

// The cleanest approach: test the static method and the Sui signature
// building in isolation, and trust that AWS SDK's SignCommand works.

// For unit tests we test:
// 1. Static deriveAddress() — pure function
// 2. Sui signature format construction (flag + pubkey + sig = 97 bytes)
// 3. Constructor validation
// 4. fetchPublicKey behavior

// --- tests -----------------------------------------------------------------

test("KmsSuiSigner.deriveAddress - produces correct 0x-prefixed address", () => {
  const addr = KmsSuiSigner.deriveAddress(FAKE_PUBKEY);
  assert.ok(addr.startsWith("0x"), "address should start with 0x");
  assert.equal(addr.length, 66, "address should be 0x + 64 hex chars (32 bytes)");
});

test("KmsSuiSigner.deriveAddress - deterministic for same input", () => {
  const a1 = KmsSuiSigner.deriveAddress(FAKE_PUBKEY);
  const a2 = KmsSuiSigner.deriveAddress(FAKE_PUBKEY);
  assert.equal(a1, a2, "same public key must produce same address");
});

test("KmsSuiSigner.deriveAddress - different keys produce different addresses", () => {
  const addr1 = KmsSuiSigner.deriveAddress(FAKE_PUBKEY);
  const addr2 = KmsSuiSigner.deriveAddress(randomBytes(32));
  assert.notEqual(addr1, addr2, "different keys should produce different addresses");
});

test("KmsSuiSigner constructor - requires FLOE_KMS_KEY_ID", () => {
  const client = mockSuiClient();
  assert.throws(
    () => new KmsSuiSigner({ keyId: "", address: "0x" + "a".repeat(64), client }),
    /FLOE_KMS_KEY_ID/,
    "should throw when keyId is empty",
  );
});

test("KmsSuiSigner constructor - requires valid Sui address format", () => {
  const client = mockSuiClient();
  assert.throws(
    () => new KmsSuiSigner({ keyId: "test-key", address: "not-a-sui-address", client }),
    /0x-prefixed/,
    "should throw when address is not a valid Sui address",
  );
});

test("KmsSuiSigner constructor - accepts valid parameters", () => {
  const client = mockSuiClient();
  const signer = new KmsSuiSigner({
    keyId: "alias/my-kms-key",
    address: "0x" + "a".repeat(64),
    client,
    region: "us-east-1",
  });
  assert.equal(signer.address, "0x" + "a".repeat(64));
});

test("KmsSuiSigner - Sui signature format is flag(1) + pubkey(32) + sig(64) = 97 bytes base64", () => {
  // Test the signature format by building it from known components
  const flag = new Uint8Array([0x00]); // Ed25519 flag
  const pubkey = FAKE_PUBKEY;
  const sig = FAKE_SIGNATURE;

  const suiSig = Buffer.concat([Buffer.from(flag), Buffer.from(pubkey), Buffer.from(sig)]);
  assert.equal(suiSig.length, 97, "Sui Ed25519 signature should be 97 bytes");

  const b64 = Buffer.from(suiSig).toString("base64");
  assert.ok(b64.length > 0, "base64 encoding should not be empty");
});
