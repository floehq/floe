import type { FastifyRequest } from "fastify";
import crypto from "node:crypto";

import { AuthApiKeyConfig, type RateLimitTier } from "../../config/auth.config.js";
import { extractPresentedCredential } from "./auth.credentials.js";
import { type ApiKeyStore, type StoredApiKey } from "./auth.api-key-store.js";
import type { AuthContext } from "./auth.context.js";

export interface VerifiedApiKeyPrincipal {
  keyId: string;
  owner?: string;
  scopes: string[];
  tier: RateLimitTier;
  credentialType: "api_key" | "bearer";
}

/**
 * Env-backed API key store. Reads keys from FLOE_API_KEYS_JSON at startup.
 * This is the default implementation for standalone self-hosted use.
 * All comparisons use timingSafeEqual — no plaintext comparison.
 */
export class EnvApiKeyStore implements ApiKeyStore {
  async findByHash(hash: Buffer): Promise<StoredApiKey | null> {
    for (const entry of AuthApiKeyConfig.keys) {
      const configuredDigest = crypto.createHash("sha256").update(entry.secret).digest();
      if (configuredDigest.length !== hash.length) continue;
      try {
        if (crypto.timingSafeEqual(configuredDigest, hash)) {
          return {
            id: entry.id,
            secretHash: configuredDigest,
            owner: entry.owner,
            scopes: entry.scopes,
            tier: entry.tier,
          };
        }
      } catch {
        // Buffer length mismatch — skip
      }
    }
    return null;
  }

  async listActive(): Promise<StoredApiKey[]> {
    return AuthApiKeyConfig.keys.map((entry) => ({
      id: entry.id,
      secretHash: crypto.createHash("sha256").update(entry.secret).digest(),
      owner: entry.owner,
      scopes: entry.scopes,
      tier: entry.tier,
    }));
  }
}

let defaultStore: ApiKeyStore | null = null;

export function setApiKeyStore(store: ApiKeyStore | null): void {
  defaultStore = store;
}

export function getApiKeyStore(): ApiKeyStore {
  if (!defaultStore) {
    defaultStore = new EnvApiKeyStore();
  }
  return defaultStore;
}

async function verifyRequestApiKey(req: FastifyRequest): Promise<VerifiedApiKeyPrincipal | null> {
  const presented = extractPresentedCredential(req);
  if (!presented) return null;
  const presentedDigest = crypto.createHash("sha256").update(presented.value).digest();
  const store = getApiKeyStore();
  const match = await store.findByHash(presentedDigest);
  if (!match) return null;
  return {
    keyId: match.id,
    owner: match.owner,
    scopes: match.scopes,
    tier: match.tier,
    credentialType: presented.type,
  };
}

export async function buildLocalAuthContext(req: FastifyRequest): Promise<AuthContext | null> {
  const principal = await verifyRequestApiKey(req);
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
