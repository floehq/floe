export type FinalizeFailureCode =
  | "lock_in_progress"
  | "lock_lost"
  | "upload_not_found"
  | "incomplete_chunks"
  | "missing_chunks"
  | "walrus_upload_failed"
  | "walrus_retention_too_low"
  | "walrus_unavailable"
  | "walrus_unknown"
  | "sui_file_create_failed"
  | "sui_unavailable"
  | "redis_failure"
  | "corrupt_completed_upload"
  | "finalize_failed";

export type FinalizeJobFailureReason = FinalizeFailureCode | "timeout";

function errorMessage(err: unknown): string {
  return String((err as Error)?.message ?? "UPLOAD_FINALIZE_FAILED").toUpperCase();
}

function toNumericField(meta: Record<string, string> | undefined, key: string): number | undefined {
  const raw = meta?.[key];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function buildFinalizeDiagnostics(meta: Record<string, string> | undefined) {
  if (!meta) return {};

  const out: Record<string, unknown> = {};
  const numericKeys = [
    "finalizeAttempts",
    "finalizeQueueWaitMs",
    "finalizeVerifyMs",
    "finalizeWalrusMs",
    "finalizeSuiMs",
    "finalizeRedisMs",
    "finalizeCleanupMs",
    "finalizeTotalMs",
    "finalizeStageStartedAt",
    "finalizeLastProgressAt",
    "finalizingQueuedAt",
    "lastFinalizeAttemptAt",
    "lastFinalizeRetryAt",
    "lastFinalizeRetryDelayMs",
    "finalizeWarningAt",
  ] as const;

  const passthroughKeys = [
    "finalizeStage",
    "finalizeAttemptState",
    "finalizeLastSuccessfulStage",
    "failedStage",
    "failedReasonCode",
    "finalizeWarning",
  ] as const;

  for (const key of passthroughKeys) {
    if (meta[key]) out[key] = meta[key];
  }

  if (meta.failedRetryable) {
    out.failedRetryable = meta.failedRetryable === "1";
  }

  for (const key of numericKeys) {
    const value = toNumericField(meta, key);
    if (value !== undefined) out[key] = value;
  }

  return out;
}

export function normalizeFinalizeFailure(err: unknown): {
  reasonCode: FinalizeFailureCode;
  retryable: boolean;
} {
  const message = errorMessage(err);

  if (message === "UPLOAD_FINALIZATION_IN_PROGRESS") {
    return { reasonCode: "lock_in_progress", retryable: true };
  }
  if (message === "UPLOAD_FINALIZATION_LOCK_LOST") {
    return { reasonCode: "lock_lost", retryable: true };
  }
  if (message === "UPLOAD_NOT_FOUND") {
    return { reasonCode: "upload_not_found", retryable: false };
  }
  if (message === "INCOMPLETE_CHUNKS") {
    return { reasonCode: "incomplete_chunks", retryable: false };
  }
  if (message === "MISSING_CHUNKS") {
    return { reasonCode: "missing_chunks", retryable: false };
  }
  if (message.includes("WALRUS_UPLOAD_FAILED")) {
    return { reasonCode: "walrus_upload_failed", retryable: true };
  }
  if (message.includes("WALRUS_RETENTION_TOO_LOW")) {
    return { reasonCode: "walrus_retention_too_low", retryable: false };
  }
  if (message.includes("WALRUS_UNKNOWN")) {
    return { reasonCode: "walrus_unknown", retryable: true };
  }
  if (message.includes("WALRUS")) {
    return { reasonCode: "walrus_unavailable", retryable: true };
  }
  if (message === "SUI_FILE_CREATE_FAILED") {
    return { reasonCode: "sui_file_create_failed", retryable: false };
  }
  if (message.includes("SUI")) {
    return { reasonCode: "sui_unavailable", retryable: true };
  }
  if (message.includes("REDIS")) {
    return { reasonCode: "redis_failure", retryable: true };
  }
  if (message === "CORRUPT_COMPLETED_UPLOAD") {
    return { reasonCode: "corrupt_completed_upload", retryable: false };
  }

  return { reasonCode: "finalize_failed", retryable: false };
}

export function classifyFinalizeJobFailure(err: unknown): {
  reason: FinalizeJobFailureReason;
  retryable: boolean;
  stage: string;
} {
  const wrapped = err as Error & { finalizeStage?: string };
  const message = errorMessage(err);
  const stage = wrapped.finalizeStage ?? "unknown";

  if (message.includes("UPLOAD_FINALIZE_TIMEOUT")) {
    return { reason: "timeout", retryable: true, stage };
  }

  const normalized = normalizeFinalizeFailure(err);
  return {
    reason: normalized.reasonCode,
    retryable: normalized.retryable,
    stage,
  };
}



export function shouldPersistFinalizeFailure(params: {
  committedCompletedState: boolean;
  errorMessage: string;
}): boolean {
  if (params.committedCompletedState) return false;
  return (
    params.errorMessage !== "UPLOAD_FINALIZATION_LOCK_LOST"
    && params.errorMessage !== "UPLOAD_FINALIZATION_IN_PROGRESS"
  );
}

export function buildFinalizeFollowupWarningMeta(params: {
  errorMessage: string;
  nowMs: number;
}) {
  return {
    finalizeWarning: params.errorMessage.slice(0, 500),
    finalizeWarningAt: String(params.nowMs),
    finalizeLastProgressAt: String(params.nowMs),
  };
}

export function shouldRetryFinalizeFailure(params: {
  retryable: boolean;
  attempt: number;
  maxAttempts: number;
}): boolean {
  return params.retryable && params.attempt < params.maxAttempts;
}

export function computeFinalizeRetryDelayMs(params: {
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
}): number {
  const exponent = Math.max(0, params.attempt - 1);
  const delay = params.baseDelayMs * (2 ** exponent);
  return Math.min(params.maxDelayMs, delay);
}

export function buildRetryableFinalizeFailureMeta(params: {
  reason: string;
  delayMs: number;
  nowMs: number;
  stage?: string;
}) {
  return {
    status: "finalizing",
    lastFinalizeRetryAt: String(params.nowMs),
    lastFinalizeRetryDelayMs: String(params.delayMs),
    failedReasonCode: params.reason,
    failedRetryable: "1",
    finalizeAttemptState: "retryable_failure",
    finalizeLastProgressAt: String(params.nowMs),
    ...(params.stage ? { failedStage: params.stage } : {}),
  };
}

export async function executeRetryableFinalizeFailure(params: {
  uploadId: string;
  reason: string;
  delayMs: number;
  stage?: string;
  nowMs: number;
  writeMeta: (fields: Record<string, string>) => Promise<void>;
  scheduleRetry: (uploadId: string, delayMs: number) => Promise<void> | void;
  clearPending: (uploadId: string) => Promise<void>;
}): Promise<{ reason: string; retryable: true; delayMs: number }> {
  await params.writeMeta(
    buildRetryableFinalizeFailureMeta({
      reason: params.reason,
      delayMs: params.delayMs,
      nowMs: params.nowMs,
      stage: params.stage,
    })
  );
  await params.scheduleRetry(params.uploadId, params.delayMs);
  await params.clearPending(params.uploadId);

  return {
    reason: params.reason,
    retryable: true,
    delayMs: params.delayMs,
  };
}

export type FinalizeWorkerFailureAction =
  | { action: "retry_lock"; reason: "lock_in_progress"; retryable: true; delayMs: number }
  | { action: "retry_transient"; reason: string; retryable: true; delayMs: number; stage?: string }
  | { action: "failed"; reason: string; retryable: boolean; stage?: string };

export function decideFinalizeWorkerFailureAction(params: {
  message: string;
  attempt: number;
  reason: string;
  retryable: boolean;
  stage?: string;
  lockRetryDelayMs: number;
  retryableBaseDelayMs: number;
  retryableMaxDelayMs: number;
  retryableMaxAttempts: number;
}): FinalizeWorkerFailureAction {
  if (params.message === "UPLOAD_FINALIZATION_IN_PROGRESS") {
    return {
      action: "retry_lock",
      reason: "lock_in_progress",
      retryable: true,
      delayMs: params.lockRetryDelayMs,
    };
  }

  if (
    shouldRetryFinalizeFailure({
      retryable: params.retryable,
      attempt: params.attempt,
      maxAttempts: params.retryableMaxAttempts,
    })
  ) {
    return {
      action: "retry_transient",
      reason: params.reason,
      retryable: true,
      stage: params.stage,
      delayMs: computeFinalizeRetryDelayMs({
        attempt: params.attempt,
        baseDelayMs: params.retryableBaseDelayMs,
        maxDelayMs: params.retryableMaxDelayMs,
      }),
    };
  }

  return {
    action: "failed",
    reason: params.reason,
    retryable: params.retryable,
    stage: params.stage,
  };
}

export async function executeFinalizeWorkerFailureAction(params: {
  action: FinalizeWorkerFailureAction;
  uploadId: string;
  nowMs: number;
  writeMeta: (fields: Record<string, string>) => Promise<void>;
  scheduleRetry: (uploadId: string, delayMs: number) => Promise<void> | void;
  clearPending: (uploadId: string) => Promise<void>;
  markFailed: (params: {
    uploadId: string;
    reason: string;
    retryable: boolean;
    stage?: string;
  }) => Promise<void>;
}): Promise<{ metricsOutcome: "retry_lock" | "retry_transient" | "failed"; reason: string; retryable: boolean }> {
  if (params.action.action === "retry_lock") {
    await executeFinalizeLockRetry({
      uploadId: params.uploadId,
      delayMs: params.action.delayMs,
      nowMs: params.nowMs,
      writeMeta: params.writeMeta,
      scheduleRetry: params.scheduleRetry,
      clearPending: params.clearPending,
    });
    return {
      metricsOutcome: "retry_lock",
      reason: params.action.reason,
      retryable: true,
    };
  }

  if (params.action.action === "retry_transient") {
    await executeRetryableFinalizeFailure({
      uploadId: params.uploadId,
      reason: params.action.reason,
      stage: params.action.stage,
      delayMs: params.action.delayMs,
      nowMs: params.nowMs,
      writeMeta: params.writeMeta,
      scheduleRetry: params.scheduleRetry,
      clearPending: params.clearPending,
    });
    return {
      metricsOutcome: "retry_transient",
      reason: params.action.reason,
      retryable: true,
    };
  }

  await params.markFailed({
    uploadId: params.uploadId,
    reason: params.action.reason,
    retryable: params.action.retryable,
    stage: params.action.stage,
  });
  await params.clearPending(params.uploadId);
  return {
    metricsOutcome: "failed",
    reason: params.action.reason,
    retryable: params.action.retryable,
  };
}

export function assessFinalizeQueueHealth(params: {
  ready: boolean;
  finalizeQueue:
    | {
        depth: number | null;
        pendingUnique: number | null;
        activeLocal: number | null;
        concurrency: number | null;
        oldestQueuedAt: number | null;
        oldestQueuedAgeMs: number | null;
      }
    | null;
  stuckAgeThresholdMs: number;
}) {
  const oldestQueuedAgeMs = params.finalizeQueue?.oldestQueuedAgeMs ?? null;
  const pendingUnique = params.finalizeQueue?.pendingUnique ?? null;
  const activeLocal = params.finalizeQueue?.activeLocal ?? null;
  const backlogStalled =
    oldestQueuedAgeMs !== null
    && pendingUnique !== null
    && activeLocal !== null
    && pendingUnique > activeLocal
    && oldestQueuedAgeMs >= params.stuckAgeThresholdMs;

  return {
    ready: params.ready && !backlogStalled,
    backlogStalled,
    finalizeQueueWarning: backlogStalled
      ? `finalize queue oldest age ${oldestQueuedAgeMs}ms exceeds ${params.stuckAgeThresholdMs}ms`
      : null,
  };
}

export type FinalizeStageName =
  | "verify_chunks"
  | "walrus_publish"
  | "sui_finalize"
  | "redis_commit"
  | "cleanup";

export function buildCompletedFinalizeResult(
  meta: Record<string, string>,
  fallbackSizeBytes: number
) {
  if (!meta.fileId || !meta.blobId) {
    throw new Error("CORRUPT_COMPLETED_UPLOAD");
  }

  return {
    fileId: meta.fileId,
    blobId: meta.blobId,
    sizeBytes: Number(meta.sizeBytes ?? fallbackSizeBytes),
    status: "ready" as const,
    ...(meta.walrusEndEpoch ? { walrusEndEpoch: Number(meta.walrusEndEpoch) } : {}),
    finalize: {
      totalMs: Number(meta.finalizeTotalMs ?? 0),
      stageDurationsMs: {
        verify_chunks: Number(meta.finalizeVerifyMs ?? 0),
        walrus_publish: Number(meta.finalizeWalrusMs ?? 0),
        sui_finalize: Number(meta.finalizeSuiMs ?? 0),
        redis_commit: Number(meta.finalizeRedisMs ?? 0),
        cleanup: Number(meta.finalizeCleanupMs ?? 0),
      } satisfies Record<FinalizeStageName, number>,
    },
  };
}

export function classifyFinalizeRecoveryAction(entry: {
  status: string | null | undefined;
  failedRetryable?: string | null | undefined;
  finalizeAttemptState?: string | null | undefined;
}):
  | "requeue"
  | "cleanup" {
  if (entry.status === "finalizing") return "requeue";
  if (entry.status === "failed" && entry.failedRetryable === "1") return "requeue";
  if (entry.finalizeAttemptState === "retryable_failure") return "requeue";
  return "cleanup";
}

export function planFinalizeRecoveryPass(
  entries: Array<{
    uploadId: string;
    status: string | null | undefined;
    failedRetryable?: string | null | undefined;
    finalizeAttemptState?: string | null | undefined;
  }>
): {
  requeueIds: string[];
  cleanupIds: string[];
  recovered: number;
  cleaned: number;
} {
  const requeueIds: string[] = [];
  const cleanupIds: string[] = [];

  for (const entry of entries) {
    if (classifyFinalizeRecoveryAction(entry) === "requeue") {
      requeueIds.push(entry.uploadId);
      continue;
    }
    cleanupIds.push(entry.uploadId);
  }

  return {
    requeueIds,
    cleanupIds,
    recovered: requeueIds.length,
    cleaned: cleanupIds.length,
  };
}

export async function executeFinalizeRecoveryPlan(params: {
  plan: { requeueIds: string[]; cleanupIds: string[]; recovered: number; cleaned: number };
  requeue: (uploadId: string) => Promise<void>;
  cleanup: (uploadId: string) => Promise<void>;
}): Promise<{ recovered: number; cleaned: number }> {
  for (const uploadId of params.plan.requeueIds) {
    await params.requeue(uploadId);
  }

  for (const uploadId of params.plan.cleanupIds) {
    await params.cleanup(uploadId);
  }

  return {
    recovered: params.plan.recovered,
    cleaned: params.plan.cleaned,
  };
}

export function buildFinalizeLockRetryMeta(params: {
  delayMs: number;
  nowMs: number;
}) {
  return {
    lastFinalizeRetryAt: String(params.nowMs),
    lastFinalizeRetryDelayMs: String(params.delayMs),
    failedReasonCode: "lock_in_progress",
    failedRetryable: "1",
  };
}

export async function executeFinalizeLockRetry(params: {
  uploadId: string;
  delayMs: number;
  writeMeta: (fields: Record<string, string>) => Promise<void>;
  scheduleRetry: (uploadId: string, delayMs: number) => Promise<void> | void;
  clearPending: (uploadId: string) => Promise<void>;
  nowMs: number;
}): Promise<{ reason: "lock_in_progress"; retryable: true; delayMs: number }> {
  await params.writeMeta(
    buildFinalizeLockRetryMeta({ delayMs: params.delayMs, nowMs: params.nowMs })
  );
  await params.scheduleRetry(params.uploadId, params.delayMs);
  await params.clearPending(params.uploadId);

  return {
    reason: "lock_in_progress",
    retryable: true,
    delayMs: params.delayMs,
  };
}

export function reserveFinalizeActiveLocal(params: {
  activeLocalIds: string[];
  uploadId: string;
}): { reserved: boolean; activeLocalIds: string[] } {
  if (params.activeLocalIds.includes(params.uploadId)) {
    return {
      reserved: false,
      activeLocalIds: [...params.activeLocalIds],
    };
  }
  return {
    reserved: true,
    activeLocalIds: [...params.activeLocalIds, params.uploadId],
  };
}

export type FinalizeQueueState = {
  queue: string[];
  pendingIds: string[];
  pendingSince: Record<string, number>;
};

export function enqueueFinalizeQueueState(params: {
  state: FinalizeQueueState;
  uploadId: string;
  queuedAt: number;
  force?: boolean;
}): { state: FinalizeQueueState; added: boolean } {
  const pending = new Set(params.state.pendingIds);
  const force = params.force === true;
  const alreadyPending = pending.has(params.uploadId);

  if (alreadyPending && !force) {
    return {
      state: {
        queue: [...params.state.queue],
        pendingIds: [...params.state.pendingIds],
        pendingSince: { ...params.state.pendingSince },
      },
      added: false,
    };
  }

  pending.add(params.uploadId);
  return {
    state: {
      queue: [params.uploadId, ...params.state.queue],
      pendingIds: [...pending],
      pendingSince: {
        ...params.state.pendingSince,
        [params.uploadId]: params.queuedAt,
      },
    },
    added: true,
  };
}

export function cleanupFinalizeQueueState(
  state: FinalizeQueueState,
  uploadId: string
): FinalizeQueueState {
  const pending = new Set(state.pendingIds);
  pending.delete(uploadId);

  const nextPendingSince = { ...state.pendingSince };
  delete nextPendingSince[uploadId];

  return {
    queue: state.queue.filter((entry) => entry !== uploadId),
    pendingIds: [...pending],
    pendingSince: nextPendingSince,
  };
}

export function applyFinalizeRecoveryPassToQueueState(params: {
  state: FinalizeQueueState;
  entries: Array<{ uploadId: string; status: string | null | undefined }>;
  queuedAt: number;
}): { state: FinalizeQueueState; recovered: number; cleaned: number } {
  const plan = planFinalizeRecoveryPass(params.entries);
  let state = {
    queue: [...params.state.queue],
    pendingIds: [...params.state.pendingIds],
    pendingSince: { ...params.state.pendingSince },
  };

  for (const uploadId of plan.requeueIds) {
    state = enqueueFinalizeQueueState({
      state,
      uploadId,
      queuedAt: params.queuedAt,
      force: true,
    }).state;
  }

  for (const uploadId of plan.cleanupIds) {
    state = cleanupFinalizeQueueState(state, uploadId);
  }

  return {
    state,
    recovered: plan.recovered,
    cleaned: plan.cleaned,
  };
}

export function shapeFinalizeQueueStats(params: {
  depth: number | string | null | undefined;
  pendingUnique: number | string | null | undefined;
  activeLocal: number;
  concurrency: number;
  oldestQueuedAt?: number | string | null;
  nowMs?: number;
}) {
  const depth = Number(params.depth ?? 0);
  const pendingUnique = Number(params.pendingUnique ?? 0);
  const oldestQueuedAtRaw = params.oldestQueuedAt;
  const oldestQueuedAt =
    oldestQueuedAtRaw === null || oldestQueuedAtRaw === undefined || oldestQueuedAtRaw === ""
      ? null
      : Number(oldestQueuedAtRaw);
  const oldestQueuedAgeMs =
    oldestQueuedAt !== null && Number.isFinite(oldestQueuedAt)
      ? Math.max(0, (params.nowMs ?? Date.now()) - oldestQueuedAt)
      : null;

  return {
    depth: Number.isFinite(depth) ? depth : 0,
    pendingUnique: Number.isFinite(pendingUnique) ? pendingUnique : 0,
    activeLocal: params.activeLocal,
    concurrency: params.concurrency,
    oldestQueuedAt:
      oldestQueuedAt !== null && Number.isFinite(oldestQueuedAt) ? oldestQueuedAt : null,
    oldestQueuedAgeMs,
  };
}
