import crypto from "crypto";
import { createRequire } from "module";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";

import type { ChunkStore } from "./chunk.js";

const require = createRequire(import.meta.url);

type AwsS3Module = {
  S3Client: new (...args: any[]) => any;
  DeleteObjectCommand: new (...args: any[]) => any;
  DeleteObjectsCommand: new (...args: any[]) => any;
  GetObjectCommand: new (...args: any[]) => any;
  HeadObjectCommand: new (...args: any[]) => any;
  ListObjectsV2Command: new (...args: any[]) => any;
  PutObjectCommand: new (...args: any[]) => any;
};

function loadAwsS3(): AwsS3Module {
  try {
    return require("@aws-sdk/client-s3") as AwsS3Module;
  } catch {
    throw new Error(
      "S3 chunk store requires @aws-sdk/client-s3. Install it with: npm install --workspace=apps/api @aws-sdk/client-s3",
    );
  }
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "1" || raw.toLowerCase() === "true") return true;
  if (raw === "0" || raw.toLowerCase() === "false") return false;
  throw new Error(`${name} must be one of: 1, 0, true, false`);
}

function parseIntEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return n;
}

type S3RuntimeConfig = {
  bucket: string;
  prefix: string;
  maxChunkBytes: number;
  client: any;
  cmd: Omit<AwsS3Module, "S3Client">;
};

/**
 * Create a Transform stream that validates chunk size and computes
 * a running SHA-256 hash. Does NOT do final hash comparison — the
 * caller (spoolStreamToTempFile) owns the hash and compares after
 * the stream completes.
 */
function createValidationStream(
  expectedSize: number,
  maxChunkBytes: number,
  hash: crypto.Hash,
) {
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

/**
 * Spool an upload stream to a temporary file on disk while validating
 * size bounds and computing a SHA-256 hash.
 *
 * Returns the temp file path, actual size, sha256 hex digest, and a
 * cleanup function to remove the temp file when done.
 *
 * This decouples client-stream timing from S3 upload timing — the
 * chunk is fully written and validated before any S3 PutObject call,
 * so slow client uploads don't hold S3 connections open.
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
    const actualSize = stat.size;
    return {
      actualSize,
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

export class S3ChunkStore implements ChunkStore {
  private readonly cfg: S3RuntimeConfig;

  constructor() {
    const bucket = (process.env.FLOE_S3_BUCKET ?? "").trim();
    if (!bucket) {
      throw new Error("Missing required env: FLOE_S3_BUCKET");
    }

    const region = (process.env.FLOE_S3_REGION ?? "us-east-1").trim();
    const endpoint = (process.env.FLOE_S3_ENDPOINT ?? "").trim();
    const forcePathStyle = parseBoolEnv("FLOE_S3_FORCE_PATH_STYLE", true);
    const prefix = (process.env.FLOE_S3_PREFIX ?? "floe/chunks").replace(/\/+$/, "");
    const maxChunkBytes = parseIntEnv("FLOE_CHUNK_MAX_BYTES", 20 * 1024 * 1024);
    const accessKeyId = (process.env.FLOE_S3_ACCESS_KEY_ID ?? "").trim();
    const secretAccessKey = (process.env.FLOE_S3_SECRET_ACCESS_KEY ?? "").trim();
    const sessionToken = (process.env.FLOE_S3_SESSION_TOKEN ?? "").trim();

    const aws = loadAwsS3();
    const client = new aws.S3Client({
      region,
      ...(endpoint ? { endpoint } : {}),
      forcePathStyle,
      ...(accessKeyId && secretAccessKey
        ? {
            credentials: {
              accessKeyId,
              secretAccessKey,
              ...(sessionToken ? { sessionToken } : {}),
            },
          }
        : {}),
    });

    const { S3Client: _ignored, ...cmd } = aws;
    this.cfg = { bucket, prefix, maxChunkBytes, client, cmd };
  }

  backend(): "disk" | "s3" {
    return "s3";
  }

  private chunkKey(uploadId: string, index: number): string {
    return `${this.cfg.prefix}/${uploadId}/${index}`;
  }

  private uploadPrefix(uploadId: string): string {
    return `${this.cfg.prefix}/${uploadId}/`;
  }

  async writeChunk(
    uploadId: string,
    index: number,
    stream: Readable,
    expectedHash: string,
    expectedSize: number,
    isLastChunk: boolean,
  ): Promise<{ alreadyExisted: boolean }> {
    const key = this.chunkKey(uploadId, index);

    try {
      const head = await this.cfg.client.send(
        new this.cfg.cmd.HeadObjectCommand({
          Bucket: this.cfg.bucket,
          Key: key,
        }),
      );
      const contentLength = Number(head?.ContentLength ?? head?.contentLength);
      const storedHash = String(
        head?.Metadata?.sha256 ?? head?.metadata?.sha256 ?? "",
      ).toLowerCase();
      if (Number.isFinite(contentLength)) {
        if (isLastChunk) {
          if (contentLength <= 0 || contentLength > expectedSize) {
            throw new Error("INVALID_LAST_CHUNK_SIZE");
          }
        } else if (contentLength !== expectedSize) {
          throw new Error("CHUNK_SIZE_MISMATCH");
        }
      }
      if (storedHash && storedHash !== expectedHash.toLowerCase()) {
        throw new Error("HASH_MISMATCH");
      }
      return { alreadyExisted: true };
    } catch (err: any) {
      if (
        err?.message === "HASH_MISMATCH" ||
        err?.message === "CHUNK_SIZE_MISMATCH" ||
        err?.message === "INVALID_LAST_CHUNK_SIZE"
      ) {
        throw err;
      }
      // Continue for missing keys.
    }

    // Spool client stream to temp file first: validates size and hash,
    // then upload from disk. This decouples client-stream timing from
    // the S3 PutObject connection, avoiding slow-client backpressure
    // on the S3 upload path.
    const { actualSize, sha256, tempPath, cleanup } = await spoolStreamToTempFile(
      stream,
      expectedSize,
      this.cfg.maxChunkBytes,
    );

    try {
      if (sha256 !== expectedHash.toLowerCase()) {
        throw new Error("HASH_MISMATCH");
      }

      if (isLastChunk) {
        if (actualSize <= 0 || actualSize > expectedSize) {
          throw new Error("INVALID_LAST_CHUNK_SIZE");
        }
      } else if (actualSize !== expectedSize) {
        throw new Error("CHUNK_SIZE_MISMATCH");
      }

      await this.cfg.client.send(
        new this.cfg.cmd.PutObjectCommand({
          Bucket: this.cfg.bucket,
          Key: key,
          Body: fs.createReadStream(tempPath),
          ContentLength: actualSize,
          ContentType: "application/octet-stream",
          Metadata: {
            sha256,
          },
          IfNoneMatch: "*",
        }),
      );
      return { alreadyExisted: false };
    } catch (err: any) {
      const status = Number(err?.$metadata?.httpStatusCode ?? 0);
      const code = String(err?.name ?? "");
      if (status === 412 || code === "PreconditionFailed") {
        return { alreadyExisted: true };
      }
      throw err;
    } finally {
      await cleanup();
    }
  }

  async hasChunk(uploadId: string, index: number): Promise<boolean> {
    try {
      await this.cfg.client.send(
        new this.cfg.cmd.HeadObjectCommand({
          Bucket: this.cfg.bucket,
          Key: this.chunkKey(uploadId, index),
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async listChunks(uploadId: string): Promise<number[]> {
    const out: number[] = [];
    let token: string | undefined;

    do {
      const res = await this.cfg.client.send(
        new this.cfg.cmd.ListObjectsV2Command({
          Bucket: this.cfg.bucket,
          Prefix: this.uploadPrefix(uploadId),
          ContinuationToken: token,
        }),
      );

      for (const obj of res.Contents ?? []) {
        const key = obj.Key ?? "";
        const tail = key.slice(this.uploadPrefix(uploadId).length);
        if (/^\d+$/.test(tail)) out.push(Number(tail));
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);

    out.sort((a, b) => a - b);
    return out;
  }

  openChunk(uploadId: string, index: number): Readable {
    const pass = new Readable({
      read() {
        // no-op; data is pushed async
      },
    });

    void (async () => {
      try {
        const res = await this.cfg.client.send(
          new this.cfg.cmd.GetObjectCommand({
            Bucket: this.cfg.bucket,
            Key: this.chunkKey(uploadId, index),
          }),
        );

        const body = res.Body;
        if (!body) {
          pass.destroy(new Error("MISSING_CHUNK"));
          return;
        }

        const rs = body as Readable;
        rs.on("data", (c) => pass.push(c));
        rs.on("end", () => pass.push(null));
        rs.on("error", (err) => pass.destroy(err));
      } catch (err) {
        pass.destroy(err as Error);
      }
    })();

    return pass;
  }

  async removeChunk(uploadId: string, index: number): Promise<void> {
    const key = this.chunkKey(uploadId, index);
    try {
      await this.cfg.client.send(
        new this.cfg.cmd.DeleteObjectCommand({
          Bucket: this.cfg.bucket,
          Key: key,
        }),
      );
    } catch {
      // Best-effort; the chunk may not exist.
    }
  }

  async cleanup(uploadId: string): Promise<void> {
    let token: string | undefined;
    do {
      const listed = await this.cfg.client.send(
        new this.cfg.cmd.ListObjectsV2Command({
          Bucket: this.cfg.bucket,
          Prefix: this.uploadPrefix(uploadId),
          ContinuationToken: token,
        }),
      );
      const keys = (listed.Contents ?? [])
        .map((x: any) => x.Key)
        .filter((k: unknown): k is string => Boolean(k));

      if (keys.length > 0) {
        await this.cfg.client.send(
          new this.cfg.cmd.DeleteObjectsCommand({
            Bucket: this.cfg.bucket,
            Delete: {
              Objects: keys.map((key: string) => ({ Key: key })),
              Quiet: true,
            },
          }),
        );
      }

      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
  }
}
