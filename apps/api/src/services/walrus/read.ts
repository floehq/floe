import { Agent, type Dispatcher } from "undici";
import { WalrusEnv, WalrusReadLimits } from "../../config/walrus.config.js";
import { parsePositiveIntEnv } from "../../utils/parseEnv.js";
import {
  observeWalrusSegmentFetch,
  setWalrusConnectionPoolMetrics,
} from "../metrics/runtime.metrics.js";
import { walrusReadCircuit } from "../circuit-breaker/instances.js";
import { CircuitBreakerError } from "../circuit-breaker/index.js";

const BODY_IDLE_TIMEOUT_MS = 30_000;
const HEAD_CHECK_TIMEOUT_MS = 15_000;

/**
 * Thrown by fetchWalrusBlob when ALL aggregators return 404 for a blob.
 * Callers should map this to the appropriate user-facing error (e.g., 503).
 */
export class WalrusBlobNotFoundError extends Error {
  readonly blobId: string;
  constructor(blobId: string) {
    super(`WALRUS_BLOB_NOT_FOUND blobId=${blobId}`);
    this.name = "WalrusBlobNotFoundError";
    this.blobId = blobId;
  }
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, "");
}

// ============================================================
// HTTP connection pooling via undici
//
// Creates a shared Agent that pools TCP connections across
// requests to Walrus aggregator URLs, reducing connection
// setup overhead per request.
// ============================================================
const WALRUS_FETCH_POOL_SIZE = parsePositiveIntEnv("FLOE_WALRUS_FETCH_POOL_SIZE", 8, 1);

let walrusPool: Agent | null = null;
let walrusPoolMetricsInterval: ReturnType<typeof setInterval> | null = null;

export function getWalrusPool(): Agent {
  if (!walrusPool) {
    walrusPool = new Agent({
      connections: WALRUS_FETCH_POOL_SIZE,
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 120_000,
    });
  }
  return walrusPool;
}

/**
 * Start a periodic metric collection for the Walrus connection pool.
 * Emits active-connection count once per second.
 */
export function startWalrusPoolMetrics(intervalMs = 5000): void {
  if (walrusPoolMetricsInterval) return;
  walrusPoolMetricsInterval = setInterval(() => {
    if (!walrusPool) return;
    try {
      let activeConns = 0;
      interface AgentInternal {
        _poolMap?: Map<string, Dispatcher>;
      }
      const poolMap = (walrusPool as unknown as AgentInternal)._poolMap as
        Map<string, Dispatcher> | undefined;
      if (poolMap) {
        for (const [, client] of poolMap) {
          const c = client as { busyConnections?: number; pending?: number };
          if (Number.isFinite(c.busyConnections)) activeConns += c.busyConnections!;
          else if (Number.isFinite(c.pending)) activeConns += c.pending!;
        }
      }
      setWalrusConnectionPoolMetrics({
        activeConnections: activeConns,
      });
    } catch {
      // Best-effort metric collection
    }
  }, intervalMs);
  walrusPoolMetricsInterval.unref();
}

/**
 * Stop periodic pool metric collection.
 */
export function stopWalrusPoolMetrics(): void {
  if (walrusPoolMetricsInterval) {
    clearInterval(walrusPoolMetricsInterval);
    walrusPoolMetricsInterval = null;
  }
}

let lastGoodAggregatorIdx = 0;

function isRetryableNetworkError(err: unknown): boolean {
  const msg = (err as Error)?.message ? String((err as Error).message) : "";
  const causeMsg = (err as { cause?: Error })?.cause?.message
    ? String((err as { cause?: Error })?.cause?.message)
    : "";

  return (
    msg.includes("fetch failed") ||
    causeMsg.includes("ENOTFOUND") ||
    causeMsg.includes("EAI_AGAIN") ||
    causeMsg.includes("ECONNRESET") ||
    causeMsg.includes("ETIMEDOUT")
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

async function sleep(ms: number, signal?: AbortSignal) {
  if (!ms || ms <= 0) return;
  if (!signal) {
    await new Promise((r) => setTimeout(r, ms));
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(Object.assign(new Error("AbortError"), { name: "AbortError" }));
    };

    const cleanup = () => {
      clearTimeout(t);
      try {
        signal.removeEventListener("abort", onAbort);
      } catch {
        /* ignore */
      }
    };

    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchWithTimeout(params: {
  url: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WalrusReadLimits.timeoutMs);

  const onAbort = () => controller.abort();
  if (params.signal) {
    if (params.signal.aborted) {
      controller.abort();
    } else {
      params.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  try {
    return await fetch(params.url, {
      method: "GET",
      headers: params.headers,
      signal: controller.signal,
      dispatcher: getWalrusPool() as Dispatcher,
    });
  } finally {
    clearTimeout(timeout);
    if (params.signal) {
      try {
        params.signal.removeEventListener("abort", onAbort);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Check whether a blob exists on ANY configured Walrus aggregator.
 *
 * Instead of falling back sequentially, this sends HEAD requests to
 * ALL aggregators in parallel and succeeds on the first 200/206.
 * Only returns { exists: false } when every aggregator fails.
 *
 * If a `requestId` is provided, it is propagated as an x-request-id
 * header on the upstream HEAD request for log correlation.
 *
 * Protected by the walrusReadCircuit breaker — if the circuit is OPEN
 * the blob is assumed to exist (optimistic pass-through) so streaming
 * doesn't degrate to hard failures during an aggregator outage.
 */
export async function checkWalrusBlobExists(params: {
  blobId: string;
  requestId?: string;
}): Promise<{ exists: boolean; reason?: string }> {
  const urls = WalrusEnv.aggregatorUrls;
  if (urls.length === 0) {
    return { exists: false, reason: "no_aggregators_configured" };
  }

  const startIdx =
    Number.isInteger(lastGoodAggregatorIdx) &&
    lastGoodAggregatorIdx >= 0 &&
    lastGoodAggregatorIdx < urls.length
      ? lastGoodAggregatorIdx
      : 0;

  // Re-order so the best aggregator is tried first, then the rest in parallel
  const ordered: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    const idx = (startIdx + i) % urls.length;
    ordered.push(urls[idx]);
  }

  // Helper to do a HEAD check on a single aggregator
  const headCheck = async (base: string): Promise<{ exists: boolean; status: number }> => {
    const normalized = normalizeBaseUrl(base);
    const url = `${normalized}/v1/blobs/${encodeURIComponent(params.blobId)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEAD_CHECK_TIMEOUT_MS);
    const reqHeaders: Record<string, string> = {};
    if (params.requestId) reqHeaders["x-request-id"] = params.requestId;
    try {
      const res = await fetch(url, {
        method: "HEAD",
        headers: reqHeaders,
        signal: controller.signal,
        dispatcher: getWalrusPool() as Dispatcher,
      });
      return { exists: res.status === 200 || res.status === 206, status: res.status };
    } catch {
      return { exists: false, status: 0 };
    } finally {
      clearTimeout(timeout);
    }
  };

  // Run HEAD check through the circuit breaker.
  // If the circuit is OPEN, optimistically assume exists so streaming
  // doesn't hard-fail — the fetch path has its own circuit protection.
  let primaryResult: { exists: boolean; status: number };
  try {
    primaryResult = await walrusReadCircuit.call(() => headCheck(ordered[0]));
  } catch (err) {
    if (err instanceof CircuitBreakerError) {
      return { exists: true, reason: "circuit_open_optimistic_pass" };
    }
    return { exists: false, reason: "head_check_failed" };
  }
  if (primaryResult.exists) {
    lastGoodAggregatorIdx = 0;
    return { exists: true };
  }
  if (primaryResult.status !== 0 && primaryResult.status !== 404) {
    return { exists: true, reason: `unexpected_status:${primaryResult.status}` };
  }

  // Fire HEAD requests to ALL remaining aggregators in parallel.
  // Succeed on first 200/206; fail only after all have responded or timed out.
  const fallbackBases = ordered.slice(1);
  if (fallbackBases.length === 0) {
    return { exists: false, reason: "not_found_on_aggregator" };
  }

  const results = await Promise.allSettled(
    fallbackBases.map(async (base) => {
      const r = await headCheck(base);
      if (!r.exists && r.status !== 0 && r.status !== 404) {
        return {
          exists: true,
          aggregatorIdx: urls.indexOf(base),
          reason: `unexpected_status:${r.status}`,
        };
      }
      return { exists: r.exists, aggregatorIdx: r.exists ? urls.indexOf(base) : -1 };
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled" && result.value.exists) {
      const idx = result.value.aggregatorIdx;
      if (Number.isInteger(idx) && idx >= 0) {
        lastGoodAggregatorIdx = idx;
      }
      return { exists: true, reason: result.value.reason };
    }
  }

  return { exists: false, reason: "not_found_on_all_aggregators" };
}

/**
 * Fetch a blob range from Walrus aggregators with circuit breaker protection.
 *
 * If the walrusReadCircuit is OPEN, throws CircuitBreakerError immediately
 * instead of burning time on attempted connections.
 */
export async function fetchWalrusBlob(params: {
  blobId: string;
  rangeHeader?: string;
  signal?: AbortSignal;
  requestId?: string;
}): Promise<{ res: Response; aggregatorUrl: string }> {
  return walrusReadCircuit.call(async () => {
    const urls = WalrusEnv.aggregatorUrls;
    const headers: Record<string, string> = {};
    if (params.rangeHeader) headers["Range"] = params.rangeHeader;
    if (params.requestId) headers["x-request-id"] = params.requestId;

    const startIdx =
      Number.isInteger(lastGoodAggregatorIdx) &&
      lastGoodAggregatorIdx >= 0 &&
      lastGoodAggregatorIdx < urls.length
        ? lastGoodAggregatorIdx
        : 0;

    let lastErr: unknown = null;
    let lastStatus: number | null = null;

    for (let aggAttempt = 0; aggAttempt < urls.length; aggAttempt++) {
      const idx = (startIdx + aggAttempt) % urls.length;
      const base = normalizeBaseUrl(urls[idx]);
      const url = `${base}/v1/blobs/${encodeURIComponent(params.blobId)}`;

      for (let attempt = 0; attempt <= WalrusReadLimits.maxSegmentRetries; attempt++) {
        if (params.signal?.aborted) {
          throw Object.assign(new Error("AbortError"), { name: "AbortError" });
        }

        const attemptStartedAt = Date.now();
        try {
          const res = await fetchWithTimeout({ url, headers, signal: params.signal });

          // Some aggregators can be out-of-sync or on a different network.
          // Try other aggregators before concluding the blob is missing.
          if (res.status === 404) {
            observeWalrusSegmentFetch({
              outcome: "not_found",
              durationMs: Date.now() - attemptStartedAt,
              statusClass: "4xx",
            });
            lastStatus = res.status;
            try {
              await res.body?.cancel();
            } catch {
              /* ignore */
            }
            break;
          }

          if (isRetryableStatus(res.status)) {
            observeWalrusSegmentFetch({
              outcome: "retryable_status",
              durationMs: Date.now() - attemptStartedAt,
              statusClass: res.status >= 500 ? "5xx" : "4xx",
            });
            lastStatus = res.status;
            try {
              await res.body?.cancel();
            } catch {
              /* ignore */
            }
            const delay = WalrusReadLimits.baseRetryDelayMs * Math.max(1, attempt + 1);
            await sleep(delay, params.signal);
            continue;
          }

          observeWalrusSegmentFetch({
            outcome: "success",
            durationMs: Date.now() - attemptStartedAt,
            statusClass: "2xx",
          });
          lastGoodAggregatorIdx = idx;

          const body = res.body;
          if (body) {
            const idleTimeoutStream = new TransformStream({
              flush(controller) {
                controller.terminate();
              },
            });
            const writer = idleTimeoutStream.writable.getWriter();
            let idleTimer: ReturnType<typeof setTimeout> | null = null;
            let idleDone = false;

            const resetIdle = () => {
              if (idleTimer) clearTimeout(idleTimer);
              if (idleDone) return;
              idleTimer = setTimeout(() => {
                idleDone = true;
                writer.close().catch(() => {});
              }, BODY_IDLE_TIMEOUT_MS);
            };

            resetIdle();
            const reader = body.getReader();

            void (async () => {
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) {
                    if (!idleDone) {
                      clearTimeout(idleTimer!);
                      await writer.close();
                    }
                    break;
                  }
                  resetIdle();
                  await writer.write(value);
                }
              } catch (err) {
                await writer.abort(err).catch(() => {});
              }
            })();

            const wrappedRes = new Response(idleTimeoutStream.readable, {
              status: res.status,
              statusText: res.statusText,
              headers: res.headers,
            });
            return { res: wrappedRes, aggregatorUrl: base };
          }

          return { res, aggregatorUrl: base };
        } catch (err) {
          const durationMs = Date.now() - attemptStartedAt;
          lastErr = err;

          if ((params.signal && params.signal.aborted) || (err as Error)?.name === "AbortError") {
            observeWalrusSegmentFetch({
              outcome: "aborted",
              durationMs,
              statusClass: "none",
            });
            throw err;
          }

          if (!isRetryableNetworkError(err)) {
            observeWalrusSegmentFetch({
              outcome: "other_error",
              durationMs,
              statusClass: "none",
            });
            throw err;
          }
          observeWalrusSegmentFetch({
            outcome: "network_error",
            durationMs,
            statusClass: "none",
          });

          const delay = WalrusReadLimits.baseRetryDelayMs * Math.max(1, attempt + 1);
          await sleep(delay, params.signal);
        }
      }

      // Move to next aggregator after per-aggregator retry budget.
    }

    if (lastErr) throw lastErr;
    if (lastStatus !== null) {
      if (lastStatus === 404) {
        throw new WalrusBlobNotFoundError(params.blobId);
      }
      throw new Error(`WALRUS_FETCH_FAILED status=${lastStatus}`);
    }
    throw new Error("WALRUS_FETCH_FAILED");
  });
}
