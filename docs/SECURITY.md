# Security

## Overview

Floe is designed as developer-first video infrastructure with explicit deployment controls around upload access, file ownership, rate limiting, and operational isolation.

Current security-sensitive surfaces include:

- upload creation and chunk ingestion
- upload finalization and file metadata minting
- file reads and stream access
- metrics and operational endpoints

## Current Controls

Floe currently supports:

- request-tier aware rate limiting
- deployment access policies: `public`, `hybrid`, and `private`
- pluggable auth providers: `none`, `local`, `external`, and `token`
- env-backed local API key verification for authenticated principals
- optional owner propagation on uploads and file metadata
- optional owner enforcement on upload and file access with `FLOE_ENFORCE_UPLOAD_OWNER=1`
- token protection for `/metrics`
- operational controls through environment-based deployment configuration

Provider contracts:

- `none`
  - no credential verification
  - only valid with `FLOE_ACCESS_POLICY=public`
- `local`
  - verifies `Authorization: Bearer <secret>` or `x-api-key: <secret>` against `FLOE_API_KEYS_JSON`
- `external`
  - posts `{ apiKey }` or `{ delegatedToken }` to `FLOE_AUTH_EXTERNAL_VERIFY_URL`
  - prefers `x-floe-shared-secret: <FLOE_AUTH_EXTERNAL_SHARED_SECRET>` for SaaS verifier auth
  - still supports `FLOE_AUTH_EXTERNAL_AUTH_TOKEN` as a backward-compatible fallback
  - bounded by `FLOE_AUTH_EXTERNAL_TIMEOUT_MS`
  - short positive cache via `FLOE_AUTH_EXTERNAL_CACHE_TTL_MS`
  - verifier auth failures stay transport-level `401`
  - accepted verifier calls return `200` with `valid: true|false`, normalized auth fields, and optional `reason`; protected routes fail closed when verification fails
- `token`
  - verifies HMAC-signed delegated tokens using `FLOE_AUTH_TOKEN_SECRET`
  - rejects malformed, expired, or bad-signature tokens

Credential precedence:

- `Authorization` is evaluated before `x-api-key`

## Deployment Guidance

For production-oriented deployments, Floe should be run in `private` mode or behind a trusted edge. The core API now supports verified in-service API key authentication, but key management remains environment-backed in this phase.

Recommended deployment posture:

- use `FLOE_ACCESS_POLICY=private` for restricted deployments
- use `FLOE_AUTH_PROVIDER=local` for self-hosted environment-backed keys
- use `FLOE_AUTH_PROVIDER=token` for delegated signed tokens issued by a control plane
- use `FLOE_AUTH_PROVIDER=external` with a verifier endpoint that normalizes presented bearer tokens or API keys
- keep metrics and operational endpoints private
- apply standard network controls, secrets management, and logging hygiene
- use environment-specific credentials and least-privilege access for infrastructure dependencies

## Access Model

Floe supports owner-aware upload and file access flows. When owner enforcement is enabled, access checks are evaluated against the stored owner associated with an upload or file.

Deployments that require restricted content access should ensure uploads are created with a verified owner context.

## Operational Hardening

Recommended hardening areas for production deployments:

- API key storage migration to a hashed persistent store when moving beyond environment-backed key management
- stronger authorization rules for private reads and tenant-scoped access
- principal-aware quotas and abuse controls
- structured security event logging and alerting

### Rate Limit Local Lease Bump

The local lease size for `FLOE_RATE_LIMIT_FILE_META_LOCAL_LEASE` and `FLOE_RATE_LIMIT_FILE_STREAM_LOCAL_LEASE` was increased from 1 to 20. This allows a single Floe instance to serve up to 20 requests per tenant before the shared distributed rate limiter is consulted. The tradeoff: a single instance can burst ~19 requests past a tenant's configured limit before other instances or the shared limiter catches up. This is acceptable for single-instance deployments and small clusters, but deployments relying on precise per-tenant caps across many instances should monitor actual request rates against the configured limit and consider lowering the local lease size via env vars if tighter enforcement is required.

## API Key Lifecycle

### Creating Keys

Use the admin API (`POST /ops/api-keys`) or set `FLOE_API_KEYS_JSON` at startup. The admin API returns a plaintext secret that is shown once — store it in a secrets manager immediately.

### Rotating Keys

Use `POST /ops/api-keys/:keyId/rotate` to rotate a compromised or aging key. The old key is revoked and a new one is created. All clients using the old key must be updated.

### Revoking Keys

Use `DELETE /ops/api-keys/:keyId` to permanently revoke a key. This is irreversible. The key is immediately denied all access.

### Audit Trail

All key lifecycle events (create, revoke, rotate) are logged via `emitAuditEvent` at `warn` level with the `audit_admin_action` event name. Include `actor` identification from the requesting API key.

## Reporting

If you find a security issue, report it privately to the maintainer before opening a public issue.

Include:

- affected endpoint or component
- reproduction steps
- expected vs actual behavior
- impact assessment
- logs or request samples if relevant

## API Key Format and Timing-Safe Auth

### Presented credential format

API keys can be presented as `Authorization: Bearer <secret>` or `x-api-key: <secret>`.

Floe supports two credential formats:

**New format (recommended):** `floe_<keyId>_<secretPart>`
- `keyId` is a short public identifier (e.g., `local-dev`, `key-1`) used for PK lookup
- `secretPart` is the random secret portion hashed with SHA-256 at rest
- Example: `floe_local-dev_aB3xY9zW8mNqR5vT2pL7cF4hJ1kD0sG6uE3wX`

**Legacy format:** Any string without the `floe_` prefix (e.g., `sk_live_abc123`)
- The entire string is hashed with SHA-256 and compared via SQL-level hash lookup

### Auth flow (new format)

1. `parseKeyId()` extracts `keyId` and `secretPart` from the presented credential.
2. `store.findById(keyId)` does a PK lookup (`WHERE id = $1 AND revoked_at IS NULL`).
3. The caller computes `SHA-256(secretPart)` and uses `crypto.timingSafeEqual` in-app.
4. If no key-id is found, a dummy `timingSafeEqual` call normalizes timing.

This avoids the timing side-channel of SQL-level hash comparison.

### Auth flow (legacy format)

1. The full credential is hashed with SHA-256.
2. `store.findByHash(hash)` searches all stored hashes (SQL `WHERE secret_hash = $1` for Postgres, or iteration with `timingSafeEqual` for env-backed).

Legacy format is silently supported for existing keys. New keys should use the new format.

### Backend behavior

- **Env-backed keys** (`FLOE_API_KEYS_JSON`): Keys with `floe_` prefix use the new fast path. Legacy format keys use iteration with `timingSafeEqual` (already constant-time).
- **Postgres-backed keys** (`FLOE_API_KEY_STORE=postgres`): Keys with `floe_` prefix use `findById` (PK lookup, timing-safe). Legacy format keys use `findByHash` (SQL hash comparison — the timing side-channel this format was designed to replace).
