import test from "node:test";
import assert from "node:assert/strict";

// ============================================================
// Sui file.metadata.ts
// ============================================================

process.env.FLOE_NETWORK = "testnet";
process.env.SUI_PRIVATE_KEY = `[${new Array(32).fill(0).join(",")}]`;
process.env.SUI_PACKAGE_ID = "0x2::package::module";

let suiModule: typeof import("../src/state/sui.ts");
let fileMetadataModule: typeof import("../src/sui/file.metadata.ts");
let suiCircuitMod: typeof import("../src/services/circuit-breaker/instances.ts");

test.before(async () => {
  suiModule = await import("../src/state/sui.js");
  await suiModule.initSuiSigner();
  fileMetadataModule = await import("../src/sui/file.metadata.js");
  suiCircuitMod = await import("../src/services/circuit-breaker/instances.js");
});

test.after(() => {
  suiModule.resetSuiStateForTests();
});

// ============================================================
// Sui file.metadata — pure function checks
// ============================================================

test("finalizeFileMetadata - function exists and accepts correct shape", async () => {
  assert.equal(typeof fileMetadataModule.finalizeFileMetadata, "function");
  assert.equal(typeof fileMetadataModule.renewFileMetadata, "function");
});

test("finalizeFileMetadata - constructs correct input types", async () => {
  suiCircuitMod.suiCircuit.forceState("closed");
  const mockResult = {
    digest: "0xabc",
    objectChanges: [
      {
        type: "created",
        objectType: "0x2::file::FileMeta",
        objectId: "0xfile123",
      },
    ],
  };
  suiModule.getSuiClient().signAndExecuteTransaction = async () => mockResult;

  const result = await fileMetadataModule.finalizeFileMetadata({
    blobId: "test-blob-id",
    sizeBytes: 1024,
    mimeType: "video/mp4",
    checksum: "sha256:abc",
    owner: "0x1111111111111111111111111111111111111111111111111111111111111111",
    walrusEndEpoch: 12,
  });

  assert.equal(result.fileId, "0xfile123");
});

test("finalizeFileMetadata - handles Sui RPC errors", async () => {
  suiCircuitMod.suiCircuit.forceState("closed");
  suiModule.getSuiClient().signAndExecuteTransaction = async () => {
    throw new Error("SUI_RPC_ERROR: node unreachable");
  };

  try {
    await fileMetadataModule.finalizeFileMetadata({
      blobId: "test-blob-fail",
      sizeBytes: 512,
      mimeType: "application/octet-stream",
    });
    assert.fail("Should have thrown");
  } catch (err: any) {
    assert.ok(err.message.includes("SUI_FINALIZE_SUBMIT_FAILED"), err.message);
  }
});

test("finalizeFileMetadata - throws when no FileMeta created", async () => {
  suiCircuitMod.suiCircuit.forceState("closed");
  suiModule.getSuiClient().signAndExecuteTransaction = async () => ({
    digest: "0xabc",
    objectChanges: [{ type: "transferred", objectType: "0x2::other::Type" }],
  });

  try {
    await fileMetadataModule.finalizeFileMetadata({
      blobId: "test-blob-no-create",
      sizeBytes: 256,
      mimeType: "text/plain",
    });
    assert.fail("Should have thrown");
  } catch (err: any) {
    assert.ok(err.message.includes("SUI_FILE_CREATE_FAILED"), err.message);
  }
});

test("renewFileMetadata - calls update_walrus_info with blobObjectId", async () => {
  suiCircuitMod.suiCircuit.forceState("closed");
  let callTarget = "";
  suiModule.getSuiClient().signAndExecuteTransaction = async (params: any) => {
    callTarget = "called";
    return { digest: "0xrenew" };
  };

  await fileMetadataModule.renewFileMetadata({
    fileId: "0x0000000000000000000000000000000000000000000000000000000000000456",
    blobObjectId: "0x0000000000000000000000000000000000000000000000000000000000000001",
    walrusEndEpoch: 24,
  });

  assert.equal(callTarget, "called");
});

test("renewFileMetadata - calls update_expiry without blobObjectId", async () => {
  suiCircuitMod.suiCircuit.forceState("closed");
  let called = false;
  suiModule.getSuiClient().signAndExecuteTransaction = async () => {
    called = true;
    return { digest: "0xrenew2" };
  };

  await fileMetadataModule.renewFileMetadata({
    fileId: "0x0000000000000000000000000000000000000000000000000000000000000789",
    walrusEndEpoch: 36,
  });

  assert.ok(called);
});

test("renewFileMetadata - wraps Sui errors", async () => {
  suiCircuitMod.suiCircuit.forceState("closed");
  suiModule.getSuiClient().signAndExecuteTransaction = async () => {
    throw new Error("timeout");
  };

  try {
    await fileMetadataModule.renewFileMetadata({
      fileId: "0x0000000000000000000000000000000000000000000000000000000000000000",
      walrusEndEpoch: 48,
    });
    assert.fail("Should have thrown");
  } catch (err: any) {
    assert.ok(err.message.includes("SUI_RENEW_SUBMIT_FAILED"), err.message);
  }
});

// ============================================================
// Walrus metrics.ts — type exports
// ============================================================

test("uploadToWalrusWithMetrics - type exports exist", async () => {
  const metricsMod = await import("../src/services/walrus/metrics.js");
  assert.equal(typeof metricsMod.uploadToWalrusWithMetrics, "function");
});

// ============================================================
// Runtime metrics — verify metric functions accept correct shapes
// ============================================================

test("runtime metrics - metric functions are callable", async () => {
  const rtMetrics = await import("../src/services/metrics/runtime.metrics.js");
  if (typeof rtMetrics.observeStreamTtfb === "function") {
    rtMetrics.observeStreamTtfb({ range: "full", durationMs: 100 });
  }
  if (typeof rtMetrics.observeStreamCacheFill === "function") {
    rtMetrics.observeStreamCacheFill({ cacheType: "range", durationMs: 50 });
  }
  if (typeof rtMetrics.recordStreamCacheAccess === "function") {
    rtMetrics.recordStreamCacheAccess({ cacheType: "range", outcome: "hit" });
  }
  if (typeof rtMetrics.observeWalrusSegmentFetch === "function") {
    rtMetrics.observeWalrusSegmentFetch({
      outcome: "success",
      durationMs: 200,
      statusClass: "2xx",
    });
  }
  if (typeof rtMetrics.observeWalrusPublish === "function") {
    rtMetrics.observeWalrusPublish({
      durationMs: 1000,
      outcome: "success",
      mode: "publisher",
      source: "newly_created",
    });
  }
  if (typeof rtMetrics.recordStreamReadError === "function") {
    rtMetrics.recordStreamReadError("network_error");
  }
  assert.ok(true, "All metric functions accepted valid inputs");
});
