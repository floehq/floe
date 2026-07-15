/**
 * =============================================================================
 * External Auth Verify Endpoint Contract
 * =============================================================================
 *
 * This file defines the contract between the Floe core API and an external
 * authentication/authorization service ("verifier"). A SaaS layer (e.g.
 * floe-cloud) implements an HTTP endpoint that Floe calls to verify
 * credentials and resolve an identity + authorization context.
 *
 * Protocol: HTTPS POST to the configured verify URL.
 *
 * Request body (Floe → verifier):
 *   {
 *     // When the client presented an x-api-key header:
 *     "apiKey": "<the-api-key-secret>"
 *
 *     // When the client presented an Authorization: Bearer <token> header:
 *     "delegatedToken": "<the-bearer-token>"
 *   }
 *
 * Request headers:
 *   content-type: application/json
 *   accept: application/json
 *   x-floe-shared-secret: <optional shared secret if FLOE_AUTH_EXTERNAL_SHARED_SECRET is set>
 *   authorization: Bearer <token> if FLOE_AUTH_EXTERNAL_AUTH_TOKEN is set
 *
 * Response: 200 OK with JSON body matching ExternalVerifyResponse.
 *   Any non-200 status is treated as "verification failed" (identity = public).
 *
 * Caching: Floe caches responses for up to FLOE_AUTH_EXTERNAL_CACHE_TTL_MS
 *   (default 5000ms). If the response includes an `expiresAt` field, the
 *   cache TTL is the minimum of the config TTL and the credential expiry.
 *
 * Failure semantics:
 *   - HTTP timeout (FLOE_AUTH_EXTERNAL_TIMEOUT_MS, default 2000ms): treated as
 *     verification failed, falls back to public identity.
 *   - Network error: treated as verification failed.
 *   - Non-200 response: treated as verification failed.
 *   - Malformed JSON or missing required fields: treated as verification failed.
 *   - Expired `expiresAt`: treated as verification failed.
 *
 * Header-trust mode (FLOE_AUTH_EXTERNAL_TRUST_HEADERS=1):
 *   When enabled, Floe skips the HTTP POST to the verifier and instead reads
 *   identity from these request headers (set by a trusted reverse proxy):
 *     x-floe-auth-subject-id      (required)
 *     x-floe-auth-subject-type    (user|api_key|service|public, default: user)
 *     x-floe-auth-expires-at      (ISO-8601, optional)
 *     x-floe-auth-key-id          (optional)
 *     x-floe-auth-org-id          (optional)
 *     x-floe-auth-project-id      (optional)
 *     x-floe-auth-scopes          (comma-separated, optional)
 *     x-floe-auth-owner-address   (optional)
 *     x-floe-auth-wallet-address  (optional)
 *     x-floe-auth-tier            (public|authenticated, default: authenticated)
 */

/**
 * Reason codes an external verifier can return when a credential is invalid.
 */
export type ExternalVerifyFailureReason =
  "invalid" | "expired" | "revoked" | "malformed" | "unauthorized" | "timeout" | "missing_claims";

/**
 * The subject type identifies what kind of principal the credential represents.
 * - "user":       A human end-user (e.g. authenticated via OAuth).
 * - "api_key":    A programmatic API key owned by a user or service.
 * - "service":    A service-to-service credential (no end-user).
 * - "public":     Unauthenticated / anonymous.
 *
 * The verifier may also return "user_token" which Floe normalizes to "user".
 */
export type ExternalVerifySubjectType = "user" | "api_key" | "service" | "public" | "user_token";

/**
 * Response from the external auth verify endpoint.
 *
 * All fields are optional from the wire; Floe applies validation rules
 * documented below.
 */
export interface ExternalVerifyResponse {
  /**
   * Whether the credential is valid. When `true`, the identity is accepted.
   * If `valid` is omitted, `authenticated` is used as a fallback.
   * If both are omitted or `false`, verification is rejected.
   */
  valid?: boolean;

  /**
   * Human/machine-readable reason when the credential is not valid.
   * Not used by Floe logic directly, but may be logged for debugging.
   */
  reason?: ExternalVerifyFailureReason;

  /**
   * Legacy fallback for `valid`. Only consulted when `valid` is undefined.
   * @deprecated Prefer `valid` instead.
   */
  authenticated?: boolean;

  /**
   * The type of principal. Determines the subject prefix in Floe's identity.
   * "user_token" is normalized to "user".
   * Default if omitted: "user".
   */
  subjectType?: ExternalVerifySubjectType;

  /**
   * Stable identifier for the principal. This becomes the `subjectId` in
   * Floe's AuthContext and is used for rate-limit bucketing.
   *
   * REQUIRED when valid=true. Must be a non-empty string.
   */
  subjectId?: string;

  /**
   * Optional API key identifier. Populates `keyId` in the AuthContext.
   */
  keyId?: string;

  /**
   * Organisation or tenant identifier. Passed through to Floe's AuthContext
   * and included in infrastructure events. Floe core does not interpret this
   * field — it is a pass-through for the SaaS layer.
   */
  orgId?: string;

  /**
   * Project or workspace identifier within an organisation. Passed through
   * and included in infrastructure events but not interpreted by core.
   */
  projectId?: string;

  /**
   * Authorized scopes for this credential. Determines what API operations
   * the principal can perform.
   *
   * Known scopes used by Floe core:
   *   "uploads:write"  - create, chunk, complete, cancel uploads
   *   "uploads:read"   - read upload status
   *   "files:read"     - read file metadata, manifest, stream
   *   "ops:read"       - read operator endpoints
   *   "admin:uploads"  - admin-level upload operations
   *   "*"              - full access (wildcard)
   *
   * If omitted or empty, the principal has no scopes.
   */
  scopes?: string[];

  /**
   * Sui wallet / owner address associated with this principal.
   * Used for owner-based authorization enforcement when
   * FLOE_ENFORCE_UPLOAD_OWNER=1.
   * Populates both `ownerAddress` and `owner` in AuthContext.
   */
  ownerAddress?: string;

  /**
   * Sui wallet address, if different from ownerAddress.
   * Populates `walletAddress` in AuthContext.
   */
  walletAddress?: string;

  /**
   * Rate limit tier. Determines which rate limit bucket the principal
   * falls into.
   *   "public"        - lower rate limits
   *   "authenticated" - higher rate limits (default)
   *
   * If omitted or any value other than "public", defaults to "authenticated".
   */
  tier?: string;

  /**
   * ISO-8601 timestamp after which this credential expires.
   * If provided, Floe will:
   *   1. Reject the credential immediately if already expired.
   *   2. Cache the response only until `expiresAt` (at most).
   *
   * Format example: "2026-07-12T23:59:59Z"
   */
  expiresAt?: string;
}

/**
 * HTTP request body sent by Floe to the external verify endpoint.
 */
export type ExternalVerifyRequestBody = { apiKey: string } | { delegatedToken: string };
