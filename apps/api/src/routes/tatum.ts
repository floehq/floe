import { FastifyInstance } from "fastify";
import { searchGlobalFiles } from "../services/tatum/indexer.js";
import { sendApiError } from "../utils/apiError.js";

export default async function tatumRoutes(app: FastifyInstance) {
  app.get("/v1/search", async (req, reply) => {
    const { owner, limit, cursor } = req.query as any;

    try {
      const results = await searchGlobalFiles({
        owner,
        limit: limit ? Number(limit) : undefined,
        cursor,
      });

      return reply.code(200).send(results);
    } catch (err: any) {
      req.log.error({ err }, "Global search failed");
      return sendApiError(
        reply,
        500,
        "INTERNAL_ERROR",
        "Failed to perform global search via Tatum"
      );
    }
  });
}
