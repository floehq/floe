import type { FastifyRequest } from "fastify";

import {
  AuthExternalConfig,
} from "../../config/auth.config.js";
import { extractPresentedCredential } from "./auth.credentials.js";
import type { AuthContext, AuthSubjectType } from "./auth.context.js";

type ExternalVerifyResponse = {
  valid?: boolean;
  reason?:
    | "invalid"
    | "expired"
    | "revoked"
    | "malformed"
    | "unauthorized"
    | "timeout"
    | "missing_claims";
  authenticated?: boolean;
  subjectType?: AuthSubjectType | "user_token";
  subjectId?: string;
  keyId?: string;
  orgId?: string;
  projectId?: string;
  scopes?: string[];
  ownerAddress?: string;
  walletAddress?: string;
  tier?: string;
  expiresAt?: string;
};

const externalAuthCache = new Map<
  string,
  { expiresAt: number; context: AuthContext }
>();

function computeCacheExpiryMs(context: AuthContext): number {
  const ttlExpiryMs = Date.now() + AuthExternalConfig.cacheTtlMs;
  if (!context.expiresAt) {
    return ttlExpiryMs;
  }

  const credentialExpiryMs = Date.parse(context.expiresAt);
  if (!Number.isFinite(credentialExpiryMs)) {
    return ttlExpiryMs;
  }

  return Math.min(ttlExpiryMs, credentialExpiryMs);
}

function readHeader(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers[name] as unknown;
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return value.length > 0 ? value : undefined;
}

function parseScopes(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseTier(raw?: string): "public" | "authenticated" {
  return raw === "public" ? "public" : "authenticated";
}

function parseSubjectType(raw?: string): AuthSubjectType {
  if (raw === "user_token") return "user";
  if (raw === "api_key" || raw === "service" || raw === "public") return raw;
  return "user";
}

function parseExternalResponse(
  presentedCredentialType: "bearer" | "api_key",
  payload: ExternalVerifyResponse
): AuthContext | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const isValid =
    payload.valid === true ||
    (payload.valid === undefined && payload.authenticated === true);
  if (!isValid) return null;
  if (typeof payload.subjectId !== "string" || payload.subjectId.trim().length === 0) {
    return null;
  }
  const subjectType = parseSubjectType(payload.subjectType);
  const scopes = Array.isArray(payload.scopes)
    ? payload.scopes.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const expiresAt = payload.expiresAt?.trim();
  if (expiresAt) {
    const expiresMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
      return null;
    }
  }

  return {
    authenticated: true,
    provider: "external",
    method: "external",
    subjectType,
    subjectId: payload.subjectId.trim(),
    subject: `${subjectType}:${payload.subjectId.trim()}`,
    keyId: payload.keyId?.trim() || undefined,
    orgId: payload.orgId?.trim() || undefined,
    projectId: payload.projectId?.trim() || undefined,
    scopes,
    ownerAddress: payload.ownerAddress?.trim() || undefined,
    owner: payload.ownerAddress?.trim() || undefined,
    walletAddress: payload.walletAddress?.trim() || undefined,
    tier: payload.tier === "public" ? "public" : "authenticated",
    expiresAt,
    credentialType: presentedCredentialType,
  };
}

async function verifyExternalCredential(req: FastifyRequest): Promise<AuthContext | null> {
  const presented = extractPresentedCredential(req);
  if (!presented) return null;
  const verifyUrl = AuthExternalConfig.verifyUrl?.trim();
  if (!verifyUrl) return null;

  const cacheKey = `${presented.type}:${presented.value}`;
  const cached = externalAuthCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.context;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AuthExternalConfig.timeoutMs);
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (AuthExternalConfig.sharedSecret) {
      headers["x-floe-shared-secret"] = AuthExternalConfig.sharedSecret;
    }
    if (AuthExternalConfig.authToken) {
      headers.authorization = `Bearer ${AuthExternalConfig.authToken}`;
    }
    const body =
      presented.type === "api_key"
        ? { apiKey: presented.value }
        : { delegatedToken: presented.value };

    const response = await fetch(verifyUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json().catch(() => null)) as ExternalVerifyResponse | null;
    if (!payload) return null;
    const parsed = parseExternalResponse(presented.type, payload);
    if (!parsed) return null;

    const cacheExpiryMs = computeCacheExpiryMs(parsed);
    if (cacheExpiryMs > Date.now()) {
      externalAuthCache.set(cacheKey, {
        expiresAt: cacheExpiryMs,
        context: parsed,
      });
    }
    return parsed;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export const externalAuthTestHooks = {
  resetCache() {
    externalAuthCache.clear();
  },
};

export async function buildExternalAuthContext(req: FastifyRequest): Promise<AuthContext | null> {
  if (AuthExternalConfig.trustHeaders) {
    const subjectId = readHeader(req, "x-floe-auth-subject-id");
    if (!subjectId) return null;

    const subjectType = parseSubjectType(readHeader(req, "x-floe-auth-subject-type"));
    const expiresAtRaw =
      readHeader(req, "x-floe-auth-expires-at") ??
      (AuthExternalConfig.defaultExpiresAt
        ? new Date(AuthExternalConfig.defaultExpiresAt).toISOString()
        : undefined);
    if (expiresAtRaw) {
      const expiresMs = Date.parse(expiresAtRaw);
      if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
        return null;
      }
    }

    return {
      authenticated: true,
      provider: "external",
      method: "external",
      subjectType,
      subjectId,
      subject: `${subjectType}:${subjectId}`,
      keyId: readHeader(req, "x-floe-auth-key-id"),
      orgId: readHeader(req, "x-floe-auth-org-id"),
      projectId: readHeader(req, "x-floe-auth-project-id"),
      scopes: parseScopes(readHeader(req, "x-floe-auth-scopes")),
      ownerAddress: readHeader(req, "x-floe-auth-owner-address"),
      owner: readHeader(req, "x-floe-auth-owner-address"),
      walletAddress: readHeader(req, "x-floe-auth-wallet-address"),
      tier: parseTier(readHeader(req, "x-floe-auth-tier")),
      expiresAt: expiresAtRaw,
      credentialType: "bearer",
    };
  }

  return await verifyExternalCredential(req);
}
