import test from "node:test";
import assert from "node:assert/strict";

import {
  applyFinalizeRecoveryPassToQueueState,
  assessFinalizeQueueHealth,
  buildCompletedFinalizeResult,
  buildFinalizeDiagnostics,
  buildFinalizeFollowupWarningMeta,
  buildFinalizeLockRetryMeta,
  buildRetryableFinalizeFailureMeta,
  classifyFinalizeJobFailure,
  classifyFinalizeRecoveryAction,
  cleanupFinalizeQueueState,
  computeFinalizeRetryDelayMs,
  decideFinalizeWorkerFailureAction,
  enqueueFinalizeQueueState,
  reserveFinalizeActiveLocal,
  executeFinalizeLockRetry,
  executeFinalizeRecoveryPlan,
  executeFinalizeWorkerFailureAction,
  executeRetryableFinalizeFailure,
  normalizeFinalizeFailure,
  planFinalizeRecoveryPass,
  shapeFinalizeQueueStats,
  shouldPersistFinalizeFailure,
  shouldRetryFinalizeFailure,
} from "../src/services/uploads/finalize.shared.ts";

test("buildFinalizeDiagnostics shapes finalize metadata into stable API fields", () => {
  const diagnostics = buildFinalizeDiagnostics({
    finalizeStage: "walrus_publish",
    finalizeAttemptState: "retryable_failure",
    finalizeLastSuccessfulStage: "verify_chunks",
    failedStage: "walrus_publish",
    failedReasonCode: "walrus_unavailable",
    failedRetryable: "1",
    finalizeAttempts: "3",
    finalizeQueueWaitMs: "250",
    finalizeVerifyMs: "15",
    finalizeWalrusMs: "820",
    finalizeSuiMs: "not-a-number",
    finalizeRedisMs: "11",
    finalizeCleanupMs: "7",
    finalizeTotalMs: "1103",
    finalizeStageStartedAt: "1711111111111",
    finalizeLastProgressAt: "1711111111222",
    finalizingQueuedAt: "1711111111000",
    lastFinalizeAttemptAt: "1711111111001",
    lastFinalizeRetryAt: "1711111111333",
    lastFinalizeRetryDelayMs: "2000",
  });

  assert.deepEqual(diagnostics, {
    finalizeStage: "walrus_publish",
    finalizeAttemptState: "retryable_failure",
    finalizeLastSuccessfulStage: "verify_chunks",
    failedStage: "walrus_publish",
    failedReasonCode: "walrus_unavailable",
    failedRetryable: true,
    finalizeAttempts: 3,
    finalizeQueueWaitMs: 250,
    finalizeVerifyMs: 15,
    finalizeWalrusMs: 820,
    finalizeRedisMs: 11,
    finalizeCleanupMs: 7,
    finalizeTotalMs: 1103,
    finalizeStageStartedAt: 1711111111111,
    finalizeLastProgressAt: 1711111111222,
    finalizingQueuedAt: 1711111111000,
    lastFinalizeAttemptAt: 1711111111001,
    lastFinalizeRetryAt: 1711111111333,
    lastFinalizeRetryDelayMs: 2000,
  });
});

test("normalizeFinalizeFailure preserves retryability and reason codes", () => {
  assert.deepEqual(normalizeFinalizeFailure(new Error("UPLOAD_FINALIZATION_IN_PROGRESS")), {
    reasonCode: "lock_in_progress",
    retryable: true,
  });
  assert.deepEqual(normalizeFinalizeFailure(new Error("UPLOAD_FINALIZATION_LOCK_LOST")), {
    reasonCode: "lock_lost",
    retryable: true,
  });
  assert.deepEqual(normalizeFinalizeFailure(new Error("walrus upload failed: WALRUS_UPLOAD_FAILED upstream 503")), {
    reasonCode: "walrus_upload_failed",
    retryable: true,
  });
  assert.deepEqual(normalizeFinalizeFailure(new Error("walrus_unknown: read timed out")), {
    reasonCode: "walrus_unknown",
    retryable: true,
  });
  assert.deepEqual(normalizeFinalizeFailure(new Error("SUI_FILE_CREATE_FAILED")), {
    reasonCode: "sui_file_create_failed",
    retryable: false,
  });
  assert.deepEqual(normalizeFinalizeFailure(new Error("REDIS timeout")), {
    reasonCode: "redis_failure",
    retryable: true,
  });
  assert.deepEqual(normalizeFinalizeFailure(new Error("CORRUPT_COMPLETED_UPLOAD")), {
    reasonCode: "corrupt_completed_upload",
    retryable: false,
  });
  assert.deepEqual(normalizeFinalizeFailure(new Error("something odd happened")), {
    reasonCode: "finalize_failed",
    retryable: false,
  });
});

test("classifyFinalizeJobFailure keeps stage context for retries and failures", () => {
  const timeout = new Error("UPLOAD_FINALIZE_TIMEOUT");
  (timeout as Error & { finalizeStage?: string }).finalizeStage = "walrus_publish";
  assert.deepEqual(classifyFinalizeJobFailure(timeout), {
    reason: "timeout",
    retryable: true,
    stage: "walrus_publish",
  });

  const missing = new Error("MISSING_CHUNKS");
  (missing as Error & { finalizeStage?: string }).finalizeStage = "verify_chunks";
  assert.deepEqual(classifyFinalizeJobFailure(missing), {
    reason: "missing_chunks",
    retryable: false,
    stage: "verify_chunks",
  });
});


test("shapeFinalizeQueueStats exposes oldest queued age for operators", () => {
  assert.deepEqual(
    shapeFinalizeQueueStats({
      depth: "5",
      pendingUnique: "3",
      activeLocal: 2,
      concurrency: 4,
      oldestQueuedAt: "1000",
      nowMs: 2500,
    }),
    {
      depth: 5,
      pendingUnique: 3,
      activeLocal: 2,
      concurrency: 4,
      oldestQueuedAt: 1000,
      oldestQueuedAgeMs: 1500,
    }
  );

  assert.deepEqual(
    shapeFinalizeQueueStats({
      depth: null,
      pendingUnique: undefined,
      activeLocal: 0,
      concurrency: 4,
      oldestQueuedAt: null,
      nowMs: 2500,
    }),
    {
      depth: 0,
      pendingUnique: 0,
      activeLocal: 0,
      concurrency: 4,
      oldestQueuedAt: null,
      oldestQueuedAgeMs: null,
    }
  );
});


test("buildCompletedFinalizeResult preserves idempotent finalize output", () => {
  assert.deepEqual(
    buildCompletedFinalizeResult(
      {
        fileId: "0xfile",
        blobId: "blob-1",
        sizeBytes: "42",
        walrusEndEpoch: "99",
        finalizeTotalMs: "1200",
        finalizeVerifyMs: "10",
        finalizeWalrusMs: "800",
        finalizeSuiMs: "200",
        finalizeRedisMs: "100",
        finalizeCleanupMs: "90",
      },
      7
    ),
    {
      fileId: "0xfile",
      blobId: "blob-1",
      sizeBytes: 42,
      walrusEndEpoch: 99,
      status: "ready",
      finalize: {
        totalMs: 1200,
        stageDurationsMs: {
          verify_chunks: 10,
          walrus_publish: 800,
          sui_finalize: 200,
          redis_commit: 100,
          cleanup: 90,
        },
      },
    }
  );

  assert.throws(
    () => buildCompletedFinalizeResult({ status: "completed", blobId: "blob-1" }, 7),
    /CORRUPT_COMPLETED_UPLOAD/
  );
});

test("classifyFinalizeRecoveryAction only requeues finalizing uploads on restart", () => {
  assert.equal(classifyFinalizeRecoveryAction("finalizing"), "requeue");
  assert.equal(classifyFinalizeRecoveryAction("completed"), "cleanup");
  assert.equal(classifyFinalizeRecoveryAction("failed"), "cleanup");
  assert.equal(classifyFinalizeRecoveryAction(undefined), "cleanup");
});


test("planFinalizeRecoveryPass batches restart recovery decisions across mixed upload states", () => {
  assert.deepEqual(
    planFinalizeRecoveryPass([
      { uploadId: "u1", status: "finalizing" },
      { uploadId: "u2", status: "completed" },
      { uploadId: "u3", status: "failed" },
      { uploadId: "u4", status: undefined },
      { uploadId: "u5", status: "finalizing" },
    ]),
    {
      requeueIds: ["u1", "u5"],
      cleanupIds: ["u2", "u3", "u4"],
      recovered: 2,
      cleaned: 3,
    }
  );
});


test("enqueueFinalizeQueueState suppresses duplicate enqueue but force requeue still re-adds", () => {
  const first = enqueueFinalizeQueueState({
    state: { queue: [], pendingIds: [], pendingSince: {} },
    uploadId: "u1",
    queuedAt: 100,
  });
  assert.equal(first.added, true);
  assert.deepEqual(first.state, {
    queue: ["u1"],
    pendingIds: ["u1"],
    pendingSince: { u1: 100 },
  });

  const duplicate = enqueueFinalizeQueueState({
    state: first.state,
    uploadId: "u1",
    queuedAt: 200,
  });
  assert.equal(duplicate.added, false);
  assert.deepEqual(duplicate.state, first.state);

  const forced = enqueueFinalizeQueueState({
    state: first.state,
    uploadId: "u1",
    queuedAt: 300,
    force: true,
  });
  assert.equal(forced.added, true);
  assert.deepEqual(forced.state, {
    queue: ["u1", "u1"],
    pendingIds: ["u1"],
    pendingSince: { u1: 300 },
  });
});

test("applyFinalizeRecoveryPassToQueueState requeues finalizing uploads and cleans stale ones", () => {
  const result = applyFinalizeRecoveryPassToQueueState({
    state: {
      queue: ["u3", "u2", "u1"],
      pendingIds: ["u1", "u2", "u3"],
      pendingSince: { u1: 10, u2: 20, u3: 30 },
    },
    entries: [
      { uploadId: "u1", status: "finalizing" },
      { uploadId: "u2", status: "completed" },
      { uploadId: "u3", status: "failed" },
    ],
    queuedAt: 99,
  });

  assert.equal(result.recovered, 1);
  assert.equal(result.cleaned, 2);
  assert.deepEqual(result.state, {
    queue: ["u1", "u1"],
    pendingIds: ["u1"],
    pendingSince: { u1: 99 },
  });

  assert.deepEqual(cleanupFinalizeQueueState(result.state, "u1"), {
    queue: [],
    pendingIds: [],
    pendingSince: {},
  });
});


test("executeFinalizeRecoveryPlan runs requeues before cleanup and returns counts", async () => {
  const calls: string[] = [];
  const result = await executeFinalizeRecoveryPlan({
    plan: {
      requeueIds: ["u1", "u2"],
      cleanupIds: ["u3"],
      recovered: 2,
      cleaned: 1,
    },
    requeue: async (uploadId) => {
      calls.push(`requeue:${uploadId}`);
    },
    cleanup: async (uploadId) => {
      calls.push(`cleanup:${uploadId}`);
    },
  });

  assert.deepEqual(calls, ["requeue:u1", "requeue:u2", "cleanup:u3"]);
  assert.deepEqual(result, { recovered: 2, cleaned: 1 });
});


test("buildFinalizeLockRetryMeta records retry timing and retryable failure fields", () => {
  assert.deepEqual(
    buildFinalizeLockRetryMeta({ delayMs: 2000, nowMs: 123456 }),
    {
      lastFinalizeRetryAt: "123456",
      lastFinalizeRetryDelayMs: "2000",
      failedReasonCode: "lock_in_progress",
      failedRetryable: "1",
    }
  );
});

test("executeFinalizeLockRetry writes retry metadata before scheduling and clearing", async () => {
  const calls: string[] = [];
  const writes: Array<Record<string, string>> = [];
  const result = await executeFinalizeLockRetry({
    uploadId: "u1",
    delayMs: 2500,
    nowMs: 999,
    writeMeta: async (fields) => {
      calls.push("writeMeta");
      writes.push(fields);
    },
    scheduleRetry: async (uploadId, delayMs) => {
      calls.push(`schedule:${uploadId}:${delayMs}`);
    },
    clearPending: async (uploadId) => {
      calls.push(`clear:${uploadId}`);
    },
  });

  assert.deepEqual(writes, [
    {
      lastFinalizeRetryAt: "999",
      lastFinalizeRetryDelayMs: "2500",
      failedReasonCode: "lock_in_progress",
      failedRetryable: "1",
    },
  ]);
  assert.deepEqual(calls, ["writeMeta", "schedule:u1:2500", "clear:u1"]);
  assert.deepEqual(result, {
    reason: "lock_in_progress",
    retryable: true,
    delayMs: 2500,
  });
});


test("shouldPersistFinalizeFailure blocks failed downgrade after completed commit or lock ownership loss", () => {
  assert.equal(
    shouldPersistFinalizeFailure({ committedCompletedState: true, errorMessage: "REDIS_TIMEOUT" }),
    false
  );
  assert.equal(
    shouldPersistFinalizeFailure({
      committedCompletedState: false,
      errorMessage: "UPLOAD_FINALIZATION_IN_PROGRESS",
    }),
    false
  );
  assert.equal(
    shouldPersistFinalizeFailure({ committedCompletedState: false, errorMessage: "WALRUS_TIMEOUT" }),
    true
  );
});

test("buildFinalizeFollowupWarningMeta records post-commit warnings without changing status", () => {
  assert.deepEqual(
    buildFinalizeFollowupWarningMeta({ errorMessage: "cleanup warning", nowMs: 77 }),
    {
      finalizeWarning: "cleanup warning",
      finalizeWarningAt: "77",
      finalizeLastProgressAt: "77",
    }
  );
});

test("retryable finalize failure helpers cap retries and record retry metadata", async () => {
  assert.equal(
    shouldRetryFinalizeFailure({ retryable: true, attempt: 1, maxAttempts: 4 }),
    true
  );
  assert.equal(
    shouldRetryFinalizeFailure({ retryable: true, attempt: 4, maxAttempts: 4 }),
    false
  );
  assert.equal(
    computeFinalizeRetryDelayMs({ attempt: 3, baseDelayMs: 2000, maxDelayMs: 30000 }),
    8000
  );
  assert.equal(
    computeFinalizeRetryDelayMs({ attempt: 10, baseDelayMs: 2000, maxDelayMs: 30000 }),
    30000
  );

  assert.deepEqual(
    buildRetryableFinalizeFailureMeta({
      reason: "walrus_unavailable",
      stage: "walrus_publish",
      delayMs: 4000,
      nowMs: 222,
    }),
    {
      lastFinalizeRetryAt: "222",
      lastFinalizeRetryDelayMs: "4000",
      failedReasonCode: "walrus_unavailable",
      failedRetryable: "1",
      finalizeAttemptState: "retryable_failure",
      failedStage: "walrus_publish",
    }
  );

  const calls: string[] = [];
  const writes: Array<Record<string, string>> = [];
  const result = await executeRetryableFinalizeFailure({
    uploadId: "u9",
    reason: "walrus_unavailable",
    stage: "walrus_publish",
    delayMs: 4000,
    nowMs: 222,
    writeMeta: async (fields) => {
      calls.push("writeMeta");
      writes.push(fields);
    },
    scheduleRetry: async (uploadId, delayMs) => {
      calls.push(`schedule:${uploadId}:${delayMs}`);
    },
    clearPending: async (uploadId) => {
      calls.push(`clear:${uploadId}`);
    },
  });

  assert.deepEqual(writes, [
    {
      lastFinalizeRetryAt: "222",
      lastFinalizeRetryDelayMs: "4000",
      failedReasonCode: "walrus_unavailable",
      failedRetryable: "1",
      finalizeAttemptState: "retryable_failure",
      failedStage: "walrus_publish",
    },
  ]);
  assert.deepEqual(calls, ["writeMeta", "schedule:u9:4000", "clear:u9"]);
  assert.deepEqual(result, {
    reason: "walrus_unavailable",
    retryable: true,
    delayMs: 4000,
  });
});


test("buildFinalizeDiagnostics exposes finalize warnings and retry timing", () => {
  assert.deepEqual(
    buildFinalizeDiagnostics({
      finalizeWarning: "cleanup warning",
      finalizeWarningAt: "55",
      lastFinalizeRetryDelayMs: "2000",
      lastFinalizeRetryAt: "44",
      finalizeAttempts: "2",
    }),
    {
      finalizeWarning: "cleanup warning",
      finalizeWarningAt: 55,
      lastFinalizeRetryDelayMs: 2000,
      lastFinalizeRetryAt: 44,
      finalizeAttempts: 2,
    }
  );
});

test("assessFinalizeQueueHealth marks stalled finalize backlog as degraded and not ready", () => {
  assert.deepEqual(
    assessFinalizeQueueHealth({
      ready: true,
      finalizeQueue: {
        depth: 4,
        pendingUnique: 2,
        activeLocal: 1,
        concurrency: 4,
        oldestQueuedAt: 100,
        oldestQueuedAgeMs: 400000,
      },
      stuckAgeThresholdMs: 300000,
    }),
    {
      ready: false,
      backlogStalled: true,
      finalizeQueueWarning: "finalize queue oldest age 400000ms exceeds 300000ms",
    }
  );
});

test("decideFinalizeWorkerFailureAction distinguishes lock, retryable transient, and terminal outcomes", () => {
  assert.deepEqual(
    decideFinalizeWorkerFailureAction({
      message: "UPLOAD_FINALIZATION_IN_PROGRESS",
      attempt: 1,
      reason: "lock_in_progress",
      retryable: true,
      stage: "unknown",
      lockRetryDelayMs: 1500,
      retryableBaseDelayMs: 2000,
      retryableMaxDelayMs: 30000,
      retryableMaxAttempts: 4,
    }),
    {
      action: "retry_lock",
      reason: "lock_in_progress",
      retryable: true,
      delayMs: 1500,
    }
  );
  assert.deepEqual(
    decideFinalizeWorkerFailureAction({
      message: "WALRUS_TIMEOUT",
      attempt: 2,
      reason: "walrus_unavailable",
      retryable: true,
      stage: "walrus_publish",
      lockRetryDelayMs: 1500,
      retryableBaseDelayMs: 2000,
      retryableMaxDelayMs: 30000,
      retryableMaxAttempts: 4,
    }),
    {
      action: "retry_transient",
      reason: "walrus_unavailable",
      retryable: true,
      stage: "walrus_publish",
      delayMs: 4000,
    }
  );
  assert.deepEqual(
    decideFinalizeWorkerFailureAction({
      message: "SUI_TIMEOUT",
      attempt: 4,
      reason: "sui_unavailable",
      retryable: true,
      stage: "sui_finalize",
      lockRetryDelayMs: 1500,
      retryableBaseDelayMs: 2000,
      retryableMaxDelayMs: 30000,
      retryableMaxAttempts: 4,
    }),
    {
      action: "failed",
      reason: "sui_unavailable",
      retryable: true,
      stage: "sui_finalize",
    }
  );
});

test("executeFinalizeWorkerFailureAction covers retry lock, retry transient, and terminal failure flows", async () => {
  const calls: string[] = [];
  const writes: Array<Record<string, string>> = [];
  const markFailedCalls: Array<{ uploadId: string; reason: string; retryable: boolean; stage?: string }> = [];

  const retryLock = await executeFinalizeWorkerFailureAction({
    action: { action: "retry_lock", reason: "lock_in_progress", retryable: true, delayMs: 1000 },
    uploadId: "u1",
    nowMs: 10,
    writeMeta: async (fields) => { calls.push("writeMeta:lock"); writes.push(fields); },
    scheduleRetry: async (uploadId, delayMs) => { calls.push(`schedule:${uploadId}:${delayMs}`); },
    clearPending: async (uploadId) => { calls.push(`clear:${uploadId}`); },
    markFailed: async (params) => { markFailedCalls.push(params); },
  });

  const retryTransient = await executeFinalizeWorkerFailureAction({
    action: { action: "retry_transient", reason: "walrus_unavailable", retryable: true, delayMs: 2000, stage: "walrus_publish" },
    uploadId: "u2",
    nowMs: 20,
    writeMeta: async (fields) => { calls.push("writeMeta:transient"); writes.push(fields); },
    scheduleRetry: async (uploadId, delayMs) => { calls.push(`schedule:${uploadId}:${delayMs}`); },
    clearPending: async (uploadId) => { calls.push(`clear:${uploadId}`); },
    markFailed: async (params) => { markFailedCalls.push(params); },
  });

  const terminal = await executeFinalizeWorkerFailureAction({
    action: { action: "failed", reason: "incomplete_chunks", retryable: false, stage: "verify_chunks" },
    uploadId: "u3",
    nowMs: 30,
    writeMeta: async (fields) => { writes.push(fields); },
    scheduleRetry: async () => {},
    clearPending: async (uploadId) => { calls.push(`clear:${uploadId}`); },
    markFailed: async (params) => { markFailedCalls.push(params); },
  });

  assert.deepEqual(retryLock, { metricsOutcome: "retry_lock", reason: "lock_in_progress", retryable: true });
  assert.deepEqual(retryTransient, { metricsOutcome: "retry_transient", reason: "walrus_unavailable", retryable: true });
  assert.deepEqual(terminal, { metricsOutcome: "failed", reason: "incomplete_chunks", retryable: false });
  assert.deepEqual(markFailedCalls, [
    { uploadId: "u3", reason: "incomplete_chunks", retryable: false, stage: "verify_chunks" },
  ]);
  assert.deepEqual(calls, [
    "writeMeta:lock",
    "schedule:u1:1000",
    "clear:u1",
    "writeMeta:transient",
    "schedule:u2:2000",
    "clear:u2",
    "clear:u3",
  ]);
});


test("reserveFinalizeActiveLocal suppresses duplicate local worker execution", () => {
  assert.deepEqual(
    reserveFinalizeActiveLocal({ activeLocalIds: [], uploadId: "u1" }),
    { reserved: true, activeLocalIds: ["u1"] }
  );
  assert.deepEqual(
    reserveFinalizeActiveLocal({ activeLocalIds: ["u1"], uploadId: "u1" }),
    { reserved: false, activeLocalIds: ["u1"] }
  );
  assert.deepEqual(
    reserveFinalizeActiveLocal({ activeLocalIds: ["u1"], uploadId: "u2" }),
    { reserved: true, activeLocalIds: ["u1", "u2"] }
  );
});
