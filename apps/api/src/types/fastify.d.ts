// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used in module augmentation below
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { AuthContext } from "../services/auth/auth.context.js";
import type { AuthProvider } from "../services/auth/auth.provider.js";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * A child logger with request-scoped context (requestId, authMethod,
     * subject, owner) baked in. Created in the onRequest hook.
     * Use instead of `req.log` to get structured log output with
     * request-level correlation fields.
     */
    childLogger: FastifyBaseLogger;

    /**
     * The resolved authentication identity for this request.
     * Set by the onRequest hook via authProvider.resolveIdentity().
     */
    authContext: AuthContext;
  }

  interface FastifyInstance {
    /**
     * The configured auth provider. Provides identity resolution,
     * authorization checks, and rate limiting for all routes.
     */
    authProvider: AuthProvider;
  }
}
