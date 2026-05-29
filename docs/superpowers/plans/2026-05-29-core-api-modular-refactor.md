# Core API Modular Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the core API into thin route handlers plus dedicated upload, finalize, file-read, and stream-cache services so the core path is easier to reason about and debug.

**Architecture:** Keep the public HTTP contract stable while moving behavior into focused service modules. Route files become adapters, upload state becomes a canonical session/state machine, finalize becomes a separate pipeline service, file lookup/normalization becomes a read-model service, and stream cache policy becomes a small helper used by the existing cache implementation.

**Tech Stack:** TypeScript, Fastify, Redis, PostgreSQL, Walrus streaming/cache helpers, node:test.

---

### Task 1: Extract upload state service

**Files:**
- Create: `apps/api/src/services/uploads/upload-state.ts`
- Modify: `apps/api/src/services/uploads/session.ts`
- Modify: `apps/api/src/routes/uploads.ts`
- Test: `apps/api/test/upload.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("upload state transitions stay canonical across create, touch, and get", async () => {
  const session = await createSession({
    uploadId: "00000000-0000-0000-0000-000000000001",
    filename: "clip.mp4",
    contentType: "video/mp4",
    sizeBytes: 8,
    chunkSize: 4,
    totalChunks: 2,
    epochs: 1,
  });

  assert.equal(session.status, "uploading");
  assert.equal(await touchUploadActivity({ uploadId: session.uploadId, chunkIndex: 0 }), true);
  const loaded = await getSession(session.uploadId);
  assert.equal(loaded?.status, "uploading");
  assert.equal(loaded?.receivedChunks.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix apps/api test -- upload.integration.test.ts`
Expected: pass only after the upload-state extraction is wired in.

- [ ] **Step 3: Write minimal implementation**

```ts
export async function createSession(input: CreateSessionInput): Promise<UploadSession> {
  return createUploadState(input);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix apps/api test -- upload.integration.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/uploads/upload-state.ts apps/api/src/services/uploads/session.ts apps/api/src/routes/uploads.ts apps/api/test/upload.integration.test.ts
git commit -m "refactor: extract canonical upload state service"
```

### Task 2: Extract file read-model service

**Files:**
- Create: `apps/api/src/services/files/file.read-model.ts`
- Modify: `apps/api/src/routes/files.ts`
- Test: `apps/api/test/files.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("metadata and manifest share the same normalized read model", async () => {
  const app = await createRouteApp();
  const fileId = "0x1111111111111111111111111111111111111111111111111111111111111111";
  const metadataRes = await app.inject({ method: "GET", url: `/v1/files/${fileId}/metadata`, routePath: "/v1/files/:fileId/metadata", params: { fileId } });
  const manifestRes = await app.inject({ method: "GET", url: `/v1/files/${fileId}/manifest`, routePath: "/v1/files/:fileId/manifest", params: { fileId } });
  assert.equal(metadataRes.statusCode, 200);
  assert.equal(manifestRes.statusCode, 200);
  assert.equal(metadataRes.json().fileId, manifestRes.json().fileId);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix apps/api test -- files.integration.test.ts`
Expected: route handlers still contain duplicate lookup logic until the read-model service is used everywhere.

- [ ] **Step 3: Write minimal implementation**

```ts
export async function resolveFileReadModel(fileId: string): Promise<ResolvedFileReadModel> {
  return normalizeResolvedFile(await getFileFieldsCached(fileId));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix apps/api test -- files.integration.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/files/file.read-model.ts apps/api/src/routes/files.ts apps/api/test/files.integration.test.ts
git commit -m "refactor: extract file read model service"
```

### Task 3: Extract stream cache policy helper

**Files:**
- Create: `apps/api/src/services/stream/stream.cache.policy.ts`
- Modify: `apps/api/src/services/stream/stream.cache.ts`
- Test: `apps/api/test/files.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("stream cache uses stable keying and invalidates truncated files", async () => {
  assert.equal(shouldCacheFullObject(8 * 1024 * 1024), true);
  assert.equal(shouldCacheFullObject(64 * 1024 * 1024), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix apps/api test -- files.integration.test.ts`
Expected: helper missing until the policy module is extracted.

- [ ] **Step 3: Write minimal implementation**

```ts
export function shouldCacheFullObject(sizeBytes: number): boolean {
  return Number.isFinite(sizeBytes) && sizeBytes > 0 && sizeBytes <= WalrusReadLimits.inlineFullObjectMaxBytes;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix apps/api test -- files.integration.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/stream/stream.cache.policy.ts apps/api/src/services/stream/stream.cache.ts apps/api/test/files.integration.test.ts
git commit -m "refactor: extract stream cache policy"
```

### Task 4: Extract finalize service

**Files:**
- Create: `apps/api/src/services/uploads/finalize.service.ts`
- Modify: `apps/api/src/services/uploads/finalize.ts`
- Modify: `apps/api/src/services/uploads/finalize.queue.ts`
- Test: `apps/api/test/finalize.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("finalize service preserves upload state and returns canonical file result", async () => {
  const session = await createSession({
    uploadId: "00000000-0000-0000-0000-000000000002",
    filename: "clip.mp4",
    contentType: "video/mp4",
    sizeBytes: 8,
    chunkSize: 4,
    totalChunks: 2,
    epochs: 1,
  });
  const result = await finalizeUpload(session);
  assert.equal(result.status, "ready");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix apps/api test -- finalize.integration.test.ts`
Expected: finalize still coupled to route and queue internals until the service is extracted.

- [ ] **Step 3: Write minimal implementation**

```ts
export async function finalizeUpload(session: InternalSession, context: FinalizeContext = {}) {
  return finalizeUploadCore(session, context);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix apps/api test -- finalize.integration.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/uploads/finalize.service.ts apps/api/src/services/uploads/finalize.ts apps/api/src/services/uploads/finalize.queue.ts apps/api/test/finalize.integration.test.ts
git commit -m "refactor: extract finalize pipeline service"
```

### Task 5: Run build and full API tests

**Files:**
- Verify: `apps/api/src/**`
- Verify: `apps/api/test/**`

- [ ] **Step 1: Run the build**

Run: `npm --prefix apps/api run build`
Expected: exit code 0

- [ ] **Step 2: Run the API test suite**

Run: `npm --prefix apps/api test`
Expected: exit code 0

- [ ] **Step 3: Commit the final refactor**

```bash
git add apps/api/src docs/superpowers/plans/2026-05-29-core-api-modular-refactor.md
git commit -m "refactor: split core api into focused services"
```
