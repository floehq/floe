import "fastify";
import type { AuthProvider } from "../services/auth/auth.provider.js";

declare module "fastify" {
  interface FastifyInstance {
    authProvider: AuthProvider;
  }
}
