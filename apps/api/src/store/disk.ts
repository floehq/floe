import fs from "fs/promises";
import { createWriteStream, createReadStream } from "fs";
import path from "path";
import crypto from "crypto";
import { pipeline } from "stream/promises";
import { Transform } from "stream";
import type { Readable } from "stream";

import { UploadConfig } from "../config/uploads.config.js";
import type { ChunkStore } from "./chunk.js";

const STALE_TMP_MS = 10 * 60 * 1000;

function createValidationStream(expectedSize: number, hash: crypto.Hash) {
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

  private async verifyExistingChunk(
    finalPath: string,
    expectedHash: string,
    expectedSize: number,
    isLastChunk: boolean,
  ): Promise<void> {
    const stat = await fs.stat(finalPath);
    if (isLastChunk) {
      if (stat.size <= 0 || stat.size > expectedSize) {
        throw new Error("INVALID_LAST_CHUNK_SIZE");
      }
    } else if (stat.size !== expectedSize) {
      throw new Error("CHUNK_SIZE_MISMATCH");
    }

    const hash = crypto.createHash("sha256");
    await pipeline(createReadStream(finalPath), hash);
    const actualHash = hash.digest("hex");
    if (actualHash !== expectedHash.toLowerCase()) {
      throw new Error("HASH_MISMATCH");
    }
  }

  async writeChunk(
    uploadId: string,
    index: number,
    stream: Readable,
    expectedHash: string,
    expectedSize: number,
    isLastChunk: boolean,
  ): Promise<{ alreadyExisted: boolean }> {
    const dir = this.dir(uploadId);
    const finalPath = this.chunkPath(uploadId, index);
    const tempPath = `${finalPath}.tmp`;

    await fs.mkdir(dir, { recursive: true });

    // If the final chunk already exists, treat this as idempotent.
    const finalExists = await fs.stat(finalPath).then(
      () => true,
      () => false,
    );
    if (finalExists) {
      await this.verifyExistingChunk(finalPath, expectedHash, expectedSize, isLastChunk);
      return { alreadyExisted: true };
    }

    const hash = crypto.createHash("sha256");
    const validator = createValidationStream(expectedSize, hash);

    let ws: import("fs").WriteStream | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        ws = createWriteStream(tempPath, { flags: "wx" });
        break;
      } catch (err: unknown) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

        // Another writer may be in progress, or a previous attempt crashed.
        const finalExists2 = await fs.stat(finalPath).then(
          () => true,
          () => false,
        );
        if (finalExists2) {
          await this.verifyExistingChunk(finalPath, expectedHash, expectedSize, isLastChunk);
          return { alreadyExisted: true };
        }

        try {
          const st = await fs.stat(tempPath);
          const isStale = Date.now() - st.mtimeMs > STALE_TMP_MS;
          if (isStale && attempt === 0) {
            await fs.rm(tempPath, { force: true });
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

      const stat = await fs.stat(tempPath);

      if (isLastChunk) {
        if (stat.size <= 0 || stat.size > expectedSize) {
          throw new Error("INVALID_LAST_CHUNK_SIZE");
        }
      } else {
        if (stat.size !== expectedSize) {
          throw new Error("CHUNK_SIZE_MISMATCH");
        }
      }

      await fs.rename(tempPath, finalPath);

      try {
        await fs.utimes(dir, new Date(), new Date());
      } catch {
        /* empty */
      }
      return { alreadyExisted: false };
    } catch (err) {
      try {
        await fs.rm(tempPath, { force: true });
      } catch {
        /* empty */
      }

      try {
        stream.destroy();
      } catch {
        /* empty */
      }

      throw err;
    }
  }

  async hasChunk(uploadId: string, index: number): Promise<boolean> {
    const path = this.chunkPath(uploadId, index);
    return await fs.stat(path).then(
      () => true,
      () => false,
    );
  }

  async listChunks(uploadId: string): Promise<number[]> {
    const dir = this.dir(uploadId);
    const dirExists = await fs.stat(dir).then(
      () => true,
      () => false,
    );
    if (!dirExists) return [];

    const entries = await fs.readdir(dir);
    return entries
      .filter((name) => /^\d+$/.test(name))
      .map(Number)
      .sort((a, b) => a - b);
  }

  openChunk(uploadId: string, index: number): Readable {
    return createReadStream(this.chunkPath(uploadId, index));
  }

  async removeChunk(uploadId: string, index: number): Promise<void> {
    await fs.rm(this.chunkPath(uploadId, index), { force: true });
  }

  async cleanup(uploadId: string): Promise<void> {
    await fs.rm(this.dir(uploadId), { recursive: true, force: true });
  }
}
