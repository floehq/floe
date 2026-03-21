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
- deployment auth modes: `public`, `hybrid`, and `private`
- env-backed API key verification for authenticated principals
- optional owner propagation on uploads and file metadata
- optional owner enforcement on upload and file access with `FLOE_ENFORCE_UPLOAD_OWNER=1`
- token protection for `/metrics`
- operational controls through environment-based deployment configuration

## Deployment Guidance

For production-oriented deployments, Floe should be run in `private` mode or behind a trusted edge. The core API now supports verified in-service API key authentication, but key management remains environment-backed in this phase.

Recommended deployment posture:

- use `FLOE_AUTH_MODE=private` for restricted deployments
- use verified API keys with owner binding for restricted uploads and reads
- terminate authentication at a trusted edge or gateway when external identity systems are required
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
