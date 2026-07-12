export type UploadStatus =
  "uploading" | "finalizing" | "completed" | "failed" | "canceled" | "expired";

export interface UploadSession {
  uploadId: string;
  filename: string;
  contentType: string;
  owner?: string;
  sizeBytes: number;
  chunkSize: number;
  totalChunks: number;
  receivedChunks: number[];
  resolvedEpochs: number;
  status: UploadStatus;
  checksum?: string;
  targetChain?: string;
  createdAt: number;
  expiresAt: number;
}
