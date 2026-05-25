import { anchorMetadataMultiChain } from "../apps/api/src/services/tatum/anchor.ts";

async function testAnchoring() {
  const apiKey = process.env.TATUM_API_KEY;
  if (!apiKey) {
    console.error("TATUM_API_KEY not found in environment.");
    process.exit(1);
  }

  console.log("Testing Tatum Multi-Chain Anchoring (CELO Testnet)...");
  try {
    // We'll try to mint a test anchor on Celo Testnet (Alfajores)
    // Tatum NFT Express supports CELO
    const result = await anchorMetadataMultiChain({
      chain: "CELO",
      to: "0x471EcE370550c122170519083341112253063773", // Checksummed Celo address
      blobId: "test-blob-" + Date.now(),
      sizeBytes: 1024,
      mimeType: "text/plain",
      filename: "test-anchor.txt",
      checksum: "5f70bf18a086007016e948b04aed3b82103a36bea41755b6cddfaf10ace3c6ef"
    });
    console.log("Success! Transaction ID:", result.txId);
  } catch (err) {
    console.error("Tatum Anchoring Test Failed:", err.message);
  }
}

testAnchoring();
