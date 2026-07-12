import { suiClient } from "../../state/sui.js";

export type WalrusBlobState = {
  endEpoch: number | null;
};

export async function getWalrusBlobState(blobObjectId: string): Promise<WalrusBlobState> {
  const updatedObj = await suiClient.getObject({
    id: blobObjectId,
    options: { showContent: true },
  });

  const fields = (updatedObj.data?.content as any)?.fields;
  const endEpoch = fields?.storage?.fields?.end_epoch;

  return {
    endEpoch:
      endEpoch === null || endEpoch === undefined || !Number.isFinite(Number(endEpoch))
        ? null
        : Number(endEpoch),
  };
}
