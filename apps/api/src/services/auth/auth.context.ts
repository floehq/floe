import type { FastifyRequest } from "fastify";

import {
  AuthAccessPolicyConfig,
  type AccessPolicy,
  type AuthProviderKind,
  type RateLimitTier,
} from "../../config/auth.config.js";

export type AuthMethod = "public" | "api_key" | "external" | "token";
export type AuthSubjectType = "public" | "api_key" | "user" | "service";
export type CredentialType = "public" | "api_key" | "bearer";

export interface AuthContext {
  authenticated: boolean;
  provider: AuthProviderKind;
  method: AuthMethod;
  subjectType: AuthSubjectType;
  subjectId: string;
  subject: string;
  keyId?: string;
  orgId?: string;
  projectId?: string;
  scopes: string[];
  ownerAddress?: string;
  owner?: string;
  walletAddress?: string;
  tier: RateLimitTier;
  expiresAt?: string;
  credentialType: CredentialType;
}

export type RequestIdentity = AuthContext;

export function buildPublicAuthContext(req: Pick<FastifyRequest, "ip">): AuthContext {
  const subjectId =
    typeof req.ip === "string" && req.ip.trim().length > 0 ? req.ip.trim() : "unknown";
  return {
    authenticated: false,
    provider: "none",
    method: "public",
    subjectType: "public",
    subjectId,
    subject: `public:${subjectId}`,
    scopes: [],
    tier: "public",
    credentialType: "public",
  };
}

export function authContextCacheKey(context: AuthContext): string {
  return context.subject;
}

export function authRequiredForAction(
  action: "upload" | "file_read",
  accessPolicy: AccessPolicy = AuthAccessPolicyConfig.policy
): boolean {
  if (accessPolicy === "private") return true;
  if (accessPolicy === "hybrid") {
    return action === "upload";
  }
  return false;
}
