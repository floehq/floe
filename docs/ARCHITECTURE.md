# Architecture Overview

## System Overview

Floe is a resumable chunk upload API that stores file chunks in temporary staging storage, assembles them into blobs on Walrus (decentralized blob storage), and records ownership metadata on Sui (blockchain). Clients upload files in parallel chunks with SHA-256 validation, trigger finalization asynchronously, and read finalized content through byte-range stream endpoints.

## Component Map

| Component | Role |
|---|---|
| **Fastify HTTP server** | Handles all client requests, CORS, rate limiting, auth, Swagger docs. Runs as a single Node.js process. |
| **Redis** | Upload session state, chunk indexes, finalize queue, idempotency locks, active upload capacity tracking, rate limiting counters. The primary state store for all write-path operations. |
| **Postgres** | File metadata read model — a queryable file registry for completed uploads. Optional; the system degrades gracefully without it. |
| **S3 / MinIO** | Chunk staging storage. Temporarily holds uploaded chunks until finalization assembles and deletes them. Supports any S3-compatible backend (R2, MinIO, local disk). |
| **Walrus** | Decentralized blob storage. Finalized files are published here permanently. Reads are served through a public aggregator. |
| **Sui** | On-chain metadata and ownership records. A `fileId` is minted for each finalized file, anchoring blob ID, size, checksum, and owner on-chain. |
| **Finalize worker** | Background process (runs inside the API process) that dequeues completed uploads, assembles chunks, publishes to Walrus, records metadata on Sui, then commits to Redis and Postgres. |
| **GC worker** | Background process (runs inside the API process) that cleans up expired upload sessions and orphaned staged chunks. |

## Upload Flow

### Phase 1: Create

Client sends `POST /v1/uploads/create` with filename, content type, size, and optional checksum. The server:

1. Checks rate limits and upload authorization.
2. Reserves a slot in the active upload capacity set (Redis `SADD`).
3. Creates a Redis session with `uploadId`, `chunkSize`, `totalChunks`, `epochs`, and `expiresAt`.
4. Returns `uploadId`, `chunkSize`, `totalChunks`, `epochs`, and `expiresAt` to the client.

Idempotency is supported via `Idempotency-Key` header — a SHA-256 fingerprint of the create payload is stored in Redis and replayed on duplicate requests.

### Phase 2: Chunk Upload

Client sends `PUT /v1/uploads/:uploadId/chunk/:index` with the chunk body as multipart and an `x-chunk-sha256` header. The server:

1. Validates the chunk index, hash header, and session status.
2. Writes the chunk to the chunk store (S3 or disk) with SHA-256 verification.
3. Adds the chunk index to the Redis chunk set (`SADD`).
4. Refreshes upload activity timestamps to prevent expiry during long transfers.

Chunks can be uploaded in any order and retried idempotently (duplicate writes return `reused: true`).

### Phase 3: Complete

Client sends `POST /v1/uploads/:uploadId/complete`. The server:

1. Reconciles chunk membership across Redis and the chunk store.
2. Verifies all chunks are present (`receivedChunks === totalChunks`).
3. Enqueues the upload to the finalize queue via Redis `LPUSH`.
4. Returns `202` with `status: "finalizing"` and a `pollAfterMs` hint.

If the queue is saturated, returns `503 FINALIZE_QUEUE_BACKPRESSURE` with a `Retry-After` header.

### Phase 4: Finalize

The finalize worker dequeues the upload and runs a five-stage pipeline:

1. **verify_chunks** — Confirms chunk count and index completeness via Redis.
2. **walrus_publish** — Assembles chunks into a contiguous stream, uploads to Walrus, and computes a streaming SHA-256 checksum. If the file's checksum matches an existing Walrus blob, the blob is reused (with epoch renewal if needed).
3. **sui_finalize** — Mints a `fileId` on Sui with blob ID, size, checksum, MIME type, and owner.
4. **redis_commit** — Atomically marks the upload `completed` in Redis, deletes session/chunk keys, and removes from the GC index.
5. **cleanup** — Deletes staged chunks from S3/disk and any leftover `.bin` artifacts.

A distributed lock (Redis `SET NX EX` with periodic refresh) prevents duplicate finalization. Retryable transient failures are requeued with exponential backoff up to a configurable max attempt count.

### Phase 5: Cleanup

After finalization completes:

- Staged chunks are deleted from S3/disk.
- The session and chunk keys are removed from Redis.
- The upload is removed from the GC tracking index.

The GC worker separately handles expired uploads and orphaned chunks that were never finalized.

## Data Flow

```
Client
  │
  ├── POST /v1/uploads/create ──→ Fastify ──→ Redis (session + capacity)
  │
  ├── PUT /v1/uploads/:id/chunk/:index ──→ Fastify ──→ S3 (chunk storage)
  │                                                └── Redis (chunk index + activity)
  │
  ├── POST /v1/uploads/:id/complete ──→ Fastify ──→ Redis LPUSH (finalize queue)
  │
  │   Finalize Worker (background):
  │     Redis (dequeue) ──→ S3 (read chunks) ──→ Walrus (blob publish)
  │                                              ──→ Sui (metadata mint)
  │                                              ──→ Redis (mark completed)
  │                                              ──→ Postgres (file index)
  │                                              ──→ S3 (cleanup chunks)
  │
  └── GET /v1/files/:fileId/stream ──→ Fastify ──→ Postgres/Sui (metadata)
                                               └── Walrus (byte-range read)
```

## Role Model

The `FLOE_NODE_ROLE` environment variable (default: `full`) controls which components and routes are active on a given instance:

| Role | Routes | Workers | Features |
|---|---|---|---|
| `full` | uploads, files, ops | finalize, uploadGc | streamCache |
| `write` | uploads, ops | finalize, uploadGc | — |
| `read` | files | — | streamCache |

- **`full`** — All components. Suitable for single-instance deployments.
- **`write`** — HTTP upload/control endpoints and finalize workers. No file read endpoints or stream cache. Use for dedicated write nodes in a split topology.
- **`read`** — HTTP file read endpoints and stream cache. No upload routes, finalize workers, or GC. Use for dedicated read-only nodes behind a load balancer.

Route and worker registration is gated by `TopologyConfig` at startup in `app.server.ts`.

## Configuration

Full environment variable reference is in [`docs/OPERATIONS.md`](./OPERATIONS.md).

Key configuration areas:

- **Chunk sizing** — `FLOE_CHUNK_MIN_BYTES`, `FLOE_CHUNK_MAX_BYTES`, `FLOE_CHUNK_DEFAULT_BYTES`
- **Upload limits** — `FLOE_MAX_FILE_SIZE_BYTES`, `FLOE_MAX_TOTAL_CHUNKS`, `FLOE_MAX_ACTIVE_UPLOADS`
- **Finalize tuning** — `FLOE_FINALIZE_CONCURRENCY`, `FLOE_FINALIZE_TIMEOUT_MS`, retry backoff parameters
- **Auth** — `FLOE_AUTH_MODE`, `FLOE_API_KEYS_JSON`, rate limit overrides per scope
- **Storage backends** — `FLOE_CHUNK_STORE_MODE` (`s3` or `disk`), `FLOE_WALRUS_STORE_MODE` (`sdk` or `cli`)
- **Networking** — `FLOE_CORS_ORIGINS`, `FLOE_TRUST_PROXY`, `FLOE_GLOBAL_REQUEST_CONCURRENCY`

## Key Files

```
apps/api/src/
├── routes/              # Fastify route handlers
│   ├── uploads.ts         # Create, chunk upload, complete, status, cancel
│   ├── files.ts           # File metadata and streaming endpoints
│   ├── health.ts          # Health and readiness checks
│   └── ops-api-keys.ts    # Operator inspection endpoints
├── services/            # Business logic
│   ├── uploads/           # Session management, finalize pipeline, queue
│   │   ├── session.ts       # Redis session CRUD
│   │   ├── finalize.service.ts  # Five-stage finalize pipeline
│   │   └── finalize.queue.ts    # Queue worker with concurrency control
│   ├── walrus/            # Walrus publish, read, epoch, blob state
│   ├── auth/              # Auth provider, rate limiting, policy
│   ├── stream/            # Byte-range streaming and cache
│   ├── metrics/           # Prometheus metrics and SLI recording
│   ├── events/            # Structured infrastructure event logging
│   └── errors/            # Error reporting (Sentry integration)
├── store/               # Chunk storage abstraction
│   ├── s3.ts               # S3/R2/MinIO chunk store
│   ├── disk.ts             # Local disk chunk store
│   └── index.ts            # Backend resolver (FLOE_CHUNK_STORE_MODE)
├── sui/                 # Sui blockchain interaction
│   └── file.metadata.ts    # File metadata minting
├── config/              # Configuration loading and validation
│   ├── topology.config.ts  # Role-based route/worker gating
│   ├── uploads.config.ts   # Upload limits and chunk sizing
│   ├── auth.config.ts      # Auth mode, rate limits, owner policy
│   └── walrus.config.ts    # Walrus epoch limits
├── db/                  # Postgres queries and migrations
│   └── files.repository.ts # File registry CRUD
├── state/               # Connection management
│   ├── redis.ts            # Redis client lifecycle
│   ├── postgres.ts         # Postgres client lifecycle
│   ├── s3.ts               # S3 client lifecycle
│   ├── gc/                 # GC scheduler and reconciliation
│   └── keys.ts             # Redis key namespace definitions
└── utils/               # Shared utilities
    ├── validation.ts       # Input validation helpers
    ├── parseEnv.ts         # Safe env parsing
    └── configDump.ts       # Config logging at startup
```

## Related Documentation

- [`docs/API.md`](./API.md) — API routes and response contracts
- [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) — Deployment and restart flow
- [`docs/OPERATIONS.md`](./OPERATIONS.md) — Runtime model, configuration reference, metrics, and runbooks
- [`docs/SECURITY.md`](./SECURITY.md) — Auth model and security notes
