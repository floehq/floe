import { getSuiClient } from "../../state/sui.js";

export type WalrusBlobState = {
  endEpoch: number | null;
};

export async function getWalrusBlobState(blobObjectId: string): Promise<WalrusBlobState> {
  const updatedObj = await getSuiClient().getObject({
    id: blobObjectId,
    options: { showContent: true },
  });

  const contentFields = (
    updatedObj?.data?.content as { fields?: Record<string, unknown> } | undefined
  )?.fields;
  const storageFields = contentFields?.storage as { fields?: Record<string, unknown> } | undefined;
  const endEpoch = storageFields?.fields?.end_epoch;

  return {
    endEpoch:
      endEpoch === null || endEpoch === undefined || !Number.isFinite(Number(endEpoch))
        ? null
        : Number(endEpoch),
  };
}
