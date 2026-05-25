import { searchGlobalFiles } from "../apps/api/src/services/tatum/indexer.js";
import { suiSigner } from "../apps/api/src/state/sui.js";

async function testTatum() {
  const apiKey = process.env.TATUM_API_KEY;
  if (!apiKey) {
    console.error("TATUM_API_KEY not found in environment.");
    process.exit(1);
  }

  const myAddress = suiSigner.toSuiAddress();
  console.log("Your Sui Address:", myAddress);

  console.log("\nTesting Tatum Gateway Connectivity (Testnet)...");
  try {
    const gatewayUrl = "https://sui-testnet.gateway.tatum.io";
    const response = await fetch(gatewayUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sui_getLatestCheckpointSequenceNumber",
        params: [],
      }),
    });

    const json = await response.json();
    if (json.error) {
       console.error("Tatum Basic RPC Error:", json.error);
    } else {
       console.log("Success! Latest Checkpoint:", json.result);
    }

    console.log("\nTesting Tatum Indexer (Search by Owner)...");
    const results = await searchGlobalFiles({
      owner: myAddress,
      limit: 5,
    });
    console.log("Success! Found", results.data.length, "files for your address.");
    if (results.data.length > 0) {
      console.log("Sample Result:", JSON.stringify(results.data[0], null, 2));
    }

    console.log("\nTesting Tatum Indexer (Global Search - Expected to fail/warn)...");
    try {
      await searchGlobalFiles({ limit: 1 });
    } catch (err) {
      console.log("Caught expected limitation:", err.message);
    }
  } catch (err) {
    console.error("Test Failed:", err.message);
  }
}

testTatum();
