import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { suiNetwork } from "../../../state/sui.js";
import { WalrusUploadLimits } from "../../../config/walrus.config.js";
import type { WalrusUploadParams, WalrusUploadResult } from "./types.js";

const execFileAsync = promisify(execFile);
const FETCH_TIMEOUT_MS = WalrusUploadLimits.timeoutMs;

const WALRUS_CLI_BIN = (process.env.FLOE_WALRUS_CLI_BIN ?? "walrus").trim();
const WALRUS_CLI_CONFIG = process.env.FLOE_WALRUS_CLI_CONFIG?.trim() || undefined;
const WALRUS_CLI_WALLET = process.env.FLOE_WALRUS_CLI_WALLET?.trim() || undefined;
const WALRUS_CLI_UPLOAD_RELAY = process.env.FLOE_WALRUS_CLI_UPLOAD_RELAY?.trim() || undefined;

export function describeWalrusCliBackend() {
  return {
    cliBin: WALRUS_CLI_BIN,
    cliConfig: WALRUS_CLI_CONFIG ?? null,
    cliWallet: WALRUS_CLI_WALLET ?? null,
    uploadRelay: WALRUS_CLI_UPLOAD_RELAY ?? null,
  };
}

export async function uploadToWalrusViaCli(
  params: WalrusUploadParams
): Promise<WalrusUploadResult> {
  const tmpFile = path.join(
    os.tmpdir(),
    `floe_walrus_${Date.now()}_${Math.random().toString(16).slice(2)}.bin`
  );

  const rs = params.streamFactory();
  const ws = createWriteStream(tmpFile);
  await pipeline(rs, ws);

  const args = ["store", tmpFile, "--epochs", String(params.epochs), "--context", suiNetwork];
  if (WALRUS_CLI_CONFIG) args.push("--config", WALRUS_CLI_CONFIG);
  if (WALRUS_CLI_WALLET) args.push("--wallet", WALRUS_CLI_WALLET);
  if (WALRUS_CLI_UPLOAD_RELAY) args.push("--upload-relay", WALRUS_CLI_UPLOAD_RELAY);

  try {
    const { stdout, stderr } = await execFileAsync(WALRUS_CLI_BIN, args, {
      timeout: FETCH_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    const out = `${stdout ?? ""}\n${stderr ?? ""}`;

    const blobId = out.match(/Blob ID:\s*([A-Za-z0-9_\-]+)/)?.[1];
    const objectId =
      out.match(/Sui object ID:\s*(0x[0-9a-fA-F]+)/)?.[1] ??
      out.match(/Owned Blob registration object ID:\s*(0x[0-9a-fA-F]+)/)?.[1];
    const endEpochRaw = out.match(/Expiry epoch \(exclusive\):\s*(\d+)/)?.[1];
    const costRaw = out.match(/Cost \(excluding gas\):\s*([0-9]*\.?[0-9]+)/)?.[1];

    if (!blobId) {
      throw new Error(`WALRUS_CLI_PARSE_FAILED:${out.slice(0, 500)}`);
    }

    const source = /already available and certified within Walrus/i.test(out)
      ? "already_certified"
      : /\(\s*1\s+newly certified\s*\)/i.test(out)
        ? "newly_created"
        : "unknown";

    return {
      blobId,
      objectId,
      endEpoch: endEpochRaw ? Number(endEpochRaw) : undefined,
      cost: costRaw ? Number(costRaw) : undefined,
      source,
    };
  } catch (err: any) {
    const msg = err?.stderr || err?.stdout || err?.message || "WALRUS_CLI_FAILED";
    throw new Error(`WALRUS_CLI_FAILED:${String(msg).slice(0, 1000)}`);
  } finally {
    await fs.rm(tmpFile, { force: true }).catch(() => {});
  }
}
