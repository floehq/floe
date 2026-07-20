/**
 * Shape of a Floe API error response body.
 *
 * @remarks
 * The server may return errors in either the structured `error` envelope
 * or a flat `message` string. The SDK normalises both into a
 * {@link FloeApiError}.
 */
export type FloeApiErrorBody = {
  error?: {
    /** Machine-readable error code (e.g. `"UPLOAD_NOT_FOUND"`). */
    code?: string;
    /** Human-readable error message. */
    message?: string;
    /** Whether the request may be retried. */
    retryable?: boolean;
    /** Arbitrary additional error details. */
    details?: unknown;
  };
  /** Flat error message when the `error` envelope is absent. */
  message?: string;
};

/**
 * Base error class thrown by the Floe SDK for non-HTTP errors.
 *
 * @remarks
 * Extends the native `Error` and preserves the original `cause` when
 * wrapping lower-level exceptions.
 *
 * @example
 * ```ts
 * try {
 *   await client.createUpload(input);
 * } catch (err) {
 *   if (err instanceof FloeError) {
 *     console.error(err.message, err.cause);
 *   }
 * }
 * ```
 */
export class FloeError extends Error {
  /** The original error that caused this exception, if any. */
  override readonly cause?: unknown;

  /**
   * @param message - Human-readable error description.
   * @param cause  - The underlying error that triggered this exception.
   */
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "FloeError";
    this.cause = cause;
  }
}

/**
 * Error class for non-successful HTTP responses from the Floe API.
 *
 * @remarks
 * Extends {@link FloeError} and carries the HTTP status code, optional
 * error code, retryability flag, and diagnostic details returned by the
 * server. Use {@link isFloeApiError} for type-safe narrowing.
 *
 * @example
 * ```ts
 * try {
 *   await client.getUploadStatus("bad-id");
 * } catch (err) {
 *   if (isFloeApiError(err)) {
 *     console.error(`HTTP ${err.status}: ${err.code} — ${err.message}`);
 *     if (err.retryable) { /* retry *\/ }
 *   }
 * }
 * ```
 */
export class FloeApiError extends FloeError {
  /** HTTP status code of the failed request. */
  readonly status: number;
  /** Machine-readable error code, if provided by the server. */
  readonly code?: string;
  /** Whether the server considers this error retryable. */
  readonly retryable?: boolean;
  /** Arbitrary error details from the server response. */
  readonly details?: unknown;
  /** The `x-request-id` header from the response, if present. */
  readonly requestId?: string;
  /** The raw parsed error body, if available. */
  readonly raw?: unknown;

  /**
   * @param params - Error construction parameters.
   * @param params.message - Human-readable error description.
   * @param params.status  - HTTP status code.
   * @param params.code    - Machine-readable error code.
   * @param params.retryable - Whether the request can be retried.
   * @param params.details - Additional error details from the server.
   * @param params.requestId - The `x-request-id` response header value.
   * @param params.raw     - The raw parsed response body.
   */
  constructor(params: {
    message: string;
    status: number;
    code?: string;
    retryable?: boolean;
    details?: unknown;
    requestId?: string;
    raw?: unknown;
  }) {
    super(params.message);
    this.name = "FloeApiError";
    this.status = params.status;
    this.code = params.code;
    this.retryable = params.retryable;
    this.details = params.details;
    this.requestId = params.requestId;
    this.raw = params.raw;
  }
}

/**
 * Type-guard that checks whether `err` is a {@link FloeApiError}.
 *
 * @param err - The value to test.
 * @returns `true` when `err` is an instance of {@link FloeApiError}.
 *
 * @example
 * ```ts
 * fetchSomething().catch((err) => {
 *   if (isFloeApiError(err)) {
 *     console.error(err.status, err.message);
 *   }
 * });
 * ```
 */
export function isFloeApiError(err: unknown): err is FloeApiError {
  return err instanceof FloeApiError;
}
