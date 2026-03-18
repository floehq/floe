import { WalrusEnv, WalrusReadLimits } from "../../config/walrus.config.js";
import { observeWalrusSegmentFetch } from "../metrics/runtime.metrics.js";

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, "");
}

let lastGoodAggregatorIdx = 0;

function isRetryableNetworkError(err: unknown): boolean {
  const msg = (err as any)?.message ? String((err as any).message) : "";
  const causeMsg = (err as any)?.cause?.message
    ? String((err as any).cause?.message)
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
      } catch {}
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
  const timeout = setTimeout(
    () => controller.abort(),
    WalrusReadLimits.timeoutMs
  );

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
    });
  } finally {
    clearTimeout(timeout);
    if (params.signal) {
      try {
        params.signal.removeEventListener("abort", onAbort);
      } catch {}
    }
  }
}

export async function fetchWalrusBlob(params: {
  blobId: string;
  rangeHeader?: string;
  signal?: AbortSignal;
}): Promise<{ res: Response; aggregatorUrl: string }> {
  const urls = WalrusEnv.aggregatorUrls;
  const headers: Record<string, string> = {};
  if (params.rangeHeader) headers["Range"] = params.rangeHeader;

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
          } catch {}
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
          } catch {}
          const delay =
            WalrusReadLimits.baseRetryDelayMs * Math.max(1, attempt + 1);
          await sleep(delay, params.signal);
          continue;
        }

        observeWalrusSegmentFetch({
          outcome: "success",
          durationMs: Date.now() - attemptStartedAt,
          statusClass: "2xx",
        });
        lastGoodAggregatorIdx = idx;
        return { res, aggregatorUrl: base };
      } catch (err) {
        const durationMs = Date.now() - attemptStartedAt;
        lastErr = err;

        if ((params.signal && params.signal.aborted) || (err as any)?.name === "AbortError") {
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

        const delay =
          WalrusReadLimits.baseRetryDelayMs * Math.max(1, attempt + 1);
        await sleep(delay, params.signal);
      }
    }

    // Move to next aggregator after per-aggregator retry budget.
  }

  if (lastErr) throw lastErr;
  if (lastStatus !== null) {
    throw new Error(`WALRUS_FETCH_FAILED status=${lastStatus}`);
  }
  throw new Error("WALRUS_FETCH_FAILED");
}
