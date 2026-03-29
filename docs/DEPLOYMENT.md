# Deployment Guide

## Goal

This branch establishes one intentional deployment baseline for Floe: a single build artifact that can run as `read`, `write`, or `full` by config, with explicit external dependencies and a persistent writable upload temp path.

## Baseline

Recommended phase-1 beta runtime:

- one or more HTTPS-exposed Floe services
- persistent Redis
- optional but intentional Postgres
- `s3`/R2/MinIO-compatible chunk staging for multi-instance safety
- persistent writable volume mounted at `UPLOAD_TMP_DIR`
- stdout/stderr log collection from the hosting platform
- one shared image/binary with role-based startup

## Role Model

Floe should be shipped as one image or executable, not separate builds per role.

Current roles:

- `full`: uploads, files, ops, and background workers enabled
- `read`: file read routes enabled, upload routes and write-path workers disabled
- `write`: upload routes, ops routes, and write-path workers enabled; public file routes disabled

Set the role with either:

```dotenv
FLOE_NODE_ROLE=read
```

or through structured config:

```yaml
node:
  role: write
```

## Structured Config

Floe now supports a structured YAML config file for topology-oriented settings.

Use:

```dotenv
FLOE_CONFIG=/etc/floe/config.yaml
```

Example file: `config/floe.example.yaml`

Use the YAML file for:

- node role
- HTTP port and CORS origins
- proxy trust for forwarded client IPs
- Walrus reader gateway lists
- Walrus writer/publisher endpoint lists

Keep env vars for:

- secrets
- tokens
- database URLs
- Redis URLs
- S3 credentials
- quick per-environment overrides

## Why `UPLOAD_TMP_DIR` Is Required

`UPLOAD_TMP_DIR` is still required in production even when `FLOE_CHUNK_STORE_MODE=s3`.

Floe uses it for:

- temporary assembled upload files before Walrus publish
- GC reconciliation and cleanup state
- disk chunk staging when `FLOE_CHUNK_STORE_MODE=disk`

Recommended default:

```dotenv
UPLOAD_TMP_DIR=/var/lib/floe/upload
```

Do not point it at a read-only or obviously ephemeral path if you want clean restart behavior for in-flight work.

## Required External Services

Before deploy, have these ready:

- Redis with persistence enabled
- S3/R2/MinIO bucket and credentials when using `FLOE_CHUNK_STORE_MODE=s3`
- Walrus aggregator and publisher configuration
- Sui signer and package id
- optional Postgres instance if you want the read model enabled

## Container Build

Build from the repo root:

```bash
docker build -t floe-api:latest .
```

The container:

- builds the API from TypeScript
- runs production with `node apps/api/dist/server.js`
- exposes port `3001`
- exposes cheap `/livez` and cached `/health`
- accepts `FLOE_NODE_ROLE` and `FLOE_CONFIG` at runtime

## Minimal Production Environment

Set at least:

```dotenv
PORT=3001
NODE_ENV=production
UPLOAD_TMP_DIR=/var/lib/floe/upload
FLOE_CHUNK_STORE_MODE=s3
FLOE_S3_BUCKET=...
FLOE_S3_REGION=...
FLOE_S3_ENDPOINT=...
FLOE_S3_FORCE_PATH_STYLE=1
FLOE_S3_ACCESS_KEY_ID=...
FLOE_S3_SECRET_ACCESS_KEY=...
FLOE_REDIS_PROVIDER=native
REDIS_URL=redis://...
WALRUS_AGGREGATOR_URL=...
FLOE_WALRUS_STORE_MODE=sdk
FLOE_WALRUS_SDK_BASE_URL=...
FLOE_NETWORK=testnet
SUI_PRIVATE_KEY=...
SUI_PACKAGE_ID=...
FLOE_METRICS_TOKEN=...
```

If Postgres is enabled:

```dotenv
DATABASE_URL=postgresql://...
FLOE_POSTGRES_REQUIRED=0
```

Optional topology config:

```dotenv
FLOE_CONFIG=/etc/floe/config.yaml
FLOE_NODE_ROLE=read
```

If Floe is behind a trusted reverse proxy or CDN and you want public rate limiting to key on real client IPs instead of the proxy IP, also set:

```dotenv
FLOE_TRUST_PROXY=1
```

Only enable this when `X-Forwarded-For` is coming from infrastructure you control or trust.

Health recommendation:

- use `/livez` for platform/container liveness
- use `/health` for cached readiness and dependency state
- tune `FLOE_HEALTH_CACHE_TTL_MS` if you need a different readiness refresh window

## Deploy Flow

1. Build and publish the container image.
2. Provision or verify Redis persistence.
3. Provision a persistent writable volume for `UPLOAD_TMP_DIR`.
4. Set production env vars from `.env.example`.
5. Add `FLOE_CONFIG` when using YAML topology config.
6. Deploy one or more role-specific containers behind HTTPS.
7. Verify `/health` reports a usable state and expected capabilities for that role.
8. Verify startup logs show dependency initialization and successful boot.

## Example Topology

Minimal split deployment:

- `read` nodes:
  - `FLOE_NODE_ROLE=read`
  - public metadata/manifest/stream traffic
  - local stream cache enabled
- `write` nodes:
  - `FLOE_NODE_ROLE=write`
  - upload create/chunk/complete/cancel
  - finalize worker and upload GC enabled
  - ops endpoints enabled
- `full` node:
  - valid for smaller deployments or staging

`/health` now reports:

- node `role`
- enabled route/worker `capabilities`
- configured Walrus reader gateway pool
- configured Walrus writer/publisher pool

## Local Docker Note

If MinIO or another S3-compatible endpoint is running on the host machine, do not use `127.0.0.1` from inside the Floe container.

Use:

```bash
docker run --rm -p 3001:3001 \
  --add-host=host.docker.internal:host-gateway \
  --env-file .env \
  -e NODE_ENV=production \
  -e FLOE_S3_ENDPOINT=http://host.docker.internal:9000 \
  floe-api:deployment
```

Inside the container, `127.0.0.1` refers to the container itself, not the host.

## Restart And Recovery Flow

1. Restart the API container.
2. Watch logs for dependency initialization.
3. Watch logs for startup recovery activity.
4. Check `/health` for `UP`, `DEGRADED`, or `DOWN`.
5. Verify a few in-flight upload ids if the restart happened during active use.

Expected behavior:

- dependency outages surface as explicit degraded or down states
- restart should not silently discard tracked upload/finalize state
- recovery is driven by the existing startup reconciliation paths, not manual guesswork

## Operational Notes

- prefer `FLOE_CHUNK_STORE_MODE=s3` for hosted beta
- keep `/metrics` private with `FLOE_METRICS_TOKEN`
- collect logs centrally from stdout/stderr
- use `/health` for platform health checks
- keep Postgres either intentionally enabled or intentionally absent

## Known Limits

- this branch does not add provider-specific manifests like Fly, Railway, Render, or Kubernetes
- TLS termination is assumed to happen at the hosting platform or reverse proxy
- backup/restore remains an operational procedure, not infrastructure automation in this branch
