import { ServerConfig } from "../../config/server.config.js";

const TATUM_API_KEY = process.env.TATUM_API_KEY;

export interface MultiChainAnchorParams {
  chain: string;
  to: string;
  blobId: string;
  sizeBytes: number;
  checksum?: string | null;
  mimeType: string;
  filename: string;
}

export interface MultiChainAnchorResult {
  txId: string;
  assetId?: string;
}

/**
 * Maps common chain names to Tatum's internal identifiers.
 */
const CHAIN_MAP: Record<string, string> = {
  "BASE": "ETH_BASE",
  "ETHEREUM": "ETH",
  "MAINNET": "ETH",
  "POLYGON": "MATIC",
  "MUMBAI": "MATIC",
  "ARBITRUM": "ETH_ARB",
  "OPTIMISM": "ETH_OP",
  "AVALANCHE": "AVAX",
  "FANTOM": "FTM",
  "CELO": "CELO",
  "ALFAJORES": "CELO",
  "BSC": "BSC",
  "BINANCE": "BSC",
  "SOLANA": "SOL",
};

export async function anchorMetadataMultiChain(params: MultiChainAnchorParams): Promise<MultiChainAnchorResult> {
  if (!TATUM_API_KEY) {
    throw new Error("TATUM_API_KEY is not set");
  }

  const baseUrl = ServerConfig.publicBaseUrl.replace(/\/$/, "");

  // Build a metadata object that standard NFT marketplaces can read
  const metadata = {
    name: params.filename,
    description: `Floe Decentralized File Anchor: ${params.blobId}`,
    image: `${baseUrl}/v1/files/${params.blobId}/stream`,
    attributes: [
      { trait_type: "Blob ID", value: params.blobId },
      { trait_type: "Size", value: params.sizeBytes },
      { trait_type: "Mime Type", value: params.mimeType },
      ...(params.checksum ? [{ trait_type: "Checksum", value: params.checksum }] : []),
    ],
    external_url: `${baseUrl}/files/${params.blobId}`,
  };

  // The metadata URL should point to a JSON endpoint that returns the above object.
  // In Floe, we have GET /v1/files/:fileId/metadata.json for this purpose.
  const metadataUrl = `${baseUrl}/v1/files/${params.blobId}/metadata.json`;

  if (metadataUrl.includes("localhost") || metadataUrl.includes("127.0.0.1")) {
    console.warn(`[Tatum] Warning: metadataUrl (${metadataUrl}) is on localhost. Tatum's minting service may not be able to reach it.`);
  }

  const rawChain = params.chain.toUpperCase();
  const tatumChain = CHAIN_MAP[rawChain] || rawChain;

  console.log(`[Tatum] Anchoring ${params.blobId} to ${tatumChain}...`);

  const body = {
    chain: tatumChain,
    to: params.to,
    url: metadataUrl,
  };

  try {
    const response = await fetch("https://api.tatum.io/v3/nft/mint", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": TATUM_API_KEY,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      let errorData;
      try {
        errorData = JSON.parse(text);
      } catch {
        errorData = text;
      }

      console.error("[Tatum] Minting failed:", {
        status: response.status,
        error: errorData,
        chain: tatumChain,
        to: params.to
      });

      throw new Error(`TATUM_NFT_MINT_FAILED:${response.status}:${text}`);
    }

    const json = (await response.json()) as any;
    console.log(`[Tatum] Successfully anchored to ${tatumChain}. TxID: ${json.txId}`);

    return {
      txId: json.txId,
      assetId: json.tokenId,
    };
  } catch (err: any) {
    if (err.message.includes("TATUM_NFT_MINT_FAILED")) throw err;
    
    console.error("[Tatum] Network or unexpected error:", err.message);
    throw new Error(`TATUM_CONNECTION_ERROR:${err.message}`);
  }
}
