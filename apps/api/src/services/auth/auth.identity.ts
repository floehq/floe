import type { FastifyRequest } from "fastify";

import {
  AuthApiKeyStoreConfig,
  AuthProviderConfig,
} from "../../config/auth.config.js";
import { buildLocalAuthContext, setApiKeyStore } from "./auth.api-key.js";
import { type ApiKeyStore } from "./auth.api-key-store.js";
import { buildPublicAuthContext, type RequestIdentity } from "./auth.context.js";
import { buildExternalAuthContext } from "./auth.external.js";
import { buildTokenAuthContext } from "./auth.token.js";

let apiKeyStoreInitialized = false;

async function ensureApiKeyStore(): Promise<void> {
  if (apiKeyStoreInitialized) return;
  apiKeyStoreInitialized = true;

  if (AuthApiKeyStoreConfig.backend === "postgres") {
    const { PostgresApiKeyStore, ensureApiKeysTable } = await import("./auth.api-key.pg.js");
    await ensureApiKeysTable();
    setApiKeyStore(new PostgresApiKeyStore());
  }
}

export async function resolveRequestIdentity(req: FastifyRequest): Promise<RequestIdentity> {
  const cached = (req as FastifyRequest & { authContext?: RequestIdentity }).authContext;
  if (cached) {
    return cached;
  }

  await ensureApiKeyStore();

  let resolved: RequestIdentity;
  switch (AuthProviderConfig.kind) {
    case "none":
      resolved = buildPublicAuthContext(req);
      break;
    case "local":
      resolved = (await buildLocalAuthContext(req)) ?? buildPublicAuthContext(req);
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
