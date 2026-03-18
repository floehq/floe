import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { fromB64, fromHEX } from "@mysten/sui/utils";

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
      "SUI_RPC_URL looks invalid/unreachable (rpc.testnet.sui.io). Use a fullnode URL like https://fullnode.testnet.sui.io:443"
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

export const suiNetwork = parseSuiNetwork();
export const suiRpcUrl = parseSuiRpcUrl(suiNetwork);
const suiPrivateKey = parseSuiPrivateKey();

export const suiClient = new SuiClient({ url: suiRpcUrl });

export const suiSigner = createSignerFromEnv(suiPrivateKey);
