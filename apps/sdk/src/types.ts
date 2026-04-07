export type FloeFetch = typeof fetch;

export type HeaderValue = string | number | boolean;

export type HeaderRecord = Record<string, HeaderValue | null | undefined>;

export type AuthConfig = {
  apiKey?: string;
  bearerToken?: string;
  authUser?: string;
  walletAddress?: string;
  ownerAddress?: string;
};

export type HeaderProvider = HeaderRecord | (() => HeaderRecord | Promise<HeaderRecord>);

export type RetryConfig = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryOnStatuses?: number[];
};

export type FloeCompatibilityTarget = "sdk" | "cli";

export type FloeCompatibilityCheckMode = "off" | "warn";

export type ResumeStore = {
  get(key: string): string | null | undefined | Promise<string | null | undefined>;
  set(key: string, uploadId: string): void | Promise<void>;
  remove(key: string): void | Promise<void>;
};

export type FloeClientConfig = {
  baseUrl?: string;
  fetch?: FloeFetch;
  timeoutMs?: number;
  retry?: RetryConfig;
  auth?: AuthConfig;
  headers?: HeaderProvider;
  userAgent?: string;
  resumeStore?: ResumeStore;
  compatibilityCheck?: FloeCompatibilityCheckMode;
};

export type CreateUploadInput = {
  filename: string;
  contentType: string;
  sizeBytes: number;
  chunkSize?: number;
  epochs?: number;
};

export type CreateUploadResponse = {
  uploadId: string;
  chunkSize: number;
  totalChunks: number;
  epochs: number;
  expiresAt: number;
};

export type UploadStatus =
  | "pending"
  | "uploading"
  | "finalizing"
  | "completed"
  | "failed"
  | "expired"
  | "canceled";

export type CancelUploadStatus = "canceled" | "failed" | "expired";

export type FinalizeDiagnostics = {
  pollAfterMs?: number;
  finalizeAttemptState?: "running" | "retryable_failure" | "terminal_failure" | "completed";
  finalizeAttempts?: number;
  lastFinalizeRetryDelayMs?: number;
  failedReasonCode?: string;
  failedRetryable?: boolean;
  finalizeWarning?: string;
  finalizeWarningAt?: number;
};

export type UploadStatusResponse = {
  uploadId: string;
  chunkSize: number | null;
  totalChunks: number | null;
  receivedChunks: number[];
  receivedChunkCount: number;
  expiresAt: number | null;
  status: UploadStatus;
  fileId?: string;
  blobId?: string;
  walrusEndEpoch?: number;
  error?: string;
} & FinalizeDiagnostics;

export type CompleteUploadReadyResponse = {
  fileId: string;
  blobId?: string;
  sizeBytes: number;
  status: "ready";
  walrusEndEpoch?: number;
};

export type CompleteUploadFinalizingResponse = {
  uploadId: string;
  status: "finalizing";
  pollAfterMs?: number;
  enqueued?: boolean;
  inProgress?: boolean;
} & FinalizeDiagnostics;

export type CompleteUploadResponse =
  | CompleteUploadReadyResponse
  | CompleteUploadFinalizingResponse;

export type FileMetadataResponse = {
  fileId: string;
  manifestVersion: number;
  container: string | null;
  blobId?: string;
  sizeBytes: number;
  mimeType: string;
  owner: unknown;
  createdAt: number;
  walrusEndEpoch?: number;
  streamUrl?: string;
};

export type FileManifestSegment = {
  index: number;
  offsetBytes: number;
  sizeBytes: number;
  blobId?: string;
};

export type FileManifestResponse = {
  fileId: string;
  manifestVersion: number;
  container: string | null;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  walrusEndEpoch?: number;
  streamUrl?: string;
  layout: {
    type: "walrus_single_blob";
    segments: FileManifestSegment[];
  };
};

export type UploadProgress = {
  uploadId: string;
  uploadedChunks: number;
  totalChunks: number;
  uploadedBytes: number;
  totalBytes: number;
};

export type UploadStage =
  | "resuming"
  | "creating_upload"
  | "uploading_chunks"
  | "finalizing"
  | "polling_finalize"
  | "completed";

export type UploadStageEvent = {
  stage: UploadStage;
  uploadId?: string;
  resumed?: boolean;
  uploadIdFromStore?: boolean;
  fileId?: string;
  pollAfterMs?: number;
  attempt?: number;
};

export type UploadBlobOptions = {
  filename: string;
  contentType?: string;
  chunkSize?: number;
  epochs?: number;
  parallel?: number;
  uploadId?: string;
  resumeKey?: string;
  includeBlobId?: boolean;
  finalizeMaxWaitMs?: number;
  finalizePollIntervalMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  onStageChange?: (event: UploadStageEvent) => void;
};

export type UploadFileOptions = Omit<UploadBlobOptions, "filename"> & {
  filename?: string;
};

export type UploadBlobResult = {
  uploadId: string;
  fileId: string;
  sizeBytes: number;
  status: "ready";
  blobId?: string;
  walrusEndEpoch?: number;
  chunkSize: number;
  totalChunks: number;
};

export type WaitForUploadReadyOptions = {
  includeBlobId?: boolean;
  maxWaitMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onStageChange?: (event: UploadStageEvent) => void;
};

export type FloeNodeRole = "read" | "write" | "full";

export type FloeDependencyState = "healthy" | "degraded" | "unavailable" | "disabled";

export type FloeHealthStatus = "UP" | "DEGRADED" | "DOWN";

export type FloeHealthRedisCheck = {
  ok: boolean;
  latencyMs: number | null;
  status: FloeDependencyState;
  timestamp: string;
};

export type FloeHealthPostgresCheck = {
  configured: boolean;
  enabled: boolean;
  required: boolean;
  ok: boolean | null;
  latencyMs: number | null;
  status: FloeDependencyState;
};

export type FloeHealthFinalizeQueueCheck = {
  depth: number | null;
  pendingUnique: number | null;
  activeLocal: number | null;
  concurrency: number | null;
  oldestQueuedAt: number | null;
  oldestQueuedAgeMs: number | null;
};

export type FloeWalrusReaders = {
  primary: string | null;
  fallbacks: string[];
  count: number;
};

export type FloeWalrusWriters = Record<string, unknown> & {
  mode: "publisher" | "cli";
  primary?: string | null;
  fallbacks?: string[];
  count?: number;
  cliBin?: string | null;
  cliConfig?: string | null;
  cliWallet?: string | null;
  uploadRelay?: string | null;
};

export type FloeCompatibilityRanges = {
  sdk: string;
  cli: string;
};

export type FloeVersionResponse = {
  service: string;
  apiVersion: string;
  serverVersion: string;
  compatibility: FloeCompatibilityRanges;
};

export type FloeCompatibilityFailureReason =
  | "outside_supported_range"
  | "invalid_current_version"
  | "invalid_supported_range";

export type FloeCompatibilityCheckResult = FloeVersionResponse & {
  target: FloeCompatibilityTarget;
  currentVersion: string;
  supportedRange: string;
  compatible: boolean;
  reason?: FloeCompatibilityFailureReason;
};

export type FloeHealthResponse = {
  httpStatus: 200 | 503;
  apiVersion: string;
  serverVersion: string;
  compatibility: FloeCompatibilityRanges;
  role: FloeNodeRole;
  capabilities: {
    uploads: boolean;
    files: boolean;
    ops: boolean;
    finalizeWorker: boolean;
  };
  walrus: {
    readers: FloeWalrusReaders;
    writers: FloeWalrusWriters;
  };
  status: FloeHealthStatus;
  service: string;
  ready: boolean;
  degraded: boolean;
  timestamp: string;
  checks: {
    redis: FloeHealthRedisCheck;
    postgres: FloeHealthPostgresCheck;
    finalizeQueue: FloeHealthFinalizeQueueCheck;
    finalizeQueueWarning: string | null;
  };
};

export type RequestOptions = {
  signal?: AbortSignal;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: HeaderRecord;
};

export type JsonRequestOptions = RequestOptions & {
  json?: unknown;
  body?: BodyInit;
};

export type FileStreamOptions = RequestOptions & {
  rangeStart?: number;
  rangeEnd?: number;
};

export type FileMetadataSource = "memory" | "postgres" | "sui" | "unknown";

export type FilePostgresState = "disabled" | "healthy" | "degraded" | "unknown";

export type FileStreamResponseInfo = {
  status: 200 | 206;
  contentType?: string;
  contentLength?: number;
  contentRange?: string;
  etag?: string;
  acceptRanges?: string;
  metadataSource?: FileMetadataSource;
  postgresState?: FilePostgresState;
};

export type FileStreamHeadResult = FileStreamResponseInfo & {
  response: Response;
};

export type DownloadFileToPathOptions = FileStreamOptions & {
  createDirectories?: boolean;
  overwrite?: boolean;
};

export type DownloadFileToPathResult = FileStreamResponseInfo & {
  path: string;
  bytesWritten: number;
};
