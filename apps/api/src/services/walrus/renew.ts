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
export async function renewWalrusBlob(
  params: WalrusRenewParams
): Promise<WalrusRenewResult> {
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

    return { endEpoch: Number(endEpoch) };
  } catch (err: any) {
    const detail = err?.stderr || err?.stdout || err?.message || "unknown";
    throw new Error(
      `WALRUS_RENEW_FAILED:${String(detail).slice(0, 1000)}`
    );
  }
}
