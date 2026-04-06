# Floe SDK

`@floehq/sdk` is the official TypeScript SDK for the Floe HTTP API.

It provides:

- typed upload and file API methods
- typed deployment health checks
- retry-aware request handling
- resumable upload helpers
- browser and Node-compatible uploads
- Node `uploadFile(path)` support
- Node `downloadFileToPath(path)` support
- lifecycle and progress callbacks for upload UX

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
  onStageChange(event) {
    console.log("stage", event.stage, event.uploadId ?? "");
  },
  onProgress(event) {
    console.log("uploaded", event.uploadedBytes, "of", event.totalBytes);
  },
});

console.log(result.fileId, result.blobId);
```

## Stream Introspection And Node Downloads

```ts
import { FloeClient } from "@floehq/sdk";

const floe = new FloeClient({
  baseUrl: "http://127.0.0.1:3001/v1",
});

const head = await floe.headFileStream("0xfileid", { rangeStart: 0, rangeEnd: 1023 });
console.log(head.status, head.contentRange, head.etag);

const saved = await floe.downloadFileToPath("0xfileid", "./downloads/video.mp4");
console.log(saved.path, saved.bytesWritten);
```

## Health Checks

```ts
import { FloeClient } from "@floehq/sdk";

const floe = new FloeClient({
  baseUrl: "http://127.0.0.1:3001/v1",
});

const health = await floe.getHealth();
console.log(health.httpStatus, health.status, health.ready);
```

## Design Notes

- The SDK wraps the current Floe API contract instead of inventing a parallel abstraction.
- `uploadBlob()`, `uploadBytes()`, and `uploadFile()` are the main high-level helpers.
- CLI tooling should be built on top of this package rather than reimplementing transport logic.
