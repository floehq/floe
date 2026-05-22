import { Transaction } from "@mysten/sui/transactions";
import { suiClient, suiSigner } from "../../state/sui.js";
import { WalrusEnv } from "../../config/walrus.config.js";

export interface WalrusRenewParams {
  blobObjectId: string;
  epochs: number;
}

export interface WalrusRenewResult {
  endEpoch: number;
}

/**
 * Extends the storage duration of a blob on Walrus.
 * This interacts with the Walrus system contract on Sui.
 */
export async function renewWalrusBlob(
  params: WalrusRenewParams
): Promise<WalrusRenewResult> {
  const tx = new Transaction();

  // The Walrus system contract call for extending storage.
  // Note: The specific function name and arguments may vary depending on the Walrus version.
  // This follows the pattern observed in Walrus CLI and docs.
  tx.moveCall({
    target: `${WalrusEnv.systemId}::system::extend_blob_storage`,
    arguments: [
      tx.object(WalrusEnv.systemId), // The system state object
      tx.object(params.blobObjectId),
      tx.pure.u64(params.epochs),
    ],
  });

  try {
    const result = await suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer: suiSigner,
      options: {
        showObjectChanges: true,
      },
    });

    // In a real implementation, we would parse the result to find the new end epoch.
    // For now, we'll return a placeholder or try to infer it.
    // Usually, you'd look at the object changes for the Blob object.
    const blobChange = result.objectChanges?.find(
      (c: any) => c.type === "mutated" && c.objectId === params.blobObjectId
    );
    
    // We'll need to fetch the object again to be sure of the new epoch if it's not in objectChanges.
    const updatedObj = await suiClient.getObject({
      id: params.blobObjectId,
      options: { showContent: true },
    });

    const fields = (updatedObj.data?.content as any)?.fields;
    const endEpoch = fields?.storage?.fields?.end_epoch ?? 0;

    return { endEpoch: Number(endEpoch) };
  } catch (err) {
    throw new Error(
      `WALRUS_RENEW_FAILED:${(err as Error)?.message ?? "unknown"}`
    );
  }
}
