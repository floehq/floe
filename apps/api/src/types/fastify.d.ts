import type { FastifyBaseLogger } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * A child logger with request-scoped context (requestId, authMethod,
     * subject, owner) baked in. Created in the onRequest hook.
     * Use instead of `req.log` to get structured log output with
     * request-level correlation fields.
     */
    childLogger: FastifyBaseLogger;
  }
}
