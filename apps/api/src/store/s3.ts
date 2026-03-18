import crypto from "crypto";
import { createRequire } from "module";
import { Readable } from "stream";

import type { ChunkStore } from "./chunk.js";

const require = createRequire(import.meta.url);

type AwsS3Module = {
  S3Client: new (...args: any[]) => any;
  DeleteObjectsCommand: new (...args: any[]) => any;
  GetObjectCommand: new (...args: any[]) => any;
  HeadObjectCommand: new (...args: any[]) => any;
  ListObjectsV2Command: new (...args: any[]) => any;
  PutObjectCommand: new (...args: any[]) => any;
};

function loadAwsS3(): AwsS3Module {
  try {
    return require("@aws-sdk/client-s3") as AwsS3Module;
  } catch (err) {
    throw new Error(
      "S3 chunk store requires @aws-sdk/client-s3. Install it with: npm install --workspace=apps/api @aws-sdk/client-s3"
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

async function streamToBuffer(
  stream: Readable,
  expectedSize: number,
  maxChunkBytes: number
): Promise<{ buf: Buffer; actualSize: number; sha256: string }> {
  const hash = crypto.createHash("sha256");
  const chunks: Buffer[] = [];
  let written = 0;

  for await (const part of stream) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    written += chunk.length;
    if (written > expectedSize || written > maxChunkBytes) {
      throw new Error("CHUNK_TOO_LARGE");
    }
    hash.update(chunk);
    chunks.push(chunk);
  }

  const buf = Buffer.concat(chunks, written);
  return {
    buf,
    actualSize: written,
    sha256: hash.digest("hex"),
  };
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
    isLastChunk: boolean
  ): Promise<void> {
    const key = this.chunkKey(uploadId, index);

    try {
      await this.cfg.client.send(
        new this.cfg.cmd.HeadObjectCommand({
          Bucket: this.cfg.bucket,
          Key: key,
        })
      );
      return;
    } catch {
      // Continue for missing keys.
    }

    const { buf, actualSize, sha256 } = await streamToBuffer(
      stream,
      expectedSize,
      this.cfg.maxChunkBytes
    );

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

    try {
      await this.cfg.client.send(
        new this.cfg.cmd.PutObjectCommand({
          Bucket: this.cfg.bucket,
          Key: key,
          Body: buf,
          ContentLength: actualSize,
          ContentType: "application/octet-stream",
          Metadata: {
            sha256,
          },
          IfNoneMatch: "*",
        })
      );
    } catch (err: any) {
      const status = Number(err?.$metadata?.httpStatusCode ?? 0);
      const code = String(err?.name ?? "");
      if (status === 412 || code === "PreconditionFailed") return;
      throw err;
    }
  }

  async hasChunk(uploadId: string, index: number): Promise<boolean> {
    try {
      await this.cfg.client.send(
        new this.cfg.cmd.HeadObjectCommand({
          Bucket: this.cfg.bucket,
          Key: this.chunkKey(uploadId, index),
        })
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
        })
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
          })
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

  async cleanup(uploadId: string): Promise<void> {
    let token: string | undefined;
    do {
      const listed = await this.cfg.client.send(
        new this.cfg.cmd.ListObjectsV2Command({
          Bucket: this.cfg.bucket,
          Prefix: this.uploadPrefix(uploadId),
          ContinuationToken: token,
        })
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
          })
        );
      }

      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
  }
}
