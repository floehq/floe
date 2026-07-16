import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";

import { S3ChunkStore } from "../src/store/s3.ts";

let envTmpDir: string | undefined;
let benchTmpDir: string;

test.before(() => {
  envTmpDir = process.env.UPLOAD_TMP_DIR;
  benchTmpDir = mkdtempSync(path.join(tmpdir(), "floe-s3-test-"));
  process.env.UPLOAD_TMP_DIR = benchTmpDir;
});

test.after(() => {
  if (envTmpDir !== undefined) {
    process.env.UPLOAD_TMP_DIR = envTmpDir;
  } else {
    delete process.env.UPLOAD_TMP_DIR;
  }
  rmSync(benchTmpDir, { recursive: true, force: true });
});

class HeadObjectCommand {
  constructor(public readonly input: Record<string, unknown>) {}
}

class PutObjectCommand {
  constructor(public readonly input: Record<string, unknown>) {}
}

async function collectBody(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function makeStore(overrides?: {
  onPut?: (input: Record<string, unknown>) => Promise<void>;
  put412?: boolean;
  headExists?: boolean;
  headResult?: Record<string, unknown>;
}) {
  const calls = { head: 0, put: 0 };
  const store = Object.create(S3ChunkStore.prototype) as S3ChunkStore & {
    cfg: Record<string, unknown>;
  };
  store.cfg = {
    bucket: "bucket",
    prefix: "prefix",
    maxChunkBytes: 1024 * 1024,
    client: {
      async send(command: HeadObjectCommand | PutObjectCommand) {
        if (command instanceof HeadObjectCommand) {
          calls.head++;
          if (overrides?.headExists) return overrides.headResult ?? {};
          throw new Error("NotFound");
        }
        if (command instanceof PutObjectCommand) {
          calls.put++;
          if (overrides?.put412) {
            const err = new Error("Precondition Failed");
            err.name = "PreconditionFailed";
            (err as any).$metadata = { httpStatusCode: 412 };
            throw err;
          }
          await overrides?.onPut?.(command.input);
          return {};
        }
        throw new Error("Unexpected command");
      },
    },
    cmd: {
      HeadObjectCommand,
      PutObjectCommand,
    },
  };
  return { store, calls };
}

test("s3 chunk store streams validated chunk bodies into put object", async () => {
  const chunk = Buffer.from("stream-me");
  const expectedHash = createHash("sha256").update(chunk).digest("hex");
  let bodyWasReadable = false;
  let uploaded: Buffer | null = null;

  const { store, calls } = makeStore({
    async onPut(input) {
      bodyWasReadable = input.Body instanceof Readable;
      uploaded = await collectBody(input.Body);
      assert.equal(input.ContentLength, chunk.length);
      assert.equal(input.Metadata.sha256, expectedHash);
    },
  });

  const result = await store.writeChunk(
    "upload-1",
    0,
    Readable.from(chunk),
    expectedHash,
    chunk.length,
    false,
  );

  assert.deepEqual(result, { alreadyExisted: false });
  assert.equal(bodyWasReadable, true);
  assert.deepEqual(uploaded, chunk);
  assert.equal(calls.head, 0, "HeadObject should not be called on fresh write");
});

test("s3 chunk store rejects hash mismatch before S3 PutObject", async () => {
  const chunk = Buffer.from("bad-hash");
  let putAttempted = false;

  const { store, calls } = makeStore({
    async onPut(input) {
      putAttempted = true;
      await collectBody(input.Body);
    },
  });

  await assert.rejects(
    () =>
      store.writeChunk("upload-2", 0, Readable.from(chunk), "0".repeat(64), chunk.length, false),
    /HASH_MISMATCH/,
  );

  // New spool-to-temp pattern validates hash AFTER writing to temp file
  // but BEFORE any S3 PutObject call — so putAttempted is false.
  assert.equal(putAttempted, false);
  assert.equal(calls.head, 0, "HeadObject should not be called on hash mismatch");
});

test("s3 chunk store calls HeadObject only after PutObject 412 (not upfront)", async () => {
  const chunk = Buffer.from("already-there");
  const expectedHash = createHash("sha256").update(chunk).digest("hex");

  const { store, calls } = makeStore({
    put412: true,
    headExists: true,
    headResult: {
      ContentLength: chunk.length,
      Metadata: { sha256: expectedHash },
    },
  });

  const result = await store.writeChunk(
    "upload-3",
    0,
    Readable.from(chunk),
    expectedHash,
    chunk.length,
    false,
  );

  assert.deepEqual(result, { alreadyExisted: true });
  assert.equal(calls.put, 1, "PutObject called once (fails with 412)");
  assert.equal(calls.head, 1, "HeadObject called once (after 412)");
});

test("s3 chunk store rejects existing chunk hash mismatch after 412", async () => {
  const chunk = Buffer.from("already-there");
  const expectedHash = createHash("sha256").update(chunk).digest("hex");

  const { store, calls } = makeStore({
    put412: true,
    headExists: true,
    headResult: {
      ContentLength: chunk.length,
      Metadata: { sha256: "0".repeat(64) },
    },
  });

  await assert.rejects(
    () => store.writeChunk("upload-4", 0, Readable.from(chunk), expectedHash, chunk.length, false),
    /HASH_MISMATCH/,
  );
  assert.equal(calls.put, 1, "PutObject called once (fails with 412)");
  assert.equal(calls.head, 1, "HeadObject called once (after 412)");
});
