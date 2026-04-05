import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { toB64 } from "@mysten/sui/utils";
import { nodeToWeb } from "../../../utils/nodeToWeb.js";
import { suiClient, suiNetwork, suiSigner } from "../../../state/sui.js";
import { WalrusUploadLimits } from "../../../config/walrus.config.js";
import type { WalrusUploadParams, WalrusUploadResult } from "./types.js";

const FETCH_TIMEOUT_MS = WalrusUploadLimits.timeoutMs;
const MIN_BALANCE_MIST = 1_000_000_000n;
const IS_MAINNET = suiNetwork === "mainnet";
const SUI_ADDRESS_RE = /^(0x)?[0-9a-fA-F]{64}$/;
let lastGoodWriterIdx = 0;

function parseSdkBaseUrls(): string[] {
  const explicitPublisherList = (process.env.FLOE_WALRUS_PUBLISHER_BASE_URLS ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
  if (explicitPublisherList.length > 0) {
    return explicitPublisherList;
  }

  const explicitLegacyList = (process.env.FLOE_WALRUS_SDK_BASE_URLS ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
  if (explicitLegacyList.length > 0) {
    return explicitLegacyList;
  }

  const singlePublisher = (process.env.FLOE_WALRUS_PUBLISHER_BASE_URL ?? "")
    .trim()
    .replace(/\/$/, "");
  if (singlePublisher) return [singlePublisher];

  const singleLegacy = (process.env.FLOE_WALRUS_SDK_BASE_URL ?? "").trim().replace(/\/$/, "");
  return singleLegacy ? [singleLegacy] : [];
}

function parseOptionalSuiAddressEnv(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  if (!SUI_ADDRESS_RE.test(raw)) {
    throw new Error(`${name} must be a valid 32-byte Sui address`);
  }
  return `0x${raw.replace(/^0x/i, "").toLowerCase()}`;
}

const WALRUS_PUBLISHER_BASE_URLS = parseSdkBaseUrls();
const WALRUS_SEND_OBJECT_TO = parseOptionalSuiAddressEnv("WALRUS_SEND_OBJECT_TO");

export function describeWalrusPublisherBackend() {
  return {
    primary: WALRUS_PUBLISHER_BASE_URLS[0] ?? null,
    fallbacks: WALRUS_PUBLISHER_BASE_URLS.slice(1),
    count: WALRUS_PUBLISHER_BASE_URLS.length,
  };
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

  const sig = await keypair.signPersonalMessage(new TextEncoder().encode(msg));

  return {
    "X-Sui-Address": address,
    "X-Sui-Timestamp": String(timestamp),
    "X-Sui-Signature": toB64(Uint8Array.from(sig.signature)),
  };
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

export async function uploadToWalrusViaPublisher(
  params: WalrusUploadParams
): Promise<WalrusUploadResult> {
  if (WALRUS_PUBLISHER_BASE_URLS.length === 0) {
    throw new Error(
      "FLOE_WALRUS_PUBLISHER_BASE_URL or FLOE_WALRUS_PUBLISHER_BASE_URLS must be set to http(s) URL when FLOE_WALRUS_STORE_MODE=publisher"
    );
  }
  for (const baseUrl of WALRUS_PUBLISHER_BASE_URLS) {
    if (!/^https?:\/\//.test(baseUrl)) {
      throw new Error("FLOE_WALRUS_PUBLISHER_BASE_URLS entries must start with http:// or https://");
    }
  }

  const startIdx =
    Number.isInteger(lastGoodWriterIdx) &&
    lastGoodWriterIdx >= 0 &&
    lastGoodWriterIdx < WALRUS_PUBLISHER_BASE_URLS.length
      ? lastGoodWriterIdx
      : 0;

  let lastError: unknown = null;
  for (let writerAttempt = 0; writerAttempt < WALRUS_PUBLISHER_BASE_URLS.length; writerAttempt += 1) {
    const idx = (startIdx + writerAttempt) % WALRUS_PUBLISHER_BASE_URLS.length;
    const baseUrl = WALRUS_PUBLISHER_BASE_URLS[idx];
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
      Object.assign(headers, await createAuthHeaders(keypair, baseUrl));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(`${baseUrl}/v1/blobs?${paramsQs.toString()}`, {
        method: "PUT",
        headers,
        body: nodeToWeb(params.streamFactory()),
        duplex: "half",
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await safeReadText(res);
        const err = new Error(`WALRUS_UPLOAD_FAILED:${res.status}:${text}`);
        lastError = err;
        if (res.status === 429 || res.status >= 500) {
          continue;
        }
        throw err;
      }

      const json = (await res.json()) as any;
      const blobId =
        json?.newlyCreated?.blobObject?.blobId ??
        json?.alreadyCertified?.blobId ??
        json?.blobObject?.blobId;

      if (!blobId) {
        throw new Error("WALRUS_MISSING_BLOB_ID");
      }

      lastGoodWriterIdx = idx;
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
    } catch (err) {
      lastError = err;
      const message = String((err as Error)?.message ?? "");
      const retryable =
        message.includes("fetch failed") ||
        message.includes("ETIMEDOUT") ||
        message.includes("ECONNRESET") ||
        message.includes("WALRUS_UPLOAD_FAILED:429") ||
        /WALRUS_UPLOAD_FAILED:5\d{2}/.test(message);
      if (!retryable || writerAttempt === WALRUS_PUBLISHER_BASE_URLS.length - 1) {
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error("WALRUS_UPLOAD_FAILED");
}
