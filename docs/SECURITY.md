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

## Reporting

If you find a security issue, report it privately to the maintainer before opening a public issue.

Include:

- affected endpoint or component
- reproduction steps
- expected vs actual behavior
- impact assessment
- logs or request samples if relevant
