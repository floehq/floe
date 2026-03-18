export type WalrusUploadOutcome =
  | "success"
  | "auth_failed"
  | "insufficient_balance"
  | "rate_limited"
  | "network_error"
  | "timeout"
  | "client_error"
  | "server_error"
  | "invalid_response"
  | "unknown_error";

export interface WalrusUploadMetric {
  uploadId: string;
  sizeBytes: number;
  epochs: number;
  attempt: number;
  durationMs: number;
  outcome: WalrusUploadOutcome;
  error?: string;
  httpStatus?: number;
  walrusCost?: number | string;
  walrusEndEpoch?: number;
  network: "mainnet" | "testnet";
  timestamp: number;
}

export function recordWalrusUploadMetric(
  metric: WalrusUploadMetric
) {
  if (process.env.FLOE_LOG_WALRUS_METRICS !== "1") {
    return;
  }
  process.stdout.write(`${JSON.stringify({ event: "walrus.upload.metric", ...metric })}\n`);
}

export function classifyWalrusError(
  err: Error
): WalrusUploadOutcome {
  const msg = (err.message ?? "").toUpperCase();

  if ((err as any)?.name === "AbortError") return "timeout";

  const m = msg.match(/WALRUS_UPLOAD_FAILED:(\d{3})\b/);
  if (m) {
    const status = Number(m[1]);
    if (status === 401 || status === 403) return "auth_failed";
    if (status === 429) return "rate_limited";
    if (status >= 400 && status <= 499) return "client_error";
    if (status >= 500 && status <= 599) return "server_error";
  }

  if (msg.includes("AUTH")) return "auth_failed";
  if (msg.includes("INSUFFICIENT")) return "insufficient_balance";
  if (
    msg.includes("ECONN") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("EAI_AGAIN") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("NETWORK") ||
    msg.includes("FETCH")
  )
    return "network_error";
  if (msg.includes("SERVER")) return "server_error";
  if (msg.includes("MISSING_BLOB_ID")) return "invalid_response";
  if (msg.includes("INVALID")) return "invalid_response";

  return "unknown_error";
}
