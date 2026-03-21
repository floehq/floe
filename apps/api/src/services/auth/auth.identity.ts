import type { FastifyRequest } from "fastify";

import { AuthModeConfig, type RateLimitTier } from "../../config/auth.config.js";
import { verifyRequestApiKey } from "./auth.api-key.js";

export type AuthMethod = "public" | "api_key";

export interface RequestIdentity {
  authenticated: boolean;
  method: AuthMethod;
  subject: string;
  owner?: string;
  keyId?: string;
  scopes: string[];
  tier: RateLimitTier;
}

export function resolveRequestIdentity(req: FastifyRequest): RequestIdentity {
  const apiKey = verifyRequestApiKey(req);
  if (apiKey) {
    return {
      authenticated: true,
      method: "api_key",
      subject: `api_key:${apiKey.keyId}`,
      owner: apiKey.owner,
      keyId: apiKey.keyId,
      scopes: apiKey.scopes,
      tier: apiKey.tier,
    };
  }

  return {
    authenticated: false,
    method: "public",
    subject: `public:${req.ip}`,
    scopes: [],
    tier: "public",
  };
}

export function authRequiredForAction(action: "upload" | "file_read"): boolean {
  if (AuthModeConfig.mode === "private") return true;
  if (AuthModeConfig.mode === "hybrid") {
    return action === "upload";
  }
  return false;
}
