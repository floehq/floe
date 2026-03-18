import fs from "fs";
import path from "path";
import crypto from "crypto";
import { pipeline } from "stream/promises";
import { Transform } from "stream";
import type { Readable } from "stream";

import { UploadConfig } from "../config/uploads.config.js";
import type { ChunkStore } from "./chunk.js";

const STALE_TMP_MS = 10 * 60 * 1000;

function createValidationStream(
  expectedSize: number,
  hash: crypto.Hash
) {
  let written = 0;

  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length;

      if (written > expectedSize) {
        cb(new Error("CHUNK_TOO_LARGE"));
        return;
      }

      hash.update(chunk);
      cb(null, chunk);
    },
  });
}

export class DiskChunkStore implements ChunkStore {
  backend(): "disk" | "s3" {
    return "disk";
  }

  private dir(uploadId: string) {
    return path.join(UploadConfig.tmpDir, uploadId);
  }

  private chunkPath(uploadId: string, index: number) {
    return path.join(this.dir(uploadId), String(index));
  }

  async writeChunk(
    uploadId: string,
    index: number,
    stream: Readable,
    expectedHash: string,
    expectedSize: number,
    isLastChunk: boolean
  ): Promise<void> {
    const dir = this.dir(uploadId);
    const finalPath = this.chunkPath(uploadId, index);
    const tempPath = `${finalPath}.tmp`;

    fs.mkdirSync(dir, { recursive: true });

    // If the final chunk already exists, treat this as idempotent.
    if (fs.existsSync(finalPath)) {
      return;
    }

    const hash = crypto.createHash("sha256");
    const validator = createValidationStream(expectedSize, hash);

    let ws: fs.WriteStream | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        ws = fs.createWriteStream(tempPath, { flags: "wx" });
        break;
      } catch (err: any) {
        if (err.code !== "EEXIST") throw err;

        // Another writer may be in progress, or a previous attempt crashed.
        if (fs.existsSync(finalPath)) {
          return;
        }

        try {
          const st = fs.statSync(tempPath);
          const isStale = Date.now() - st.mtimeMs > STALE_TMP_MS;
          if (isStale && attempt === 0) {
            fs.rmSync(tempPath, { force: true });
            continue;
          }
        } catch {
          // If we can't stat it, treat as in-progress to avoid corrupting another writer.
        }

        throw new Error("CHUNK_IN_PROGRESS");
      }
    }

    try {
      if (!ws) {
        throw new Error("CHUNK_TEMP_CREATE_FAILED");
      }

      await pipeline(stream, validator, ws);

      const actualHash = hash.digest("hex");
      if (actualHash !== expectedHash.toLowerCase()) {
        throw new Error("HASH_MISMATCH");
      }

      const stat = fs.statSync(tempPath);

      if (isLastChunk) {
        if (stat.size <= 0 || stat.size > expectedSize) {
          throw new Error("INVALID_LAST_CHUNK_SIZE");
        }
      } else {
        if (stat.size !== expectedSize) {
          throw new Error("CHUNK_SIZE_MISMATCH");
        }
      }

      fs.renameSync(tempPath, finalPath);

      try {
        fs.utimesSync(dir, new Date(), new Date());
      } catch {}

    } catch (err) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {}

      try {
        stream.destroy();
      } catch {}

      throw err;
    }
  }

  async hasChunk(uploadId: string, index: number): Promise<boolean> {
    return fs.existsSync(this.chunkPath(uploadId, index));
  }

  async listChunks(uploadId: string): Promise<number[]> {
    const dir = this.dir(uploadId);
    if (!fs.existsSync(dir)) return [];

    return fs
      .readdirSync(dir)
      .filter(name => /^\d+$/.test(name))
      .map(Number)
      .sort((a, b) => a - b);
  }

  openChunk(uploadId: string, index: number): Readable {
    return fs.createReadStream(this.chunkPath(uploadId, index));
  }

  async cleanup(uploadId: string): Promise<void> {
    fs.rmSync(this.dir(uploadId), { recursive: true, force: true });
  }
}
