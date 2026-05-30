export type TatumMintMode = "express" | "native";

export interface TatumMintRoute {
  chain: string;
  mode: TatumMintMode;
  requiresPrivateKey: boolean;
  requiresContractAddress: boolean;
}

const EXPRESS_CHAIN_MAP: Record<string, string> = {
  bsc: "BSC",
  bnb: "BSC",
  binance: "BSC",
  celo: "CELO",
  alfajores: "CELO",
  eth: "ETH",
  ethereum: "ETH",
  mainnet: "ETH",
  polygon: "MATIC",
  matic: "MATIC",
};

const NATIVE_CHAIN_MAP: Record<string, string> = {
  arbitrum: "ETH_ARB",
  avax: "AVAX",
  avalanche: "AVAX",
  base: "ETH_BASE",
  fantom: "FTM",
  optimism: "ETH_OP",
};

function normalizeChain(rawChain?: string | null) {
  const chain = rawChain?.trim().toLowerCase();
  if (!chain) {
    return "sui";
  }
  return chain.replace(/[-\s]/g, "");
}

export function resolveTatumMintRoute(rawChain?: string | null): TatumMintRoute {
  const normalized = normalizeChain(rawChain);
  const expressChain = EXPRESS_CHAIN_MAP[normalized];
  if (expressChain) {
    return {
      chain: expressChain,
      mode: "express",
      requiresPrivateKey: false,
      requiresContractAddress: false,
    };
  }

  const nativeChain = NATIVE_CHAIN_MAP[normalized];
  if (nativeChain) {
    return {
      chain: nativeChain,
      mode: "native",
      requiresPrivateKey: true,
      requiresContractAddress: true,
    };
  }

  throw new Error(`UNSUPPORTED_TATUM_CHAIN:${rawChain ?? "sui"}`);
}
