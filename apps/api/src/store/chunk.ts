import type { Readable } from "stream";

export interface ChunkStore {
  backend(): "disk" | "s3";

  writeChunk(
    uploadId: string,
    index: number,
    stream: Readable,
    expectedHash: string,
    expectedSize: number,
    isLastChunk: boolean
  ): Promise<void>;

  hasChunk(uploadId: string, index: number): Promise<boolean>;

  listChunks(uploadId: string): Promise<number[]>;

  openChunk(uploadId: string, index: number): Readable;

  cleanup(uploadId: string): Promise<void>;
}
