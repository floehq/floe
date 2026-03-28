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
- when `FLOE_REDIS_PROVIDER=upstash`: `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
- when `FLOE_REDIS_PROVIDER=native`: `REDIS_URL`
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

- `FLOE_REDIS_PROVIDER` default `upstash`
- `UPSTASH_REDIS_REST_URL` required for `upstash` mode
- `UPSTASH_REDIS_REST_TOKEN` required for `upstash` mode
- `REDIS_URL` required for `native` mode

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
- `FLOE_FINALIZE_RETRYABLE_FAILURE_BASE_MS` default `2000`
- `FLOE_FINALIZE_RETRYABLE_FAILURE_MAX_MS` default `30000`
- `FLOE_FINALIZE_RETRYABLE_FAILURE_MAX_ATTEMPTS` default `4`
- `FLOE_FINALIZE_QUEUE_STUCK_AGE_MS` default `300000`
- `FLOE_FINALIZE_DRAIN_INTERVAL_MS` default `500`
- `FLOE_FINALIZE_QUEUE_MAX_DEPTH` default `5000`
- `FLOE_FINALIZE_STATUS_POLL_MS` default `2000`

GC:

- `FLOE_GC_INTERVAL_MS` default `300000`
- `FLOE_GC_GRACE_MS` default `900000`

Auth and request shaping:

- `FLOE_AUTH_MODE` default `hybrid`
- `FLOE_API_KEYS_JSON` optional env-backed API key list

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

Auth mode defaults:

- default auth mode: `hybrid`
- verified auth method: API key via `x-api-key` or `Authorization: Bearer <key>`
- `hybrid` mode requires auth for upload actions and allows public file reads
- `private` mode requires auth for upload and file routes

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
- retryable transient finalize failures stay in a recoverable state and are requeued on restart
- timeout recovery races the worker and schedules retry instead of holding the slot indefinitely

## Garbage Collection

GC reconciles tracked uploads and removes expired or terminal staging data.

Important behavior:

- active uploads are indexed in Redis
- successful chunk uploads refresh upload activity timestamps and session/meta TTL so long-running active uploads do not expire mid-transfer
- uploads can transition to `expired` from `expiresAt` even before passive Redis key eviction occurs
- status and complete reconcile received chunk membership from the backing chunk store when Redis chunk membership drifts
- if chunk-store reconciliation cannot read from staging, upload status and complete return retryable `503 CHUNK_STORE_UNAVAILABLE`
- disk reconciliation only runs when the chunk backend is `disk`
- staged chunk cleanup uses the chunk store abstraction, so `s3` and `disk` both work with the same lifecycle rules
- terminal uploads are only removed from GC tracking after artifact cleanup succeeds; failed cleanup keeps them discoverable for later reconciliation

### Upload Reliability Notes

- duplicate chunk retries are intentionally idempotent and may return `reused: true`
- partial upload cancel removes staged chunks, session state, and chunk membership when cleanup succeeds
- expired uploads return `UPLOAD_EXPIRED` on finalize attempts instead of falling through as generic upload-not-found cases
- incomplete Redis chunk membership does not by itself mean the upload is incomplete if staging already contains the chunks

## Playback Model

Floe serves files through `/v1/files/:fileId/stream` with single-range support.

Current read-path behavior:

- metadata and manifests are served from Sui-backed file metadata with optional Postgres read-model caching
- stream responses support `200`, `206`, and `416`
- stream routes accept bounded, open-ended, and suffix single-range requests
- Walrus reads are stitched in bounded segments
- local disk cache can materially improve warm reads on the same Floe instance
- playback reads use a smaller default segment size than the absolute max range size
- segment fetches shrink on retry when public aggregators reject or fail larger range requests
- a CDN or reverse proxy in front of Floe can benefit from this local cache as origin shielding, but the Floe cache itself is still per-instance and not edge-distributed

For best first-play behavior with MP4 files, use stream-ready/faststart MP4s.

### Known Streaming Limits

- only single-range reads are supported in phase 1
- there is no HLS, DASH, transcoding, or adaptive bitrate playback yet
- non-faststart MP4 files may have weaker first-play behavior even when range reads succeed
- metadata caching reduces lookup cost, but cold playback still depends on Walrus/public aggregator health and latency
- increasing `FLOE_STREAM_CACHE_MAX_BYTES` helps recent hot content on one server, but does not by itself create CDN-grade global caching

### Cold Vs Warm Read Check

Use the built-in measurement helper against a finalized file:

```bash
npm run measure:stream -- <fileId> --base-url http://localhost:3001 --range bytes=0-1048575 --runs 2
```

Or let the helper calculate a range size for you:

```bash
npm run measure:stream -- <fileId> --size-mib 5 --runs 5
```

To sample random 5 MiB windows instead of always starting at byte `0`:

```bash
npm run measure:stream -- <fileId> --size-mib 5 --random-start --runs 5
```

If stream reads require auth, add one of:

```bash
npm run measure:stream -- <fileId> --api-key <key>
npm run measure:stream -- <fileId> --bearer <token>
```

Interpretation:

- run `1` is the cold read for that process/cache state
- run `2` is the immediate warm follow-up read
- compare `ttfbMs` first, then `totalMs`
- capture at least a few samples per file before claiming a latency improvement

This does not replace full p50/p95 benchmarking, but it gives a reproducible branch-level check for read-path regressions and warm-cache benefit.

## Metrics

Floe exports:

- HTTP request counts and duration
- finalize queue depth, oldest queued age, active workers, enqueue totals, and job durations
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
- the same token also gates `GET /ops/uploads/:uploadId`

## Health Endpoint

`GET /health` returns:

- overall readiness
- Redis health
- Postgres health when configured
- finalize queue depth and active worker stats

Current health semantics:

- `status="UP"` means Redis is healthy and no blocking finalize backlog is detected
- `status="DEGRADED"` means the API is still serving but an optional dependency or queue condition needs operator attention
- `status="DOWN"` means Redis is unavailable, a required Postgres dependency is unavailable, or finalize backlog is stalled beyond the configured threshold
- Postgres can report `disabled`, `healthy`, `degraded`, or `unavailable`
- Redis can report `healthy` or `unavailable`

Operator inspection endpoint:

- `GET /ops/uploads/:uploadId`
- returns dependency state, upload session, upload metadata, received chunk indexes, finalize pending state, and lock TTL
- use `?includeReceivedIndexes=1` only when you need the full chunk index list for a specific upload
- intended for direct tester-support and outage triage without manual Redis inspection

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
- `floe_finalize_jobs_total{outcome="retry_transient"}` sustained above threshold
- `floe_walrus_publish_total{outcome="failure"}` above threshold
- `floe_sui_finalize_total{outcome="failure"}` above threshold
- `floe_stream_read_errors_total` rapid growth

## Runbook Basics

When upload status or complete returns `CHUNK_STORE_UNAVAILABLE`:

1. verify the configured chunk staging backend is reachable and healthy
2. if using `s3`/R2/MinIO, verify bucket access, credentials, and endpoint health
3. if using `disk`, verify local filesystem availability and permissions under `UPLOAD_TMP_DIR`
4. retry after backend recovery; these responses are intentionally retryable

When uploads appear to expire unexpectedly:

1. inspect whether chunk traffic is still arriving; successful chunk writes should refresh upload activity and TTL
2. verify `FLOE_UPLOAD_SESSION_TTL_MS` is appropriate for the largest expected uploads
3. inspect upload `expiresAt` in status responses rather than relying only on Redis key presence
4. check for staging backend or client retry issues that prevented chunk progress from being recorded

When `/health` is `DEGRADED`:

1. inspect `checks.postgres.status` and `checks.finalizeQueueWarning`
2. if Postgres is degraded and `FLOE_POSTGRES_REQUIRED=0`, keep serving traffic but treat read-model-backed behavior as non-authoritative until recovery
3. if finalize backlog is degraded, inspect Walrus and Sui latency before increasing concurrency
4. confirm startup recovery did not report unexpected `orphanUploads.recovered` or `finalizeQueue.cleaned` counts
5. use `GET /ops/uploads/:uploadId` for any affected tester upload before digging through raw Redis keys

When `/health` is `DOWN`:

1. if Redis is unavailable, treat upload create, chunk, complete, and cancel paths as blocked until Redis is restored
2. if Postgres is required and unavailable, restore Postgres or explicitly accept degraded behavior before changing config
3. restart one API instance after the dependency is restored and confirm startup recovery logs
4. confirm `GET /health` returns `ready=true` before resuming tester traffic

When finalize backlog grows:

1. inspect finalize queue depth, oldest queued age, and active worker count
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

Finalize retry model:

- lock contention records `outcome="retry_lock"` and requeues using the lock TTL-derived delay
- transient retryable failures record `outcome="retry_transient"` and back off exponentially from `FLOE_FINALIZE_RETRYABLE_FAILURE_BASE_MS` up to `FLOE_FINALIZE_RETRYABLE_FAILURE_MAX_MS`
- retryable transient failures stop requeueing after `FLOE_FINALIZE_RETRYABLE_FAILURE_MAX_ATTEMPTS` attempts and then become terminal failures
- `/health` marks the service degraded when queued backlog age exceeds `FLOE_FINALIZE_QUEUE_STUCK_AGE_MS` beyond currently active local workers
- `finalizeWarning` means the upload already committed as completed, but a best-effort follow-up step failed after commit

Startup recovery model:

- disk-backed orphan chunk directories and final `.bin` artifacts are re-registered for GC as `expired`
- startup logs include `startupRecovery.orphanUploads` with scanned and recovered counts
- finalize queue startup recovery scans tracked uploads, requeues `finalizing` and retryable-failed uploads, and cleans stale queue entries for non-finalizing uploads
- startup logs include `startupRecovery.finalizeQueue` with scanned, recovered, and cleaned counts

Redis outage handling:

1. restore Redis connectivity first; upload control paths return retryable `503 DEPENDENCY_UNAVAILABLE` while Redis is down
2. restart one API instance after Redis is reachable
3. inspect startup recovery logs and `GET /health`
4. verify an existing upload can return `/status` and a new upload can succeed through `/create`

Operator upload inspection:

1. call `GET /ops/uploads/:uploadId` with `x-metrics-token` or bearer auth
2. inspect `session`, `meta`, and `chunks.receivedIndexes` to confirm whether the upload is incomplete, finalizing, failed, or already committed
3. inspect `finalize.pending`, `finalize.activeLock`, and `finalize.lockTtlSeconds` to distinguish queued work from an active lock holder
4. inspect `dependencies.redis` and `dependencies.postgres` in the same response before assuming application-level corruption

Postgres outage handling:

1. if `FLOE_POSTGRES_REQUIRED=0`, the API may stay `DEGRADED`; do not trust read-model-backed behavior until Postgres returns
2. if `FLOE_POSTGRES_REQUIRED=1`, treat the API as down until Postgres is restored
3. after restore, restart one API instance and confirm `/health` reports Postgres `healthy`

Backup and restore minimums:

1. keep Redis persistence or managed durability enabled; ephemeral Redis is not beta-safe
2. keep one documented, tested Redis restore path and one documented, tested Postgres restore path
3. after any restore, verify startup recovery logs, `GET /health`, one upload status read, and one finalize flow before declaring recovery complete
