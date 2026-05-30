import { ServerConfig } from "../../config/server.config.js";
import { resolveTatumMintRoute } from "./mint.provider.js";

const TATUM_API_KEY = process.env.TATUM_API_KEY;
const TATUM_TEST_PRIVATE_KEY = process.env.TATUM_TEST_PRIVATE_KEY ?? process.env.TATUM_PRIVATE_KEY ?? null;
const TATUM_SIGNATURE_ID = process.env.TATUM_SIGNATURE_ID ?? null;
const TATUM_NATIVE_CONTRACT_ADDRESS = process.env.TATUM_NATIVE_CONTRACT_ADDRESS ?? null;

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

export async function anchorMetadataMultiChain(params: MultiChainAnchorParams): Promise<MultiChainAnchorResult> {
  if (!TATUM_API_KEY) {
    throw new Error("TATUM_API_KEY is not set");
  }

  const baseUrl = ServerConfig.publicBaseUrl.replace(/\/$/, "");
  const mintRoute = resolveTatumMintRoute(params.chain);

  // The metadata URL should point to a JSON endpoint that returns the NFT metadata.
  // In Floe, we have GET /v1/files/:fileId/metadata.json for this purpose.
  const metadataUrl = `${baseUrl}/v1/files/${params.blobId}/metadata.json`;

  if (metadataUrl.includes("localhost") || metadataUrl.includes("127.0.0.1")) {
    console.warn(`[Tatum] Warning: metadataUrl (${metadataUrl}) is on localhost. Tatum's minting service may not be able to reach it.`);
  }

  const tatumChain = mintRoute.chain;

  console.log(`[Tatum] Anchoring ${params.blobId} to ${tatumChain} via ${mintRoute.mode}...`);

  const body: Record<string, unknown> = {
    chain: tatumChain,
    to: params.to,
    url: metadataUrl,
  };

  if (mintRoute.mode === "native") {
    if (!TATUM_NATIVE_CONTRACT_ADDRESS) {
      throw new Error("TATUM_NATIVE_CONTRACT_ADDRESS is not set for native Tatum minting");
    }
    body.contractAddress = TATUM_NATIVE_CONTRACT_ADDRESS;
    if (TATUM_SIGNATURE_ID) {
      body.signatureId = TATUM_SIGNATURE_ID;
    } else if (TATUM_TEST_PRIVATE_KEY) {
      body.privateKey = TATUM_TEST_PRIVATE_KEY;
    } else {
      throw new Error("TATUM_TEST_PRIVATE_KEY or TATUM_SIGNATURE_ID is required for native Tatum minting");
    }
  }

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
