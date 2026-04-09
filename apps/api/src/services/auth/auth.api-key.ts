import type { FastifyRequest } from "fastify";

import { AuthApiKeyConfig, type RateLimitTier } from "../../config/auth.config.js";
import { extractPresentedCredential } from "./auth.credentials.js";
import type { AuthContext } from "./auth.context.js";

export interface VerifiedApiKeyPrincipal {
  keyId: string;
  owner?: string;
  scopes: string[];
  tier: RateLimitTier;
  credentialType: "api_key" | "bearer";
}

export function verifyRequestApiKey(req: FastifyRequest): VerifiedApiKeyPrincipal | null {
  const presented = extractPresentedCredential(req);
  if (!presented) return null;
  const match = AuthApiKeyConfig.keys.find((entry) => entry.secret === presented.value);
  if (!match) return null;
  return {
    keyId: match.id,
    owner: match.owner,
    scopes: match.scopes,
    tier: match.tier,
    credentialType: presented.type,
  };
}

export function buildLocalAuthContext(req: FastifyRequest): AuthContext | null {
  const principal = verifyRequestApiKey(req);
  if (!principal) return null;
  return {
    authenticated: true,
    provider: "local",
    method: "api_key",
    subjectType: "api_key",
    subjectId: principal.keyId,
    subject: `api_key:${principal.keyId}`,
    keyId: principal.keyId,
    scopes: principal.scopes,
    ownerAddress: principal.owner,
    owner: principal.owner,
    tier: principal.tier,
    credentialType: principal.credentialType,
  };
}
