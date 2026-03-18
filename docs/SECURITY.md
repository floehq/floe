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
- optional owner propagation on uploads and file metadata
- optional owner enforcement on upload and file access with `FLOE_ENFORCE_UPLOAD_OWNER=1`
- token protection for `/metrics`
- operational controls through environment-based deployment configuration

## Deployment Guidance

For production-oriented deployments, Floe should be run behind a trusted authentication layer or paired with verified in-service identity enforcement.

Recommended deployment posture:

- terminate authentication at a trusted edge or gateway
- require verified owner assignment for restricted content
- keep metrics and operational endpoints private
- apply standard network controls, secrets management, and logging hygiene
- use environment-specific credentials and least-privilege access for infrastructure dependencies

## Access Model

Floe supports owner-aware upload and file access flows. When owner enforcement is enabled, access checks are evaluated against the stored owner associated with an upload or file.

Deployments that require restricted content access should ensure uploads are created with a verified owner context.

## Operational Hardening

Recommended hardening areas for production deployments:

- verified identity middleware for application-facing traffic
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
