import { DiskChunkStore } from "./disk.js";
import { S3ChunkStore } from "./s3.js";

function resolveChunkStoreMode(): "disk" | "s3" {
  const mode = (process.env.FLOE_CHUNK_STORE_MODE ?? "s3").trim().toLowerCase();
  if (mode === "disk" || mode === "s3") return mode;
  throw new Error("FLOE_CHUNK_STORE_MODE must be one of: disk, s3");
}

const chunkStoreMode = resolveChunkStoreMode();
export const chunkStore = chunkStoreMode === "s3" ? new S3ChunkStore() : new DiskChunkStore();

export * from "./chunk.js";
