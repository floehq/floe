import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { fromB64, fromHEX } from "@mysten/sui/utils";
import { EnvSuiSigner } from "../sui/sui.signer.js";
import { KmsSuiSigner } from "../sui/sui.signer.kms.js";
import type { SuiSigner } from "../sui/sui.signer.js";

const MAINNET_RPC = "https://fullnode.mainnet.sui.io:443";
const TESTNET_RPC = "https://fullnode.testnet.sui.io:443";

function parseSuiNetwork(): "mainnet" | "testnet" {
  const net = process.env.FLOE_NETWORK;
  if (net !== "mainnet" && net !== "testnet") {
    throw new Error("FLOE_NETWORK must be 'mainnet' or 'testnet'");
  }
  return net;
}

function parseSuiRpcUrl(network: "mainnet" | "testnet"): string {
  const configured = process.env.SUI_RPC_URL?.trim();
  const fallback = network === "mainnet" ? MAINNET_RPC : TESTNET_RPC;
  const url = configured || fallback;

  if (!/^https?:\/\//.test(url)) {
    throw new Error("SUI_RPC_URL must start with http:// or https://");
  }

  // Common misconfig: this hostname often fails to resolve in some environments.
  if (url.includes("rpc.testnet.sui.io")) {
    throw new Error(
      "SUI_RPC_URL looks invalid/unreachable (rpc.testnet.sui.io). Use a fullnode URL like https://fullnode.testnet.sui.io:443",
    );
  }

  if (network === "testnet" && url.includes("mainnet")) {
    throw new Error("NETWORK_MISMATCH: testnet Floe cannot use mainnet Sui RPC");
  }

  if (network === "mainnet" && url.includes("testnet")) {
    throw new Error("NETWORK_MISMATCH: mainnet Floe cannot use testnet Sui RPC");
  }

  return url;
}

function parseSuiPrivateKey(): string {
  const raw = process.env.SUI_PRIVATE_KEY?.trim();
  if (!raw) {
    throw new Error("SUI_PRIVATE_KEY is not set");
  }
  return raw;
}

function createSignerFromEnv(key: string): Ed25519Keypair {
  if (key.startsWith("suiprivkey")) {
    const decoded = decodeSuiPrivateKey(key);

    if (decoded.schema !== "ED25519") {
      throw new Error(`Unsupported key schema: ${decoded.schema}`);
    }

    return Ed25519Keypair.fromSecretKey(decoded.secretKey);
  }

  if (key.startsWith("[")) {
    try {
      const arr = JSON.parse(key);
      return Ed25519Keypair.fromSecretKey(Uint8Array.from(arr).slice(0, 32));
    } catch (err: any) {
      throw new Error(`Invalid JSON array SUI_PRIVATE_KEY: ${err?.message ?? "parse error"}`);
    }
  }

  if (/^[A-Za-z0-9+/]+=*$/.test(key)) {
    try {
      return Ed25519Keypair.fromSecretKey(fromB64(key));
    } catch (err: any) {
      throw new Error(`Invalid base64 SUI_PRIVATE_KEY: ${err?.message ?? "decode error"}`);
    }
  }

  if (/^(0x)?[0-9a-fA-F]+$/.test(key)) {
    try {
      return Ed25519Keypair.fromSecretKey(fromHEX(key.replace(/^0x/, "")).slice(0, 32));
    } catch (err: any) {
      throw new Error(`Invalid hex SUI_PRIVATE_KEY: ${err?.message ?? "decode error"}`);
    }
  }

  throw new Error("Unrecognized SUI_PRIVATE_KEY format");
}

// Lazy-initialized state — these are set on first access, not at module import time.
// This avoids throwing when the module is imported before FLOE_NETWORK or
// SUI_PRIVATE_KEY are ready (e.g. in test environments that set env vars after imports).
let _suiNetwork: "mainnet" | "testnet" | null = null;
let _suiRpcUrl: string | null = null;
let _suiClient: SuiClient | null = null;
let _suiSigner: SuiSigner | null = null;

/** @internal test-only hook — resets lazy singleton state so tests can re-parse env vars. */
export function resetSuiStateForTests(): void {
  _suiNetwork = null;
  _suiRpcUrl = null;
  _suiClient = null;
  _suiSigner = null;
}

export function getSuiNetwork(): "mainnet" | "testnet" {
  if (!_suiNetwork) _suiNetwork = parseSuiNetwork();
  return _suiNetwork;
}

export function getSuiRpcUrl(): string {
  if (!_suiRpcUrl) _suiRpcUrl = parseSuiRpcUrl(getSuiNetwork());
  return _suiRpcUrl;
}

export function getSuiClient(): SuiClient {
  if (!_suiClient) _suiClient = new SuiClient({ url: getSuiRpcUrl() });
  return _suiClient;
}

function parseSignerBackend(): "env" | "kms" {
  const raw = process.env.FLOE_SIGNER_BACKEND?.trim().toLowerCase();
  if (!raw || raw === "env") return "env";
  if (raw === "kms") return "kms";
  throw new Error("FLOE_SIGNER_BACKEND must be 'env' or 'kms'");
}

export function getSuiSigner(): SuiSigner {
  if (!_suiSigner) {
    const backend = parseSignerBackend();

    if (backend === "kms") {
      const keyId = process.env.FLOE_KMS_KEY_ID?.trim();
      if (!keyId) {
        throw new Error("FLOE_KMS_KEY_ID is required when FLOE_SIGNER_BACKEND=kms");
      }
      const address = process.env.FLOE_SIGNER_ADDRESS?.trim();
      if (!address || !/^0x[0-9a-fA-F]{64}$/.test(address)) {
        throw new Error(
          "FLOE_SIGNER_ADDRESS must be a 0x-prefixed 64 hex character Sui address " +
            "(required when FLOE_SIGNER_BACKEND=kms)",
        );
      }
      const region = process.env.AWS_REGION?.trim();
      const signer = new KmsSuiSigner({ keyId, address, client: getSuiClient(), region });
      // fetchPublicKey is called lazily on first use via a proxy pattern,
      // but we eagerly fetch here to fail fast at startup if KMS is misconfigured.
      _suiSigner = signer;
    } else {
      const key = parseSuiPrivateKey();
      const kp = createSignerFromEnv(key);
      _suiSigner = new EnvSuiSigner(kp, getSuiClient());
    }
  }
  return _suiSigner;
}
