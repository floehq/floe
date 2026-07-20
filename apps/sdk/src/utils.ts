import type { JsonRequestOptions, RetryConfig } from "./types.js";
import { FloeApiError, FloeError, type FloeApiErrorBody } from "./errors.js";

/**
 * Default base URL for the Floe API.
 */
export const DEFAULT_BASE_URL = "http://127.0.0.1:3001/v1";

/**
 * Default retry configuration applied when no overrides are provided.
 */
export const DEFAULT_RETRY: Required<RetryConfig> = {
  maxAttempts: 4,
  baseDelayMs: 300,
  maxDelayMs: 5000,
  retryOnStatuses: [408, 425, 429, 500, 502, 503, 504],
};

/**
 * Merges a partial {@link RetryConfig} with SDK defaults.
 *
 * @param retry - Caller-provided retry overrides.
 * @returns A complete retry configuration with all fields populated.
 */
export function withDefaultRetry(retry?: RetryConfig): Required<RetryConfig> {
  return {
    maxAttempts: retry?.maxAttempts ?? DEFAULT_RETRY.maxAttempts,
    baseDelayMs: retry?.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs,
    maxDelayMs: retry?.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs,
    retryOnStatuses: retry?.retryOnStatuses ?? DEFAULT_RETRY.retryOnStatuses,
  };
}

/**
 * Joins a base URL and a path, normalising duplicate/trailing slashes.
 *
 * @param baseUrl - The base URL (e.g. `http://localhost:3001/v1`).
 * @param path    - The path to append (e.g. `/uploads/123`).
 * @returns The fully qualified URL string.
 */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

/**
 * Serialises a query parameter record into a `?key=value` string.
 *
 * @param query - Key-value pairs to encode. `undefined` values are skipped.
 * @returns A query string including the leading `?`, or an empty string when
 *          `query` is empty / `undefined`.
 */
export function buildQuery(query?: Record<string, string | number | boolean | undefined>): string {
  if (!query) return "";

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }

  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Applies a header record to a `Headers` instance, skipping null/undefined values.
 *
 * @param target  - The `Headers` object to mutate.
 * @param headers - Header name/value pairs to apply.
 */
export function applyHeaders(
  target: Headers,
  headers?: Record<string, string | number | boolean | null | undefined>,
) {
  if (!headers) return;
  for (const [key, value] of Object.entries(headers)) {
    if (value === null || value === undefined) continue;
    target.set(key, String(value));
  }
}

/**
 * Parses the `Retry-After` header from a `Response`.
 *
 * @remarks
 * Supports both the integer-seconds format and the HTTP-date format.
 *
 * @param headers - Response headers.
 * @returns Delay in milliseconds, or `undefined` if the header is absent or invalid.
 */
export function parseRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000);
  }

  const ts = Date.parse(raw);
  if (Number.isFinite(ts)) {
    const delta = ts - Date.now();
    return delta > 0 ? delta : 0;
  }

  return undefined;
}

/**
 * Sleeps for the given duration, respecting an optional abort signal.
 *
 * @param ms     - Duration in milliseconds.
 * @param signal - When aborted, the sleep rejects with an `AbortError`.
 * @returns A promise that resolves after the delay or rejects on abort.
 * @throws {DOMException} With name `"AbortError"` if `signal` is aborted.
 */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;

  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted", "AbortError"));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Computes an exponential back-off delay with jitter.
 *
 * @param attempt    - The current attempt number (1-based).
 * @param baseDelayMs - Base delay in milliseconds.
 * @param maxDelayMs  - Maximum delay cap in milliseconds.
 * @returns Delay in milliseconds before the next retry.
 */
export function computeBackoffMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exp * 0.2)));
  return Math.min(maxDelayMs, exp + jitter);
}

/**
 * Normalises and validates a base URL.
 *
 * @param baseUrl - The raw base URL string.
 * @returns The trimmed URL with trailing slashes removed.
 * @throws {FloeError} If the URL does not start with `http://` or `https://`.
 */
export function normalizeBaseUrl(baseUrl?: string): string {
  const url = (baseUrl ?? DEFAULT_BASE_URL).trim();
  if (!/^https?:\/\//.test(url)) {
    throw new FloeError("Floe baseUrl must start with http:// or https://");
  }
  return url.replace(/\/+$/, "");
}

/**
 * Safely parses the response body as a {@link FloeApiErrorBody}.
 *
 * @remarks
 * Never throws — returns `undefined` when the body is empty or not valid JSON.
 *
 * @param response - The HTTP response to read.
 * @returns The parsed error body, or `undefined`.
 */
export async function parseErrorBodySafe(
  response: Response,
): Promise<FloeApiErrorBody | undefined> {
  try {
    const text = await response.text();
    if (!text) return undefined;
    return JSON.parse(text) as FloeApiErrorBody;
  } catch {
    return undefined;
  }
}

/**
 * Constructs a {@link FloeApiError} from a failed HTTP response.
 *
 * @param response - The HTTP response.
 * @param body     - Optionally pre-parsed error body.
 * @returns A fully populated {@link FloeApiError}.
 */
export function toApiError(response: Response, body?: FloeApiErrorBody): FloeApiError {
  const err = body?.error;
  return new FloeApiError({
    message: err?.message ?? body?.message ?? `Request failed (${response.status})`,
    status: response.status,
    code: err?.code,
    retryable: err?.retryable,
    details: err?.details,
    requestId: response.headers.get("x-request-id") ?? undefined,
    raw: body,
  });
}

/**
 * Computes the byte length of a single chunk within a chunked upload.
 *
 * @remarks
 * All chunks except the last are exactly `chunkSize` bytes. The final chunk
 * holds the remaining bytes.
 *
 * @param index       - Zero-based chunk index.
 * @param totalChunks - Total number of chunks.
 * @param chunkSize   - Nominal chunk size in bytes.
 * @param totalSize   - Total file size in bytes.
 * @returns Byte length of the chunk, or `0` for out-of-range indices.
 */
export function chunkByteLength(
  index: number,
  totalChunks: number,
  chunkSize: number,
  totalSize: number,
): number {
  if (index < 0 || index >= totalChunks) return 0;
  if (index < totalChunks - 1) return chunkSize;
  const used = chunkSize * (totalChunks - 1);
  return Math.max(0, totalSize - used);
}

/**
 * Computes the SHA-256 hash of a byte buffer and returns it as a hex string.
 *
 * @remarks
 * Uses `crypto.subtle` when available and falls back to a pure-JS
 * implementation for environments without the Web Crypto API.
 *
 * @param input - The bytes to hash.
 * @returns A lowercase hex-encoded SHA-256 digest.
 */
export async function sha256Hex(input: Uint8Array | ArrayBuffer): Promise<string> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);

  if (!globalThis.crypto?.subtle) {
    return sha256HexFallback(copy);
  }

  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy);
  const out = new Uint8Array(digest);
  return Array.from(out)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function sha256HexFallback(message: Uint8Array): string {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const length = message.length;
  const bitLenHi = Math.floor((length * 8) / 0x100000000);
  const bitLenLo = (length * 8) >>> 0;
  const withOne = length + 1;
  const paddedLen = ((withOne + 8 + 63) & ~63) >>> 0;
  const data = new Uint8Array(paddedLen);
  data.set(message);
  data[length] = 0x80;
  data[paddedLen - 8] = (bitLenHi >>> 24) & 0xff;
  data[paddedLen - 7] = (bitLenHi >>> 16) & 0xff;
  data[paddedLen - 6] = (bitLenHi >>> 8) & 0xff;
  data[paddedLen - 5] = bitLenHi & 0xff;
  data[paddedLen - 4] = (bitLenLo >>> 24) & 0xff;
  data[paddedLen - 3] = (bitLenLo >>> 16) & 0xff;
  data[paddedLen - 2] = (bitLenLo >>> 8) & 0xff;
  data[paddedLen - 1] = bitLenLo & 0xff;

  const words = new Uint32Array(64);
  for (let i = 0; i < paddedLen; i += 64) {
    for (let t = 0; t < 16; t++) {
      const j = i + t * 4;
      words[t] = (data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3];
    }

    for (let t = 16; t < 64; t++) {
      const s0 = rotr(words[t - 15], 7) ^ rotr(words[t - 15], 18) ^ (words[t - 15] >>> 3);
      const s1 = rotr(words[t - 2], 17) ^ rotr(words[t - 2], 19) ^ (words[t - 2] >>> 10);
      words[t] = (((words[t - 16] + s0) >>> 0) + ((words[t - 7] + s1) >>> 0)) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let t = 0; t < 64; t++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (((((h + s1) >>> 0) + ch) >>> 0) + ((K[t] + words[t]) >>> 0)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map((v) => v.toString(16).padStart(8, "0")).join("");
}

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/**
 * Checks whether a value looks like a `Blob` (duck-typing check).
 *
 * @param value - The value to test.
 * @returns `true` when `value` has `arrayBuffer`, `slice`, and `size` properties.
 */
export function isBlobLike(value: unknown): value is Blob {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Blob).arrayBuffer === "function" &&
    typeof (value as Blob).slice === "function" &&
    typeof (value as Blob).size === "number"
  );
}

/**
 * Internal request options that include a raw `body` alongside `json`.
 */
export type JsonRequestInternalOptions = JsonRequestOptions & {
  body?: BodyInit;
};
