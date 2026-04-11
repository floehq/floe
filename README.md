# Floe

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

### Requirements

- Node.js `>=20`
- Redis access
- Walrus aggregator access
- Sui RPC access and a signing key
- Walrus upload access through:
  - `sdk` mode with `FLOE_WALRUS_SDK_BASE_URL`, or
  - `cli` mode with a local `walrus` binary

### Setup

```bash
git clone https://github.com/floehq/floe.git
cd floe
npm install
```

Minimal environment example:

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

Floe can also load a topology config file:

```bash
npm run dev -- --config ./config/floe.example.yaml --role read
```

Redis modes:

- `FLOE_REDIS_PROVIDER=upstash` with `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
- `FLOE_REDIS_PROVIDER=native` with `REDIS_URL=redis://host:6379`

### Run

```bash
npm run dev
```

Examples:

```bash
npm run dev -- --role read
npm run dev -- --role write
npm run dev -- --config ./config/floe.example.yaml
```

### Build

```bash
npm run build --workspace=apps/api
npm run start
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
