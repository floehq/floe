import { suiNetwork } from "../../state/sui.js";

const TATUM_API_KEY = process.env.TATUM_API_KEY;
const SUI_PACKAGE_ID = process.env.SUI_PACKAGE_ID;

const GATEWAY_URLS: Record<string, string> = {
  mainnet: "https://sui-mainnet.gateway.tatum.io",
  testnet: "https://sui-testnet.gateway.tatum.io",
  devnet: "https://sui-devnet.gateway.tatum.io",
};

export interface FileMetaSearchQuery {
  owner?: string;
  limit?: number;
  cursor?: string;
}

export interface FileMetaSearchResult {
  objectId: string;
  version: string;
  digest: string;
  type: string;
  owner: string;
  content: any;
}

export async function searchGlobalFiles(query: FileMetaSearchQuery) {
  if (!TATUM_API_KEY) {
    throw new Error("TATUM_API_KEY is not set");
  }
  if (!SUI_PACKAGE_ID) {
    throw new Error("SUI_PACKAGE_ID is not set");
  }

  const gatewayUrl = GATEWAY_URLS[suiNetwork] || GATEWAY_URLS.testnet;
  const structType = `${SUI_PACKAGE_ID}::file::FileMeta`;

  // Tatum's Sui Gateway currently supports suix_getOwnedObjects but not suix_queryObjects.
  // We prioritize suix_getOwnedObjects if an owner is provided.
  const useQueryObjects = !query.owner;
  const method = useQueryObjects ? "suix_queryObjects" : "suix_getOwnedObjects";

  const params: any = useQueryObjects
    ? [
        {
          filter: { StructType: structType },
          options: { showType: true, showContent: true, showOwner: true },
        },
        query.cursor ?? null,
        query.limit ?? 50,
        true, // Descending
      ]
    : [
        query.owner,
        {
          filter: { StructType: structType },
          options: { showType: true, showContent: true, showOwner: true },
        },
        query.cursor ?? null,
        query.limit ?? 50,
      ];

  try {
    const response = await fetch(gatewayUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": TATUM_API_KEY,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`TATUM_SUI_QUERY_FAILED:${response.status}:${text}`);
    }

    const json = (await response.json()) as any;
    if (json.error) {
      if (json.error.code === -32601 && useQueryObjects) {
        throw new Error(
          "Tatum's Sui gateway does not support global filtering (suix_queryObjects). Please provide an 'owner' address to use suix_getOwnedObjects, or use a full-indexer RPC provider."
        );
      }
      throw new Error(`TATUM_SUI_QUERY_ERROR:${JSON.stringify(json.error)}`);
    }

    const data = (json.result?.data ?? []).map((item: any) => ({
      objectId: item.data?.objectId,
      version: item.data?.version,
      digest: item.data?.digest,
      type: item.data?.type,
      owner: item.data?.owner?.AddressOwner || item.data?.owner,
      content: item.data?.content?.fields,
    }));

    return {
      data: data as FileMetaSearchResult[],
      nextCursor: json.result?.nextCursor || null,
      hasNextPage: !!json.result?.hasNextPage,
    };
  } catch (err: any) {
    if (err.message.includes("TATUM_SUI_QUERY")) throw err;
    throw new Error(`TATUM_INDEXER_CONNECTION_ERROR:${err.message}`);
  }
}
