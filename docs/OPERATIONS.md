# Operations Guide

## Runtime Model

Floe currently runs as:

- Fastify API process
- Redis state store
- Postgres read model and index cache (optional)
- chunk staging backend:
  - `s3`/R2/MinIO-compatible object storage by default
  - `disk` optional for local development
- finalize queue worker inside the API process
- Walrus publish and read integration
- Sui metadata write path

## Required Environment

Minimum required environment values:

- `PORT`
- `NODE_ENV`
- `UPLOAD_TMP_DIR`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `WALRUS_AGGREGATOR_URL`
- `FLOE_NETWORK`
- `SUI_PRIVATE_KEY`
- `SUI_PACKAGE_ID`

Mode-specific requirements:

- when `FLOE_CHUNK_STORE_MODE=s3`: `FLOE_S3_BUCKET` and compatible credentials/config
- when `FLOE_WALRUS_STORE_MODE=sdk`: `FLOE_WALRUS_SDK_BASE_URL`
- when `FLOE_WALRUS_STORE_MODE=cli`: `FLOE_WALRUS_CLI_BIN`

Use `.env.example` as the environment source of truth.

## Environment Reference

Core:

- `PORT` default `3001`
- `NODE_ENV` default `development`
- `UPLOAD_TMP_DIR`

Chunk staging:

- `FLOE_CHUNK_STORE_MODE` default `s3`
- `FLOE_S3_BUCKET`
- `FLOE_S3_REGION` default `us-east-1`
- `FLOE_S3_ENDPOINT`
- `FLOE_S3_FORCE_PATH_STYLE` default `1`
- `FLOE_S3_ACCESS_KEY_ID`
- `FLOE_S3_SECRET_ACCESS_KEY`
- `FLOE_S3_SESSION_TOKEN`
- `FLOE_S3_PREFIX` default `floe/chunks`
- `FLOE_S3_CREATE_BUCKET_IF_MISSING` default `0`

Redis:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Postgres:

- `DATABASE_URL`
- `FLOE_POSTGRES_POOL_MAX` default `10`
- `FLOE_POSTGRES_IDLE_TIMEOUT_MS` default `30000`
- `FLOE_POSTGRES_CONNECT_TIMEOUT_MS` default `10000`
- `FLOE_POSTGRES_REQUIRED` default `0`

Walrus read path:

- `WALRUS_AGGREGATOR_URL`
- `WALRUS_AGGREGATOR_FALLBACK_URLS`
- `WALRUS_READ_TIMEOUT_MS` default `600000`
- `WALRUS_READ_MAX_RETRIES` default `2`
- `WALRUS_READ_RETRY_DELAY_MS` default `250`
- `FLOE_STREAM_MAX_RANGE_BYTES` default `67108864`
- `FLOE_STREAM_MEDIA_SEGMENT_BYTES` default `8388608`

Walrus write path:

- `FLOE_WALRUS_STORE_MODE` default `sdk`
- `FLOE_WALRUS_SDK_BASE_URL`
- `FLOE_WALRUS_CLI_BIN` default `walrus`
- `WALRUS_SEND_OBJECT_TO`
- `FLOE_WALRUS_UPLOAD_TIMEOUT_MS` default `1200000`
- `FLOE_WALRUS_UPLOAD_MAX_RETRIES` default `3`
- `FLOE_WALRUS_UPLOAD_RETRY_DELAY_MS` default `2000`
- `FLOE_WALRUS_QUEUE_CONCURRENCY` default `4`
- `FLOE_WALRUS_QUEUE_INTERVAL_CAP` default `4`
- `FLOE_WALRUS_QUEUE_INTERVAL_MS` default `1000`

Sui:

- `FLOE_NETWORK`
- `SUI_PRIVATE_KEY`
- `SUI_RPC_URL`
- `SUI_PACKAGE_ID`

Upload and finalize limits:

- `FLOE_MAX_FILE_SIZE_BYTES` default `16106127360`
- `FLOE_MAX_TOTAL_CHUNKS` default `200000`
- `FLOE_MAX_ACTIVE_UPLOADS` default `100`
- `FLOE_UPLOAD_SESSION_TTL_MS` default `21600000`
- `FLOE_CHUNK_MIN_BYTES` default `262144`
- `FLOE_CHUNK_MAX_BYTES` default `20971520`
- `FLOE_CHUNK_DEFAULT_BYTES` default `2097152`
- `FLOE_FINALIZE_CONCURRENCY` default `4`
- `FLOE_FINALIZE_TIMEOUT_MS` default `1800000`
- `FLOE_FINALIZE_RETRY_MS` default `2000`
- `FLOE_FINALIZE_RETRY_MAX_MS` default `30000`
- `FLOE_FINALIZE_DRAIN_INTERVAL_MS` default `500`
- `FLOE_FINALIZE_QUEUE_MAX_DEPTH` default `5000`
- `FLOE_FINALIZE_STATUS_POLL_MS` default `2000`

GC:

- `FLOE_GC_INTERVAL_MS` default `300000`
- `FLOE_GC_GRACE_MS` default `900000`

Auth and request shaping:

- `FLOE_RATE_LIMIT_WINDOW_SECONDS` default `60`
- `FLOE_RATE_LIMIT_UPLOAD_CONTROL_PUBLIC` default `5`
- `FLOE_RATE_LIMIT_UPLOAD_CONTROL_AUTH` default `120`
- `FLOE_RATE_LIMIT_UPLOAD_CHUNK_PUBLIC` default `30`
- `FLOE_RATE_LIMIT_UPLOAD_CHUNK_AUTH` default `1200`
- `FLOE_RATE_LIMIT_FILE_META_PUBLIC` default `240`
- `FLOE_RATE_LIMIT_FILE_META_AUTH` default `2400`
- `FLOE_RATE_LIMIT_FILE_STREAM_PUBLIC` default `120`
- `FLOE_RATE_LIMIT_FILE_STREAM_AUTH` default `1200`
- `FLOE_PUBLIC_MAX_FILE_SIZE_BYTES` default `104857600`
- `FLOE_AUTH_MAX_FILE_SIZE_BYTES` default `16106127360`
- `FLOE_ENFORCE_UPLOAD_OWNER` default `0`
- `FLOE_DEFAULT_OWNER_ADDRESS`

Read behavior and observability:

- `FLOE_EXPOSE_BLOB_ID` default `0`
- `FLOE_FILE_FIELDS_MEMORY_CACHE_TTL_MS` default `60000`
- `FLOE_FILE_FIELDS_MEMORY_CACHE_MAX_ENTRIES` default `5000`
- `FLOE_FILE_FIELDS_DEBUG` default `0`
- `FLOE_LOG_WALRUS_METRICS` default `0`
- `FLOE_CORS_ORIGINS`
- `FLOE_ENABLE_METRICS` default `1`
- `FLOE_METRICS_TOKEN`

## Current Defaults

Core defaults from the current config:

- max file size: `15GB`
- public max file size: `100MB`
- max chunk size: `20MB`
- default chunk size: `2MB`
- max active uploads: `100`
- max total chunks per upload: `200000`
- upload session TTL: `6h`

## Finalization Model

Finalize is asynchronous and queue-backed.

Current behavior:

- upload is marked `finalizing`
- finalize worker validates chunk completeness
- Walrus publish occurs first
- Sui metadata creation occurs second
- terminal Redis completion state is committed before staging cleanup
- chunk/session cleanup runs after completion commit

Recovery behavior:

- finalize lock prevents duplicate work
- lock contention is retried with TTL-aware backoff
- uploads can be resumed across interrupted client flows
- transient dependency failures can still leave uploads in `failed` state; this is part of the current beta hardening surface

## Garbage Collection

GC reconciles tracked uploads and removes expired or terminal staging data.

Important behavior:

- active uploads are indexed in Redis
- disk reconciliation only runs when the chunk backend is `disk`
- staged chunk cleanup uses the chunk store abstraction, so `s3` and `disk` both work with the same lifecycle rules

## Playback Model

Floe serves files through `/v1/files/:fileId/stream` with single-range support.

Current read-path behavior:

- metadata and manifests are served from Sui-backed file metadata with optional Postgres read-model caching
- stream responses support `200`, `206`, and `416`
- Walrus reads are stitched in bounded segments
- playback reads use a smaller default segment size than the absolute max range size
- segment fetches shrink on retry when public aggregators reject or fail larger range requests

For best first-play behavior with MP4 files, use stream-ready/faststart MP4s.

## Metrics

Floe exports:

- HTTP request counts and duration
- finalize queue depth, active workers, enqueue totals, and job durations
- Walrus publish totals and durations
- Sui finalize totals and durations
- metadata lookup duration
- stream TTFB
- Walrus segment fetch totals and durations
- stream read error counts

### `/metrics` Security

- keep `/metrics` private whenever possible
- require `FLOE_METRICS_TOKEN`
- send either:
  - `x-metrics-token: <token>`
  - or `Authorization: Bearer <token>`

## Health Endpoint

`GET /health` returns:

- overall readiness
- Redis health
- Postgres health when configured
- finalize queue depth and active worker stats

## Operational Recommendations

- run behind a reverse proxy with timeouts aligned to upload chunk size and streaming behavior
- prefer `s3`/R2/MinIO-compatible staging for multi-instance deployments
- monitor:
  - `429` rates
  - `5xx` rates
  - finalize failures
  - Walrus read/write failures
  - Sui finalize failures
  - finalize queue growth

## Suggested Alerts

- sustained `5xx` spikes on upload or file routes
- sustained `429` spikes on upload/status routes
- `floe_finalize_queue_depth` above threshold
- `floe_finalize_jobs_total{outcome="failed"}` above threshold
- `floe_walrus_publish_total{outcome="failure"}` above threshold
- `floe_sui_finalize_total{outcome="failure"}` above threshold
- `floe_stream_read_errors_total` rapid growth

## Runbook Basics

When finalize backlog grows:

1. inspect finalize queue depth and active worker count
2. inspect Walrus and Sui dependency failures
3. tune `FLOE_FINALIZE_CONCURRENCY` only after confirming downstream capacity
4. reduce ingest pressure if public traffic is saturating the queue

When Walrus failures spike:

1. verify aggregator health and fallback list
2. verify publisher or CLI path depending on `FLOE_WALRUS_STORE_MODE`
3. inspect range-read instability separately from publish failures

When Sui failures spike:

1. verify signer validity and balance
2. verify RPC reachability and latency
3. confirm package/object compatibility
