import type { Readable } from "stream";

export type WalrusUploadSource = "newly_created" | "already_certified" | "unknown";

export type WalrusUploadResult = {
  blobId: string;
  objectId?: string;
  cost?: number;
  endEpoch?: number;
  source: WalrusUploadSource;
};

export type WalrusUploadParams = {
  streamFactory: () => Readable;
  epochs: number;
};
