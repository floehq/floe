# Infrastructure Events

Floe emits structured infrastructure events as structured log lines. These
events are designed for downstream ingest into observability pipelines,
audit logs, or the SaaS billing/analytics layer.

## Delivery Guarantees

| Property             | Guarantee                                                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Delivery**         | **Log-based, best-effort.** Events are written via `log.info(...)` under the key `infraEvent`. There is no retry, no at-least-once delivery, and no durable queue. A process crash between the action and the log write means the event is lost. |
| **Ordering**         | **No ordering guarantee.** Events from concurrent request handlers may interleave. The `timestamp` field provides chronology for ordering after the fact.                                                                                        |
| **Deduplication**    | **No deduplication.** The same logical event (e.g. same upload retried) may appear multiple times. Downstream consumers should use `(event, uploadId/fileId, timestamp)` or an idempotency key for dedup.                                        |
| **Schema stability** | Fields documented below are stable across patch versions within the same `schemaVersion`. New fields may be added; unknown fields must be ignored by consumers.                                                                                  |
| **Enum values**      | Event name and `outcome` values are stable once released. New event names may be added.                                                                                                                                                          |

## Enabling / Disabling

Events are enabled by default. Set `FLOE_EVENT_LOG_ENABLED=false` to
disable them entirely.

## Common Envelope

Every event is wrapped in this envelope:

```typescript
{
  "infraEvent": {
    "schemaVersion": 1,           // Always 1 in the current version
    "timestamp": "2026-07-12T12:00:00.000Z",  // ISO-8601
    "event": "<event_name>",      // One of the event names below
    "requestId": "req_...",       // Floe request ID (may be absent for background events)
    "uploadId": "uuid",           // Present for upload-scoped events
    "fileId": "0x...",            // Present for file-scoped events
    "blobId": "...",              // Present for blob-scoped events
    "actor": {                    // Present for request-scoped events (may be absent for background events)
      "authenticated": true,
      "method": "api_key",
      "subject": "user:user_abc",
      "apiKeyId": "key_abc",
      "owner": "0x...",
      "orgId": "org_42",          // Pass-through from external auth
      "projectId": "proj_7",      // Pass-through from external auth
      "tier": "authenticated"
    },
    "statusCode": 200,
    "outcome": "success",        // "success" | "failure"
    "durationMs": 1234,          // Millisecond duration (present for async/completion events)
    "bytes": 1048576,            // Byte count (present for data-transfer events)
    "metadata": { ... }          // Event-specific metadata (see below)
  }
}
```

## Event Catalog

### `upload_created`

Emitted when a new upload session is created successfully.

| Field        | Value                        |
| ------------ | ---------------------------- |
| `uploadId`   | The new upload UUID          |
| `statusCode` | `201`                        |
| `outcome`    | `success`                    |
| `bytes`      | Requested file size in bytes |
| `actor`      | Present (request-scoped)     |

Metadata:

```typescript
{
  "contentType": "video/mp4",
  "chunkSize": 2097152,
  "totalChunks": 48,
  "epochs": 3
}
```

### `chunk_uploaded`

Emitted after a chunk is successfully persisted to the staging store.

| Field        | Value           |
| ------------ | --------------- |
| `uploadId`   | Upload UUID     |
| `statusCode` | `200`           |
| `outcome`    | `success`       |
| `bytes`      | Chunk byte size |
| `actor`      | Present         |

Metadata:

```typescript
{
  "chunkIndex": 5,
  "reused": false,         // true if the chunk already existed
  "totalChunks": 48
}
```

### `finalize_requested`

Emitted when a client calls `POST /v1/uploads/:uploadId/complete` and
the upload is enqueued for finalization.

| Field        | Value       |
| ------------ | ----------- |
| `uploadId`   | Upload UUID |
| `statusCode` | `202`       |
| `outcome`    | `success`   |
| `actor`      | Present     |

Metadata:

```typescript
{
  "enqueued": true,
  "inProgress": false,
  "receivedChunks": 48,
  "totalChunks": 48
}
```

### `upload_canceled`

Emitted when a client cancels an upload via `DELETE /v1/uploads/:uploadId`.

| Field        | Value       |
| ------------ | ----------- |
| `uploadId`   | Upload UUID |
| `statusCode` | `200`       |
| `outcome`    | `success`   |
| `actor`      | Present     |

Metadata:

```typescript
{
  "status": "canceled"
}
```

### `finalize_succeeded`

Emitted from the background finalize worker when an upload completes
successfully (Walrus publish + Sui metadata creation).

| Field        | Value                                           |
| ------------ | ----------------------------------------------- |
| `uploadId`   | Upload UUID                                     |
| `fileId`     | The new Sui file object ID                      |
| `blobId`     | The Walrus blob ID                              |
| `outcome`    | `success`                                       |
| `bytes`      | File size in bytes                              |
| `durationMs` | Total finalize duration in milliseconds         |
| `actor`      | **Absent** (background job, no request context) |

Metadata:

```typescript
{
  "owner": "0x...",
  "attempt": 1,
  "queueWaitMs": 250,
  "walrusEndEpoch": 123456,
  "walrusSource": "newly_created",    // "newly_created" | "already_certified"
  "stageDurationsMs": {
    "verify_chunks": 10,
    "walrus_publish": 1200,
    "sui_finalize": 800,
    "redis_commit": 5,
    "cleanup": 15
  }
}
```

### `finalize_failed`

Emitted from the background finalize worker when an upload finalization
fails (terminal or retryable).

| Field        | Value                                  |
| ------------ | -------------------------------------- |
| `uploadId`   | Upload UUID                            |
| `outcome`    | `failure`                              |
| `bytes`      | File size in bytes                     |
| `durationMs` | Duration until failure in milliseconds |
| `actor`      | **Absent** (background job)            |

Metadata:

```typescript
{
  "owner": "0x...",
  "attempt": 2,
  "queueWaitMs": 300,
  "failedStage": "walrus_publish",
  "reasonCode": "WALRUS_PUBLISH_FAILED",
  "retryable": true
}
```

### `stream_started`

Emitted when a stream request begins (either from cache or from Walrus).

| Field        | Value                   |
| ------------ | ----------------------- |
| `fileId`     | File ID                 |
| `blobId`     | Walrus blob ID          |
| `statusCode` | `200` or `206`          |
| `outcome`    | `success`               |
| `bytes`      | Requested span in bytes |
| `actor`      | Present                 |

Metadata:

```typescript
{
  "method": "GET",
  "cacheHit": true,
  "range": "bytes=0-1048575",      // null for full object
  "start": 0,
  "end": 1048575
}
```

### `stream_completed`

Emitted when a stream request finishes delivering all bytes.

| Field        | Value                 |
| ------------ | --------------------- |
| `fileId`     | File ID               |
| `blobId`     | Walrus blob ID        |
| `statusCode` | `200` or `206`        |
| `outcome`    | `success`             |
| `bytes`      | Total bytes delivered |
| `durationMs` | Total stream duration |
| `actor`      | Present               |

Metadata:

```typescript
{
  "range": "bytes=0-1048575",      // null for full object
  "start": 0,
  "end": 1048575,
  "cacheHit": true                  // present only for cache-served streams
}
```

### `stream_failed`

Emitted when a stream request terminates with an error.

| Field     | Value          |
| --------- | -------------- |
| `fileId`  | File ID        |
| `blobId`  | Walrus blob ID |
| `outcome` | `failure`      |
| `actor`   | Present        |

Metadata:

```typescript
{
  "range": "bytes=0-1048575",
  "start": 0,
  "end": 1048575,
  "expectedBytes": 1048576,
  "reason": "blob_unavailable",    // classification of the error
  "cacheHit": true                  // present only for cache-served streams
}
```

## Consuming Events

Events are written as structured JSON via Fastify's logger. In production,
your logging pipeline should forward these to your observability platform.

Example log line:

```json
{
  "level": 30,
  "time": 1720785600000,
  "msg": "",
  "infraEvent": {
    "schemaVersion": 1,
    "timestamp": "2026-07-12T12:00:00.000Z",
    "event": "upload_created",
    "requestId": "req-abc-123",
    "uploadId": "550e8400-e29b-41d4-a716-446655440000",
    "outcome": "success",
    "statusCode": 201,
    "bytes": 104857600,
    "actor": {
      "authenticated": true,
      "method": "api_key",
      "subject": "api_key:key_abc",
      "apiKeyId": "key_abc",
      "owner": "0x...",
      "orgId": "org_42",
      "projectId": "proj_7",
      "tier": "authenticated"
    },
    "metadata": {
      "contentType": "video/mp4",
      "chunkSize": 2097152,
      "totalChunks": 50,
      "epochs": 3
    }
  }
}
```

## TypeScript Types

The canonical type definitions live in:

```
apps/api/src/services/events/infrastructure.events.ts
```

The `InfrastructureEvent` type covers the generic envelope. Event-specific
metadata is typed as `Record<string, unknown>` and documented in the
per-event metadata tables above.

## JSON Schema

An external ingester should validate against these expectations:

1. `infraEvent` is always a top-level JSON object.
2. `infraEvent.schemaVersion` is always `1`.
3. `infraEvent.event` is one of the 9 event names listed above.
4. `infraEvent.timestamp` is an ISO-8601 string (millisecond precision).
5. `infraEvent.actor` is present for request-scoped events.
6. `infraEvent.actor.orgId` and `infraEvent.actor.projectId` are pass-through
   strings, present only when the external auth provided them.
7. `infraEvent.metadata` is an object with event-specific keys documented above.
8. Unknown top-level fields under `infraEvent` should be ignored by consumers.
