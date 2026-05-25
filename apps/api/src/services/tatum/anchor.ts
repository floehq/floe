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

export async function anchorMetadataMultiChain(params: MultiChainAnchorParams): Promise<MultiChainAnchorResult> {
  if (!TATUM_API_KEY) {
    throw new Error("TATUM_API_KEY is not set");
  }

  // Build a metadata object that standard NFT marketplaces can read
  const metadata = {
    name: params.filename,
    description: `Floe Decentralized File Anchor: ${params.blobId}`,
    image: `https://api.floehq.com/v1/files/${params.blobId}/icon`, // Placeholder
    attributes: [
      { trait_type: "Blob ID", value: params.blobId },
      { trait_type: "Size", value: params.sizeBytes },
      { trait_type: "Mime Type", value: params.mimeType },
      ...(params.checksum ? [{ trait_type: "Checksum", value: params.checksum }] : []),
    ],
    external_url: `https://floehq.com/files/${params.blobId}`,
  };

  // In a real app, you'd upload this metadata to IPFS first.
  // For the hackathon, we'll use a data URI or a Floe-hosted URL.
  const metadataUrl = `https://api.floehq.com/v1/files/${params.blobId}/metadata.json`;

  const response = await fetch("https://api.tatum.io/v3/nft/mint", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": TATUM_API_KEY,
    },
    body: JSON.stringify({
      chain: params.chain.toUpperCase(),
      to: params.to,
      url: metadataUrl,
      // We use Tatum NFT Express (no private key needed, uses Tatum's credits)
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`TATUM_NFT_MINT_FAILED:${response.status}:${text}`);
  }

  const json = (await response.json()) as any;
  return {
    txId: json.txId,
    assetId: json.tokenId,
  };
}
