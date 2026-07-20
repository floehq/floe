/**
 * @module @floehq/sdk
 *
 * The Floe SDK provides a TypeScript client for interacting with the Floe
 * media storage and streaming API. It supports chunked uploads with resume,
 * parallel chunk workers, streaming downloads, file metadata, Walrus
 * compatibility checks, and health monitoring.
 *
 * @example
 * ```ts
 * import { FloeClient } from "@floehq/sdk";
 *
 * const client = new FloeClient({
 *   baseUrl: "https://api.floe.tech/v1",
 *   auth: { apiKey: "sk_..." },
 * });
 *
 * const { fileId } = await client.uploadBlob(blob, { filename: "clip.mp4" });
 * const bytes = await client.downloadFile(fileId);
 * ```
 */

export { FloeClient, SDK_VERSION } from "./client.js";
export { FloeError, FloeApiError, isFloeApiError } from "./errors.js";
export { createBrowserLocalStorageResumeStore, createNodeFileResumeStore } from "./resume.js";
export type {
  AuthConfig,
  CancelUploadStatus,
  CompleteUploadResponse,
  CompleteUploadFinalizingResponse,
  CompleteUploadReadyResponse,
  CreateUploadInput,
  CreateUploadResponse,
  DownloadFileToPathOptions,
  DownloadFileToPathResult,
  FloeCompatibilityCheckMode,
  FloeCompatibilityCheckResult,
  FloeCompatibilityFailureReason,
  FloeCompatibilityRanges,
  FloeCompatibilityTarget,
  FileMetadataSource,
  FileManifestResponse,
  FileMetadataResponse,
  FilePostgresState,
  FileStreamHeadResult,
  FileStreamOptions,
  FileStreamResponseInfo,
  FinalizeDiagnostics,
  FloeDependencyState,
  FloeClientConfig,
  FloeHealthResponse,
  FloeHealthStatus,
  FloeNodeRole,
  FloeVersionResponse,
  RequestOptions,
  ResumeStore,
  RetryConfig,
  UploadBlobOptions,
  UploadBlobResult,
  UploadFileOptions,
  UploadProgress,
  UploadStage,
  UploadStageEvent,
  UploadStatus,
  UploadStatusResponse,
  WalrusDebugInfo,
  WaitForUploadReadyOptions,
} from "./types.js";
