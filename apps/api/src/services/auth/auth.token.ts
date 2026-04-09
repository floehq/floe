import crypto from "node:crypto";
import type { FastifyRequest } from "fastify";

import { AuthTokenConfig, type RateLimitTier } from "../../config/auth.config.js";
import { extractPresentedCredential } from "./auth.credentials.js";
import type { AuthContext, AuthSubjectType } from "./auth.context.js";

type DelegatedTokenClaims = {
  sub: string;
  subjectType?: AuthSubjectType;
  keyId?: string;
  orgId?: string;
  projectId?: string;
  scopes?: string[];
  ownerAddress?: string;
  walletAddress?: string;
  tier?: RateLimitTier;
  exp?: number;
  iss?: string;
  aud?: string;
};

function base64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${pad}`, "base64").toString("utf8");
}

function base64UrlEncode(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function verifySignature(payloadPart: string, signaturePart: string, secret: string): boolean {
  const expected = crypto.createHmac("sha256", secret).update(payloadPart).digest();
  const actual = Buffer.from(
    signaturePart.replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  );
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function validateClaims(claims: DelegatedTokenClaims): claims is DelegatedTokenClaims & { sub: string } {
  if (!claims || typeof claims !== "object") return false;
  if (typeof claims.sub !== "string" || claims.sub.trim().length === 0) return false;
  if (claims.subjectType && !["user", "service", "api_key"].includes(claims.subjectType)) {
    return false;
  }
  if (claims.tier && claims.tier !== "public" && claims.tier !== "authenticated") {
    return false;
  }
  if (claims.scopes && !Array.isArray(claims.scopes)) {
    return false;
  }
  if (!claims.scopes || claims.scopes.length === 0) {
    return false;
  }
  if (claims.scopes.some((scope) => typeof scope !== "string" || scope.trim().length === 0)) {
    return false;
  }
  if (claims.orgId !== undefined && (typeof claims.orgId !== "string" || claims.orgId.trim().length === 0)) {
    return false;
  }
  if (
    claims.projectId !== undefined &&
    (typeof claims.projectId !== "string" || claims.projectId.trim().length === 0)
  ) {
    return false;
  }
  return true;
}

export function buildTokenAuthContext(req: FastifyRequest): AuthContext | null {
  const presented = extractPresentedCredential(req);
  if (!presented) return null;
  const secret = AuthTokenConfig.secret;
  if (!secret) return null;

  const parts = presented.value.split(".");
  if (parts.length !== 2) return null;
  const [payloadPart, signaturePart] = parts;
  if (!verifySignature(payloadPart, signaturePart, secret)) return null;

  let claims: DelegatedTokenClaims;
  try {
    claims = JSON.parse(base64UrlDecode(payloadPart)) as DelegatedTokenClaims;
  } catch {
    return null;
  }
  if (!validateClaims(claims)) return null;
  if (AuthTokenConfig.issuer && claims.iss !== AuthTokenConfig.issuer) return null;
  if (AuthTokenConfig.audience && claims.aud !== AuthTokenConfig.audience) return null;
  if (!claims.exp || !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) return null;

  const subjectType = claims.subjectType ?? "user";
  return {
    authenticated: true,
    provider: "token",
    method: "token",
    subjectType,
    subjectId: claims.sub,
    subject: `${subjectType}:${claims.sub}`,
    keyId: claims.keyId,
    orgId: claims.orgId,
    projectId: claims.projectId,
    scopes: Array.isArray(claims.scopes) ? claims.scopes.filter((value) => typeof value === "string") : [],
    ownerAddress: claims.ownerAddress,
    owner: claims.ownerAddress,
    walletAddress: claims.walletAddress,
    tier: claims.tier ?? "authenticated",
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    credentialType: presented.type,
  };
}

export function signDelegatedAuthTokenForTests(
  claims: DelegatedTokenClaims & { sub: string },
  secret: string
): string {
  const payloadPart = base64UrlEncode(Buffer.from(JSON.stringify(claims), "utf8"));
  const signaturePart = base64UrlEncode(
    crypto.createHmac("sha256", secret).update(payloadPart).digest()
  );
  return `${payloadPart}.${signaturePart}`;
}
