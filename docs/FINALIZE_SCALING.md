# Finalize Queue Scaling Guide

## How the Finalize Queue Works

The finalize queue is an in-process async queue backed by Redis. Uploads are enqueued via `LPUSH` to a Redis list and dequeued via `RPOP`. Each process runs a concurrency-limited worker pool (`LocalAsyncQueue`) that pulls from the list on a fixed interval. A per-upload Redis lock (`SET NX EX`) ensures only one instance processes a given upload at a time.

Key configuration variables with their defaults:

| Var | Default | Purpose |
|-----|---------|---------|
| `FLOE_FINALIZE_CONCURRENCY` | 4 | Max concurrent finalize jobs per process |
| `FLOE_FINALIZE_QUEUE_MAX_DEPTH` | 5000 | Max queue depth before backpressure |
| `FLOE_FINALIZE_TIMEOUT_MS` | 1800000 (30 min) | Hard timeout per job |
| `FLOE_FINALIZE_DRAIN_INTERVAL_MS` | 500 | How often drain loop polls Redis |
| `FLOE_FINALIZE_RETRYABLE_FAILURE_MAX_ATTEMPTS` | 4 | Max retries before terminal failure |
| `FLOE_WALRUS_QUEUE_CONCURRENCY` | 4 | Max concurrent Walrus publishes |
| `FLOE_WALRUS_QUEUE_INTERVAL_CAP` | 4 | Max Walrus jobs per interval |
| `FLOE_WALRUS_QUEUE_INTERVAL_MS` | 1000 | Walrus rate limit window |

Additional retry-related config:

| Var | Default | Purpose |
|-----|---------|---------|
| `FLOE_FINALIZE_RETRY_MS` | 2000 | Base delay for lock contention retries |
| `FLOE_FINALIZE_RETRY_MAX_MS` | 30000 | Max delay for lock contention retries |
| `FLOE_FINALIZE_RETRYABLE_FAILURE_BASE_MS` | 2000 | Base delay for transient failure retries |
| `FLOE_FINALIZE_RETRYABLE_FAILURE_MAX_MS` | 30000 | Max delay for transient failure retries |

## Finalize Pipeline Stages

Each finalize job runs through five sequential stages. Stage durations are tracked per-upload in Redis meta and emitted as Prometheus histograms.

| Stage | Typical Duration | Bottleneck | Retryable Failures |
|-------|-----------------|------------|-------------------|
| verify_chunks | <50ms | Redis | None (non-retryable) |
| walrus_publish | 10s–20min | Walrus network | `walrus_upload_failed`, `walrus_retention_too_low`, `walrus_unknown`, `walrus_unavailable` |
| sui_finalize | 1–10s | Sui RPC | `sui_unavailable` |
| redis_commit | <100ms | Redis | `redis_failure` |
| cleanup | 1–5s | S3/disk | None (best-effort) |

Non-retryable failure codes include: `upload_not_found`, `incomplete_chunks`, `missing_chunks`, `checksum_mismatch`, `sui_file_create_failed`, `walrus_retention_too_low`, `corrupt_completed_upload`.

The `walrus_publish` stage is the dominant bottleneck. It streams assembled chunks through `createChunkAssemblyStream` (4 concurrent S3 reads) into the Walrus publisher. For a 15 GB file with 2 MB chunks (7500 chunks), the upload alone can take 10–20 minutes depending on network conditions.

## Multi-Instance Coordination

Multiple API instances share the same Redis-backed finalize queue. Coordination works as follows:

- **Lock acquisition:** Each finalize worker attempts `SET NX EX` on `{metaKey}:lock` with a 15-minute TTL and a random UUID token. Only the instance that acquires the lock runs the pipeline.
- **Lock refresh:** The lock holder refreshes the lock every 60 seconds via an atomic Lua script that verifies the token before extending TTL.
- **Lock release:** On completion or failure, the lock holder releases via a Lua script that checks the token before deleting.
- **Dual dequeue:** Two instances can RPOP the same upload ID from the queue (since RPOP is not atomic with the lock check), but only one will win the `SET NX EX`. The loser retries with a TTL-aware backoff delay.

Concurrency is per-process: `FLOE_FINALIZE_CONCURRENCY=4` means each instance runs at most 4 concurrent finalize workers. Total system concurrency equals instances multiplied by per-instance concurrency.

**Recommendation:** Start with 1 instance at concurrency 4. Scale to 2+ instances only after confirming downstream capacity (Walrus, Sui, Postgres).

## Concurrency Tuning

Finalize workers are coupled to multiple downstream systems. Tuning one without considering others can create hidden bottlenecks.

### Finalize → Walrus

Each finalize worker streams chunks through `createChunkAssemblyStream` (which reads 4 chunks concurrently from S3) into the Walrus publisher. The `FLOE_WALRUS_QUEUE_CONCURRENCY` setting caps total concurrent Walrus publishes across all workers.

If `FLOE_FINALIZE_CONCURRENCY > FLOE_WALRUS_QUEUE_CONCURRENCY`, workers will block waiting for a slot in the Walrus queue. This is safe but wastes finalize worker capacity.

**Recommended:** Keep `FLOE_FINALIZE_CONCURRENCY <= FLOE_WALRUS_QUEUE_CONCURRENCY`.

The Walrus queue also enforces a rate limit: `FLOE_WALRUS_QUEUE_INTERVAL_CAP` jobs per `FLOE_WALRUS_QUEUE_INTERVAL_MS` window. At defaults (4 jobs per 1000ms), this is 4 publishes/second sustained.

### Finalize → Sui

The Sui finalize stage has no explicit rate limiter — only a circuit breaker (`FLOE_CB_SUI_FAILURE_THRESHOLD` consecutive failures opens the circuit for `FLOE_CB_SUI_OPEN_DURATION_MS`). Under high concurrency, Sui RPC may throttle with HTTP 429 or 503 responses.

Monitor `floe_sui_finalize_total{outcome="failed"}` for throttling signals. If failures spike, reduce finalize concurrency or add delay between retries.

### Finalize → Postgres

`upsertIndexedFile` and `upsertBlobObjectMapping` use the shared Postgres connection pool. The default pool max is 10 (`FLOE_POSTGRES_POOL_MAX`). Postgres writes happen after the Redis commit stage and are best-effort (failures are logged but do not fail the finalize job).

If finalize concurrency is high and Postgres latency is non-trivial, consider increasing pool size proportionally. At concurrency 4, the default pool of 10 is typically sufficient.

### Finalize → Redis

Redis handles enqueue/dequeue operations, lock acquisition/release, session reads, meta hash updates, and the final completion transaction. Redis is single-threaded; high finalize concurrency means more concurrent Redis commands.

Under load, monitor Redis `connected_clients` and `used_memory` via INFO. The completion transaction (`MULTI/EXEC`) atomically updates meta, deletes the session, deletes the chunk set, and removes the upload from GC and active indexes.

## Resource Estimation

### Redis memory per upload

Each active upload consumes several Redis keys under the `floe:v1:` prefix:

| Key | Type | Approximate Size |
|-----|------|-----------------|
| `upload:{id}:meta` | Hash | ~400 bytes (status, blobId, fileId, checksum, timing fields) |
| `upload:{id}:session` | Hash | ~200 bytes (upload parameters, owner, content type) |
| `upload:{id}:chunks` | Set | ~50 bytes per chunk member |
| `upload:{id}:meta:lock` | String + TTL | ~50 bytes |
| `upload:finalize:queue` | List | ~50 bytes per entry (UUID string) |
| `upload:finalize:pending` | Set | ~50 bytes per member |
| `upload:finalize:pending_since` | Sorted Set | ~80 bytes per entry (member + score timestamp) |

**Total per active upload:** ~800–1200 bytes (varies by chunk count).

At `FLOE_FINALIZE_QUEUE_MAX_DEPTH=5000`:
- Queue + pending overhead: ~5000 × 200 bytes ≈ 1 MB
- Plus per-upload state for in-flight uploads: varies by active upload count

### Memory per concurrent finalize worker

`createChunkAssemblyStream` buffers up to 4 chunks concurrently (the `CHUNK_READ_CONCURRENCY` constant). At the default chunk size of 2 MB (`FLOE_CHUNK_DEFAULT_BYTES`):

- Per worker: 4 × 2 MB = 8 MB peak assembly buffer
- At `FLOE_FINALIZE_CONCURRENCY=4`: 4 × 8 MB = **32 MB peak assembly buffer**

For large files (e.g., 15 GB with 2 MB chunks = 7500 chunks), the assembly stream still reads only 4 chunks at a time, so peak memory per worker stays at 8 MB regardless of total file size.

### Disk temp files

Each finalize worker creates a temporary `.bin` file at `UPLOAD_TMP_DIR/{uploadId}.bin` during the Walrus publish stage. The file is deleted after the Redis commit stage completes.

- Size = upload file size
- At concurrency 4 with 15 GB files: worst case is 4 × 15 GB = **60 GB temp disk needed**
- For typical uploads (10 MB–1 GB), disk pressure is minimal

## Backpressure Behavior

When queue depth reaches `FLOE_FINALIZE_QUEUE_MAX_DEPTH` (default 5000), new enqueue attempts are rejected with `rejected_backpressure`. The enqueue flow works as follows:

1. The upload's meta hash is set to `status: "finalizing"` with `finalizingQueuedAt` timestamp
2. The Lua script checks `LLEN(queue) >= maxDepth`
3. If full, the upload is **not** added to the queue or pending set

This creates a subtle state: backpressured uploads appear as `status: "finalizing"` in Redis but are NOT in the finalize queue. They are effectively stuck until:
- Startup recovery scans the GC index and requeues them
- A manual force-requeue is performed

Monitor backpressure with:

```promql
rate(floe_finalize_enqueue_total{result="rejected_backpressure"}[5m])
```

## Scaling Decision Tree

Use this flowchart to decide when and how to scale:

```
Is finalize queue depth growing over time?
├── YES → Is queue oldest age > 5 minutes?
│   ├── YES → Check downstream health (Walrus, Sui)
│   │   ├── Downstream healthy → Increase FLOE_FINALIZE_CONCURRENCY
│   │   └── Downstream degraded → Fix downstream first
│   └── NO → Queue is growing but not critical; monitor
└── NO → System is healthy; no action needed
```

### When to increase concurrency

- Single instance, downstream systems have headroom
- Queue depth is moderate (100–1000)
- Walrus and Sui latency is within normal bounds
- `floe_walrus_publish_total{outcome="failed"}` is low
- Redis and Postgres are not saturated

### When to add instances

- Single instance is at max concurrency
- Downstream systems have headroom
- Queue depth is high (>1000)
- You need high availability (fault tolerance)
- S3/R2 chunk backend is used (shared storage across instances)

### When to do both

- Throughput demand exceeds single-instance capacity
- You need both higher throughput and fault tolerance
- Ensure `FLOE_WALRUS_QUEUE_CONCURRENCY` is also scaled proportionally

## Monitoring Checklist

Prometheus queries to watch:

```promql
# Queue depth trend
floe_finalize_queue_depth

# Oldest queued item age
floe_finalize_queue_oldest_age_ms

# Active workers
floe_finalize_workers_active

# Enqueue rejections (backpressure)
rate(floe_finalize_enqueue_total{result="rejected_backpressure"}[5m])

# Finalize failure rate
rate(floe_finalize_jobs_total{outcome="failed"}[5m])

# Walrus publish failures
rate(floe_walrus_publish_total{outcome="failed"}[5m])

# Sui finalize failures
rate(floe_sui_finalize_total{outcome="failed"}[5m])
```

Additional useful queries:

```promql
# Lock contention retries
rate(floe_finalize_jobs_total{outcome="retry_lock"}[5m])

# Transient retry rate
rate(floe_finalize_jobs_total{outcome="retry_transient"}[5m])

# Finalize stage durations (p95)
histogram_quantile(0.95, rate(floe_finalize_stage_duration_ms_bucket[5m]))

# Circuit breaker state
floe_circuit_breaker_state
```

## Common Failure Scenarios

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Queue depth growing, oldest age increasing | Walrus or Sui degraded | Check downstream health, reduce ingest rate |
| Queue depth growing, workers idle | Lock contention or drain loop too slow | Check `floe_finalize_workers_active`, increase `FLOE_FINALIZE_DRAIN_INTERVAL_MS` |
| Backpressure rejections | Queue full | Increase `FLOE_FINALIZE_QUEUE_MAX_DEPTH` or increase concurrency |
| Lock contention retries | Multiple instances processing same upload | Normal behavior; if excessive, reduce instance count |
| Finalize timeout retries | Large files + slow Walrus | Increase `FLOE_FINALIZE_TIMEOUT_MS` or reduce file sizes |
| Circuit breaker open (Sui) | Too many Sui RPC failures | Wait for recovery; check Sui network status |
