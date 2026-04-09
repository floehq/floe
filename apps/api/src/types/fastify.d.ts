import "fastify";
import type { AuthProvider } from "../services/auth/auth.provider.js";
import type { RequestIdentity } from "../services/auth/auth.context.js";

declare module "fastify" {
  interface FastifyInstance {
    authProvider: AuthProvider;
  }

  interface FastifyRequest {
    authContext?: RequestIdentity;
  }
}
