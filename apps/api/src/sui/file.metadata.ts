import { Transaction } from "@mysten/sui/transactions";
import { suiClient, suiSigner } from "../state/sui.js";

const SUI_PACKAGE_ID = process.env.SUI_PACKAGE_ID;

if (!SUI_PACKAGE_ID) {
  throw new Error("SUI_PACKAGE_ID is not set");
}

export interface FinalizeFileInput {
  blobId: string;
  sizeBytes: number;
  mimeType: string;
  owner?: string;
  walrusEndEpoch?: number;
}

export interface FinalizeFileResult {
  fileId: string;
}

export async function finalizeFileMetadata(
  input: FinalizeFileInput
): Promise<FinalizeFileResult> {
  const tx = new Transaction();

  tx.moveCall({
    target: `${SUI_PACKAGE_ID}::file::create_with_owner`,
    arguments: [
      tx.pure.string(input.blobId),
      tx.pure.u64(input.sizeBytes),
      tx.pure.string(input.mimeType),
      input.owner 
        ? tx.pure.option("address", input.owner)
        : tx.pure.option("address", null),
      input.walrusEndEpoch !== undefined
        ? tx.pure.option("u64", input.walrusEndEpoch)
        : tx.pure.option("u64", null),
      tx.object("0x6"),
    ],
  });

  const result = await suiClient.signAndExecuteTransaction({
    transaction: tx,
    signer: suiSigner,
    options: {
      showObjectChanges: true,
    },
  });

  const created = result.objectChanges?.find(
    (c: any) => c.type === "created" && c.objectType?.includes("::file::FileMeta")
  );

  if (!created || !("objectId" in created)) {
    throw new Error("SUI_FILE_CREATE_FAILED");
  }

  return { fileId: created.objectId };
}
