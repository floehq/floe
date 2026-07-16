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
   * Legacy path. The caller computes the SHA-256 digest of the presented
   * credential and passes it here. Prefer findById for new deployments.
   *
   * @param hash - Raw SHA-256 digest (32 bytes) of the presented secret.
   * @returns The matching StoredApiKey, or null.
   */
  findByHash(hash: Buffer): Promise<StoredApiKey | null>;

  /**
   * Look up a key by its public id (the key-id prefix encoded in presented
   * credentials). The caller parses the presented key's id prefix, looks up
   * by id here, then independently verifies the secret hash via
   * crypto.timingSafeEqual in the caller.
   *
   * This avoids the timing side-channel of SQL-level hash comparison.
   *
   * @param id - Public key identifier (alphanumeric, from floe_<id>_<secret>).
   * @returns The matching StoredApiKey (with secretHash of the secret portion
   *          only), or null.
   */
  findById(id: string): Promise<StoredApiKey | null>;

  /**
   * List all non-revoked keys. Used for cache warming or debug inspection.
   */
  listActive(): Promise<StoredApiKey[]>;
}
