import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";

import { S3ChunkStore } from "../src/store/s3.ts";

class HeadObjectCommand {
  constructor(public readonly input: any) {}
}

class PutObjectCommand {
  constructor(public readonly input: any) {}
}

async function collectBody(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function makeStore(overrides?: {
  onPut?: (input: any) => Promise<void>;
  headExists?: boolean;
}) {
  const store = Object.create(S3ChunkStore.prototype) as S3ChunkStore & { cfg: any };
  store.cfg = {
    bucket: "bucket",
    prefix: "prefix",
    maxChunkBytes: 1024 * 1024,
    client: {
      async send(command: any) {
        if (command instanceof HeadObjectCommand) {
          if (overrides?.headExists) return {};
          throw new Error("NotFound");
        }
        if (command instanceof PutObjectCommand) {
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
  return store;
}

test("s3 chunk store streams validated chunk bodies into put object", async () => {
  const chunk = Buffer.from("stream-me");
  const expectedHash = createHash("sha256").update(chunk).digest("hex");
  let bodyWasReadable = false;
  let uploaded: Buffer | null = null;

  const store = makeStore({
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
    false
  );

  assert.deepEqual(result, { alreadyExisted: false });
  assert.equal(bodyWasReadable, true);
  assert.deepEqual(uploaded, chunk);
});

test("s3 chunk store rejects hash mismatch without buffering to a final object", async () => {
  const chunk = Buffer.from("bad-hash");
  let putAttempted = false;

  const store = makeStore({
    async onPut(input) {
      putAttempted = true;
      await collectBody(input.Body);
    },
  });

  await assert.rejects(
    () =>
      store.writeChunk(
        "upload-2",
        0,
        Readable.from(chunk),
        "0".repeat(64),
        chunk.length,
        false
      ),
    /HASH_MISMATCH/
  );

  assert.equal(putAttempted, true);
});
