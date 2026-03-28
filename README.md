# Floe

Floe is a developer-first video infrastructure backend for Walrus.

It provides resumable chunk uploads, Walrus-backed finalization, Sui-linked file metadata, and range-based read endpoints for playback-friendly access.

## What Floe Does

- large-file upload sessions with resumable chunk transfer
- per-chunk SHA-256 validation
- asynchronous finalize flow with Walrus publish + Sui metadata creation
- file read endpoints for metadata, manifest, and byte-range streaming
- developer tooling through a CLI uploader and API surface

## Current Scope

Floe is currently a phase-1 backend focused on the core upload-to-playback workflow.

Included today:

- upload session creation and status tracking
- chunk upload, retry, resume, and cancel flows
- Walrus-backed durable file finalization
- Sui `fileId` creation for stable metadata lookup
- byte-range streaming through `/v1/files/:fileId/stream`
- public, hybrid, or private auth modes
- env-backed API key verification
- optional owner-based authorization enforcement

Current upload reliability behavior:

- duplicate chunk retries are idempotent and may return `reused: true`
- successful chunk uploads refresh upload activity and expiry state
- upload status and complete reconcile chunk presence from staging when Redis chunk membership drifts
- timed-out uploads transition to `expired` explicitly and return `UPLOAD_EXPIRED` on finalize attempts

Not included yet:

- auth management UI, key rotation workflows, or tenant auth control plane
- transcoding or adaptive bitrate playback
- analytics, billing, or subscription logic
- complete private-content policy stack

## Architecture

High-level flow:

1. client creates an upload session
2. client uploads chunks in any order
3. Floe validates chunk hashes and tracks received parts
4. client requests finalize
5. Floe publishes the assembled asset to Walrus
6. Floe creates file metadata on Sui and returns a stable `fileId`
7. clients read through `/v1/files/:fileId/metadata`, `/manifest`, or `/stream`

Runtime components:

- **API**: Fastify routes and orchestration
- **Redis**: upload state, chunk index, locks, queue state, and rate-limit keys
- **Postgres**: optional read-model/index cache for file lookups
- **Chunk store**: `s3`/R2/MinIO-compatible staging by default, `disk` optional
- **Walrus**: durable blob storage and read path
- **Sui**: file metadata object and ownership anchor

## Local Development

### Requirements

- Node.js `>=20`
- Redis credentials
- Walrus aggregator endpoint
- Sui key + RPC access
- Walrus upload path:
  - `sdk` mode with `FLOE_WALRUS_SDK_BASE_URL`, or
  - `cli` mode with a local `walrus` binary

### Setup

```bash
git clone https://github.com/tejas0111/floe.git
cd floe
npm install
cp .env.example .env
```

Set required values in `.env`.

Minimal working example:

```dotenv
PORT=3001
NODE_ENV=development
UPLOAD_TMP_DIR=/var/lib/floe/upload
FLOE_CHUNK_STORE_MODE=s3
FLOE_S3_BUCKET=floe-staging
FLOE_REDIS_PROVIDER=upstash
UPSTASH_REDIS_REST_URL=https://<your-upstash-url>.upstash.io
UPSTASH_REDIS_REST_TOKEN=<your-upstash-token>
WALRUS_AGGREGATOR_URL=https://walrus-testnet-aggregator.nodes.guru
FLOE_WALRUS_STORE_MODE=sdk
FLOE_WALRUS_SDK_BASE_URL=https://publisher.walrus-testnet.walrus.space
FLOE_NETWORK=testnet
SUI_PRIVATE_KEY=suiprivkey...
SUI_PACKAGE_ID=0x<your-package-id>
```

Use `.env.example` as the full environment reference.

Auth defaults to `hybrid` mode. Upload actions require a verified API key in `hybrid` and `private` mode. File reads remain public in `hybrid` mode and require auth in `private` mode.

For Redis, Floe now supports two runtime modes:

- `FLOE_REDIS_PROVIDER=upstash` with `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
- `FLOE_REDIS_PROVIDER=native` with `REDIS_URL=redis://host:6379`

### Run

```bash
npm run dev
```

### Build

```bash
npm run build --workspace=apps/api
npm run start
```

## Deployment Baseline

Floe now includes a container-first deployment baseline for phase-1 beta.

- build with `docker build -t floe-api:latest .`
- run production from built JS instead of `tsx`
- mount a persistent writable path at `UPLOAD_TMP_DIR`
- use `/health` for container/platform health checks
- if local MinIO runs on the host, use `host.docker.internal` instead of `127.0.0.1` from inside Docker

See `docs/DEPLOYMENT.md` for the deploy, restart, and recovery flow.

## Upload CLI

Floe ships a root launcher at `./floe.sh` that delegates to `scripts/floe.sh`.

Basic usage:

```bash
./floe.sh "path/to/video.mp4" --parallel 3 --epochs 3
npm run upload -- "path/to/video.mp4" --parallel 3 --epochs 3
```

Resume an upload or override the API base:

```bash
./floe.sh "path/to/video.mp4" --resume <uploadId>
./floe.sh "path/to/video.mp4" --api http://localhost:3001/v1/uploads
```

Prepare a non-faststart MP4 for better first-play behavior:

```bash
./floe.sh "path/to/video.mp4" --faststart
```

### Auth Example

```dotenv
FLOE_AUTH_MODE=hybrid
FLOE_API_KEYS_JSON=[{"id":"local-dev","secret":"replace-with-long-random-secret","owner":"0xf35568c562fd25dccd58e4e9240d8a6f864de0a9854ddd1f7d8aa6ff5f9722a4","tier":"authenticated","scopes":["*"]}]
```

Send the key with either `x-api-key` or `Authorization: Bearer <key>`.

## Documentation

- `docs/API.md` - route behavior and response contract
- `docs/DEPLOYMENT.md` - deployment baseline, required services, and restart flow
- `docs/OPERATIONS.md` - runtime model, env, metrics, and runbook notes
- `docs/SECURITY.md` - current auth model and hardening path

## License

MIT (`LICENSE`)
