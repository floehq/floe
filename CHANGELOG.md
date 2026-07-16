# Changelog

All notable changes to the Floe API are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Security hardening**: `@fastify/helmet` for security headers (HSTS, CSP, X-Frame-Options, X-Content-Type-Options)
- **Sentry error reporting**: Optional Sentry integration with `FLOE_SENTRY_DSN` env var; captures unhandledRejection and uncaughtException
- **Startup config dump**: Logs all resolved `FLOE_*` env vars on startup (secrets redacted)
- **S3 and Walrus liveness checks**: Added `HeadBucket` / aggregator HEAD checks to `/health` endpoint
- **`x-request-id` propagation**: Request ID is propagated as an HTTP header to downstream Walrus aggregator calls for log correlation
- **Input sanitization**: `validateFilename()` and `validateContentType()` functions with MIME whitelist, path traversal rejection, and 255-byte filename limit
- **Graceful shutdown on `uncaughtException`**: Drains finalize jobs, closes Postgres/Redis, and force-exits after 10s timeout
- **Database migration system**: Versioned migrations via `floe_migrations` table; existing schema converted to migration 001; `blob_objects` table added in migration 002
- **In-memory stream cache index**: Maintains an `Map<string, {size, mtimeMs}>` to avoid recursive directory scanning on every prune
- **Walrus epoch caching**: `getCurrentWalrusEpoch()` results cached with 30s TTL
- **Walrus renew caching**: `renewWalrusBlob()` results cached with 10s TTL
- **Configurable gas object**: `FLOE_SUI_GAS_OBJECT_ID` env var (defaults to `0x6`)
- **Request body size limits**: 64KB `bodyLimit` on JSON-only routes (`/create`, `/complete`, `/renew`, `DELETE /:uploadId`)
- **LRU eviction for `fileFieldsMemoryCache`**: Replaced O(n log n) sort-based eviction with O(1) LRU via `LruMap` class
- **`externalAuthCache` size cap**: Capped at 10,000 entries with oldest-eviction on overflow
- **Unified `ChunkConfig`**: `s3.ts` now imports `ChunkConfig` from `uploads.config.ts` instead of re-parsing `FLOE_CHUNK_MAX_BYTES`
- **Shared `parsePositiveIntEnv`**: Extracted to `utils/parseEnv.ts`, removing 6 local copies
- **Shared `isUuid()`**: Extracted to `utils/validation.ts`, removing 3 local copies
- **Docker Compose**: `docker-compose.yml` (Redis, Postgres, MinIO) and `docker-compose.test.yml` for dev/test
- **Docker CI/CD**: `.github/workflows/docker.yml` builds and pushes to ghcr.io on main/tags
- **OpenAPI spec**: `@fastify/swagger` + `@fastify/swagger-ui` registered at `/docs` with 9 route schemas
- **Startup config validation**: `validateConfig()` checks required env vars and warns on optional misconfigurations
- **Memory leak fix**: `.finally()` replaces duplicate `.then()` cleanup for `activeFinalizeProcesses`
- **CHANGELOG.md**: This file

### Changed

- **Finalize pipeline**: Merged `verify_chunks` and `walrus_publish` into a single pass; parallel S3 chunk reads (4x concurrency) with AbortController
- **Walrus blob existence check**: Parallel HEAD requests to all aggregators (primary first, then Promise.allSettled on fallbacks)
- **HTTP connection pooling**: undici `Agent` with configurable pool size (`FLOE_WALRUS_FETCH_POOL_SIZE`, default 8)
- **`?skipBlobCheck` query param**: Bypasses Walrus HEAD check on stream endpoint for trusted clients with `admin:uploads` scope
- **Disk chunk store**: Converted from synchronous `fs.*` calls to async `fs.promises.*` APIs
- **Default API key scopes**: Changed from `["*"]` to `["uploads:write", "files:read"]` in `.env.example`
- **`FLOE_ENFORCE_UPLOAD_OWNER`**: Now defaults to `1` in `.env.example`
- **Lazy `SUI_PACKAGE_ID` validation**: Module-level throw replaced with lazy `getSuiPackageId()` getter
- **ESLint coverage**: `.mjs` scripts no longer excluded from linting
- **Prometheus metrics**: Added `floe_walrus_pool_active_connections` gauge

### Fixed

- **Blob-reuse checksum verification**: On reuse path, actual checksum is computed from chunk data and verified against `providedChecksum`; mismatch falls through to upload path
- **Checksum in Redis commit transaction**: Checksum field now included in the atomic `hset` during finalize
- **Reflected blobId XSS**: Blob ID is HTML-escaped via `escapeHtml()` in the 503 error page
- **undici v7 → v6**: Downpinned to undici v6 for Node 18 compatibility

### Security

- **Helmet CSP**: Very restrictive policy (no scripts, no images, no frames) for the API surface
- **HSTS**: 1-year, includeSubDomains, preload
- **Content-type validation**: Whitelist-based MIME type validation with `FLOE_ALLOWED_CONTENT_TYPES` env override
- **Filename sanitization**: Path traversal, null bytes, control characters, and 255-byte limit enforced
- **`skipBlobCheck` gated behind `admin:uploads` scope**: Non-admin callers are logged and the param is ignored

## [0.2.5] - 2026-05-29

### Added

- Pluggable API key store with Postgres backend
- Pluggable SuiSigner interface with EnvSuiSigner
- `@fastify/helmet` for security headers
- Sentry error reporting (optional)

### Changed

- Default API key scopes narrowed to `["uploads:write", "files:read"]`

### Fixed

- S3 spool-to-temp directory handling
- Race condition in upload cancel/finalize
- Reflected blobId XSS in stream error page

## [0.1.2] - 2026-05-15

### Added

- Initial resumable chunk upload API
- S3 chunk storage backend
- Walrus blob publish and Sui metadata finalization
- Streaming file reads from Walrus aggregators
- Disk-based stream cache
- Prometheus metrics
- Rate limiting with Redis-backed sliding window
- Idempotency support for upload create/complete/cancel
- Upload GC for expired sessions
- Postgres-based file indexing

### Changed

- Migrated from raw HTTP handlers to Fastify plugin architecture
- Upgraded from Sui SDK v1 to v2

### Fixed

- Connection leak in Walrus aggregator fetch
- Chunk hash verification race condition
- Upload session expiry not being propagated to GC
