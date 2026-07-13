import type { FastifyRequest } from "fastify";
import crypto from "node:crypto";

import { AuthApiKeyConfig, type RateLimitTier } from "../../config/auth.config.js";
import { extractPresentedCredential } from "./auth.credentials.js";
import { type ApiKeyStore, type StoredApiKey } from "./auth.api-key-store.js";
import type { AuthContext } from "./auth.context.js";

/**
 * Parse a presented credential in the format floe_<keyId>_<secretPart>.
 * Returns the keyId and secret portion, or null for legacy format.
 */
export function parseKeyId(credential: string): { keyId: string; secretPart: string } | null {
  const match = credential.match(/^floe_([a-zA-Z0-9_-]+)_(.+)$/);
  if (!match) return null;
  return { keyId: match[1], secretPart: match[2] };
}

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

  async findById(id: string): Promise<StoredApiKey | null> {
    const entry = AuthApiKeyConfig.keys.find((k) => k.id === id);
    if (!entry) return null;
    // Parse the new-format secret to extract just the secret portion to hash.
    // For legacy keys without the floe_ prefix, fall back to hashing the full secret.
    const parsed = parseKeyId(entry.secret);
    const secretToHash = parsed ? parsed.secretPart : entry.secret;
    return {
      id: entry.id,
      secretHash: crypto.createHash("sha256").update(secretToHash).digest(),
      owner: entry.owner,
      scopes: entry.scopes,
      tier: entry.tier,
    };
  }

  async listActive(): Promise<StoredApiKey[]> {
    return AuthApiKeyConfig.keys.map((entry) => {
      const parsed = parseKeyId(entry.secret);
      const secretToHash = parsed ? parsed.secretPart : entry.secret;
      return {
        id: entry.id,
        secretHash: crypto.createHash("sha256").update(secretToHash).digest(),
        owner: entry.owner,
        scopes: entry.scopes,
        tier: entry.tier,
      };
    });
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

  const store = getApiKeyStore();
  const parsed = parseKeyId(presented.value);

  if (parsed) {
    // New format: floe_<keyId>_<secretPart>
    // Look up by public id (PK lookup, constant-time), then verify hash in-app.
    const stored = await store.findById(parsed.keyId);
    const computedHash = crypto.createHash("sha256").update(parsed.secretPart).digest();

    if (stored) {
      try {
        if (crypto.timingSafeEqual(stored.secretHash, computedHash)) {
          return {
            keyId: stored.id,
            owner: stored.owner,
            scopes: stored.scopes,
            tier: stored.tier,
            credentialType: presented.type,
          };
        }
      } catch {
        // Length mismatch between stored and computed hash (shouldn't happen)
      }
    } else {
      // No key found for this id — normalize timing with a dummy comparison
      const dummy = crypto.createHash("sha256").update("dummy").digest();
      crypto.timingSafeEqual(dummy, dummy);
    }
    return null;
  }

  // Legacy format: hash the full credential and compare via findByHash
  const presentedDigest = crypto.createHash("sha256").update(presented.value).digest();
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
