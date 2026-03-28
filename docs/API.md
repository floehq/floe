# API Reference

Base URL (local default):

```text
http://localhost:3001
```

## Upload Endpoints

### `POST /v1/uploads/create`

Create an upload session.

Required JSON fields:

- `filename`
- `contentType`
- `sizeBytes`

Optional JSON fields:

- `chunkSize`
- `epochs`

Returns:

- `uploadId`
- `chunkSize`
- `totalChunks`
- `epochs`
- `expiresAt`

### `PUT /v1/uploads/:uploadId/chunk/:index`

Upload one chunk for a session.

Required:

- multipart file field named `chunk`
- header `x-chunk-sha256`

Returns:

```json
{ "ok": true, "chunkIndex": 0 }
```

### `GET /v1/uploads/:uploadId/status`
Status responses may include finalize diagnostics when an upload is finalizing, failed, or completed after asynchronous finalize work. Important fields:

- `finalizeAttemptState`: `running`, `retryable_failure`, `terminal_failure`, or `completed`
- `finalizeAttempts`: current finalize attempt count
- `lastFinalizeRetryDelayMs`: next scheduled retry delay for retryable failures
- `failedReasonCode` and `failedRetryable`: terminal vs retryable failure details
- `finalizeWarning` and `finalizeWarningAt`: post-commit warning recorded after status already reached `completed`


Read upload state and received chunk indexes.

Response may include:

- `uploadId`
- `chunkSize`
- `totalChunks`
- `receivedChunks`
- `receivedChunkCount`
- `expiresAt`
- `status`
- `pollAfterMs` when finalizing
- `fileId` when completed
- `blobId` only when explicitly exposed
- `walrusEndEpoch` when available
- `error` when failed
- finalize diagnostics when applicable:
  - `finalizeAttemptState`: `running`, `retryable_failure`, `terminal_failure`, or `completed`
  - `finalizeAttempts`
  - `lastFinalizeRetryDelayMs`
  - `failedReasonCode` and `failedRetryable`
  - `finalizeWarning` and `finalizeWarningAt` for post-commit degraded follow-up work

### `POST /v1/uploads/:uploadId/complete`

Trigger finalize for an upload.

Possible responses:

- `200` with completed file data when already finalized
- `202` with:
  - `uploadId`
  - `status: "finalizing"`
  - `pollAfterMs`
  - `enqueued`
  - optional `inProgress`

Finalize is asynchronous. Clients should poll `GET /v1/uploads/:uploadId/status`.

### `DELETE /v1/uploads/:uploadId`

Cancel an upload session.

Behavior:

- idempotent for `canceled`, `failed`, and `expired` sessions
- returns `409` when finalize is in progress or the upload is already completed

## File Endpoints

### `GET /v1/files/:fileId/metadata`

Returns normalized file metadata:

- `fileId`
- `manifestVersion`
- `container`
- `sizeBytes`
- `mimeType`
- `owner`
- `createdAt`
- optional `walrusEndEpoch`
- optional `blobId`

Response headers also include:

- `x-floe-metadata-source`: `memory`, `postgres`, or `sui`
- `x-floe-postgres-state`: `healthy`, `degraded`, or `disabled`

### `GET /v1/files/:fileId/manifest`

Returns the current read contract for the file:

- `fileId`
- `manifestVersion`
- `sizeBytes`
- `mimeType`
- `container`
- `layout.type = "walrus_single_blob"`
- `layout.segments[0]`

Response headers also include:

- `x-floe-metadata-source`
- `x-floe-postgres-state`

### `GET /v1/files/:fileId/stream`

Byte-range stream endpoint.

Behavior:

- supports single `Range` requests
- returns `200`, `206`, or `416`
- includes `Accept-Ranges: bytes`
- includes `ETag`
- includes `x-floe-metadata-source`
- includes `x-floe-postgres-state`

### `HEAD /v1/files/:fileId/stream`

Returns range-aware headers without streaming the body.

## Operational Endpoints

### `GET /health`

Returns service readiness and dependency checks for:

- Redis
- Postgres
- finalize queue state, including oldest queued age and thresholded warning when finalize is stalled
- a queue warning when finalize backlog is degraded by age threshold

### `GET /metrics`

Prometheus metrics endpoint.

Requirements:

- `FLOE_ENABLE_METRICS=1`
- `FLOE_METRICS_TOKEN` configured
- send either:
  - `x-metrics-token: <token>`
  - or `Authorization: Bearer <token>`

### `GET /ops/uploads/:uploadId`

Operator-only upload inspection endpoint.

Requirements:

- `FLOE_ENABLE_METRICS=1`
- `FLOE_METRICS_TOKEN` configured
- send either:
  - `x-metrics-token: <token>`
  - or `Authorization: Bearer <token>`

Returns:

- dependency health for Redis and Postgres
- upload `session` when present
- upload `meta` when present
- received chunk count
- finalize pending state, active lock state, and lock TTL

Optional query flags:

- `includeReceivedIndexes=1` to include the full received chunk index list

## Blob ID Exposure

By default, `blobId` is hidden from upload and file responses.

Expose it only when needed:

- query flag: `?includeBlobId=1`
- server env: `FLOE_EXPOSE_BLOB_ID=1`

## Request Tiers And Limits

Default public tier:

- `upload_control`: `5` / `60s`
- `upload_chunk`: `30` / `60s`
- `file_meta_read`: `240` / `60s`
- `file_stream_read`: `120` / `60s`
- max upload size: `100MB`

Default authenticated API key tier:

- `upload_control`: `120` / `60s`
- `upload_chunk`: `1200` / `60s`
- `file_meta_read`: `2400` / `60s`
- `file_stream_read`: `1200` / `60s`
- max upload size: `15GB`

These limits are configured in `apps/api/src/config/auth.config.ts`.

## Auth Model

Floe supports three deployment modes:

- `public`
- `hybrid`
- `private`

Current verified auth method:

- `x-api-key: <secret>`
- `Authorization: Bearer <secret>`

Mode behavior:

- `public`: upload and file routes can be used without auth, subject to public rate limits
- `hybrid`: upload actions require a verified API key; file reads can remain public
- `private`: upload and file routes require a verified API key

Verified API keys are configured through `FLOE_API_KEYS_JSON`. Each key can carry:

- `id`
- `owner`
- `tier`
- `scopes`

## Error Format

All API errors use this envelope:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message",
    "retryable": false
  }
}
```

Common error codes include:

- `INVALID_*`
- `UPLOAD_NOT_FOUND`
- `UPLOAD_INCOMPLETE`
- `UPLOAD_FINALIZATION_IN_PROGRESS`
- `UPLOAD_CAPACITY_REACHED`
- `FINALIZE_QUEUE_BACKPRESSURE`
- `DEPENDENCY_UNAVAILABLE`
- `RATE_LIMITED`
- `AUTH_REQUIRED`
- `OWNER_MISMATCH`
- `FILE_BLOB_UNAVAILABLE`
- `SUI_UNAVAILABLE`

## Upload Lifecycle

States currently used:

- `uploading`
- `finalizing`
- `completed`
- `failed`
- `canceled`
- `expired`

Lifecycle behavior:

- `complete` is idempotent
- `cancel` is idempotent for terminal non-complete states
- `status` always returns deterministic chunk ordering

## Response Headers

All responses include:

- `x-request-id`

Rate-limited endpoints also include:

- `x-ratelimit-limit`
- `x-ratelimit-remaining`
- `x-ratelimit-window`
- `retry-after` when applicable
