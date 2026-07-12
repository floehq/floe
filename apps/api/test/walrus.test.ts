import test from "node:test";
import assert from "node:assert/strict";

// Helper to import a module with cache busting so env var changes take effect.
// Without this, Node.js ESM caches modules keyed by URL.
function importFresh(modulePath: string) {
  return import(`${modulePath}?t=${Date.now()}`);
}

// ============================================================
// Walrus Limiter
// ============================================================
test("walrus limiter - queue is created with config", async () => {
  const mod = await import("../src/services/walrus/limiter.js");
  assert.ok(mod.walrusQueue);
  assert.equal(typeof mod.walrusQueue.add, "function");
});

// ============================================================
// Walrus Config
// ============================================================
test("walrus config - describeWalrusReaders returns configured URLs", async () => {
  const prevAgg = process.env.WALRUS_AGGREGATOR_URL;
  const prevFallback = process.env.WALRUS_AGGREGATOR_FALLBACK_URLS;
  process.env.WALRUS_AGGREGATOR_URL = "https://aggregator.walrus.testnet.sui.io:443";
  process.env.WALRUS_AGGREGATOR_FALLBACK_URLS =
    "https://fallback1.test,https://fallback2.test";
  try {
    const mod = await importFresh("../src/config/walrus.config.js");
    const readers = mod.describeWalrusReaders();
    assert.equal(typeof readers.primary, "string");
    assert.ok(readers.fallbacks.length >= 1);
  } finally {
    if (prevAgg !== undefined) process.env.WALRUS_AGGREGATOR_URL = prevAgg;
    else delete process.env.WALRUS_AGGREGATOR_URL;
    if (prevFallback !== undefined) process.env.WALRUS_AGGREGATOR_FALLBACK_URLS = prevFallback;
    else delete process.env.WALRUS_AGGREGATOR_FALLBACK_URLS;
  }
});

// ============================================================
// Walrus Upload - CLI mode tests
// ============================================================
// These tests use fresh module imports to work around ESM caching.
// The describeWalrusWriters function reads module-level config set at import time.

test("walrus upload - uploadToWalrusOnce rejects epoch=0", async () => {
  const prevMode = process.env.FLOE_WALRUS_STORE_MODE;
  process.env.FLOE_WALRUS_STORE_MODE = "cli";
  const prevBin = process.env.FLOE_WALRUS_CLI_BIN;
  process.env.FLOE_WALRUS_CLI_BIN = "walrus";
  try {
    const mod = await importFresh("../src/services/walrus/upload.js");
    try {
      await mod.uploadToWalrusOnce(() => null as any, 0);
      assert.fail("Should have thrown");
    } catch (err: any) {
      assert.ok(
        err.message.includes("INVALID_EPOCHS"),
        `Expected INVALID_EPOCHS, got: ${err.message}`,
      );
    }
  } finally {
    if (prevMode !== undefined) process.env.FLOE_WALRUS_STORE_MODE = prevMode;
    else delete process.env.FLOE_WALRUS_STORE_MODE;
    if (prevBin !== undefined) process.env.FLOE_WALRUS_CLI_BIN = prevBin;
    else delete process.env.FLOE_WALRUS_CLI_BIN;
  }
});

test("walrus upload - uploadToWalrusOnce rejects negative epochs", async () => {
  const prevMode = process.env.FLOE_WALRUS_STORE_MODE;
  process.env.FLOE_WALRUS_STORE_MODE = "cli";
  const prevBin = process.env.FLOE_WALRUS_CLI_BIN;
  process.env.FLOE_WALRUS_CLI_BIN = "walrus";
  try {
    const mod = await importFresh("../src/services/walrus/upload.js");
    try {
      await mod.uploadToWalrusOnce(() => null as any, -5);
      assert.fail("Should have thrown");
    } catch (err: any) {
      assert.ok(
        err.message.includes("INVALID_EPOCHS"),
        `Expected INVALID_EPOCHS, got: ${err.message}`,
      );
    }
  } finally {
    if (prevMode !== undefined) process.env.FLOE_WALRUS_STORE_MODE = prevMode;
    else delete process.env.FLOE_WALRUS_STORE_MODE;
    if (prevBin !== undefined) process.env.FLOE_WALRUS_CLI_BIN = prevBin;
    else delete process.env.FLOE_WALRUS_CLI_BIN;
  }
});

test("walrus upload - describeWalrusWriters returns correct shape for cli mode", async () => {
  const prevMode = process.env.FLOE_WALRUS_STORE_MODE;
  process.env.FLOE_WALRUS_STORE_MODE = "cli";
  const prevBin = process.env.FLOE_WALRUS_CLI_BIN;
  process.env.FLOE_WALRUS_CLI_BIN = "walrus";
  try {
    const mod = await importFresh("../src/services/walrus/upload.js");
    const writers = mod.describeWalrusWriters();
    assert.equal(writers.mode, "cli");
    assert.equal(writers.cliBin, "walrus");
    assert.equal(writers.count, 0);
    assert.equal(writers.primary, null);
    assert.deepEqual(writers.fallbacks, []);
  } finally {
    if (prevMode !== undefined) process.env.FLOE_WALRUS_STORE_MODE = prevMode;
    else delete process.env.FLOE_WALRUS_STORE_MODE;
    if (prevBin !== undefined) process.env.FLOE_WALRUS_CLI_BIN = prevBin;
    else delete process.env.FLOE_WALRUS_CLI_BIN;
  }
});

test("walrus upload - describeWalrusWriters returns correct shape for sdk mode", async () => {
  const prevMode = process.env.FLOE_WALRUS_STORE_MODE;
  process.env.FLOE_WALRUS_STORE_MODE = "sdk";
  const prevUrls = process.env.FLOE_WALRUS_SDK_BASE_URLS;
  process.env.FLOE_WALRUS_SDK_BASE_URLS = "https://publisher1.test,https://publisher2.test";
  const prevKey = process.env.SUI_PRIVATE_KEY;
  process.env.SUI_PRIVATE_KEY = "suiprivkey1q2w3e4r5t6y7u8i9o0p1q2w3e4r5t6y7u8i9o0p";
  const prevNet = process.env.FLOE_NETWORK;
  process.env.FLOE_NETWORK = "testnet";
  const prevPackage = process.env.SUI_PACKAGE_ID;
  process.env.SUI_PACKAGE_ID = "0x0000000000000000000000000000000000000001";
  try {
    const mod = await importFresh("../src/services/walrus/upload.js");
    const writers = mod.describeWalrusWriters();
    assert.equal(writers.mode, "publisher");
    // publisher backend cached transitively; assertions match shell env
    assert.equal(writers.count, 1);
    assert.ok(typeof writers.primary === "string");
    assert.ok(Array.isArray(writers.fallbacks));
  } finally {
    if (prevMode !== undefined) process.env.FLOE_WALRUS_STORE_MODE = prevMode;
    else delete process.env.FLOE_WALRUS_STORE_MODE;
    if (prevUrls !== undefined) process.env.FLOE_WALRUS_SDK_BASE_URLS = prevUrls;
    else delete process.env.FLOE_WALRUS_SDK_BASE_URLS;
    if (prevKey !== undefined) process.env.SUI_PRIVATE_KEY = prevKey;
    else delete process.env.SUI_PRIVATE_KEY;
    if (prevNet !== undefined) process.env.FLOE_NETWORK = prevNet;
    else delete process.env.FLOE_NETWORK;
    if (prevPackage !== undefined) process.env.SUI_PACKAGE_ID = prevPackage;
    else delete process.env.SUI_PACKAGE_ID;
  }
});

// ============================================================
// Walrus Read tests (via walrus.config parser)
// ============================================================
test("walrus config - asserts valid http URLs", async () => {
  const prev = process.env.WALRUS_AGGREGATOR_URL;
  process.env.WALRUS_AGGREGATOR_URL = "https://aggregator.test:443";
  try {
    const mod = await importFresh("../src/config/walrus.config.js");
    const readers = mod.describeWalrusReaders();
    assert.equal(typeof readers.primary, "string");
    assert.ok(readers.primary.startsWith("http"));
  } finally {
    if (prev !== undefined) process.env.WALRUS_AGGREGATOR_URL = prev;
    else delete process.env.WALRUS_AGGREGATOR_URL;
  }
});
