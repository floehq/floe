import { suiNetwork } from "../../state/sui.js";

const TATUM_API_KEY = process.env.TATUM_API_KEY;
const SUI_PACKAGE_ID = process.env.SUI_PACKAGE_ID;

const MAINNET_GATEWAY = "https://sui-mainnet.gateway.tatum.io";
const TESTNET_GATEWAY = "https://sui-testnet.gateway.tatum.io";

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

  const gatewayUrl = suiNetwork === "mainnet" ? MAINNET_GATEWAY : TESTNET_GATEWAY;
  const structType = `${SUI_PACKAGE_ID}::file::FileMeta`;

  const params: any = [
    {
      filter: {
        MatchAll: [
          { StructType: structType },
          ...(query.owner ? [{ AddressOwner: query.owner }] : []),
        ],
      },
      options: {
        showType: true,
        showContent: true,
        showOwner: true,
      },
    },
    query.cursor ?? null,
    query.limit ?? 50,
    true, // Descending
  ];

  const response = await fetch(gatewayUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": TATUM_API_KEY,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "suix_queryObjects",
      params,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`TATUM_SUI_QUERY_FAILED:${response.status}:${text}`);
  }

  const json = (await response.json()) as any;
  if (json.error) {
    throw new Error(`TATUM_SUI_QUERY_ERROR:${JSON.stringify(json.error)}`);
  }

  return {
    data: (json.result?.data ?? []).map((item: any) => ({
      objectId: item.data?.objectId,
      version: item.data?.version,
      digest: item.data?.digest,
      type: item.data?.type,
      owner: item.data?.owner?.AddressOwner,
      content: item.data?.content?.fields,
    })) as FileMetaSearchResult[],
    nextCursor: json.result?.nextCursor,
    hasNextPage: json.result?.hasNextPage,
  };
}
