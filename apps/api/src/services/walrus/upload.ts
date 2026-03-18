import type { Readable } from "stream";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { toB64 } from "@mysten/sui/utils";
import { nodeToWeb } from "../../utils/nodeToWeb.js";
import { suiClient, suiNetwork, suiSigner } from "../../state/sui.js";
import { WalrusUploadLimits } from "../../config/walrus.config.js";

const FETCH_TIMEOUT_MS = WalrusUploadLimits.timeoutMs;
const execFileAsync = promisify(execFile);
const MIN_BALANCE_MIST = 1_000_000_000n;
const IS_MAINNET = suiNetwork === "mainnet";
const SUI_ADDRESS_RE = /^(0x)?[0-9a-fA-F]{64}$/;

type WalrusStoreMode = "sdk" | "cli";

function parseStoreMode(): WalrusStoreMode {
  const raw = (process.env.FLOE_WALRUS_STORE_MODE ?? "sdk").trim().toLowerCase();
  if (raw === "sdk" || raw === "cli") return raw;
  throw new Error("INVALID_FLOE_WALRUS_STORE_MODE (expected: sdk|cli)");
}

const WALRUS_STORE_MODE = parseStoreMode();
const WALRUS_CLI_BIN = (process.env.FLOE_WALRUS_CLI_BIN ?? "walrus").trim();
const WALRUS_SDK_BASE_URL = (process.env.FLOE_WALRUS_SDK_BASE_URL ?? "").trim().replace(/\/$/, "");
const WALRUS_SEND_OBJECT_TO = parseOptionalSuiAddressEnv("WALRUS_SEND_OBJECT_TO");

function parseOptionalSuiAddressEnv(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  if (!SUI_ADDRESS_RE.test(raw)) {
    throw new Error(`${name} must be a valid 32-byte Sui address`);
  }
  return `0x${raw.replace(/^0x/i, "").toLowerCase()}`;
}

let lastBalanceCheck = 0;
async function checkBalanceOnce(clientAddress: string) {
  const now = Date.now();
  if (now - lastBalanceCheck < 60_000) return;

  const bal = await suiClient.getBalance({ owner: clientAddress });
  if (BigInt(bal.totalBalance) < MIN_BALANCE_MIST) {
    throw new Error("INSUFFICIENT_BALANCE");
  }

  lastBalanceCheck = now;
}

async function createAuthHeaders(
  keypair: Ed25519Keypair,
  apiBaseUrl: string
): Promise<Record<string, string>> {
  const address = keypair.getPublicKey().toSuiAddress();
  const timestamp = Date.now();
  const msg = `${apiBaseUrl}:${address}:${timestamp}`;

  const sig = await keypair.signPersonalMessage(
    new TextEncoder().encode(msg)
  );

  return {
    "X-Sui-Address": address,
    "X-Sui-Timestamp": String(timestamp),
    "X-Sui-Signature": toB64(Uint8Array.from(sig.signature)),
  };
}

async function uploadToWalrusViaCli(params: {
  streamFactory: () => Readable;
  epochs: number;
}): Promise<{
  blobId: string;
  objectId?: string;
  cost?: number;
  endEpoch?: number;
  source: "newly_created" | "already_certified" | "unknown";
}> {
  const tmpFile = path.join(
    os.tmpdir(),
    `floe_walrus_${Date.now()}_${Math.random().toString(16).slice(2)}.bin`
  );

  const rs = params.streamFactory();
  const ws = createWriteStream(tmpFile);
  await pipeline(rs, ws);

  const args = ["store", tmpFile, "--epochs", String(params.epochs), "--context", suiNetwork];

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

async function uploadToWalrusViaSdk(params: {
  streamFactory: () => Readable;
  epochs: number;
}): Promise<{
  blobId: string;
  objectId?: string;
  cost?: number;
  endEpoch?: number;
  source: "newly_created" | "already_certified" | "unknown";
}> {
  if (!/^https?:\/\//.test(WALRUS_SDK_BASE_URL)) {
    throw new Error("FLOE_WALRUS_SDK_BASE_URL must be set to http(s) URL when FLOE_WALRUS_STORE_MODE=sdk");
  }

  const paramsQs = new URLSearchParams({ epochs: String(params.epochs) });
  if (WALRUS_SEND_OBJECT_TO) {
    paramsQs.set("send_object_to", WALRUS_SEND_OBJECT_TO);
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
  };

  if (IS_MAINNET) {
    const keypair = suiSigner;
    await checkBalanceOnce(keypair.getPublicKey().toSuiAddress());
    Object.assign(headers, await createAuthHeaders(keypair, WALRUS_SDK_BASE_URL));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${WALRUS_SDK_BASE_URL}/v1/blobs?${paramsQs.toString()}`, {
      method: "PUT",
      headers,
      body: nodeToWeb(params.streamFactory()),
      duplex: "half",
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await safeReadText(res);
      throw new Error(`WALRUS_UPLOAD_FAILED:${res.status}:${text}`);
    }

    const json = (await res.json()) as any;
    const blobId =
      json?.newlyCreated?.blobObject?.blobId ??
      json?.alreadyCertified?.blobId ??
      json?.blobObject?.blobId;

    if (!blobId) {
      throw new Error("WALRUS_MISSING_BLOB_ID");
    }

    return {
      blobId,
      objectId:
        json?.newlyCreated?.blobObject?.id ??
        json?.alreadyCertified?.blobObject?.id ??
        json?.blobObject?.id,
      cost: json?.newlyCreated?.cost,
      endEpoch:
        json?.newlyCreated?.blobObject?.storage?.endEpoch ??
        json?.alreadyCertified?.endEpoch ??
        json?.blobObject?.storage?.endEpoch,
      source: json?.newlyCreated
        ? "newly_created"
        : json?.alreadyCertified
          ? "already_certified"
          : "unknown",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function uploadToWalrusOnce(
  streamFactory: () => Readable,
  epochs: number
): Promise<{
  blobId: string;
  objectId?: string;
  cost?: number;
  endEpoch?: number;
  source: "newly_created" | "already_certified" | "unknown";
}> {
  if (!Number.isInteger(epochs) || epochs <= 0) {
    throw new Error("INVALID_EPOCHS");
  }

  if (WALRUS_STORE_MODE === "sdk") {
    return uploadToWalrusViaSdk({ streamFactory, epochs });
  }

  if (WALRUS_STORE_MODE === "cli") {
    return uploadToWalrusViaCli({ streamFactory, epochs });
  }

  throw new Error("INVALID_FLOE_WALRUS_STORE_MODE (expected: sdk|cli)");
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
