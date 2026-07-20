/**
 * The native `fetch` function signature used by the SDK for HTTP requests.
 */
export type FloeFetch = typeof fetch;

/**
 * A value that can be used in an HTTP header (string, number, or boolean).
 */
export type HeaderValue = string | number | boolean;

/**
 * A record of HTTP header name/value pairs where values may be null or undefined
 * (in which case they are omitted when applied).
 */
export type HeaderRecord = Record<string, HeaderValue | null | undefined>;

/**
 * Authentication configuration for the Floe client.
 *
 * @remarks
 * Supply one or more authentication methods. When multiple are provided,
 * all applicable headers are sent. Wallet/owner addresses must be valid
 * 32-byte Sui addresses (64 hex characters, optionally prefixed with `0x`).
 */
export type AuthConfig = {
  /** API key sent via the `x-api-key` header. */
  apiKey?: string;
  /** Bearer token sent via the `Authorization` header. */
  bearerToken?: string;
  /** User identifier sent via the `x-auth-user` header. */
  authUser?: string;
  /** Sui wallet address sent via the `x-wallet-address` header. */
  walletAddress?: string;
  /** Sui owner address sent via the `x-owner-address` header. */
  ownerAddress?: string;
};

/**
 * A static header record or an async function that returns one.
 *
 * @remarks
 * Use a function when headers must be resolved dynamically (e.g., fetching
 * a fresh token on each request).
 */
export type HeaderProvider = HeaderRecord | (() => HeaderRecord | Promise<HeaderRecord>);

/**
 * Configuration for automatic request retries with exponential back-off.
 */
export type RetryConfig = {
  /** Maximum number of attempts (including the initial request). Default: `4`. */
  maxAttempts?: number;
  /** Base delay in milliseconds before the first retry. Default: `300`. */
  baseDelayMs?: number;
  /** Upper bound for the computed back-off delay. Default: `5000`. */
  maxDelayMs?: number;
  /** HTTP status codes that trigger a retry. Default: `[408, 425, 429, 500, 502, 503, 504]`. */
  retryOnStatuses?: number[];
};

/**
 * Identifies which product the SDK compatibility check should target.
 */
export type FloeCompatibilityTarget = "sdk" | "cli";

/**
 * Controls how the SDK reports version incompatibility with the server.
 *
 * - `"off"` — no automatic checks.
 * - `"warn"` — a `console.warn` is emitted on the first non-health request
 *   when the client version falls outside the server's supported range.
 */
export type FloeCompatibilityCheckMode = "off" | "warn";

/**
 * An adapter that persists upload resume tokens so interrupted uploads can
 * resume without re-uploading completed chunks.
 *
 * @remarks
 * The SDK ships with browser (`localStorage`) and Node.js (file-based)
 * implementations. You may provide a custom implementation for other runtimes.
 */
export type ResumeStore = {
  /** Retrieve the stored upload ID for `key`, or `null` / `undefined` if absent. */
  get(key: string): string | null | undefined | Promise<string | null | undefined>;
  /** Persist `uploadId` under `key`. */
  set(key: string, uploadId: string): void | Promise<void>;
  /** Remove the entry for `key`. */
  remove(key: string): void | Promise<void>;
};

/**
 * Configuration for {@link FloeClient}.
 *
 * @example
 * ```ts
 * const client = new FloeClient({
 *   baseUrl: "https://api.example.com/v1",
 *   auth: { apiKey: "sk_..." },
 *   timeoutMs: 60_000,
 * });
 * ```
 */
export type FloeClientConfig = {
  /** Base URL of the Floe server (default: `http://127.0.0.1:3001/v1`). */
  baseUrl?: string;
  /** Custom `fetch` implementation. Falls back to `globalThis.fetch`. */
  fetch?: FloeFetch;
  /** Per-request timeout in milliseconds (default: `30000`). */
  timeoutMs?: number;
  /** Retry configuration merged with SDK defaults. */
  retry?: RetryConfig;
  /** Authentication credentials. */
  auth?: AuthConfig;
  /** Static headers or an async provider that supplies them. */
  headers?: HeaderProvider;
  /** User-Agent identifier sent as the `x-floe-sdk` header (default: `@floehq/sdk`). */
  userAgent?: string;
  /** Adapter for persisting upload resume tokens. */
  resumeStore?: ResumeStore;
  /** Compatibility check mode (default: `"off"`). */
  compatibilityCheck?: FloeCompatibilityCheckMode;
};

/**
 * Input parameters for initiating a new upload session via
 * {@link FloeClient.createUpload}.
 */
export type CreateUploadInput = {
  /** Original filename of the asset being uploaded. */
  filename: string;
  /** MIME type of the file (e.g., `"video/mp4"`). */
  contentType: string;
  /** Total size of the file in bytes. */
  sizeBytes: number;
  /** Optional SHA-256 hex digest of the file contents. */
  checksum?: string;
  /** Desired chunk size in bytes. The server may adjust this. */
  chunkSize?: number;
  /** Number of Walrus storage epochs to persist the blob for. */
  epochs?: number;
};

/**
 * Response returned after a successful {@link FloeClient.createUpload} call.
 */
export type CreateUploadResponse = {
  /** Unique identifier for the upload session. */
  uploadId: string;
  /** Final chunk size in bytes (may differ from the requested value). */
  chunkSize: number;
  /** Total number of chunks the file is divided into. */
  totalChunks: number;
  /** Number of Walrus epochs the blob will be stored for. */
  epochs: number;
  /** Unix timestamp (ms) when the upload session expires. */
  expiresAt: number;
};

/**
 * Lifecycle status of an upload session.
 */
export type UploadStatus =
  | "pending"
  | "uploading"
  | "finalizing"
  | "completed"
  | "failed"
  | "expired"
  | "canceled";

/**
 * Status values returned when an upload is successfully canceled.
 */
export type CancelUploadStatus = "canceled" | "failed" | "expired";

/**
 * Diagnostics returned by the server during finalization polling.
 */
export type FinalizeDiagnostics = {
  /** Suggested delay before the next poll, in milliseconds. */
  pollAfterMs?: number;
  /** Current state of the server-side finalize worker. */
  finalizeAttemptState?: "running" | "retryable_failure" | "terminal_failure" | "completed";
  /** Number of finalize attempts the server has made so far. */
  finalizeAttempts?: number;
  /** Delay in milliseconds the server used before its last retry. */
  lastFinalizeRetryDelayMs?: number;
  /** Machine-readable reason code if finalization failed. */
  failedReasonCode?: string;
  /** Whether the failure is considered retryable by the server. */
  failedRetryable?: boolean;
  /** Human-readable warning emitted during finalization. */
  finalizeWarning?: string;
  /** Unix timestamp (ms) when the warning was generated. */
  finalizeWarningAt?: number;
};

/**
 * Debug metadata about the underlying Walrus blob.
 */
export type WalrusDebugInfo = {
  /** Origin description (e.g., which publisher handled the blob). */
  source?: string;
  /** On-chain object ID of the Walrus blob. */
  objectId?: string;
};

/**
 * Response from {@link FloeClient.getUploadStatus}.
 *
 * @remarks
 * Inherits {@link FinalizeDiagnostics} fields — check `status` to determine
 * the current lifecycle stage, and the diagnostic fields for polling guidance.
 */
export type UploadStatusResponse = {
  /** Unique identifier for the upload session. */
  uploadId: string;
  /** Chunk size in bytes, or `null` if not yet determined. */
  chunkSize: number | null;
  /** Total number of chunks, or `null` if not yet determined. */
  totalChunks: number | null;
  /** Indices of chunks that have been received by the server. */
  receivedChunks: number[];
  /** Number of chunks received so far. */
  receivedChunkCount: number;
  /** Unix timestamp (ms) when the upload session expires, or `null`. */
  expiresAt: number | null;
  /** Current lifecycle status of the upload. */
  status: UploadStatus;
  /** File identifier, present once the upload is completed. */
  fileId?: string;
  /** Walrus blob identifier, if requested and available. */
  blobId?: string;
  /** Walrus epoch after which the blob will expire. */
  walrusEndEpoch?: number;
  /** Debug information about the Walrus blob. */
  walrusDebug?: WalrusDebugInfo;
  /** Error message when `status` is `"failed"`. */
  error?: string;
} & FinalizeDiagnostics;

/**
 * Response when an upload completes immediately (server already has the blob).
 */
export type CompleteUploadReadyResponse = {
  /** The file identifier for the completed upload. */
  fileId: string;
  /** Walrus blob identifier, if requested. */
  blobId?: string;
  /** Total size of the file in bytes. */
  sizeBytes: number;
  /** Always `"ready"` when the upload is complete. */
  status: "ready";
  /** Walrus epoch after which the blob will expire. */
  walrusEndEpoch?: number;
  /** Debug information about the Walrus blob. */
  walrusDebug?: WalrusDebugInfo;
};

/**
 * Response when finalization is still in progress — the caller should poll.
 */
export type CompleteUploadFinalizingResponse = {
  /** Unique identifier for the upload session. */
  uploadId: string;
  /** Always `"finalizing"`. */
  status: "finalizing";
  /** Suggested delay in milliseconds before the next poll. */
  pollAfterMs?: number;
  /** Whether the finalization job is enqueued in the worker queue. */
  enqueued?: boolean;
  /** Whether the finalization worker is actively processing this upload. */
  inProgress?: boolean;
} & FinalizeDiagnostics;

/**
 * Discriminated union returned by {@link FloeClient.completeUpload}.
 *
 * @remarks
 * Check the `status` field to determine whether the upload completed
 * (`"ready"`) or is still finalizing (`"finalizing"`).
 */
export type CompleteUploadResponse = CompleteUploadReadyResponse | CompleteUploadFinalizingResponse;

/**
 * Walrus storage expiry information for a stored blob.
 */
export type WalrusExpiryStatus = {
  /** Current Walrus epoch. */
  currentEpoch: number;
  /** Epoch when the blob expires. */
  endEpoch: number;
  /** Number of epochs remaining before expiry. */
  epochsRemaining: number;
  /** Estimated number of days remaining before expiry. */
  estimatedDaysRemaining: number;
  /** Whether the blob has already expired. */
  isExpired: boolean;
};

/**
 * Response from {@link FloeClient.getFileMetadata}.
 */
export type FileMetadataResponse = {
  /** Unique file identifier. */
  fileId: string;
  /** Version of the manifest format used. */
  manifestVersion: number;
  /** Storage container name, or `null` if not applicable. */
  container: string | null;
  /** Walrus blob identifier, if available. */
  blobId?: string;
  /** On-chain Walrus blob object ID, if available. */
  blobObjectId?: string;
  /** Total file size in bytes. */
  sizeBytes: number;
  /** MIME type of the file. */
  mimeType: string;
  /** Owner of the file (opaque type). */
  owner: unknown;
  /** Unix timestamp (ms) when the file was created. */
  createdAt: number;
  /** Walrus epoch when the blob expires. */
  walrusEndEpoch?: number;
  /** Expiry status of the underlying Walrus blob. */
  expiryStatus?: WalrusExpiryStatus;
  /** URL for streaming the file, if available. */
  streamUrl?: string;
};

/**
 * A single segment within a file's manifest describing a chunk's position.
 */
export type FileManifestSegment = {
  /** Zero-based index of the segment. */
  index: number;
  /** Byte offset where this segment begins within the file. */
  offsetBytes: number;
  /** Size of this segment in bytes. */
  sizeBytes: number;
  /** Walrus blob identifier for this segment, if available. */
  blobId?: string;
};

/**
 * Response from {@link FloeClient.getFileManifest}.
 *
 * @remarks
 * Describes the layout of a file split into one or more segments.
 */
export type FileManifestResponse = {
  /** Unique file identifier. */
  fileId: string;
  /** Version of the manifest format used. */
  manifestVersion: number;
  /** Storage container name, or `null`. */
  container: string | null;
  /** MIME type of the file. */
  mimeType: string;
  /** Total file size in bytes. */
  sizeBytes: number;
  /** Unix timestamp (ms) when the file was created. */
  createdAt: number;
  /** Walrus epoch when the blob expires. */
  walrusEndEpoch?: number;
  /** Expiry status of the underlying Walrus blob. */
  expiryStatus?: WalrusExpiryStatus;
  /** URL for streaming the file, if available. */
  streamUrl?: string;
  /** Layout describing how the file is stored as Walrus blobs. */
  layout: {
    /** Storage layout type. Always `"walrus_single_blob"`. */
    type: "walrus_single_blob";
    /** Ordered list of segments that make up the file. */
    segments: FileManifestSegment[];
  };
};

/**
 * Response from {@link FloeClient.renewFile}.
 */
export type FileRenewResponse = {
  /** Whether the renewal was successful. */
  success: boolean;
  /** The file identifier that was renewed. */
  fileId: string;
  /** New Walrus epoch after which the blob will expire. */
  walrusEndEpoch: number;
};

/**
 * Options for {@link FloeClient.renewFile}.
 */
export type RenewFileOptions = RequestOptions & {
  /** Number of additional Walrus epochs to extend storage by. */
  epochs: number;
  /** On-chain object ID of the Walrus blob, if known. */
  blobObjectId?: string;
};

/**
 * Progress information emitted during chunked uploads.
 */
export type UploadProgress = {
  /** Upload session identifier. */
  uploadId: string;
  /** Number of chunks successfully uploaded so far. */
  uploadedChunks: number;
  /** Total number of chunks in the upload. */
  totalChunks: number;
  /** Number of bytes uploaded so far. */
  uploadedBytes: number;
  /** Total size of the file in bytes. */
  totalBytes: number;
};

/**
 * High-level stages of the {@link FloeClient.uploadBlob} workflow.
 */
export type UploadStage =
  | "resuming"
  | "creating_upload"
  | "uploading_chunks"
  | "finalizing"
  | "polling_finalize"
  | "completed";

/**
 * Event object emitted via the `onStageChange` callback during uploads.
 */
export type UploadStageEvent = {
  /** Current stage of the upload workflow. */
  stage: UploadStage;
  /** Upload session identifier. */
  uploadId?: string;
  /** Whether this upload was resumed from a previous session. */
  resumed?: boolean;
  /** Whether the resume token came from the resume store. */
  uploadIdFromStore?: boolean;
  /** File identifier, available once the upload reaches `"completed"`. */
  fileId?: string;
  /** Suggested delay before the next poll during `"polling_finalize"`. */
  pollAfterMs?: number;
  /** Poll attempt number during `"polling_finalize"`. */
  attempt?: number;
};

/**
 * Options for {@link FloeClient.uploadBlob} and {@link FloeClient.uploadBytes}.
 *
 * @example
 * ```ts
 * const result = await client.uploadBlob(blob, {
 *   filename: "video.mp4",
 *   contentType: "video/mp4",
 *   parallel: 4,
 *   onProgress: (p) => console.log(`${p.uploadedChunks}/${p.totalChunks}`),
 * });
 * ```
 */
export type UploadBlobOptions = {
  /** Original filename of the asset. */
  filename: string;
  /** MIME type. Inferred from the Blob if omitted. */
  contentType?: string;
  /** Pre-computed SHA-256 hex digest of the entire file. */
  checksum?: string;
  /** Desired chunk size in bytes. The server may adjust this. */
  chunkSize?: number;
  /** Number of Walrus epochs to store the blob for. */
  epochs?: number;
  /** Maximum number of parallel chunk uploads (default: `3`). */
  parallel?: number;
  /** Existing upload ID to resume (takes priority over resume store). */
  uploadId?: string;
  /** Custom key for the resume store. Derived from file metadata if omitted. */
  resumeKey?: string;
  /** When `true`, include the Walrus blob ID in the response. */
  includeBlobId?: boolean;
  /** When `true`, include Walrus debug info in the response. */
  includeWalrusDebug?: boolean;
  /** Idempotency key sent with the create-upload request. */
  idempotencyKey?: string;
  /** Maximum time in ms to wait for finalization (default: 1 hour). */
  finalizeMaxWaitMs?: number;
  /** Interval in ms between finalization polls (default: `5000`). */
  finalizePollIntervalMs?: number;
  /** `AbortSignal` to cancel the upload. */
  signal?: AbortSignal;
  /** Callback invoked with upload progress after each chunk. */
  onProgress?: (progress: UploadProgress) => void;
  /** Callback invoked when the upload workflow changes stage. */
  onStageChange?: (event: UploadStageEvent) => void;
};

/**
 * Options for {@link FloeClient.uploadFile}.
 *
 * @remarks
 * Extends {@link UploadBlobOptions} with the `filename` field made optional
 * (it defaults to the basename of the file path).
 */
export type UploadFileOptions = Omit<UploadBlobOptions, "filename"> & {
  /** Filename override. Defaults to the basename of the file path. */
  filename?: string;
};

/**
 * Result returned by {@link FloeClient.uploadBlob}, {@link FloeClient.uploadBytes},
 * and {@link FloeClient.uploadFile} on success.
 */
export type UploadBlobResult = {
  /** Upload session identifier. */
  uploadId: string;
  /** File identifier for the completed upload. */
  fileId: string;
  /** Total size of the file in bytes. */
  sizeBytes: number;
  /** Always `"ready"` on success. */
  status: "ready";
  /** Walrus blob identifier, if requested. */
  blobId?: string;
  /** Walrus epoch after which the blob expires. */
  walrusEndEpoch?: number;
  /** Walrus debug information, if requested. */
  walrusDebug?: WalrusDebugInfo;
  /** Chunk size in bytes used for the upload. */
  chunkSize: number;
  /** Total number of chunks uploaded. */
  totalChunks: number;
};

/**
 * Options for {@link FloeClient.waitForUploadReady}.
 */
export type WaitForUploadReadyOptions = {
  /** Include the Walrus blob ID in the response. */
  includeBlobId?: boolean;
  /** Include Walrus debug info in the response. */
  includeWalrusDebug?: boolean;
  /** Maximum time in ms to wait (default: 1 hour). */
  maxWaitMs?: number;
  /** Interval in ms between polls (default: `5000`). */
  pollIntervalMs?: number;
  /** `AbortSignal` to cancel waiting. */
  signal?: AbortSignal;
  /** Callback invoked when the polling stage changes. */
  onStageChange?: (event: UploadStageEvent) => void;
};

/**
 * Permission level for a Floe node.
 */
export type FloeNodeRole = "read" | "write" | "full";

/**
 * Health state of a server dependency.
 */
export type FloeDependencyState = "healthy" | "degraded" | "unavailable" | "disabled";

/**
 * Top-level health status of the Floe server.
 */
export type FloeHealthStatus = "UP" | "DEGRADED" | "DOWN";

/**
 * Health check result for the Redis dependency.
 */
export type FloeHealthRedisCheck = {
  /** Whether Redis is responding. */
  ok: boolean;
  /** Response latency in milliseconds, or `null` if unavailable. */
  latencyMs: number | null;
  /** Dependency state. */
  status: FloeDependencyState;
  /** ISO-8601 timestamp of the check. */
  timestamp: string;
};

/**
 * Health check result for the PostgreSQL dependency.
 */
export type FloeHealthPostgresCheck = {
  /** Whether PostgreSQL is configured. */
  configured: boolean;
  /** Whether PostgreSQL is enabled. */
  enabled: boolean;
  /** Whether PostgreSQL is required for normal operation. */
  required: boolean;
  /** Whether PostgreSQL is responding, or `null` if not checked. */
  ok: boolean | null;
  /** Response latency in milliseconds, or `null` if unavailable. */
  latencyMs: number | null;
  /** Dependency state. */
  status: FloeDependencyState;
};

/**
 * Health check result for the finalization worker queue.
 */
export type FloeHealthFinalizeQueueCheck = {
  /** Number of jobs in the queue, or `null`. */
  depth: number | null;
  /** Number of unique uploads awaiting finalization, or `null`. */
  pendingUnique: number | null;
  /** Number of uploads being finalized concurrently by this node, or `null`. */
  activeLocal: number | null;
  /** Maximum concurrency for the finalization worker, or `null`. */
  concurrency: number | null;
  /** Unix timestamp (ms) of the oldest queued job, or `null`. */
  oldestQueuedAt: number | null;
  /** Age of the oldest queued job in milliseconds, or `null`. */
  oldestQueuedAgeMs: number | null;
};

/**
 * Walrus reader (downloader) configuration.
 */
export type FloeWalrusReaders = {
  /** Primary reader endpoint, or `null` if not configured. */
  primary: string | null;
  /** Fallback reader endpoints. */
  fallbacks: string[];
  /** Total number of configured readers. */
  count: number;
};

/**
 * Walrus writer (uploader) configuration.
 *
 * @remarks
 * When `mode` is `"cli"`, the SDK interacts with the Walrus CLI binary
 * directly. When `"publisher"`, it uses a publisher HTTP endpoint.
 */
export type FloeWalrusWriters = Record<string, unknown> & {
  /** How the server publishes blobs — via a publisher endpoint or the CLI. */
  mode: "publisher" | "cli";
  /** Primary publisher endpoint, or `null`. */
  primary?: string | null;
  /** Fallback publisher endpoints. */
  fallbacks?: string[];
  /** Total number of configured writers. */
  count?: number;
  /** Path to the Walrus CLI binary (when `mode` is `"cli"`). */
  cliBin?: string | null;
  /** Path to the Walrus CLI config file. */
  cliConfig?: string | null;
  /** Wallet identifier used by the CLI. */
  cliWallet?: string | null;
  /** Upload relay endpoint, if configured. */
  uploadRelay?: string | null;
};

/**
 * Semver compatibility ranges supported by the Floe server.
 */
export type FloeCompatibilityRanges = {
  /** Semver range of SDK versions compatible with this server. */
  sdk: string;
  /** Semver range of CLI versions compatible with this server. */
  cli: string;
};

/**
 * Response from {@link FloeClient.getVersion}.
 */
export type FloeVersionResponse = {
  /** Service name (e.g., `"floe"`). */
  service: string;
  /** API version string. */
  apiVersion: string;
  /** Server software version string. */
  serverVersion: string;
  /** Compatibility ranges for supported SDK and CLI versions. */
  compatibility: FloeCompatibilityRanges;
};

/**
 * Reason a compatibility check failed.
 */
export type FloeCompatibilityFailureReason =
  | "outside_supported_range"
  | "invalid_current_version"
  | "invalid_supported_range";

/**
 * Result of a version compatibility check performed by
 * {@link FloeClient.checkCompatibility}.
 *
 * @remarks
 * Extends {@link FloeVersionResponse} with the check result and metadata
 * about the versions compared.
 */
export type FloeCompatibilityCheckResult = FloeVersionResponse & {
  /** Which client type was checked. */
  target: FloeCompatibilityTarget;
  /** The version string of the client being checked. */
  currentVersion: string;
  /** The server's supported semver range for the target. */
  supportedRange: string;
  /** Whether the client version is within the supported range. */
  compatible: boolean;
  /** Reason code when `compatible` is `false`. */
  reason?: FloeCompatibilityFailureReason;
};

/**
 * Response from {@link FloeClient.getHealth}.
 *
 * @remarks
 * The `httpStatus` field is `200` when healthy and `503` when degraded or down.
 */
export type FloeHealthResponse = {
  /** HTTP status code of the health endpoint (`200` or `503`). */
  httpStatus: 200 | 503;
  /** API version string. */
  apiVersion: string;
  /** Server software version string. */
  serverVersion: string;
  /** Compatibility ranges for supported SDK and CLI versions. */
  compatibility: FloeCompatibilityRanges;
  /** Permission role of this server node. */
  role: FloeNodeRole;
  /** Capabilities enabled on this node. */
  capabilities: {
    /** Whether the node can accept uploads. */
    uploads: boolean;
    /** Whether the node can serve file data. */
    files: boolean;
    /** Whether operational endpoints are available. */
    ops: boolean;
    /** Whether the finalization worker is active. */
    finalizeWorker: boolean;
  };
  /** Walrus reader and writer configuration. */
  walrus: {
    /** Reader (downloader) configuration. */
    readers: FloeWalrusReaders;
    /** Writer (uploader) configuration. */
    writers: FloeWalrusWriters;
  };
  /** Overall health status. */
  status: FloeHealthStatus;
  /** Service name. */
  service: string;
  /** Whether the server is ready to accept traffic. */
  ready: boolean;
  /** Whether the server is operating in a degraded state. */
  degraded: boolean;
  /** ISO-8601 timestamp of the health check. */
  timestamp: string;
  /** Per-dependency health checks. */
  checks: {
    /** Redis health. */
    redis: FloeHealthRedisCheck;
    /** PostgreSQL health. */
    postgres: FloeHealthPostgresCheck;
    /** Finalization queue health. */
    finalizeQueue: FloeHealthFinalizeQueueCheck;
    /** Warning message related to the finalization queue, if any. */
    finalizeQueueWarning: string | null;
  };
};

/**
 * Base options for SDK request methods.
 *
 * @remarks
 * Most client methods accept this type to allow callers to attach an
 * abort signal, query parameters, extra headers, and an idempotency key.
 */
export type RequestOptions = {
  /** `AbortSignal` to cancel the request. */
  signal?: AbortSignal;
  /** URL query parameters appended to the request. */
  query?: Record<string, string | number | boolean | undefined>;
  /** Additional HTTP headers merged with SDK defaults. */
  headers?: HeaderRecord;
  /** Idempotency key sent as the `idempotency-key` header. */
  idempotencyKey?: string;
};

/**
 * Extends {@link RequestOptions} with a JSON body or raw `BodyInit`.
 */
export type JsonRequestOptions = RequestOptions & {
  /** Object to be serialized as the JSON request body. */
  json?: unknown;
  /** Raw request body (takes precedence over `json` when both are set). */
  body?: BodyInit;
};

/**
 * Options for streaming and downloading file data.
 */
export type FileStreamOptions = RequestOptions & {
  /** Start byte of the range (inclusive). */
  rangeStart?: number;
  /** End byte of the range (inclusive). */
  rangeEnd?: number;
};

/**
 * Where the file metadata was loaded from.
 */
export type FileMetadataSource = "memory" | "postgres" | "sui" | "unknown";

/**
 * PostgreSQL state as reported by the server for metadata lookups.
 */
export type FilePostgresState = "disabled" | "healthy" | "degraded" | "unknown";

/**
 * Response metadata extracted from a file stream or HEAD request.
 */
export type FileStreamResponseInfo = {
  /** HTTP status code (`200` for full, `206` for partial content). */
  status: 200 | 206;
  /** MIME type of the response body. */
  contentType?: string;
  /** Total size of the response body in bytes. */
  contentLength?: number;
  /** Value of the `Content-Range` header. */
  contentRange?: string;
  /** Entity tag for cache validation. */
  etag?: string;
  /** Whether the server supports range requests. */
  acceptRanges?: string;
  /** Where the file metadata was loaded from. */
  metadataSource?: FileMetadataSource;
  /** PostgreSQL state for the metadata lookup. */
  postgresState?: FilePostgresState;
};

/**
 * Result of a HEAD request for file streaming.
 */
export type FileStreamHeadResult = FileStreamResponseInfo & {
  /** The raw `Response` object from the HEAD request. */
  response: Response;
};

/**
 * Options for {@link FloeClient.downloadFileToPath}.
 *
 * @remarks
 * Extends {@link FileStreamOptions} with file-system-specific options.
 * This method is only available in Node.js environments.
 */
export type DownloadFileToPathOptions = FileStreamOptions & {
  /** Whether to create intermediate directories (default: `true`). */
  createDirectories?: boolean;
  /** Whether to overwrite an existing file (default: `true`). */
  overwrite?: boolean;
};

/**
 * Result of {@link FloeClient.downloadFileToPath}.
 */
export type DownloadFileToPathResult = FileStreamResponseInfo & {
  /** Absolute path the file was written to. */
  path: string;
  /** Number of bytes written to disk. */
  bytesWritten: number;
};
