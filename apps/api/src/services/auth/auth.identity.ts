import type { FastifyRequest } from "fastify";

import { AuthProviderConfig } from "../../config/auth.config.js";
import { buildLocalAuthContext } from "./auth.api-key.js";
import { buildPublicAuthContext, type RequestIdentity } from "./auth.context.js";
import { buildExternalAuthContext } from "./auth.external.js";
import { buildTokenAuthContext } from "./auth.token.js";

export async function resolveRequestIdentity(req: FastifyRequest): Promise<RequestIdentity> {
  const cached = (req as FastifyRequest & { authContext?: RequestIdentity }).authContext;
  if (cached) {
    return cached;
  }

  let resolved: RequestIdentity;
  switch (AuthProviderConfig.kind) {
    case "none":
      resolved = buildPublicAuthContext(req);
      break;
    case "local":
      resolved = buildLocalAuthContext(req) ?? buildPublicAuthContext(req);
      break;
    case "token":
      resolved = buildTokenAuthContext(req) ?? buildPublicAuthContext(req);
      break;
    case "external":
      resolved = (await buildExternalAuthContext(req)) ?? buildPublicAuthContext(req);
      break;
    default:
      resolved = buildPublicAuthContext(req);
      break;
  }

  (req as FastifyRequest & { authContext?: RequestIdentity }).authContext = resolved;
  return resolved;
}
