# Floe

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](CHANGELOG.md)

Floe is a backend for uploading, finalizing, and reading large files with Walrus and Sui.

It supports resumable chunk uploads, asynchronous finalize flow, stable file metadata, and byte-range reads through a versioned API.

## Features

- resumable upload sessions for large files
- chunk uploads with SHA-256 validation
- asynchronous finalize flow backed by Walrus
- Sui-based file metadata with stable `fileId` lookup
- metadata, manifest, and stream endpoints
- CLI and SDK clients in this workspace

## API Version

The current server API contract is `v1`.

Compatibility window:

- SDK: `>=0.2.0 <0.3.0`
- CLI: `>=0.2.0 <0.3.0`

## How It Works

1. A client creates an upload session.
2. The client uploads chunks in any order.
3. Floe validates and stores uploaded chunks.
4. The client requests finalize.
5. Floe publishes the assembled file to Walrus.
6. Floe records metadata on Sui and returns a `fileId`.
7. Clients read the file through the file endpoints.

## Components

- **API**: Fastify server and route handlers
- **Redis**: upload state, chunk indexes, locks, queue state, and rate limiting
- **Postgres**: optional cache for file lookups
- **Chunk store**: `s3`/R2/MinIO-compatible storage by default, `disk` optional
- **Walrus**: blob storage for finalized files
- **Sui**: file metadata and ownership anchor

## Local Development

### Prerequisites

- Node.js `>=20`
- npm `>=9`
- Docker and Docker Compose
- Walrus aggregator access
- Sui RPC access and a signing key

### Step 1 — Start infrastructure

The project includes a `docker-compose.yml` that runs Redis, Postgres, and MinIO locally.
Start them before anything else:

```bash
docker compose up -d
```

Verify the containers are healthy:

```bash
docker compose ps
```

See the [Docker Compose Services](#docker-compose-services) subsection below for ports and what each service does.

### Step 2 — Configure environment

```bash
cp .env.example .env
```

Open `.env` and set the mandatory variables. For a minimal local setup the key
vars to change from defaults are:

| Variable | Default | Action |
|---|---|---|
| `FLOE_REDIS_PROVIDER` | `upstash` | Change to `native` for local Docker Redis |
| `REDIS_URL` | — | Set to `redis://127.0.0.1:6379` |
| `FLOE_S3_ACCESS_KEY_ID` | `minioadmin` | Keep default for local MinIO |
| `FLOE_S3_SECRET_ACCESS_KEY` | `minioadmin` | Keep default for local MinIO |
| `SUI_PRIVATE_KEY` | — | Set to your Sui testnet private key |
| `SUI_PACKAGE_ID` | — | Set to your deployed package ID |
| `FLOE_API_KEYS_JSON` | — | Add a test API key (see below) |
| `FLOE_METRICS_TOKEN` | `change-me-strong-random-token` | Set to any random string |

All other variables have sensible defaults for local development.

### Step 3 — Install dependencies

```bash
npm install
```

### Step 4 — Run the server

```bash
npm run dev
```

The server starts on **http://localhost:3001** by default.

Additional run modes:

```bash
npm run dev -- --role read
npm run dev -- --role write
npm run dev -- --config ./config/floe.example.yaml
```

### Step 5 — Verify

```bash
curl http://localhost:3001/health
```

A healthy response returns status `"ok"` with a JSON body.

### Step 6 — Create a test API key

Add an API key to the `FLOE_API_KEYS_JSON` variable in your `.env` file.
Use the JSON format with an `id`, `secret`, `owner`, `tier`, and `scopes`:

```json
[
  {
    "id": "local-dev",
    "secret": "floe_local-dev_aB3xY9zW8mNqR5vT2pL7cF4hJ1kD0sG6uE3wX",
    "owner": "0xf35568c562fd25dccd58e4e9240d8a6f864de0a9854ddd1f7d8aa6ff5f9722a4",
    "tier": "authenticated",
    "scopes": ["*"]
  }
]
```

The secret value is the key you present in requests. Pass it as a header or bearer token:

```bash
# Header
curl -H "x-api-key: floe_local-dev_aB3xY9zW8mNqR5vT2pL7cF4hJ1kD0sG6uE3wX" ...

# Bearer token
curl -H "Authorization: Bearer floe_local-dev_aB3xY9zW8mNqR5vT2pL7cF4hJ1kD0sG6uE3wX" ...
```

### Step 7 — Run tests

```bash
npm test --workspace=apps/api
```

Integration tests require Redis running locally (provided by docker-compose).

### Step 8 — Useful commands

| Command | Description |
|---|---|
| `npm run dev` | Start dev server with hot-reload |
| `npm run build` | Build all workspaces (api, sdk, cli) |
| `npm run start` | Start production build |
| `npm run lint` | Lint all workspaces |
| `npm run upload` | Upload a file via the CLI |
| `npm run bench:stream` | Run stream benchmark |
| `npm run bench:upload` | Run upload load test |
| `npm run clean` | Remove `node_modules` and reinstall |

### Build

```bash
npm run build --workspace=apps/api
npm run start
```

### Docker Compose Services

The `docker-compose.yml` at the project root runs three backing services for local development.

| Service | Image | Ports | Purpose |
|---|---|---|---|
| **redis** | `redis:7-alpine` | `6379` | Upload state, chunk indexes, locks, rate limiting, queue state |
| **postgres** | `postgres:16-alpine` | `5432` | Optional file metadata read model (user: `floe`, password: `floe`, database: `floe`) |
| **minio** | `minio/minio:latest` | `9000` (API), `9001` (console) | S3-compatible object storage for chunk staging (user: `floe`, password: `floe_secret`) |

To stop all services:

```bash
docker compose down
```

To wipe volumes (fresh start):

```bash
docker compose down -v
```

## Docker

```bash
docker build -t floe-api:latest .
```

For container deployments:

- mount a persistent writable path at `UPLOAD_TMP_DIR`
- use `/health` for health checks
- if local MinIO runs on the host, use `host.docker.internal` instead of `127.0.0.1`

## CLI

Floe includes a root launcher at `./floe.sh` that delegates to `scripts/floe.sh`.

```bash
./floe.sh "path/to/file.mp4" --parallel 3 --epochs 3
npm run upload -- "path/to/file.mp4" --parallel 3 --epochs 3
```

Resume or override the API base:

```bash
./floe.sh "path/to/file.mp4" --resume <uploadId>
./floe.sh "path/to/file.mp4" --api http://localhost:3001/v1/uploads
```

Prepare a non-faststart MP4 before upload:

```bash
./floe.sh "path/to/file.mp4" --faststart
```

## Benchmark

```bash
npm run bench:stream -- --base http://localhost:3001 --file <fileId>
```

This writes CSV output under `tmp/stream-load/<timestamp>/`.

## Documentation

- `docs/API.md` - API routes and response contract
- `docs/DEPLOYMENT.md` - deployment and restart flow
- `docs/OPERATIONS.md` - runtime model, configuration, metrics, and runbook notes
- `docs/SECURITY.md` - auth model and security notes

## License

MIT (`LICENSE`)
