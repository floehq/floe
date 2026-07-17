# Latency Round 2+3: Chunk Upload & Redis Optimization

## Overview
Reduce latency in the chunk upload path (R2) and Redis round trips (R3) with test-first implementation.

## Global Constraints
- Run tests from `apps/api/` via `npm test`
- Test runner: `npx tsx --test` (NOT vitest)
- Do NOT touch `apps/api/src/services/auth/*.ts` existing timing-safe comparison logic
- Each task gets its own commit
- Write or extend tests FIRST for each change

---

## Round 2: S3 & Finalize Path

### Task 1: S3 writeChunk HeadObject Deferral
**Files:** `apps/api/src/store/s3.ts`, `apps/api/test/s3.store.test.ts`

Write test for S3 writeChunk confirming:
- HeadObjectCommand NOT called on fresh write
- HeadObjectCommand IS called on 412 (precondition failed)

Modify `S3ChunkStore.writeChunk()` to:
- Remove upfront HeadObjectCommand
- Catch 412 from PutObjectCommand
- On 412, issue HeadObjectCommand then retry PutObjectCommand

### Task 2: Finalize remove redis.scard
**Files:** `apps/api/src/services/uploads/finalize.service.ts`, `apps/api/test/finalize.integration.test.ts`

Write test confirming finalize does NOT call redis.scard.
Remove the `redis.scard(key)` call and the associated metrics/gauge.

### Task 3: Finalize parallelize checksum writes
**Files:** `apps/api/src/services/uploads/finalize.service.ts`, `apps/api/test/finalize.integration.test.ts`

Write test verifying checksum writes happen concurrently (all promises start before any resolves).
Replace sequential `for` loop with `Promise.all()`.

### Task 4: Finalize parallelize upsertIndexedFile + upsertBlobObjectMapping
**Files:** `apps/api/src/services/uploads/finalize.service.ts`, `apps/api/test/finalize.integration.test.ts`

Write test verifying both DB calls happen concurrently.
Replace sequential calls with `Promise.all()`.

---

## Round 3: Redis Round Trips

### Task 5: touchUploadActivity Lua SADD fusion
**Files:** `apps/api/src/services/uploads/upload-state.ts`, `apps/api/test/upload-state.test.ts` (new)

Write test verifying touchUploadActivity uses single Lua script for SADD + EXPIRE.
Fuse `redis.sadd()` + `redis.expire()` into single `redis.eval()` Lua call.

### Task 6: chunk handler remove standalone sadd
**Files:** `apps/api/src/routes/uploads.ts`, `apps/api/test/chunk-upload.test.ts` (new)

Write test verifying chunk handler does NOT call redis.sadd standalone.
Remove standalone `redis.sadd()` from chunk upload handler (touchUploadActivity already does SADD).

### Task 7: resolveReusableWalrusBlob parallelize epoch fetch
**Files:** `apps/api/src/services/walrus/blob.js`, `apps/api/test/walrus-blob.test.ts` (new)

Write test verifying epoch and blob state are fetched concurrently.
Replace sequential `await getCurrentWalrusEpoch()` + `await getWalrusBlobState()` with `Promise.all()`.

---

## Task 8: Benchmark & Docs
**Files:** `scripts/stream-bench.mjs`, `docs/OPERATIONS.md`

Run `stream-bench.mjs` and document before/after results.
Update `docs/OPERATIONS.md` with benchmark section.
