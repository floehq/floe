import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FloeApiError, FloeClient, SDK_VERSION } from "../dist/index.js";

test("client sends normalized auth headers and surfaces request ids", async () => {
  let seenHeaders;

  const client = new FloeClient({
    baseUrl: "http://example.test/v1",
    auth: {
      apiKey: "api_test",
      bearerToken: "bearer_test",
      authUser: "tester",
      walletAddress: "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
      ownerAddress: "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
    },
    fetch: async (_url, init) => {
      seenHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          error: {
            code: "FORCED_FAILURE",
            message: "forced",
            retryable: true,
            details: { why: "test" },
          },
        }),
        {
          status: 503,
          headers: {
            "content-type": "application/json",
            "x-request-id": "req_123",
          },
        }
      );
    },
  });

  await assert.rejects(
    () => client.getFileMetadata("file_1"),
    (error) => {
      assert.ok(error instanceof FloeApiError);
      assert.equal(error.status, 503);
      assert.equal(error.code, "FORCED_FAILURE");
      assert.equal(error.requestId, "req_123");
      assert.equal(error.retryable, true);
      return true;
    }
  );

  assert.equal(seenHeaders.get("x-api-key"), "api_test");
  assert.equal(seenHeaders.get("authorization"), "Bearer bearer_test");
  assert.equal(seenHeaders.get("x-auth-user"), "tester");
  assert.equal(
    seenHeaders.get("x-wallet-address"),
    "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
  );
  assert.equal(
    seenHeaders.get("x-owner-address"),
    "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
  );
});

test("uploadFile infers filename, content type, and emits lifecycle stages", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "floe-sdk-upload-"));
  const filePath = path.join(tmpDir, "sample.txt");
  await fs.writeFile(filePath, "hello sdk");

  const seen = {
    createBody: null,
    chunkCount: 0,
    finalizeCalls: 0,
  };
  const stages = [];
  const progress = [];
  let statusCalls = 0;

  const client = new FloeClient({
    baseUrl: "http://example.test/v1",
    fetch: async (url, init) => {
      const href = typeof url === "string" ? url : url.toString();
      const parsed = new URL(href);

      if (parsed.pathname === "/v1/uploads/create" && init?.method === "POST") {
        seen.createBody = JSON.parse(init.body);
        return Response.json({
          uploadId: "upload_1",
          chunkSize: 4,
          totalChunks: 3,
          epochs: 1,
          expiresAt: Date.now() + 60_000,
        });
      }

      if (parsed.pathname === "/v1/uploads/upload_1/status" && init?.method === "GET") {
        statusCalls += 1;
        if (statusCalls === 1) {
          return Response.json({
            uploadId: "upload_1",
            chunkSize: 4,
            totalChunks: 3,
            receivedChunks: [],
            receivedChunkCount: 0,
            expiresAt: Date.now() + 60_000,
            status: "pending",
          });
        }

        if (statusCalls === 2) {
          return Response.json({
            uploadId: "upload_1",
            chunkSize: 4,
            totalChunks: 3,
            receivedChunks: [0, 1, 2],
            receivedChunkCount: 3,
            expiresAt: Date.now() + 60_000,
            status: "finalizing",
            pollAfterMs: 1,
          });
        }

        return Response.json({
          uploadId: "upload_1",
          chunkSize: 4,
          totalChunks: 3,
          receivedChunks: [0, 1, 2],
          receivedChunkCount: 3,
          expiresAt: Date.now() + 60_000,
          status: "completed",
          fileId: "file_1",
          blobId: "blob_1",
        });
      }

      if (parsed.pathname.startsWith("/v1/uploads/upload_1/chunk/") && init?.method === "PUT") {
        seen.chunkCount += 1;
        return Response.json({ ok: true, chunkIndex: seen.chunkCount - 1 });
      }

      if (parsed.pathname === "/v1/uploads/upload_1/complete" && init?.method === "POST") {
        seen.finalizeCalls += 1;
        return Response.json({
          uploadId: "upload_1",
          status: "finalizing",
          pollAfterMs: 1,
        });
      }

      if (parsed.pathname === "/v1/files/file_1/metadata" && init?.method === "GET") {
        return Response.json({
          fileId: "file_1",
          manifestVersion: 1,
          container: null,
          sizeBytes: 9,
          mimeType: "text/plain",
          owner: null,
          createdAt: Date.now(),
        });
      }

      throw new Error(`Unexpected request: ${init?.method} ${href}`);
    },
  });

  const result = await client.uploadFile(filePath, {
    includeBlobId: true,
    finalizePollIntervalMs: 1,
    onStageChange(event) {
      stages.push(event.stage);
    },
    onProgress(event) {
      progress.push(event.uploadedBytes);
    },
  });

  assert.deepEqual(seen.createBody, {
    filename: "sample.txt",
    contentType: "text/plain",
    sizeBytes: 9,
  });
  assert.equal(seen.chunkCount, 3);
  assert.equal(seen.finalizeCalls, 1);
  assert.equal(result.fileId, "file_1");
  assert.equal(result.blobId, "blob_1");
  assert.ok(stages.includes("creating_upload"));
  assert.ok(stages.includes("uploading_chunks"));
  assert.ok(stages.includes("finalizing"));
  assert.ok(stages.includes("polling_finalize"));
  assert.ok(stages.includes("completed"));
  assert.equal(progress.at(-1), 9);
});

test("getHealth returns a typed payload for degraded or down responses", async () => {
  let seenUrl = null;

  const client = new FloeClient({
    baseUrl: "http://example.test/nested/v1",
    fetch: async (url) => {
      seenUrl = typeof url === "string" ? url : url.toString();
      return Response.json(
        {
          apiVersion: "v1",
          serverVersion: "0.1.0",
          compatibility: {
            sdk: ">=0.2.0 <0.3.0",
            cli: ">=0.2.0 <0.3.0",
          },
          role: "full",
          capabilities: {
            uploads: true,
            files: true,
            ops: true,
            finalizeWorker: true,
          },
          walrus: {
            readers: {
              primary: "https://walrus-reader.test",
              fallbacks: [],
              count: 1,
            },
            writers: {
              mode: "publisher",
              primary: "https://walrus-writer.test",
              fallbacks: [],
              count: 1,
            },
          },
          status: "DOWN",
          service: "floe-api-v1",
          ready: false,
          degraded: false,
          timestamp: new Date().toISOString(),
          checks: {
            redis: {
              ok: false,
              latencyMs: null,
              status: "unavailable",
              timestamp: new Date().toISOString(),
            },
            postgres: {
              configured: false,
              enabled: false,
              required: false,
              ok: null,
              latencyMs: null,
              status: "disabled",
            },
            finalizeQueue: {
              depth: null,
              pendingUnique: null,
              activeLocal: null,
              concurrency: null,
              oldestQueuedAt: null,
              oldestQueuedAgeMs: null,
            },
            finalizeQueueWarning: null,
          },
        },
        { status: 503 }
      );
    },
  });

  const health = await client.getHealth();

  assert.equal(seenUrl, "http://example.test/nested/health");
  assert.equal(health.httpStatus, 503);
  assert.equal(health.apiVersion, "v1");
  assert.equal(health.serverVersion, "0.1.0");
  assert.equal(health.compatibility.sdk, ">=0.2.0 <0.3.0");
  assert.equal(health.status, "DOWN");
  assert.equal(health.ready, false);
  assert.equal(health.walrus.writers.mode, "publisher");
});

test("getVersion and checkCompatibility expose typed server compatibility", async () => {
  const client = new FloeClient({
    baseUrl: "http://example.test/v1",
    fetch: async (url) => {
      const href = typeof url === "string" ? url : url.toString();
      const parsed = new URL(href);

      if (parsed.pathname === "/version") {
        return Response.json({
          service: "floe-api-v1",
          apiVersion: "v1",
          serverVersion: "0.1.0",
          compatibility: {
            sdk: ">=0.2.0 <0.3.0",
            cli: ">=0.2.0 <0.3.0",
          },
        });
      }

      throw new Error(`Unexpected request: ${href}`);
    },
  });

  const version = await client.getVersion();
  const sdkCompatibility = await client.checkCompatibility({ versionInfo: version });
  const cliCompatibility = await client.checkCompatibility({
    client: "cli",
    currentVersion: "0.1.0",
    versionInfo: version,
  });

  assert.equal(version.service, "floe-api-v1");
  assert.equal(version.serverVersion, "0.1.0");
  assert.equal(sdkCompatibility.compatible, true);
  assert.equal(sdkCompatibility.supportedRange, ">=0.2.0 <0.3.0");
  assert.equal(cliCompatibility.compatible, false);
  assert.equal(cliCompatibility.reason, "outside_supported_range");
});

test("SDK exports a stable diagnostic version constant", () => {
  assert.equal(SDK_VERSION, "0.2.3");
  assert.equal(FloeClient.VERSION, SDK_VERSION);
});

test("compatibilityCheck warn mode logs one warning for incompatible servers", async () => {
  let versionCalls = 0;
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => {
    warnings.push(String(message));
  };

  try {
    const client = new FloeClient({
      baseUrl: "http://example.test/v1",
      compatibilityCheck: "warn",
      fetch: async (url, init) => {
        const href = typeof url === "string" ? url : url.toString();
        const parsed = new URL(href);

        if (parsed.pathname === "/version") {
          versionCalls += 1;
          return Response.json({
            service: "floe-api-v1",
            apiVersion: "v1",
            serverVersion: "0.1.0",
            compatibility: {
              sdk: ">=0.3.0 <0.4.0",
              cli: ">=0.3.0 <0.4.0",
            },
          });
        }

        if (parsed.pathname === "/v1/files/file_1/metadata" && init?.method === "GET") {
          return Response.json({
            fileId: "file_1",
            manifestVersion: 1,
            container: null,
            sizeBytes: 1,
            mimeType: "text/plain",
            owner: null,
            createdAt: Date.now(),
          });
        }

        throw new Error(`Unexpected request: ${init?.method} ${href}`);
      },
    });

    await client.getFileMetadata("file_1");
    await client.getFileMetadata("file_1");

    assert.equal(versionCalls, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /not within floe-api-v1 0.1.0 supported range/);
  } finally {
    console.warn = originalWarn;
  }
});

test("headFileStream and downloadFileToPath expose stream metadata and write bytes", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "floe-sdk-download-"));
  const outPath = path.join(tmpDir, "nested", "video.bin");
  const bytes = new TextEncoder().encode("hello world");
  const ranges = [];

  const client = new FloeClient({
    baseUrl: "http://example.test/v1",
    fetch: async (url, init) => {
      const href = typeof url === "string" ? url : url.toString();
      const parsed = new URL(href);
      ranges.push(new Headers(init?.headers).get("range"));

      if (parsed.pathname === "/v1/files/file_1/stream" && init?.method === "HEAD") {
        return new Response(null, {
          status: 206,
          headers: {
            "content-type": "video/mp4",
            "content-length": String(bytes.byteLength),
            "content-range": `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
            "accept-ranges": "bytes",
            etag: "blob_123",
            "x-floe-metadata-source": "postgres",
            "x-floe-postgres-state": "healthy",
          },
        });
      }

      if (parsed.pathname === "/v1/files/file_1/stream" && init?.method === "GET") {
        return new Response(bytes, {
          status: 200,
          headers: {
            "content-type": "video/mp4",
            "content-length": String(bytes.byteLength),
            "accept-ranges": "bytes",
            etag: "blob_123",
            "x-floe-metadata-source": "postgres",
            "x-floe-postgres-state": "healthy",
          },
        });
      }

      throw new Error(`Unexpected request: ${init?.method} ${href}`);
    },
  });

  const head = await client.headFileStream("file_1", {
    rangeStart: 0,
    rangeEnd: bytes.byteLength - 1,
  });
  const download = await client.downloadFileToPath("file_1", outPath);
  const written = await fs.readFile(outPath, "utf8");

  assert.equal(head.status, 206);
  assert.equal(head.contentRange, `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`);
  assert.equal(head.etag, "blob_123");
  assert.equal(head.metadataSource, "postgres");
  assert.equal(download.status, 200);
  assert.equal(download.bytesWritten, bytes.byteLength);
  assert.equal(download.path, outPath);
  assert.equal(download.contentType, "video/mp4");
  assert.equal(written, "hello world");
  assert.deepEqual(ranges, [`bytes=0-${bytes.byteLength - 1}`, null]);
});

test("downloadFileToPath refuses to overwrite an existing file when overwrite is false", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "floe-sdk-download-overwrite-"));
  const outPath = path.join(tmpDir, "video.bin");
  await fs.writeFile(outPath, "existing");

  const client = new FloeClient({
    baseUrl: "http://example.test/v1",
    fetch: async (url, init) => {
      const href = typeof url === "string" ? url : url.toString();
      const parsed = new URL(href);

      if (parsed.pathname === "/v1/files/file_1/stream" && init?.method === "GET") {
        return new Response(new TextEncoder().encode("hello"), {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": "5",
          },
        });
      }

      throw new Error(`Unexpected request: ${init?.method} ${href}`);
    },
  });

  await assert.rejects(
    () => client.downloadFileToPath("file_1", outPath, { overwrite: false }),
    (error) => {
      assert.match(String(error instanceof Error ? error.message : error), /Refusing to overwrite existing file/);
      return true;
    }
  );

  assert.equal(await fs.readFile(outPath, "utf8"), "existing");
});
