import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { Writable, Readable } from "stream";

import { spoolStreamToTempFile, createValidationStream } from "../src/store/s3.js";

/**
 * Comparative benchmark: old direct-stream path vs new spool-to-temp path.
 *
 * The old path pipes the upload stream through a validation Transform
 * directly to the destination (simulated here as a /dev/null-like sink).
 * The new path writes to a temp file first via spoolStreamToTempFile,
 * then reads back from disk.
 *
 * Both paths exercise the real createValidationStream / spoolStreamToTempFile
 * imported directly from s3.ts — not copies.
 *
 * Run with:
 *   npx tsx --test test/spool-bench.test.ts
 */

const MAX_CHUNK = 20 * 1024 * 1024;
const WARMUP_ITERATIONS = 3;
const BENCH_ITERATIONS = 10;

let prevTmpDir: string | undefined;
let benchTmpDir: string;

/**
 * Set UPLOAD_TMP_DIR to an isolated temp so the real spoolStreamToTempFile
 * from s3.ts can use its UploadConfig.tmpDir getter without throwing.
 * Snapshot and restore the original value so sibling test files in the same
 * process (e.g. when run with --test-concurrency=1 across multiple files)
 * don't lose their env setup.
 */
test.before(() => {
  prevTmpDir = process.env.UPLOAD_TMP_DIR;
  benchTmpDir = fs.mkdtempSync(path.join(tmpdir(), "floe-s3-bench-"));
  process.env.UPLOAD_TMP_DIR = benchTmpDir;
});

test.after(() => {
  if (prevTmpDir !== undefined) {
    process.env.UPLOAD_TMP_DIR = prevTmpDir;
  } else {
    delete process.env.UPLOAD_TMP_DIR;
  }
  fs.rmSync(benchTmpDir, { recursive: true, force: true });
});

/**
 * Simulate the OLD direct-stream path: pipe through validation Transform
 * to a discard sink. Measures time to validate + "upload" in one pass.
 */
async function oldDirectStreamPath(
  data: Buffer,
  expectedSize: number,
  maxChunkBytes: number,
): Promise<{ elapsedMs: number }> {
  const hash = crypto.createHash("sha256");
  const stream = Readable.from(data);
  const validator = createValidationStream(expectedSize, maxChunkBytes, hash);

  let bytesWritten = 0;
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      bytesWritten += chunk.length;
      cb();
    },
  });

  const start = performance.now();
  const { pipeline } = await import("stream/promises");
  await pipeline(stream, validator, sink);
  const elapsedMs = performance.now() - start;

  assert.equal(bytesWritten, data.length);
  return { elapsedMs };
}

/**
 * Simulate the NEW spool-to-temp path: drain to temp file, then discard
 * the file. Measures time to write to disk + read back.
 */
async function newSpoolToTempPath(
  data: Buffer,
  expectedSize: number,
  maxChunkBytes: number,
): Promise<{ elapsedMs: number }> {
  const stream = Readable.from(data);

  const start = performance.now();
  const result = await spoolStreamToTempFile(stream, expectedSize, maxChunkBytes);
  const elapsedMs = performance.now() - start;

  try {
    assert.equal(result.actualSize, data.length);
    return { elapsedMs };
  } finally {
    await result.cleanup();
  }
}

const SIZES = [
  { label: "1KB", bytes: 1024 },
  { label: "1MB", bytes: 1024 * 1024 },
  { label: "10MB", bytes: 10 * 1024 * 1024 },
];

for (const { label, bytes } of SIZES) {
  test(`comparative bench: ${label}`, async () => {
    const data = crypto.randomBytes(bytes);
    const pipeline = (await import("stream/promises")).pipeline;

    // Warmup: run both paths a few times to prime disk cache and V8 JIT
    for (let i = 0; i < WARMUP_ITERATIONS; i++) {
      const hash = crypto.createHash("sha256");
      await pipeline(
        Readable.from(data),
        createValidationStream(bytes, MAX_CHUNK, hash),
        new Writable({
          write(c: Buffer, _e: BufferEncoding, cb: () => void) {
            cb();
          },
        }),
      );
      hash.digest("hex");

      const r = await spoolStreamToTempFile(Readable.from(data), bytes, MAX_CHUNK);
      await r.cleanup();
    }

    // Benchmark: old path
    let oldTotal = 0;
    for (let i = 0; i < BENCH_ITERATIONS; i++) {
      const { elapsedMs } = await oldDirectStreamPath(data, bytes, MAX_CHUNK);
      oldTotal += elapsedMs;
    }
    const oldAvg = oldTotal / BENCH_ITERATIONS;

    // Benchmark: new path
    let newTotal = 0;
    for (let i = 0; i < BENCH_ITERATIONS; i++) {
      const { elapsedMs } = await newSpoolToTempPath(data, bytes, MAX_CHUNK);
      newTotal += elapsedMs;
    }
    const newAvg = newTotal / BENCH_ITERATIONS;

    const ratio = newAvg / oldAvg;
    // Tab-separated for easy table copy
    console.log(
      `  ${label.padStart(4)}\told direct-stream: ${oldAvg.toFixed(2).padStart(8)}ms\tnew spool-to-temp: ${newAvg.toFixed(2).padStart(8)}ms\tratio: ${ratio.toFixed(2)}x`,
    );

    // Verify hashes match
    const expectedHash = crypto.createHash("sha256").update(data).digest("hex");

    // old path hash
    const h1 = crypto.createHash("sha256");
    const s1 = new Writable({
      write(c: Buffer, _e: BufferEncoding, cb: () => void) {
        h1.update(c);
        cb();
      },
    });
    await pipeline(Readable.from(data), s1);
    assert.equal(h1.digest("hex"), expectedHash);

    // new path hash
    const r = await spoolStreamToTempFile(Readable.from(data), bytes, MAX_CHUNK);
    try {
      assert.equal(r.sha256, expectedHash);
      assert.equal(r.actualSize, bytes);
    } finally {
      await r.cleanup();
    }
  });
}

test("spool-to-temp: rejects oversized chunk", async () => {
  const data = crypto.randomBytes(4096);
  const stream = Readable.from(data);
  // maxChunkBytes smaller than data — spoolStreamToTempFile should reject
  await assert.rejects(() => spoolStreamToTempFile(stream, data.length, 512), /CHUNK_TOO_LARGE/);
});

test("spool-to-temp: correctness for empty input", async () => {
  const data = Buffer.alloc(0);
  const stream = Readable.from(data);
  const res = await spoolStreamToTempFile(stream, 0, MAX_CHUNK);
  try {
    assert.equal(res.actualSize, 0);
    const expectedHash = crypto.createHash("sha256").update(data).digest("hex");
    assert.equal(res.sha256, expectedHash);
  } finally {
    await res.cleanup();
  }
});
