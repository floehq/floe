import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";

/**
 * Synthetic benchmark for the spool-to-temp pattern used in S3ChunkStore.
 *
 * This test does not require any external infra (S3, Redis, etc.) and
 * runs against a temp directory that is cleaned up after each run.
 *
 * It measures the end-to-end time to spool in-memory data through the
 * validation stream to a temp file, which is the same path used by
 * S3ChunkStore.writeChunk when it calls spoolStreamToTempFile().
 *
 * Run with: npx tsx --test test/spool-bench.test.ts
 */
async function spoolStreamToTempFile(
  stream: Readable,
  expectedSize: number,
  maxChunkBytes: number,
): Promise<{
  actualSize: number;
  sha256: string;
  tempPath: string;
  cleanup: () => Promise<void>;
}> {
  const hash = crypto.createHash("sha256");
  const validator = createValidationStream(expectedSize, maxChunkBytes, hash);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "floe-s3-chunk-"));
  const tempPath = path.join(tempDir, `${crypto.randomUUID()}.chunk`);

  try {
    await pipeline(stream, validator, fs.createWriteStream(tempPath, { flags: "wx" }));
    const stat = await fsp.stat(tempPath);
    return {
      actualSize: stat.size,
      sha256: hash.digest("hex"),
      tempPath,
      cleanup: async () => {
        await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch (err) {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

function createValidationStream(expectedSize: number, maxChunkBytes: number, hash: crypto.Hash) {
  let written = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length;
      if (written > expectedSize || written > maxChunkBytes) {
        cb(new Error("CHUNK_TOO_LARGE"));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });
}

test("spool-to-temp benchmark: 1KB chunk", async () => {
  const data = crypto.randomBytes(1024);
  const stream = Readable.from(data);
  const result = await spoolStreamToTempFile(stream, data.length, 20 * 1024 * 1024);
  try {
    assert.equal(result.actualSize, data.length);
    const expectedHash = crypto.createHash("sha256").update(data).digest("hex");
    assert.equal(result.sha256, expectedHash);
    const fileContent = await fsp.readFile(result.tempPath);
    assert.deepEqual(fileContent, data);
  } finally {
    await result.cleanup();
  }
});

test("spool-to-temp benchmark: 1MB chunk (timed)", async () => {
  const data = crypto.randomBytes(1024 * 1024);
  const stream = Readable.from(data);

  const start = performance.now();
  const result = await spoolStreamToTempFile(stream, data.length, 20 * 1024 * 1024);
  const elapsedMs = performance.now() - start;

  try {
    assert.equal(result.actualSize, data.length);
    const expectedHash = crypto.createHash("sha256").update(data).digest("hex");
    assert.equal(result.sha256, expectedHash);
    // Should complete well under 500ms for 1MB on any reasonable hardware
    assert.ok(elapsedMs < 500, `1MB spool took ${elapsedMs.toFixed(1)}ms (expected < 500ms)`);
    console.log(`  1MB spool-to-temp: ${elapsedMs.toFixed(1)}ms`);
  } finally {
    await result.cleanup();
  }
});

test("spool-to-temp benchmark: rejects oversized chunk", async () => {
  const data = crypto.randomBytes(1024);
  const stream = Readable.from(data);
  // maxChunkBytes is smaller than the data — should reject
  await assert.rejects(() => spoolStreamToTempFile(stream, data.length, 512), /CHUNK_TOO_LARGE/);
});

test("spool-to-temp benchmark: 10MB chunk timing", async () => {
  const data = crypto.randomBytes(10 * 1024 * 1024);
  const stream = Readable.from(data);

  const start = performance.now();
  const result = await spoolStreamToTempFile(stream, data.length, 20 * 1024 * 1024);
  const elapsedMs = performance.now() - start;

  try {
    assert.equal(result.actualSize, data.length);
    const expectedHash = crypto.createHash("sha256").update(data).digest("hex");
    assert.equal(result.sha256, expectedHash);
    // Should complete well under 2000ms for 10MB on any reasonable hardware
    assert.ok(elapsedMs < 2000, `10MB spool took ${elapsedMs.toFixed(1)}ms (expected < 2000ms)`);
    console.log(` 10MB spool-to-temp: ${elapsedMs.toFixed(1)}ms`);
  } finally {
    await result.cleanup();
  }
});
