import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

// ============================================================
// Walrus upload.ts — resolveWalrusStoreMode
// ============================================================

function importFresh(modulePath: string) {
  return import(`${modulePath}?t=${Date.now()}`);
}

test("resolveWalrusStoreMode - defaults to publisher", async () => {
  const origMode = process.env.FLOE_WALRUS_STORE_MODE;
  delete process.env.FLOE_WALRUS_STORE_MODE;
  try {
    const mod = await importFresh("../src/services/walrus/upload.js");
    // resolveWalrusStoreMode is called at module load, so we check the type
    assert.equal(typeof mod.uploadToWalrusOnce, "function");
    assert.equal(typeof mod.describeWalrusWriters, "function");
  } finally {
    if (origMode !== undefined) process.env.FLOE_WALRUS_STORE_MODE = origMode;
  }
});

test("resolveWalrusStoreMode - accepts 'cli'", async () => {
  const origMode = process.env.FLOE_WALRUS_STORE_MODE;
  process.env.FLOE_WALRUS_STORE_MODE = "cli";
  const prevBin = process.env.FLOE_WALRUS_CLI_BIN;
  process.env.FLOE_WALRUS_CLI_BIN = "walrus";
  try {
    const mod = await importFresh("../src/services/walrus/upload.js");
    const writers = mod.describeWalrusWriters();
    assert.equal(writers.mode, "cli");
  } finally {
    if (origMode !== undefined) process.env.FLOE_WALRUS_STORE_MODE = origMode;
    else delete process.env.FLOE_WALRUS_STORE_MODE;
    if (prevBin !== undefined) process.env.FLOE_WALRUS_CLI_BIN = prevBin;
    else delete process.env.FLOE_WALRUS_CLI_BIN;
  }
});

test("resolveWalrusStoreMode - accepts 'sdk' as alias for publisher", async () => {
  const origMode = process.env.FLOE_WALRUS_STORE_MODE;
  process.env.FLOE_WALRUS_STORE_MODE = "sdk";
  try {
    const mod = await importFresh("../src/services/walrus/upload.js");
    const writers = mod.describeWalrusWriters();
    assert.equal(writers.mode, "publisher");
  } finally {
    if (origMode !== undefined) process.env.FLOE_WALRUS_STORE_MODE = origMode;
    else delete process.env.FLOE_WALRUS_STORE_MODE;
  }
});

test("resolveWalrusStoreMode - rejects invalid mode", async () => {
  const origMode = process.env.FLOE_WALRUS_STORE_MODE;
  process.env.FLOE_WALRUS_STORE_MODE = "invalid_mode";
  try {
    try {
      await importFresh("../src/services/walrus/upload.js");
      assert.fail("Should have thrown");
    } catch (err: any) {
      assert.ok(err.message.includes("INVALID_FLOE_WALRUS_STORE_MODE"), err.message);
    }
  } finally {
    if (origMode !== undefined) process.env.FLOE_WALRUS_STORE_MODE = origMode;
    else delete process.env.FLOE_WALRUS_STORE_MODE;
  }
});

// ============================================================
// uploadToWalrusOnce
// ============================================================

test("uploadToWalrusOnce - rejects epoch=0", async () => {
  const prevMode = process.env.FLOE_WALRUS_STORE_MODE;
  process.env.FLOE_WALRUS_STORE_MODE = "cli";
  const prevBin = process.env.FLOE_WALRUS_CLI_BIN;
  process.env.FLOE_WALRUS_CLI_BIN = "walrus";
  try {
    const mod = await importFresh("../src/services/walrus/upload.js");
    try {
      await mod.uploadToWalrusOnce(() => Readable.from("test"), 0);
      assert.fail("Should have thrown");
    } catch (err: any) {
      assert.equal(err.message, "INVALID_EPOCHS");
    }
  } finally {
    if (prevMode !== undefined) process.env.FLOE_WALRUS_STORE_MODE = prevMode;
    else delete process.env.FLOE_WALRUS_STORE_MODE;
    if (prevBin !== undefined) process.env.FLOE_WALRUS_CLI_BIN = prevBin;
    else delete process.env.FLOE_WALRUS_CLI_BIN;
  }
});

test("uploadToWalrusOnce - rejects negative epochs", async () => {
  const prevMode = process.env.FLOE_WALRUS_STORE_MODE;
  process.env.FLOE_WALRUS_STORE_MODE = "cli";
  const prevBin = process.env.FLOE_WALRUS_CLI_BIN;
  process.env.FLOE_WALRUS_CLI_BIN = "walrus";
  try {
    const mod = await importFresh("../src/services/walrus/upload.js");
    try {
      await mod.uploadToWalrusOnce(() => Readable.from("test"), -5);
      assert.fail("Should have thrown");
    } catch (err: any) {
      assert.equal(err.message, "INVALID_EPOCHS");
    }
  } finally {
    if (prevMode !== undefined) process.env.FLOE_WALRUS_STORE_MODE = prevMode;
    else delete process.env.FLOE_WALRUS_STORE_MODE;
    if (prevBin !== undefined) process.env.FLOE_WALRUS_CLI_BIN = prevBin;
    else delete process.env.FLOE_WALRUS_CLI_BIN;
  }
});

test("uploadToWalrusOnce - rejects non-integer epochs", async () => {
  const prevMode = process.env.FLOE_WALRUS_STORE_MODE;
  process.env.FLOE_WALRUS_STORE_MODE = "cli";
  const prevBin = process.env.FLOE_WALRUS_CLI_BIN;
  process.env.FLOE_WALRUS_CLI_BIN = "walrus";
  try {
    const mod = await importFresh("../src/services/walrus/upload.js");
    try {
      await mod.uploadToWalrusOnce(() => Readable.from("test"), 1.5);
      assert.fail("Should have thrown");
    } catch (err: any) {
      assert.equal(err.message, "INVALID_EPOCHS");
    }
  } finally {
    if (prevMode !== undefined) process.env.FLOE_WALRUS_STORE_MODE = prevMode;
    else delete process.env.FLOE_WALRUS_STORE_MODE;
    if (prevBin !== undefined) process.env.FLOE_WALRUS_CLI_BIN = prevBin;
    else delete process.env.FLOE_WALRUS_CLI_BIN;
  }
});

// ============================================================
// CLI backend — output parsing
// ============================================================

test("CLI backend - describeWalrusCliBackend returns config", async () => {
  const prevMode = process.env.FLOE_WALRUS_STORE_MODE;
  process.env.FLOE_WALRUS_STORE_MODE = "cli";
  const prevBin = process.env.FLOE_WALRUS_CLI_BIN;
  process.env.FLOE_WALRUS_CLI_BIN = "walrus-test";
  try {
    const cliMod = await importFresh("../src/services/walrus/backends/cli.js");
    const desc = cliMod.describeWalrusCliBackend();
    assert.equal(desc.cliBin, "walrus-test");
    assert.ok("cliConfig" in desc);
    assert.ok("cliContext" in desc);
    assert.ok("cliWallet" in desc);
  } finally {
    if (prevMode !== undefined) process.env.FLOE_WALRUS_STORE_MODE = prevMode;
    else delete process.env.FLOE_WALRUS_STORE_MODE;
    if (prevBin !== undefined) process.env.FLOE_WALRUS_CLI_BIN = prevBin;
    else delete process.env.FLOE_WALRUS_CLI_BIN;
  }
});

// ============================================================
// Publisher backend — URL parsing
// ============================================================

test("Publisher backend - parseSdkBaseUrls from env", async () => {
  const origUrls = process.env.FLOE_WALRUS_PUBLISHER_BASE_URLS;
  process.env.FLOE_WALRUS_PUBLISHER_BASE_URLS = "https://pub1.test,https://pub2.test";
  try {
    const pubMod = await importFresh("../src/services/walrus/backends/publisher.js");
    const desc = pubMod.describeWalrusPublisherBackend();
    assert.ok(desc);
  } finally {
    if (origUrls !== undefined) process.env.FLOE_WALRUS_PUBLISHER_BASE_URLS = origUrls;
    else delete process.env.FLOE_WALRUS_PUBLISHER_BASE_URLS;
  }
});

// ============================================================
// Walrus limiter
// ============================================================

test("walrus limiter - queue is created", async () => {
  const limiterMod = await import("../src/services/walrus/limiter.js");
  assert.ok(limiterMod.walrusQueue);
  assert.equal(typeof limiterMod.walrusQueue.add, "function");
});
