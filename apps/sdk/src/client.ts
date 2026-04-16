import { headersFromAuth, resolveHeaderProvider } from "./auth.js";
import { FloeApiError, FloeError } from "./errors.js";
import { createBrowserLocalStorageResumeStore } from "./resume.js";
import type {
  CancelUploadStatus,
  CompleteUploadReadyResponse,
  CompleteUploadResponse,
  CreateUploadInput,
  CreateUploadResponse,
  DownloadFileToPathOptions,
  DownloadFileToPathResult,
  FileStreamHeadResult,
  FileStreamResponseInfo,
  FileManifestResponse,
  FileMetadataResponse,
  FileStreamOptions,
  FloeCompatibilityCheckResult,
  FloeCompatibilityTarget,
  FloeClientConfig,
  FloeHealthResponse,
  FloeVersionResponse,
  JsonRequestOptions,
  RequestOptions,
  UploadBlobOptions,
  UploadBlobResult,
  UploadFileOptions,
  UploadStatusResponse,
  WaitForUploadReadyOptions,
} from "./types.js";
import {
  applyHeaders,
  buildQuery,
  chunkByteLength,
  computeBackoffMs,
  isBlobLike,
  joinUrl,
  normalizeBaseUrl,
  parseErrorBodySafe,
  parseRetryAfterMs,
  sha256Hex,
  sleep,
  toApiError,
  withDefaultRetry,
} from "./utils.js";

type ResponseRequestOptions = JsonRequestOptions & {
  acceptedStatuses?: number[];
};

export const SDK_VERSION = "0.2.4";

export class FloeClient {
  static readonly VERSION = SDK_VERSION;
  private static readonly DEFAULT_FINALIZE_MAX_WAIT_MS = 60 * 60_000;
  private static readonly DEFAULT_FINALIZE_POLL_INTERVAL_MS = 5_000;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retry: ReturnType<typeof withDefaultRetry>;
  private readonly authHeaders: Record<string, string>;
  private readonly dynamicHeaders?: FloeClientConfig["headers"];
  private readonly userAgent?: string;
  private readonly resumeStore?: FloeClientConfig["resumeStore"];
  private readonly compatibilityCheckMode: FloeClientConfig["compatibilityCheck"];
  private compatibilityWarningAttempted = false;
  private compatibilityWarningInFlight = false;

  constructor(config: FloeClientConfig = {}) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);

    const rawFetch = config.fetch ?? globalThis.fetch;
    this.fetchImpl = rawFetch ? rawFetch.bind(globalThis) : undefined!;
    if (!this.fetchImpl) {
      throw new FloeError("No fetch implementation available");
    }

    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.retry = withDefaultRetry(config.retry);
    this.authHeaders = headersFromAuth(config.auth);
    this.dynamicHeaders = config.headers;
    this.userAgent = config.userAgent ?? "@floehq/sdk";
    this.resumeStore = config.resumeStore ?? this.resolveDefaultResumeStore();
    this.compatibilityCheckMode = config.compatibilityCheck ?? "off";
  }

  async createUpload(
    input: CreateUploadInput,
    options: RequestOptions = {}
  ): Promise<CreateUploadResponse> {
    return this.requestJson<CreateUploadResponse>("POST", "/uploads/create", {
      ...options,
      json: {
        filename: input.filename,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        chunkSize: input.chunkSize,
        epochs: input.epochs,
      },
    });
  }

  async uploadChunk(
    uploadId: string,
    index: number,
    chunk: Blob,
    sha256: string,
    options: RequestOptions = {}
  ): Promise<{ ok: boolean; chunkIndex: number; reused?: boolean }> {
    const form = new FormData();
    form.set("chunk", chunk, `chunk-${index}`);

    return this.requestJson("PUT", `/uploads/${encodeURIComponent(uploadId)}/chunk/${index}`, {
      ...options,
      headers: {
        ...(options.headers ?? {}),
        "x-chunk-sha256": sha256,
      },
      body: form,
    });
  }

  async getUploadStatus(
    uploadId: string,
    options: RequestOptions & { includeBlobId?: boolean; includeWalrusDebug?: boolean } = {}
  ): Promise<UploadStatusResponse> {
    return this.requestJson("GET", `/uploads/${encodeURIComponent(uploadId)}/status`, {
      ...options,
      query: {
        ...(options.query ?? {}),
        ...(options.includeBlobId ? { includeBlobId: 1 } : {}),
        ...(options.includeWalrusDebug ? { debug: 1 } : {}),
      },
    });
  }

  async completeUpload(
    uploadId: string,
    opts: RequestOptions & { includeBlobId?: boolean; includeWalrusDebug?: boolean } = {}
  ): Promise<CompleteUploadResponse> {
    const response = await this.requestJson<
      CompleteUploadResponse | { status: "ready"; fileId: string }
    >("POST", `/uploads/${encodeURIComponent(uploadId)}/complete`, {
      ...opts,
      query: {
        ...(opts.query ?? {}),
        ...(opts.includeBlobId ? { includeBlobId: 1 } : {}),
        ...(opts.includeWalrusDebug ? { debug: 1 } : {}),
      },
    });

    if (response.status === "ready") {
      return response as CompleteUploadReadyResponse;
    }

    return response as CompleteUploadResponse;
  }

  async cancelUpload(
    uploadId: string,
    options: RequestOptions = {}
  ): Promise<{ ok: true; uploadId: string; status: CancelUploadStatus }> {
    return this.requestJson("DELETE", `/uploads/${encodeURIComponent(uploadId)}`, options);
  }

  async getHealth(options: RequestOptions = {}): Promise<FloeHealthResponse> {
    const response = await this.requestResponse("GET", this.rootPath("/health"), {
      ...options,
      acceptedStatuses: [503],
    });
    const payload = (await response.json()) as Omit<FloeHealthResponse, "httpStatus">;
    return {
      ...payload,
      httpStatus: response.status as 200 | 503,
    };
  }

  async getVersion(options: RequestOptions = {}): Promise<FloeVersionResponse> {
    return this.requestJson<FloeVersionResponse>("GET", this.rootPath("/version"), options);
  }

  async checkCompatibility(
    options: RequestOptions & {
      client?: FloeCompatibilityTarget;
      currentVersion?: string;
      versionInfo?: FloeVersionResponse;
    } = {}
  ): Promise<FloeCompatibilityCheckResult> {
    const target = options.client ?? "sdk";
    const currentVersion = (options.currentVersion ?? SDK_VERSION).trim();
    const versionInfo = options.versionInfo ?? (await this.getVersion(options));
    const supportedRange = versionInfo.compatibility[target];
    const current = parseSemver(currentVersion);

    if (!current) {
      return {
        ...versionInfo,
        target,
        currentVersion,
        supportedRange,
        compatible: false,
        reason: "invalid_current_version",
      };
    }

    const evaluation = satisfiesSemverRange(current, supportedRange);
    return {
      ...versionInfo,
      target,
      currentVersion,
      supportedRange,
      compatible: evaluation.ok,
      ...(evaluation.reason ? { reason: evaluation.reason } : {}),
    };
  }

  async getFileMetadata(
    fileId: string,
    opts: RequestOptions & { includeBlobId?: boolean } = {}
  ): Promise<FileMetadataResponse> {
    return this.requestJson("GET", `/files/${encodeURIComponent(fileId)}/metadata`, {
      ...opts,
      query: {
        ...(opts.query ?? {}),
        ...(opts.includeBlobId ? { includeBlobId: 1 } : {}),
      },
    });
  }

  async getFileManifest(
    fileId: string,
    opts: RequestOptions = {}
  ): Promise<FileManifestResponse> {
    return this.requestJson("GET", `/files/${encodeURIComponent(fileId)}/manifest`, opts);
  }

  getFileStreamUrl(fileId: string): string {
    return joinUrl(this.baseUrl, `/files/${encodeURIComponent(fileId)}/stream`);
  }

  async streamFile(fileId: string, options: FileStreamOptions = {}): Promise<Response> {
    const rangeHeader = this.buildRangeHeader(options.rangeStart, options.rangeEnd);
    return this.requestResponse("GET", `/files/${encodeURIComponent(fileId)}/stream`, {
      ...options,
      headers: {
        ...(options.headers ?? {}),
        ...(rangeHeader ? { range: rangeHeader } : {}),
      },
    });
  }

  async headFileStream(
    fileId: string,
    options: FileStreamOptions = {}
  ): Promise<FileStreamHeadResult> {
    const rangeHeader = this.buildRangeHeader(options.rangeStart, options.rangeEnd);
    const response = await this.requestResponse("HEAD", `/files/${encodeURIComponent(fileId)}/stream`, {
      ...options,
      headers: {
        ...(options.headers ?? {}),
        ...(rangeHeader ? { range: rangeHeader } : {}),
      },
    });

    return {
      ...this.extractFileStreamResponseInfo(response),
      response,
    };
  }

  async downloadFile(fileId: string, options: FileStreamOptions = {}): Promise<Uint8Array> {
    const res = await this.streamFile(fileId, options);
    const ab = await res.arrayBuffer();
    return new Uint8Array(ab);
  }

  async downloadFileAsBlob(fileId: string, options: FileStreamOptions = {}): Promise<Blob> {
    const res = await this.streamFile(fileId, options);
    return await res.blob();
  }

  async downloadFileToPath(
    fileId: string,
    filePath: string,
    options: DownloadFileToPathOptions = {}
  ): Promise<DownloadFileToPathResult> {
    const dynamicImport = new Function("s", "return import(s)") as <T>(specifier: string) => Promise<T>;
    const fs = await dynamicImport<{
      createWriteStream(
        path: string,
        options?: { flags?: "w" | "wx" }
      ): {
        on(event: "close", listener: () => void): unknown;
        on(event: "error", listener: (err: unknown) => void): unknown;
      };
      promises: {
        mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
        stat(path: string): Promise<{ size: number }>;
      };
    }>("node:fs");
    const pathModule = await dynamicImport<{
      dirname(path: string): string;
      resolve(...parts: string[]): string;
    }>("node:path");
    const stream = await dynamicImport<{
      Readable: {
        fromWeb(
          stream: ReadableStream<Uint8Array>
        ): {
          on(event: "close", listener: () => void): unknown;
          on(event: "error", listener: (err: unknown) => void): unknown;
        };
      };
    }>("node:stream");
    const streamPromises = await dynamicImport<{
      pipeline(source: unknown, destination: unknown): Promise<void>;
    }>("node:stream/promises");

    const resolvedPath = pathModule.resolve(filePath);
    if (options.createDirectories ?? true) {
      await fs.promises.mkdir(pathModule.dirname(resolvedPath), { recursive: true });
    }

    const response = await this.streamFile(fileId, options);
    if (!response.body) {
      throw new FloeError("Download response did not include a body");
    }

    try {
      const destination = fs.createWriteStream(resolvedPath, {
        flags: options.overwrite === false ? "wx" : "w",
      });

      await streamPromises.pipeline(stream.Readable.fromWeb(response.body), destination);
    } catch (error) {
      const code = (error as { code?: string } | undefined)?.code;
      if (code === "EEXIST" && options.overwrite === false) {
        throw new FloeError(`Refusing to overwrite existing file: ${resolvedPath}`, error);
      }
      throw error;
    }

    const info = this.extractFileStreamResponseInfo(response);
    const stat = await fs.promises.stat(resolvedPath);
    return {
      ...info,
      path: resolvedPath,
      bytesWritten: stat.size,
    };
  }

  async uploadBlob(blob: Blob, options: UploadBlobOptions): Promise<UploadBlobResult> {
    if (!isBlobLike(blob)) {
      throw new FloeError("uploadBlob requires a Blob/File input");
    }
    if (!options.filename?.trim()) {
      throw new FloeError("uploadBlob requires filename");
    }

    const parallel = Math.max(1, Math.floor(options.parallel ?? 3));
    const contentType =
      options.contentType ?? blob.type ?? "application/octet-stream";
    const resumeKey = options.resumeKey ?? this.defaultResumeKey(blob, options);

    let create: CreateUploadResponse | undefined;
    let uploadId = options.uploadId;
    let uploadIdFromStore = false;

    if (!uploadId && this.resumeStore) {
      const stored = await this.resumeStore.get(resumeKey);
      if (stored && stored.trim()) {
        uploadId = stored.trim();
        uploadIdFromStore = true;
        options.onStageChange?.({
          stage: "resuming",
          uploadId,
          resumed: true,
          uploadIdFromStore: true,
        });
      }
    }

    if (!uploadId) {
      options.onStageChange?.({ stage: "creating_upload" });
      create = await this.createUpload(
        {
          filename: options.filename,
          contentType,
          sizeBytes: blob.size,
          chunkSize: options.chunkSize,
          epochs: options.epochs,
        },
        {
          signal: options.signal,
          idempotencyKey: options.idempotencyKey,
        }
      );
      uploadId = create.uploadId;
      if (this.resumeStore) {
        await this.resumeStore.set(resumeKey, uploadId);
      }
    } else {
      options.onStageChange?.({
        stage: "resuming",
        uploadId,
        resumed: true,
        uploadIdFromStore,
      });
    }

    let status: UploadStatusResponse;
    try {
      status = await this.getUploadStatus(uploadId, { signal: options.signal });
    } catch (err) {
      const staleStoredUpload =
        uploadIdFromStore &&
        err instanceof FloeApiError &&
        (err.status === 404 || err.code === "UPLOAD_NOT_FOUND");

      if (!staleStoredUpload) throw err;

      if (this.resumeStore) {
        await this.resumeStore.remove(resumeKey);
      }

      create = await this.createUpload(
        {
          filename: options.filename,
          contentType,
          sizeBytes: blob.size,
          chunkSize: options.chunkSize,
          epochs: options.epochs,
        },
        {
          signal: options.signal,
          idempotencyKey: options.idempotencyKey,
        }
      );
      uploadId = create.uploadId;
      status = await this.getUploadStatus(uploadId, { signal: options.signal });
      if (this.resumeStore) {
        await this.resumeStore.set(resumeKey, uploadId);
      }
      options.onStageChange?.({ stage: "creating_upload", uploadId });
    }

    const chunkSize = create?.chunkSize ?? status.chunkSize;
    const totalChunks = create?.totalChunks ?? status.totalChunks;
    if (!chunkSize || !totalChunks) {
      throw new FloeError("Upload status did not include valid chunkSize/totalChunks");
    }

    const uploaded = new Set(status.receivedChunks ?? []);
    const pending: number[] = [];
    for (let i = 0; i < totalChunks; i++) {
      if (!uploaded.has(i)) pending.push(i);
    }

    let uploadedChunks = uploaded.size;
    let uploadedBytes = (status.receivedChunks ?? []).reduce(
      (sum, idx) => sum + chunkByteLength(idx, totalChunks, chunkSize, blob.size),
      0
    );

    options.onProgress?.({
      uploadId,
      uploadedChunks,
      totalChunks,
      uploadedBytes,
      totalBytes: blob.size,
    });
    options.onStageChange?.({ stage: "uploading_chunks", uploadId });

    let cursor = 0;
    const worker = async () => {
      while (true) {
        if (options.signal?.aborted) {
          throw new DOMException("The operation was aborted", "AbortError");
        }

        const idx = pending[cursor];
        cursor += 1;
        if (idx === undefined) return;

        const start = idx * chunkSize;
        const end = Math.min(blob.size, start + chunkSize);
        const piece = blob.slice(start, end);
        const raw = await piece.arrayBuffer();
        const sha = await sha256Hex(raw);

        await this.uploadChunk(uploadId, idx, piece, sha, { signal: options.signal });

        uploadedChunks += 1;
        uploadedBytes += piece.size;
        options.onProgress?.({
          uploadId,
          uploadedChunks,
          totalChunks,
          uploadedBytes,
          totalBytes: blob.size,
        });
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(parallel, pending.length || 1) }, () => worker())
    );

    const firstComplete = await this.completeUpload(uploadId, {
      includeBlobId: options.includeBlobId,
      includeWalrusDebug: options.includeWalrusDebug,
      idempotencyKey: options.idempotencyKey,
      signal: options.signal,
    });
    options.onStageChange?.({ stage: "finalizing", uploadId });

    const complete =
      firstComplete.status === "ready" && "fileId" in firstComplete
        ? firstComplete
        : await this.waitForUploadReadyInternal(uploadId, {
            includeBlobId: options.includeBlobId,
            includeWalrusDebug: options.includeWalrusDebug,
            signal: options.signal,
            maxWaitMs:
              options.finalizeMaxWaitMs ?? FloeClient.DEFAULT_FINALIZE_MAX_WAIT_MS,
            pollIntervalMs:
              options.finalizePollIntervalMs ??
              FloeClient.DEFAULT_FINALIZE_POLL_INTERVAL_MS,
            fallbackSizeBytes: blob.size,
            onStageChange: options.onStageChange,
          });

    if (this.resumeStore) {
      await this.resumeStore.remove(resumeKey);
    }

    options.onStageChange?.({
      stage: "completed",
      uploadId,
      fileId: complete.fileId,
    });

    return {
      uploadId,
      fileId: complete.fileId,
      sizeBytes: complete.sizeBytes,
      status: complete.status,
      ...(options.includeBlobId && complete.blobId ? { blobId: complete.blobId } : {}),
      ...(options.includeWalrusDebug && complete.walrusDebug
        ? { walrusDebug: complete.walrusDebug }
        : {}),
      walrusEndEpoch: complete.walrusEndEpoch,
      chunkSize,
      totalChunks,
    };
  }

  async uploadBytes(
    bytes: Uint8Array | ArrayBuffer,
    options: UploadBlobOptions
  ): Promise<UploadBlobResult> {
    const normalized = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const copy = new Uint8Array(normalized.byteLength);
    copy.set(normalized);
    const blob = new Blob([copy.buffer], {
      type: options.contentType ?? "application/octet-stream",
    });
    return this.uploadBlob(blob, options);
  }

  async uploadFile(filePath: string, options: UploadFileOptions = {}): Promise<UploadBlobResult> {
    const dynamicImport = new Function("s", "return import(s)") as <T>(specifier: string) => Promise<T>;
    const fs = await dynamicImport<{
      readFile(path: string): Promise<Uint8Array>;
      stat(path: string): Promise<{ isFile(): boolean }>;
      openAsBlob?: (path: string, options?: { type?: string }) => Promise<Blob>;
    }>("node:fs/promises");
    const pathModule = await dynamicImport<{
      basename(path: string): string;
      extname(path: string): string;
      resolve(...parts: string[]): string;
    }>("node:path");

    const resolvedPath = pathModule.resolve(filePath);
    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) {
      throw new FloeError(`Not a file: ${resolvedPath}`);
    }

    const contentType = options.contentType ?? inferMimeTypeFromPath(resolvedPath);
    const filename = options.filename?.trim() || pathModule.basename(resolvedPath);
    const blob =
      typeof fs.openAsBlob === "function"
        ? await fs.openAsBlob(resolvedPath, { type: contentType })
        : await (async () => {
            const bytes = new Uint8Array(await fs.readFile(resolvedPath));
            const buffer = bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength
            );
            return new Blob([buffer], { type: contentType });
          })();

    return this.uploadBlob(blob, {
      ...options,
      filename,
      contentType,
    });
  }

  async waitForUploadReady(
    uploadId: string,
    options: WaitForUploadReadyOptions = {}
  ): Promise<CompleteUploadReadyResponse> {
    return this.waitForUploadReadyInternal(uploadId, {
      includeBlobId: options.includeBlobId,
      includeWalrusDebug: options.includeWalrusDebug,
      signal: options.signal,
      maxWaitMs: options.maxWaitMs ?? FloeClient.DEFAULT_FINALIZE_MAX_WAIT_MS,
      pollIntervalMs:
        options.pollIntervalMs ?? FloeClient.DEFAULT_FINALIZE_POLL_INTERVAL_MS,
      onStageChange: options.onStageChange,
    });
  }

  private async waitForUploadReadyInternal(
    uploadId: string,
    options: WaitForUploadReadyOptions & { fallbackSizeBytes?: number }
  ): Promise<CompleteUploadReadyResponse> {
    const startedAt = Date.now();
    let lastErr: unknown;
    let waitMs = options.pollIntervalMs ?? FloeClient.DEFAULT_FINALIZE_POLL_INTERVAL_MS;

    while (Date.now() - startedAt < (options.maxWaitMs ?? FloeClient.DEFAULT_FINALIZE_MAX_WAIT_MS)) {
      if (options.signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }

      try {
        const status = await this.getUploadStatus(uploadId, {
          signal: options.signal,
          includeBlobId: options.includeBlobId,
          includeWalrusDebug: options.includeWalrusDebug,
        });

        if (status.status === "completed" && status.fileId) {
          let sizeBytes = options.fallbackSizeBytes;
          if (sizeBytes === undefined) {
            const metadata = await this.getFileMetadata(status.fileId, {
              signal: options.signal,
            });
            sizeBytes = metadata.sizeBytes;
          }

          return {
            fileId: status.fileId,
            status: "ready",
            sizeBytes: sizeBytes ?? 0,
            ...(options.includeBlobId && status.blobId ? { blobId: status.blobId } : {}),
            ...(options.includeWalrusDebug && status.walrusDebug
              ? { walrusDebug: status.walrusDebug }
              : {}),
            ...(status.walrusEndEpoch !== undefined
              ? { walrusEndEpoch: status.walrusEndEpoch }
              : {}),
          };
        }

        if (status.status === "failed") {
          throw new FloeError(status.error ?? "Upload finalization failed");
        }

        const pollAfterMs =
          typeof status.pollAfterMs === "number" && status.pollAfterMs > 0
            ? Number(status.pollAfterMs)
            : waitMs;
        options.onStageChange?.({
          stage: "polling_finalize",
          uploadId,
          pollAfterMs,
          attempt: Math.max(1, Math.floor((Date.now() - startedAt) / Math.max(1, waitMs))),
        });
        waitMs = Math.max(
          options.pollIntervalMs ?? FloeClient.DEFAULT_FINALIZE_POLL_INTERVAL_MS,
          pollAfterMs
        );
      } catch (err) {
        lastErr = err;

        if (!(err instanceof FloeApiError)) {
          throw err;
        }

        const shouldPoll =
          err.status === 409 ||
          err.status === 429 ||
          err.code === "UPLOAD_FINALIZATION_IN_PROGRESS" ||
          (err.retryable === true && err.status >= 500);

        if (!shouldPoll) throw err;

        const detailsObj =
          err.details && typeof err.details === "object"
            ? (err.details as Record<string, unknown>)
            : undefined;
        const retryAfterMs =
          typeof detailsObj?.retryAfterMs === "number"
            ? Number(detailsObj.retryAfterMs)
            : undefined;

        if (retryAfterMs && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
          waitMs = Math.max(
            options.pollIntervalMs ?? FloeClient.DEFAULT_FINALIZE_POLL_INTERVAL_MS,
            Math.floor(retryAfterMs)
          );
        } else {
          const pollInterval =
            options.pollIntervalMs ?? FloeClient.DEFAULT_FINALIZE_POLL_INTERVAL_MS;
          waitMs = Math.min(
            10_000,
            computeBackoffMs(
              Math.max(1, Math.floor((Date.now() - startedAt) / pollInterval)),
              pollInterval,
              10_000
            )
          );
        }
      }

      await sleep(waitMs, options.signal);
    }

    throw new FloeError("Upload finalization timed out", lastErr);
  }

  private async requestJson<T>(
    method: string,
    path: string,
    options: JsonRequestOptions = {}
  ): Promise<T> {
    const response = await this.requestResponse(method, path, options);
    return (await response.json()) as T;
  }

  private async requestResponse(
    method: string,
    path: string,
    options: ResponseRequestOptions = {}
  ): Promise<Response> {
    await this.maybeWarnAboutCompatibility(path, options.signal);

    const base = /^https?:\/\//.test(path) ? path : joinUrl(this.baseUrl, path);
    const url = `${base}${buildQuery(options.query)}`;
    let attempt = 0;
    let lastErr: unknown;

    while (attempt < this.retry.maxAttempts) {
      attempt += 1;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      const linkedAbort = () => controller.abort();
      options.signal?.addEventListener("abort", linkedAbort, { once: true });

      try {
        const headers = new Headers();
        applyHeaders(headers, this.authHeaders);
        applyHeaders(headers, await resolveHeaderProvider(this.dynamicHeaders));
        applyHeaders(headers, options.headers);
        if (options.idempotencyKey && !headers.has("idempotency-key")) {
          headers.set("idempotency-key", options.idempotencyKey);
        }

        let body = options.body;
        if (options.json !== undefined) {
          body = JSON.stringify(options.json);
          if (!headers.has("content-type")) {
            headers.set("content-type", "application/json");
          }
        }

        if (this.userAgent && !headers.has("x-floe-sdk")) {
          headers.set("x-floe-sdk", this.userAgent);
        }

        const response = await this.fetchImpl(url, {
          method,
          headers,
          body,
          signal: controller.signal,
        });

        if (response.ok || options.acceptedStatuses?.includes(response.status)) {
          return response;
        }

        const bodyJson = await parseErrorBodySafe(response);
        const apiError = toApiError(response, bodyJson);

        if (
          attempt < this.retry.maxAttempts &&
          this.retry.retryOnStatuses.includes(response.status)
        ) {
          const retryAfterMs = parseRetryAfterMs(response.headers);
          const backoffMs =
            retryAfterMs ??
            computeBackoffMs(
              attempt,
              this.retry.baseDelayMs,
              this.retry.maxDelayMs
            );
          await sleep(backoffMs, options.signal);
          continue;
        }

        throw apiError;
      } catch (err) {
        if (err instanceof FloeApiError) throw err;
        lastErr = err;

        if (options.signal?.aborted) {
          throw err;
        }

        if (attempt < this.retry.maxAttempts) {
          const backoffMs = computeBackoffMs(
            attempt,
            this.retry.baseDelayMs,
            this.retry.maxDelayMs
          );
          await sleep(backoffMs, options.signal);
          continue;
        }
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", linkedAbort);
      }
    }

    throw new FloeError("Request failed after retries", lastErr);
  }

  private rootPath(path: string): string {
    const rootUrl = new URL(this.baseUrl);
    rootUrl.pathname = rootUrl.pathname.replace(/\/v1\/?$/, "/");
    return new URL(path.replace(/^\/+/, ""), rootUrl).toString();
  }

  private buildRangeHeader(
    rangeStart?: number,
    rangeEnd?: number
  ): string | undefined {
    if (rangeStart === undefined && rangeEnd === undefined) {
      return undefined;
    }
    if (rangeStart !== undefined && (!Number.isInteger(rangeStart) || rangeStart < 0)) {
      throw new FloeError("rangeStart must be an integer >= 0");
    }
    if (rangeEnd !== undefined && (!Number.isInteger(rangeEnd) || rangeEnd < 0)) {
      throw new FloeError("rangeEnd must be an integer >= 0");
    }
    if (rangeStart !== undefined && rangeEnd !== undefined && rangeEnd < rangeStart) {
      throw new FloeError("rangeEnd must be >= rangeStart");
    }
    if (rangeStart !== undefined && rangeEnd !== undefined) {
      return `bytes=${rangeStart}-${rangeEnd}`;
    }
    if (rangeStart !== undefined) {
      return `bytes=${rangeStart}-`;
    }
    return `bytes=-${rangeEnd}`;
  }

  private defaultResumeKey(blob: Blob, options: UploadBlobOptions): string {
    const hasFileCtor = typeof File !== "undefined";
    const lastModified =
      hasFileCtor &&
      blob instanceof File &&
      Number.isFinite(blob.lastModified)
        ? blob.lastModified
        : 0;
    const contentType =
      options.contentType ?? blob.type ?? "application/octet-stream";
    return `floe:${options.filename}:${blob.size}:${contentType}:${lastModified}`;
  }

  private resolveDefaultResumeStore() {
    if (typeof window === "undefined") return undefined;

    try {
      if (window.localStorage) {
        return createBrowserLocalStorageResumeStore();
      }
    } catch {
      return undefined;
    }

    return undefined;
  }

  private extractFileStreamResponseInfo(response: Response): FileStreamResponseInfo {
    return {
      status: response.status as 200 | 206,
      contentType: response.headers.get("content-type") ?? undefined,
      contentLength: this.parseOptionalIntegerHeader(response.headers, "content-length"),
      contentRange: response.headers.get("content-range") ?? undefined,
      etag: response.headers.get("etag") ?? undefined,
      acceptRanges: response.headers.get("accept-ranges") ?? undefined,
      metadataSource:
        (response.headers.get("x-floe-metadata-source") as
          | FileStreamResponseInfo["metadataSource"]
          | null) ?? undefined,
      postgresState:
        (response.headers.get("x-floe-postgres-state") as
          | FileStreamResponseInfo["postgresState"]
          | null) ?? undefined,
    };
  }

  private parseOptionalIntegerHeader(headers: Headers, name: string): number | undefined {
    const raw = headers.get(name);
    if (!raw) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return undefined;
    return Math.floor(value);
  }

  private async maybeWarnAboutCompatibility(path: string, signal?: AbortSignal) {
    if (this.compatibilityCheckMode !== "warn") return;
    if (this.compatibilityWarningAttempted || this.compatibilityWarningInFlight) return;
    if (!this.shouldAutoCheckCompatibility(path)) return;

    this.compatibilityWarningInFlight = true;
    try {
      const result = await this.checkCompatibility({ signal });
      this.compatibilityWarningAttempted = true;
      if (!result.compatible) {
        console.warn(
          `[Floe SDK] ${result.target} ${result.currentVersion} is not within ${result.service} ${result.serverVersion} supported range ${result.supportedRange}`
        );
      }
    } catch {
      this.compatibilityWarningAttempted = true;
    } finally {
      this.compatibilityWarningInFlight = false;
    }
  }

  private shouldAutoCheckCompatibility(path: string): boolean {
    const href = /^https?:\/\//.test(path) ? path : joinUrl(this.baseUrl, path);
    return ![
      this.rootPath("/version"),
      this.rootPath("/health"),
      this.rootPath("/livez"),
    ].includes(href);
  }
}

type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
};

type SemverRangeEvaluation = {
  ok: boolean;
  reason?: FloeCompatibilityCheckResult["reason"];
};

function parseSemver(value: string): ParsedSemver | null {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function satisfiesSemverRange(version: ParsedSemver, range: string): SemverRangeEvaluation {
  const clauses = range.trim().split(/\s+/).filter(Boolean);
  if (clauses.length === 0) {
    return { ok: false, reason: "invalid_supported_range" };
  }

  for (const clause of clauses) {
    const match = clause.match(/^(>=|<=|>|<|=)?(.+)$/);
    if (!match) {
      return { ok: false, reason: "invalid_supported_range" };
    }

    const operator = match[1] ?? "=";
    const parsed = parseSemver(match[2]);
    if (!parsed) {
      return { ok: false, reason: "invalid_supported_range" };
    }

    const comparison = compareSemver(version, parsed);
    const satisfied =
      (operator === ">" && comparison > 0) ||
      (operator === ">=" && comparison >= 0) ||
      (operator === "<" && comparison < 0) ||
      (operator === "<=" && comparison <= 0) ||
      (operator === "=" && comparison === 0);

    if (!satisfied) {
      return { ok: false, reason: "outside_supported_range" };
    }
  }

  return { ok: true };
}

function inferMimeTypeFromPath(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".json") return "application/json";
  if (ext === ".txt") return "text/plain";
  if (ext === ".mkv") return "video/x-matroska";
  return "application/octet-stream";
}
