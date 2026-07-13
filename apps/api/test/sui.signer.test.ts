import test from "node:test";
import assert from "node:assert/strict";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { SuiClient } from "@mysten/sui/client";
import { EnvSuiSigner } from "../src/sui/sui.signer.js";

function makeKeypair(): Ed25519Keypair {
  return Ed25519Keypair.generate();
}

function mockClient(): SuiClient {
  let callCount = 0;
  return {
    getBalance: async (_owner: { owner: string }) => {
      callCount++;
      return {
        totalBalance: String(500_000_000n * BigInt(callCount)),
        coinType: "0x2::sui::SUI",
      } as any;
    },
    signAndExecuteTransaction: async () => ({}) as any,
    // @ts-expect-error: SuiClient has ~60 methods; only need getBalance + signAndExecuteTransaction
  } as SuiClient;
}

test("EnvSuiSigner - address matches keypair.getPublicKey().toSuiAddress()", () => {
  const kp = makeKeypair();
  const client = mockClient();
  const signer = new EnvSuiSigner(kp, client);
  assert.equal(signer.address, kp.getPublicKey().toSuiAddress());
});

test("EnvSuiSigner - signPersonalMessage produces byte-identical output to raw keypair", async () => {
  const kp = makeKeypair();
  const client = mockClient();
  const signer = new EnvSuiSigner(kp, client);

  const message = new TextEncoder().encode("hello-world");
  const signerResult = await signer.signPersonalMessage(message);
  const kpResult = await kp.signPersonalMessage(message);

  assert.equal(signerResult.bytes, kpResult.bytes);
  assert.equal(signerResult.signature, kpResult.signature);
});

test("EnvSuiSigner - signPersonalMessage produces deterministic output for same key and message", async () => {
  const kp = makeKeypair();
  const client = mockClient();
  const signer = new EnvSuiSigner(kp, client);

  const message = new TextEncoder().encode("deterministic-test");
  const result1 = await signer.signPersonalMessage(message);
  const result2 = await signer.signPersonalMessage(message);

  assert.equal(result1.bytes, result2.bytes);
  assert.equal(result1.signature, result2.signature);
});

test("EnvSuiSigner - getBalance has no internal caching", async () => {
  const kp = makeKeypair();
  // getBalance is called on the mock client twice — each returns a different value
  const client = mockClient();
  const signer = new EnvSuiSigner(kp, client);

  const bal1 = await signer.getBalance();
  const bal2 = await signer.getBalance();

  // The mock increments callCount and returns callCount * 500M each time
  assert.notEqual(bal1, bal2, "getBalance returned the same value twice — suggests caching");
  assert.ok(bal1 > 0n);
  assert.ok(bal2 > 0n);
});

test("EnvSuiSigner - getBalance returns positive bigint", async () => {
  const kp = makeKeypair();
  const client = mockClient();
  const signer = new EnvSuiSigner(kp, client);

  const bal = await signer.getBalance();
  assert.equal(typeof bal, "bigint");
  assert.ok(bal > 0n);
});
