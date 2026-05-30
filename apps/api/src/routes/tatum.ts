import { FastifyInstance } from "fastify";

import { listDiscoveryFiles } from "../db/files.repository.js";
import { searchGlobalFiles } from "../services/tatum/indexer.js";
import { sendApiError } from "../utils/apiError.js";

export interface TatumSearchDependencies {
  searchGlobalFiles: typeof searchGlobalFiles;
  listDiscoveryFiles: typeof listDiscoveryFiles;
}

const defaultDependencies: TatumSearchDependencies = {
  searchGlobalFiles,
  listDiscoveryFiles,
};

export function createTatumSearchRoutes(
  dependencies: TatumSearchDependencies = defaultDependencies
) {
  return async function tatumRoutes(app: FastifyInstance) {
    app.get("/v1/search", async (req, reply) => {
      const query = req.query as Record<string, string | undefined>;
      const owner = query.owner?.trim() || null;
      const chain = query.chain?.trim() || null;
      const cursor = query.cursor?.trim() || null;
      const limit = query.limit ? Number(query.limit) : undefined;

      const searchLimit = limit ? Math.min(100, Math.max(1, limit)) : undefined;

      try {
        if (!chain) {
          const results = await dependencies.searchGlobalFiles({
            owner: owner ?? undefined,
            cursor: cursor ?? undefined,
            limit: searchLimit,
          });

          return reply.code(200).send({
            source: "tatum-gateway",
            rpcProvider: "tatum",
            ...results,
          });
        }

        const results = await dependencies.listDiscoveryFiles({
          owner,
          chain,
          cursor,
          limit: searchLimit,
        });

        return reply.code(200).send({
          source: "floe-index",
          rpcProvider: "floe-db",
          ...results,
        });
      } catch (err: any) {
        req.log.error({ err }, "Global discovery search failed");

        if (!chain) {
          try {
            const results = await dependencies.listDiscoveryFiles({
              owner,
              chain,
              cursor,
              limit: searchLimit,
            });

            return reply.code(200).send({
              source: "floe-index-fallback",
              rpcProvider: "floe-db",
              ...results,
            });
          } catch (fallbackErr: any) {
            req.log.error({ err: fallbackErr }, "Fallback discovery search failed");
            const fallbackMessage = fallbackErr.message || "Failed to perform fallback search";
            return sendApiError(
              reply,
              500,
              "INTERNAL_ERROR",
              fallbackMessage
            );
          }
        }

        const message = err.message || "Failed to perform global search via Tatum";

        return sendApiError(reply, 500, "INTERNAL_ERROR", message);
      }
    });
  };
}

export default createTatumSearchRoutes();
