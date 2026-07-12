import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { toB64 } from "@mysten/sui/utils";
import { nodeToWeb } from "../../../utils/nodeToWeb.js";
import { getSuiClient, getSuiNetwork, getSuiSigner } from "../../../state/sui.js";
import { WalrusUploadLimits } from "../../../config/walrus.config.js";
import type { WalrusUploadParams, WalrusUploadResult } from "./types.js";

const FETCH_TIMEOUT_MS = WalrusUploadLimits.timeoutMs;
const MIN_BALANCE_MIST = 1_000_000_000n;
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

function pickFirstString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function pickFirstNumber(values: unknown[]): number | undefined {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function parseOptionalSuiAddressEnv(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  if (!SUI_ADDRESS_RE.test(raw)) {
    throw new Error(`${name} must be a valid 32-byte Sui address`);
  }
  return `0x${raw.replace(/^0x/i, "").toLowerCase()}`;
}

let _publisherBaseUrls: string[] | null = null;
function getPublisherBaseUrls(): string[] {
  if (!_publisherBaseUrls) _publisherBaseUrls = parseSdkBaseUrls();
  return _publisherBaseUrls;
}

let _sendObjectTo: string | undefined;
function getSendObjectTo(): string | undefined {
  if (_sendObjectTo === undefined)
    _sendObjectTo = parseOptionalSuiAddressEnv("WALRUS_SEND_OBJECT_TO");
  return _sendObjectTo;
}

export function describeWalrusPublisherBackend() {
  const urls = getPublisherBaseUrls();
  return {
    primary: urls[0] ?? null,
    fallbacks: urls.slice(1),
    count: urls.length,
  };
}

let lastBalanceCheck = 0;
async function checkBalanceOnce(clientAddress: string) {
  const now = Date.now();
  if (now - lastBalanceCheck < 60_000) return;

  const bal = await getSuiClient().getBalance({ owner: clientAddress });
  if (BigInt(bal.totalBalance) < MIN_BALANCE_MIST) {
    throw new Error("INSUFFICIENT_BALANCE");
  }

  lastBalanceCheck = now;
}

async function createAuthHeaders(
  keypair: Ed25519Keypair,
  apiBaseUrl: string,
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
  params: WalrusUploadParams,
): Promise<WalrusUploadResult> {
  const urls = getPublisherBaseUrls();
  if (urls.length === 0) {
    throw new Error(
      "FLOE_WALRUS_PUBLISHER_BASE_URL or FLOE_WALRUS_PUBLISHER_BASE_URLS must be set to http(s) URL when FLOE_WALRUS_STORE_MODE=publisher",
    );
  }
  for (const baseUrl of urls) {
    if (!/^https?:\/\//.test(baseUrl)) {
      throw new Error(
        "FLOE_WALRUS_PUBLISHER_BASE_URLS entries must start with http:// or https://",
      );
    }
  }

  const startIdx =
    Number.isInteger(lastGoodWriterIdx) && lastGoodWriterIdx >= 0 && lastGoodWriterIdx < urls.length
      ? lastGoodWriterIdx
      : 0;

  let lastError: unknown = null;
  for (let writerAttempt = 0; writerAttempt < urls.length; writerAttempt += 1) {
    const idx = (startIdx + writerAttempt) % urls.length;
    const baseUrl = urls[idx];
    const paramsQs = new URLSearchParams({ epochs: String(params.epochs) });
    const sendObjectTo = getSendObjectTo();
    if (sendObjectTo) {
      paramsQs.set("send_object_to", sendObjectTo);
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
    };

    if (getSuiNetwork() === "mainnet") {
      const keypair = getSuiSigner();
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
      const newlyCreated = json?.newlyCreated ?? json?.newly_created;
      const alreadyCertified = json?.alreadyCertified ?? json?.already_certified;
      const blobObject =
        newlyCreated?.blobObject ??
        newlyCreated?.blob_object ??
        alreadyCertified?.blobObject ??
        alreadyCertified?.blob_object ??
        json?.blobObject ??
        json?.blob_object;

      const blobId = pickFirstString([
        newlyCreated?.blobId,
        newlyCreated?.blob_id,
        newlyCreated?.blobObject?.blobId,
        newlyCreated?.blobObject?.blob_id,
        newlyCreated?.blob_object?.blobId,
        newlyCreated?.blob_object?.blob_id,
        alreadyCertified?.blobId,
        alreadyCertified?.blob_id,
        alreadyCertified?.blobObject?.blobId,
        alreadyCertified?.blobObject?.blob_id,
        alreadyCertified?.blob_object?.blobId,
        alreadyCertified?.blob_object?.blob_id,
        blobObject?.blobId,
        blobObject?.blob_id,
      ]);

      if (!blobId) {
        throw new Error("WALRUS_MISSING_BLOB_ID");
      }

      const objectId = pickFirstString([
        newlyCreated?.blobObjectId,
        newlyCreated?.blob_object_id,
        newlyCreated?.blobObject?.id,
        newlyCreated?.blobObject?.objectId,
        newlyCreated?.blobObject?.object_id,
        newlyCreated?.blob_object?.id,
        newlyCreated?.blob_object?.objectId,
        newlyCreated?.blob_object?.object_id,
        alreadyCertified?.blobObjectId,
        alreadyCertified?.blob_object_id,
        alreadyCertified?.blobObject?.id,
        alreadyCertified?.blobObject?.objectId,
        alreadyCertified?.blobObject?.object_id,
        alreadyCertified?.blob_object?.id,
        alreadyCertified?.blob_object?.objectId,
        alreadyCertified?.blob_object?.object_id,
        blobObject?.id,
        blobObject?.objectId,
        blobObject?.object_id,
      ]);
      const endEpoch = pickFirstNumber([
        newlyCreated?.endEpoch,
        newlyCreated?.end_epoch,
        newlyCreated?.blobObject?.storage?.endEpoch,
        newlyCreated?.blobObject?.storage?.end_epoch,
        newlyCreated?.blob_object?.storage?.endEpoch,
        newlyCreated?.blob_object?.storage?.end_epoch,
        alreadyCertified?.endEpoch,
        alreadyCertified?.end_epoch,
        alreadyCertified?.blobObject?.storage?.endEpoch,
        alreadyCertified?.blobObject?.storage?.end_epoch,
        alreadyCertified?.blob_object?.storage?.endEpoch,
        alreadyCertified?.blob_object?.storage?.end_epoch,
        blobObject?.storage?.endEpoch,
        blobObject?.storage?.end_epoch,
      ]);

      lastGoodWriterIdx = idx;
      return {
        blobId,
        objectId,
        cost: pickFirstNumber([
          newlyCreated?.cost,
          newlyCreated?.storageCost,
          newlyCreated?.storage_cost,
        ]),
        endEpoch,
        source: newlyCreated ? "newly_created" : alreadyCertified ? "already_certified" : "unknown",
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
      if (!retryable || writerAttempt === urls.length - 1) {
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error("WALRUS_UPLOAD_FAILED");
}
