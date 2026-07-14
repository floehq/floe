/**
 * S3 chunk store — integration test.
 *
 * Connects to a real S3-compatible store (MinIO via FLOE_S3_ENDPOINT),
 * exercises writeChunk, hasChunk, openChunk, listChunks, and cleanup.
 *
 * Skipped when FLOE_S3_BUCKET is not set.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";

test("S3ChunkStore integration — real MinIO lifecycle", { timeout: 20_000 }, async (t) => {
  if (!process.env.FLOE_S3_BUCKET?.trim()) {
    return t.skip("FLOE_S3_BUCKET not set");
  }

  const envTmpDir = process.env.UPLOAD_TMP_DIR;
  const benchTmpDir = mkdtempSync(path.join(tmpdir(), "floe-s3-int-"));
  process.env.UPLOAD_TMP_DIR = benchTmpDir;

  try {
    const { S3ChunkStore } = await import("../src/store/s3.js");
    const store = new S3ChunkStore();

    const uploadId = `int-test-${randomUUID().slice(0, 8)}`;

    // Write chunk 0
    const chunk0 = Buffer.from("hello-chunk-0");
    const hash0 = createHash("sha256").update(chunk0).digest("hex");
    const result0 = await store.writeChunk(
      uploadId, 0, Readable.from(chunk0), hash0, chunk0.length, false,
    );
    assert.deepEqual(result0, { alreadyExisted: false });

    // Write chunk 1 (last chunk)
    const chunk1 = Buffer.from("hello-chunk-1-last");
    const hash1 = createHash("sha256").update(chunk1).digest("hex");
    const result1 = await store.writeChunk(
      uploadId, 1, Readable.from(chunk1), hash1, chunk1.length, true,
    );
    assert.deepEqual(result1, { alreadyExisted: false });

    // hasChunk
    assert.ok(await store.hasChunk(uploadId, 0));
    assert.ok(await store.hasChunk(uploadId, 1));
    assert.equal(await store.hasChunk(uploadId, 999), false);

    // listChunks
    const indices = await store.listChunks(uploadId);
    assert.deepEqual(indices, [0, 1]);

    // openChunk + read
    const stream0 = store.openChunk(uploadId, 0);
    const chunks: Buffer[] = [];
    for await (const c of stream0) {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    }
    assert.deepEqual(Buffer.concat(chunks), chunk0);

    // Write same chunk again — should return alreadyExisted
    const resultRepeat = await store.writeChunk(
      uploadId, 0, Readable.from(chunk0), hash0, chunk0.length, false,
    );
    assert.deepEqual(resultRepeat, { alreadyExisted: true });

    // cleanup
    await store.cleanup(uploadId);
    assert.equal(await store.hasChunk(uploadId, 0), false);
    assert.equal(await store.hasChunk(uploadId, 1), false);
    assert.deepEqual(await store.listChunks(uploadId), []);

  } finally {
    // Restore env
    if (envTmpDir !== undefined) {
      process.env.UPLOAD_TMP_DIR = envTmpDir;
    } else {
      delete process.env.UPLOAD_TMP_DIR;
    }
    rmSync(benchTmpDir, { recursive: true, force: true });
  }
});
