# Floe SDK

`@floehq/sdk` is the official TypeScript SDK for the Floe HTTP API.

It provides:

- typed upload and file API methods
- typed deployment health checks
- typed server version and compatibility checks
- retry-aware request handling
- resumable upload helpers
- browser and Node-compatible uploads
- Node `uploadFile(path)` support
- Node `downloadFileToPath(path)` support
- lifecycle and progress callbacks for upload UX
- typed idempotency support for create, complete, and cancel flows
- typed upload debug flags for `blobId` and Walrus diagnostics when exposed by the server

## Install

```bash
npm install @floehq/sdk
```

## Basic Usage

```ts
import { FloeClient } from "@floehq/sdk";

const floe = new FloeClient({
  baseUrl: "http://127.0.0.1:3001/v1",
  auth: {
    apiKey: process.env.FLOE_API_KEY,
  },
});

const result = await floe.uploadBytes(new TextEncoder().encode("hello"), {
  filename: "hello.txt",
  contentType: "text/plain",
});

console.log(result.fileId);
```

## Node File Uploads

```ts
import { FloeClient } from "@floehq/sdk";

const floe = new FloeClient({
  baseUrl: "http://127.0.0.1:3001/v1",
  auth: {
    apiKey: process.env.FLOE_API_KEY,
  },
});

const result = await floe.uploadFile("./video.mp4", {
  includeBlobId: true,
  includeWalrusDebug: true,
  idempotencyKey: "upload-video-1",
  onStageChange(event) {
    console.log("stage", event.stage, event.uploadId ?? "");
  },
  onProgress(event) {
    console.log("uploaded", event.uploadedBytes, "of", event.totalBytes);
  },
});

console.log(result.fileId, result.blobId, result.walrusDebug);
```

## Stream Introspection And Node Downloads

```ts
import { FloeClient, SDK_VERSION } from "@floehq/sdk";

const floe = new FloeClient({
  baseUrl: "http://127.0.0.1:3001/v1",
});

console.log("sdk", SDK_VERSION, FloeClient.VERSION);

const head = await floe.headFileStream("0xfileid", { rangeStart: 0, rangeEnd: 1023 });
console.log(head.status, head.contentLength, head.contentRange, head.acceptRanges, head.etag);

const saved = await floe.downloadFileToPath("0xfileid", "./downloads/video.mp4", {
  overwrite: false,
});
console.log(saved.path, saved.bytesWritten);
```

When `overwrite` is `false`, `downloadFileToPath()` throws a `FloeError` instead of silently replacing an existing file.

## Health Checks

```ts
import { FloeClient } from "@floehq/sdk";

const floe = new FloeClient({
  baseUrl: "http://127.0.0.1:3001/v1",
});

const health = await floe.getHealth();
console.log(health.httpStatus, health.apiVersion, health.serverVersion, health.status, health.ready);
```

## Version And Compatibility

```ts
import { FloeClient } from "@floehq/sdk";

const floe = new FloeClient({
  baseUrl: "http://127.0.0.1:3001/v1",
  compatibilityCheck: "warn",
});

const version = await floe.getVersion();
console.log(version.apiVersion, version.serverVersion, version.compatibility.cli);

const compatibility = await floe.checkCompatibility();
console.log(compatibility.compatible, compatibility.supportedRange, compatibility.reason ?? "");
```

## Auth And Request Controls

```ts
import { FloeClient } from "@floehq/sdk";

const floe = new FloeClient({
  baseUrl: "http://127.0.0.1:3001/v1",
  auth: {
    bearerToken: process.env.FLOE_BEARER_TOKEN,
  },
});

const status = await floe.getUploadStatus("upload_123", {
  includeBlobId: true,
  includeWalrusDebug: true,
});

const canceled = await floe.cancelUpload("upload_123", {
  idempotencyKey: "cancel-upload-123",
});

console.log(status.blobId, status.walrusDebug, canceled.status);
```

Notes:

- `auth.apiKey` sends `x-api-key`
- `auth.bearerToken` sends `Authorization: Bearer <token>`
- if both are configured, Floe core evaluates `Authorization` first
- `idempotencyKey` maps to the `Idempotency-Key` request header
- `includeWalrusDebug` maps to the upload `debug=1` query flag

## Design Notes

- The SDK wraps the current Floe API contract instead of inventing a parallel abstraction.
- `uploadBlob()`, `uploadBytes()`, and `uploadFile()` are the main high-level helpers.
- CLI tooling should be built on top of this package rather than reimplementing transport logic.
