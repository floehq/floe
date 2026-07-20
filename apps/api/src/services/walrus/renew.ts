import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { WalrusUploadLimits } from "../../config/walrus.config.js";
import { getWalrusBlobState } from "./blob.js";

export interface WalrusRenewParams {
  blobObjectId: string;
  epochs: number;
}

export interface WalrusRenewResult {
  endEpoch: number;
}

const WALRUS_RENEW_CACHE_TTL_MS = 10_000;
const renewResultCache = new Map<string, { result: WalrusRenewResult; expiresAt: number }>();

const execFileAsync = promisify(execFile);
const WALRUS_CLI_BIN = (process.env.FLOE_WALRUS_CLI_BIN ?? "walrus").trim();
const WALRUS_CLI_WALLET = process.env.FLOE_WALRUS_CLI_WALLET?.trim() || undefined;
const WALRUS_CLI_CONTEXT = process.env.FLOE_WALRUS_CLI_CONTEXT?.trim() || undefined;

function defaultWalrusCliConfigPath(): string | undefined {
  const configured = process.env.FLOE_WALRUS_CLI_CONFIG?.trim();
  if (configured) return configured;

  if (process.env.FLOE_NETWORK === "testnet") {
    return path.join(os.homedir(), ".walrus", "client_config.yaml");
  }

  return undefined;
}

/**
 * Extends the storage duration of a blob on Walrus.
 * Use the Walrus CLI so coin selection and network-specific package wiring stay aligned
 * with the installed Walrus client configuration.
 */
export async function renewWalrusBlob(params: WalrusRenewParams): Promise<WalrusRenewResult> {
  const cacheKey = `${params.blobObjectId}:${params.epochs}`;
  const cached = renewResultCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const args = [
    "extend",
    "--blob-obj-id",
    params.blobObjectId,
    "--epochs-extended",
    String(params.epochs),
    "--json",
  ];
  const walrusConfig = defaultWalrusCliConfigPath();
  if (walrusConfig) args.push("--config", walrusConfig);
  if (WALRUS_CLI_CONTEXT) args.push("--context", WALRUS_CLI_CONTEXT);
  if (WALRUS_CLI_WALLET) args.push("--wallet", WALRUS_CLI_WALLET);

  try {
    await execFileAsync(WALRUS_CLI_BIN, args, {
      timeout: WalrusUploadLimits.timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });

    const state = await getWalrusBlobState(params.blobObjectId);
    const endEpoch = state.endEpoch ?? 0;
    const result: WalrusRenewResult = { endEpoch: Number(endEpoch) };
    renewResultCache.set(cacheKey, {
      result,
      expiresAt: Date.now() + WALRUS_RENEW_CACHE_TTL_MS,
    });
    return result;
  } catch (err: unknown) {
    const e = err as Record<string, unknown> | undefined;
    const detail = e?.stderr || e?.stdout || (err instanceof Error ? err.message : null) || "unknown";
    throw new Error(`WALRUS_RENEW_FAILED:${String(detail).slice(0, 1000)}`);
  }
}
