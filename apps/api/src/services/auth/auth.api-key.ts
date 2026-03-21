import type { FastifyRequest } from "fastify";

import { AuthApiKeyConfig, type RateLimitTier } from "../../config/auth.config.js";

export interface VerifiedApiKeyPrincipal {
  keyId: string;
  owner?: string;
  scopes: string[];
  tier: RateLimitTier;
}

function parseBearerToken(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1]?.trim();
  return token || undefined;
}

function extractPresentedApiKey(req: FastifyRequest): string | undefined {
  const headers = req.headers as Record<string, unknown>;
  const explicit = typeof headers["x-api-key"] === "string" ? headers["x-api-key"].trim() : "";
  if (explicit) return explicit;
  return parseBearerToken(headers.authorization);
}

export function verifyRequestApiKey(req: FastifyRequest): VerifiedApiKeyPrincipal | null {
  const presented = extractPresentedApiKey(req);
  if (!presented) return null;
  const match = AuthApiKeyConfig.keys.find((entry) => entry.secret === presented);
  if (!match) return null;
  return {
    keyId: match.id,
    owner: match.owner,
    scopes: match.scopes,
    tier: match.tier,
  };
}
