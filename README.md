<p align="center">
  <h1 align="center">Floe</h1>
  <p align="center">
    Developer-first video infrastructure built on Walrus decentralized storage and Sui blockchain.
  </p>
  <p align="center">
    <a href="https://github.com/floehq/floe/actions/workflows/ci.yml"><img src="https://github.com/floehq/floe/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="https://github.com/floehq/floe/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
    <a href="https://github.com/floehq/floe/releases"><img src="https://img.shields.io/badge/version-1.0.0-blue.svg" alt="Version"></a>
  </p>
</p>

---

Floe handles the hard parts of large file workflows -- resumable chunk uploads, asynchronous finalization, decentralized blob storage, and byte-range streaming -- through a versioned REST API with first-class TypeScript SDK and CLI clients.

## Key Features

- **Resumable Chunk Uploads** -- Upload files in any order with SHA-256 validation per chunk. Resume from where you left off.
- **Asynchronous Finalize** -- Queue-backed 5-stage pipeline: verify, publish to Walrus, mint on Sui, commit, cleanup.
- **Decentralized Storage** -- Files are stored on Walrus with on-chain metadata anchored to Sui for verifiable ownership.
- **Byte-Range Streaming** -- Serve file bytes for playback with local disk caching and range-aware responses.
- **Multi-Role Topology** -- Run `full`, `write`, or `read` nodes from a single build artifact.
- **Pluggable Auth** -- Local, external, and token-based auth providers with scope-based access control.
- **Rate Limiting** -- Redis-backed sliding window with per-scope, per-tier limits.
- **Circuit Breakers** -- Automatic failure isolation for Walrus, Sui, and external auth dependencies.
- **Observability** -- Prometheus metrics, structured infrastructure events, Sentry integration, SLI/SLO tracking.

## Architecture

```
                          ┌─────────────┐
                          │   Client    │
                          │  (SDK/CLI)  │
                          └──────┬──────┘
                                 │
                          ┌──────▼──────┐
                          │  Floe API   │
                          │  (Fastify)  │
                          └──┬───┬───┬──┘
                             │   │   │
              ┌──────────────┘   │   └──────────────┐
              │                  │                   │
       ┌──────▼──────┐   ┌──────▼──────┐   ┌───────▼───────┐
       │    Redis    │   │   Postgres  │   │  S3 / R2 /   │
       │   (state)   │   │  (metadata) │   │    MinIO     │
       └─────────────┘   └─────────────┘   └──────────────┘
                                                     │
                                              chunks staged here
                                                     │
                               ┌──────────────────────┘
                               │
                     ┌─────────▼─────────┐
                     │      Walrus       │
                     │ (blob finalized)  │
                     └─────────┬─────────┘
                               │
                     ┌─────────▼─────────┐
                     │        Sui        │
                     │  (on-chain meta)  │
                     └───────────────────┘
```

## Quick Start

### Prerequisites

- Node.js >= 20, npm >= 9
- Docker and Docker Compose
- Walrus aggregator access
- Sui RPC access and a signing key

### 1. Start infrastructure

```bash
docker compose up -d
```

This starts Redis, Postgres, and MinIO locally.

### 2. Configure

```bash
cp .env.example .env
```

Minimum variables to set for local development:

| Variable | Default | Action |
|---|---|---|
| `FLOE_REDIS_PROVIDER` | `upstash` | Change to `native` |
| `REDIS_URL` | -- | Set to `redis://127.0.0.1:6379` |
| `SUI_PRIVATE_KEY` | -- | Your Sui testnet key |
| `SUI_PACKAGE_ID` | -- | Your deployed package ID |
| `FLOE_API_KEYS_JSON` | -- | Add a test API key (see below) |

### 3. Install and run

```bash
npm install
npm run dev
```

Server starts at **http://localhost:3001**.

### 4. Verify

```bash
curl http://localhost:3001/health
```

## API Overview

All endpoints are prefixed with `/v1`. Full reference in [`docs/API.md`](docs/API.md).

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/v1/uploads/create` | Create upload session |
| `PUT` | `/v1/uploads/:id/chunk/:index` | Upload a chunk |
| `GET` | `/v1/uploads/:id/status` | Upload status |
| `POST` | `/v1/uploads/:id/complete` | Trigger finalize |
| `DELETE` | `/v1/uploads/:id` | Cancel upload |
| `GET` | `/v1/files/:id/metadata` | File metadata |
| `GET` | `/v1/files/:id/stream` | Byte-range stream |
| `HEAD` | `/v1/files/:id/stream` | Stream headers |
| `POST` | `/v1/files/:id/renew` | Extend storage |
| `GET` | `/v1/files/:id/manifest` | Read manifest |
| `GET` | `/health` | Health check |
| `GET` | `/docs` | OpenAPI / Swagger UI |

### Create an API key

Add a key to `FLOE_API_KEYS_JSON` in your `.env`:

```json
[
  {
    "id": "local-dev",
    "secret": "floe_local-dev_aB3xY9zW8mNqR5vT2pL7cF4hJ1kD0sG6uE3wX",
    "owner": "0x...",
    "tier": "authenticated",
    "scopes": ["*"]
  }
]
```

Pass it as a header or bearer token:

```bash
curl -H "x-api-key: floe_local-dev_aB3xY9zW8mNqR5vT2pL7cF4hJ1kD0sG6uE3wX" ...
```

## SDK

The TypeScript SDK provides typed clients for all API operations.

```bash
npm install @floehq/sdk
```

```typescript
import { FloeClient } from "@floehq/sdk";

const client = new FloeClient({
  baseUrl: "http://localhost:3001",
  apiKey: "your-api-key",
});

// Upload a file with progress tracking
const upload = await client.uploadFile("./video.mp4", {
  epochs: 3,
  onProgress: ({ uploaded, total }) =>
    console.log(`${((uploaded / total) * 100).toFixed(1)}%`),
});

// Wait for finalize
await client.waitForUploadReady(upload.uploadId);

// Stream the file
const stream = await client.streamFile(upload.fileId);
for await (const chunk of stream) {
  // process chunk
}

// Download to disk (Node.js)
await client.downloadFileToPath(upload.fileId, "./downloaded.mp4");
```

**Key methods:** `createUpload`, `uploadChunk`, `uploadBlob`, `uploadBytes`, `uploadFile`, `completeUpload`, `waitForUploadReady`, `streamFile`, `downloadFile`, `getFileMetadata`, `renewFile`, `getHealth`.

Full type definitions and all 40+ exported interfaces are documented in [`apps/sdk/src/`](apps/sdk/src/).

## CLI

The CLI wraps the SDK for terminal workflows.

```bash
npm install -g @floehq/cli
```

### Upload

```bash
# Upload a file
floe upload ./video.mp4 --epochs 3

# Upload with parallel chunks
floe upload ./video.mp4 --parallel 4

# Resume a failed upload
floe upload ./video.mp4 --resume <uploadId>

# Check status
floe status <uploadId>
```

### File operations

```bash
# Get metadata
floe metadata <fileId>

# Stream raw bytes to stdout
floe stream <fileId> > output.bin

# Download to file
floe download <fileId> ./output.mp4

# Extend storage duration
floe renew <fileId> --epochs 5

# Get stream URL
floe stream-url <fileId>
```

### Ops and diagnostics

```bash
# Check deployment health
floe ops health

# Show effective config
floe config show

# Runtime diagnostics
floe doctor
```

Global flags: `--base-url`, `--api-key`, `--json`, `--verbose`, `--no-compat-check`.

## Docker

### Build

```bash
docker build -t floe-api:latest .
```

### Run

```bash
docker run -p 3001:3001 \
  -e REDIS_URL=redis://host:6379 \
  -e SUI_PRIVATE_KEY=your-key \
  -e SUI_PACKAGE_ID=your-package \
  floe-api:latest
```

- Mount a persistent path at the upload temp directory for chunk staging
- Use `/health` for container health checks
- If MinIO runs on the host, use `host.docker.internal` instead of `127.0.0.1`

## Configuration

Floe is configured through environment variables or YAML. See [`config/floe.example.yaml`](config/floe.example.yaml) for the full reference.

**Key groups:**

| Group | Variables | Purpose |
|---|---|---|
| Server | `FLOE_PORT`, `FLOE_NODE_ROLE` | HTTP port, node topology role |
| Storage | `FLOE_S3_*`, `FLOE_CHUNK_STORE` | S3/R2/MinIO chunk staging |
| Redis | `FLOE_REDIS_PROVIDER`, `REDIS_URL` | State, locks, queues, rate limiting |
| Postgres | `DATABASE_URL` | File metadata read model |
| Walrus | `WALRUS_AGGREGATOR_URLS`, `WALRUS_EPOCHS` | Blob storage and renewal |
| Sui | `SUI_NETWORK`, `SUI_PRIVATE_KEY`, `SUI_PACKAGE_ID` | Blockchain metadata |
| Auth | `FLOE_AUTH_MODE`, `FLOE_API_KEYS_JSON` | Authentication and access control |
| Upload | `FLOE_MAX_FILE_SIZE`, `FLOE_MAX_CHUNK_SIZE` | Upload limits |
| Stream | `FLOE_STREAM_CACHE_*` | Byte-range caching behavior |
| Observability | `FLOE_METRICS_TOKEN`, `SENTRY_DSN` | Metrics and error tracking |

### Node Roles

| Role | Routes | Workers | Stream Cache |
|---|---|---|---|
| `full` | uploads, files, ops | finalize, uploadGc | Yes |
| `write` | uploads, ops | finalize, uploadGc | No |
| `read` | files | -- | Yes |

## Testing

```bash
# Run the full test suite
npm test --workspace=apps/api

# Run with coverage
npm test --workspace=apps/api -- --experimental-test-coverage
```

Integration tests require Redis and Postgres (provided by `docker compose up -d`).

## Benchmarks

```bash
# Stream benchmark
npm run bench:stream -- --base http://localhost:3001 --file <fileId>

# Upload load test
npm run bench:upload -- --sessions 10 --concurrency 4

# Measure cold vs warm stream latency
npm run measure:stream
```

CSV output is written to `tmp/stream-load/<timestamp>/`.

## Documentation

| Document | Description |
|---|---|
| [`docs/API.md`](docs/API.md) | Full API reference, endpoints, error codes, auth model |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System overview, component map, data flow |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Deployment guide, container build, restart flow |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Runtime config, GC, metrics, runbooks |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Auth model, provider contracts, API key lifecycle |
| [`docs/EXTERNAL_AUTH.md`](docs/EXTERNAL_AUTH.md) | External auth provider contract |
| [`docs/INFRA_EVENTS.md`](docs/INFRA_EVENTS.md) | Infrastructure event catalog |
| [`docs/FINALIZE_SCALING.md`](docs/FINALIZE_SCALING.md) | Finalize queue scaling guide |
| [`docs/WALRUS_OPERATIONS.md`](docs/WALRUS_OPERATIONS.md) | Self-hosted Walrus aggregator setup |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Development setup, code style, PR guidelines |
| [`CHANGELOG.md`](CHANGELOG.md) | Release history |

## Project Structure

```
Floe/
├── apps/
│   ├── api/              @floe/api       Fastify API server
│   ├── sdk/              @floehq/sdk     TypeScript SDK
│   └── cli/              @floehq/cli     Command-line client
├── config/               YAML config examples
├── docs/                 Architecture and operations docs
├── scripts/              Benchmarks and utilities
├── .github/              CI workflows, Dependabot
├── docker-compose.yml    Local dev infrastructure
├── Dockerfile            Multi-stage production build
└── package.json          npm workspaces root
```

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development setup, code style rules, and PR guidelines.

**Quick overview:**

```bash
git clone https://github.com/floehq/floe.git
cd floe
npm ci
docker compose up -d
cp .env.example .env    # edit with your keys
npm run dev
```

Code style: TypeScript strict, semicolons, double quotes, no explicit `any`.

## License

[MIT](LICENSE) -- Copyright 2026 tejas0111
