import { Transaction } from "@mysten/sui/transactions";
import type { SuiObjectChange } from "@mysten/sui/client";
import { getSuiSigner } from "../state/sui.js";
import { suiCircuit } from "../services/circuit-breaker/instances.js";

const SUI_CLOCK_OBJECT_ID = "0x6";

let _suiPackageId: string | null = null;

function getSuiPackageId(): string {
  if (_suiPackageId) return _suiPackageId;
  const value = process.env.SUI_PACKAGE_ID?.trim();
  if (!value) {
    throw new Error("SUI_PACKAGE_ID is not set");
  }
  _suiPackageId = value;
  return value;
}

export interface FinalizeFileInput {
  blobId: string;
  blobObjectId?: string;
  sizeBytes: number;
  mimeType: string;
  checksum?: string;
  owner?: string;
  walrusEndEpoch?: number;
}

export interface FinalizeFileResult {
  fileId: string;
}

/**
 * Finalize file metadata on Sui with circuit breaker protection.
 *
 * If the suiCircuit is OPEN, throws CircuitBreakerError immediately
 * instead of attempting RPC calls that are likely to fail.
 */
export async function finalizeFileMetadata(input: FinalizeFileInput): Promise<FinalizeFileResult> {
  return suiCircuit.call(async () => {
    const tx = new Transaction();

    tx.moveCall({
      target: `${getSuiPackageId()}::file::create_with_owner`,
      arguments: [
        tx.pure.string(input.blobId),
        input.blobObjectId
          ? tx.pure.option("address", input.blobObjectId)
          : tx.pure.option("address", null),
        tx.pure.u64(input.sizeBytes),
        tx.pure.string(input.mimeType),
        input.checksum ? tx.pure.option("string", input.checksum) : tx.pure.option("string", null),
        input.owner ? tx.pure.option("address", input.owner) : tx.pure.option("address", null),
        input.walrusEndEpoch !== undefined
          ? tx.pure.option("u64", input.walrusEndEpoch)
          : tx.pure.option("u64", null),
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });

    let result;
    try {
      result = await getSuiSigner().signAndExecuteTransaction({
        transaction: tx,
        options: {
          showObjectChanges: true,
        },
      });
    } catch (err) {
      throw new Error(`SUI_FINALIZE_SUBMIT_FAILED:${(err as Error)?.message ?? "unknown"}`);
    }

    const created = result.objectChanges?.find(
      (c: SuiObjectChange) => c.type === "created" && c.objectType?.includes("::file::FileMeta"),
    );

    if (!created || !("objectId" in created)) {
      throw new Error("SUI_FILE_CREATE_FAILED");
    }

    return { fileId: created.objectId };
  });
}

export async function renewFileMetadata(params: {
  fileId: string;
  blobObjectId?: string;
  walrusEndEpoch: number;
}): Promise<void> {
  return suiCircuit.call(async () => {
    const tx = new Transaction();

    if (params.blobObjectId) {
      tx.moveCall({
        target: `${getSuiPackageId()}::file::update_walrus_info`,
        arguments: [
          tx.object(params.fileId),
          tx.pure.address(params.blobObjectId),
          tx.pure.u64(params.walrusEndEpoch),
        ],
      });
    } else {
      tx.moveCall({
        target: `${getSuiPackageId()}::file::update_expiry`,
        arguments: [tx.object(params.fileId), tx.pure.u64(params.walrusEndEpoch)],
      });
    }

    try {
      await getSuiSigner().signAndExecuteTransaction({
        transaction: tx,
      });
    } catch (err) {
      throw new Error(`SUI_RENEW_SUBMIT_FAILED:${(err as Error)?.message ?? "unknown"}`);
    }
  });
}
