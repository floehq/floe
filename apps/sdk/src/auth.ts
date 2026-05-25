import type { AuthConfig, HeaderProvider } from "./types.js";

const SUI_ADDRESS_RE = /^(0x)?[0-9a-fA-F]{64}$/;
const EVM_ADDRESS_RE = /^(0x)?[0-9a-fA-F]{40}$/;

function normalizeAddress(name: string, value?: string): string | undefined {
  if (!value) return undefined;
  const isSui = SUI_ADDRESS_RE.test(value);
  const isEvm = EVM_ADDRESS_RE.test(value);
  if (!isSui && !isEvm) {
    throw new Error(`${name} must be a valid Sui (32-byte) or EVM (20-byte) address`);
  }
  const clean = value.replace(/^0x/i, "");
  return isSui ? `0x${clean.toLowerCase()}` : `0x${clean}`;
}

export async function resolveHeaderProvider(
  provider?: HeaderProvider
): Promise<Record<string, string | number | boolean | null | undefined> | undefined> {
  if (!provider) return undefined;
  if (typeof provider === "function") {
    return await provider();
  }
  return provider;
}

export function headersFromAuth(auth?: AuthConfig): Record<string, string> {
  if (!auth) return {};

  const headers: Record<string, string> = {};

  if (auth.apiKey) headers["x-api-key"] = auth.apiKey;
  if (auth.bearerToken) headers.authorization = `Bearer ${auth.bearerToken}`;
  if (auth.authUser) headers["x-auth-user"] = auth.authUser;

  const wallet = normalizeAddress("walletAddress", auth.walletAddress);
  if (wallet) headers["x-wallet-address"] = wallet;

  const owner = normalizeAddress("ownerAddress", auth.ownerAddress);
  if (owner) headers["x-owner-address"] = owner;

  return headers;
}
