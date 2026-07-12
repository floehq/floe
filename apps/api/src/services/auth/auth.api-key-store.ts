import type { RateLimitTier } from "../../config/auth.config.js";

/**
 * A stored API key record returned by an ApiKeyStore implementation.
 * Only contains a SHA-256 hash of the secret — never the plaintext.
 */
export type StoredApiKey = {
  /** Stable identifier for the key (matches StaticApiKeyConfig.id). */
  id: string;
  /** SHA-256 digest of the secret (raw Buffer, 32 bytes). */
  secretHash: Buffer;
  /** Optional Sui wallet address associated with this key. */
  owner?: string;
  /** Authorized scopes. "*" means full access. */
  scopes: string[];
  /** Rate limit tier: "public" or "authenticated". */
  tier: RateLimitTier;
};

/**
 * Read-side interface for API key storage.
 *
 * Implementations:
 *   - EnvApiKeyStore  — reads from FLOE_API_KEYS_JSON (env/config)
 *   - PostgresApiKeyStore — reads from a floe_api_keys table
 *
 * Create/revoke operations are NOT provided here — those belong in the
 * SaaS layer or a later core admin API.
 */
export interface ApiKeyStore {
  /**
   * Look up a key by its SHA-256 hash.
   *
   * The caller computes the SHA-256 digest of the presented credential and
   * passes it here. The store compares it against stored hashes and returns
   * the matched key, or null if not found or the key has been revoked.
   *
   * @param hash - Raw SHA-256 digest (32 bytes) of the presented secret.
   * @returns The matching StoredApiKey, or null.
   */
  findByHash(hash: Buffer): Promise<StoredApiKey | null>;

  /**
   * List all non-revoked keys. Used for cache warming or debug inspection.
   */
  listActive(): Promise<StoredApiKey[]>;
}
