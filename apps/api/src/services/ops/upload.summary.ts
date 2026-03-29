import { buildFinalizeDiagnostics } from "../uploads/finalize.shared.js";

type QueueStats = {
  depth: number;
  pendingUnique: number;
  activeLocal: number;
  concurrency: number;
  oldestQueuedAt: number | null;
  oldestQueuedAgeMs: number | null;
} | null;

type Dependencies = {
  redis: { status: string };
  postgres: { status: string };
};

export function buildOperatorUploadSummary(params: {
  session: {
    totalChunks: number;
    expiresAt: number;
    status: string;
  } | null;
  meta: Record<string, string> | null;
  receivedChunkIndexes: number[];
  finalizePending: boolean;
  finalizeActiveLock: boolean;
  finalizeLockTtlSeconds: number;
  finalizeQueue: QueueStats;
  dependencies: Dependencies;
  finalizeStuckAgeThresholdMs?: number;
  nowMs?: number;
}) {
  const nowMs = params.nowMs ?? Date.now();
  const status = params.meta?.status ?? params.session?.status ?? "unknown";
  const totalChunks =
    params.session?.totalChunks ?? (Number(params.meta?.totalChunks ?? 0) || 0);
  const receivedCount = params.receivedChunkIndexes.length;
  const missingChunkCount = Math.max(0, totalChunks - receivedCount);
  const uploadComplete = totalChunks > 0 && missingChunkCount === 0;
  const finalize = buildFinalizeDiagnostics(params.meta ?? undefined) as Record<string, unknown>;
  const finalizeAttemptState =
    typeof finalize.finalizeAttemptState === "string" ? finalize.finalizeAttemptState : null;
  const failedReasonCode =
    typeof finalize.failedReasonCode === "string" ? finalize.failedReasonCode : null;
  const failedRetryable =
    typeof finalize.failedRetryable === "boolean" ? finalize.failedRetryable : null;
  const failedStage =
    typeof finalize.failedStage === "string" ? finalize.failedStage : null;
  const finalizeWarning =
    typeof finalize.finalizeWarning === "string" ? finalize.finalizeWarning : null;
  const finalizeWarningAt =
    typeof finalize.finalizeWarningAt === "number" ? finalize.finalizeWarningAt : null;
  const lastFinalizeRetryAt =
    typeof finalize.lastFinalizeRetryAt === "number" ? finalize.lastFinalizeRetryAt : null;
  const lastFinalizeRetryDelayMs =
    typeof finalize.lastFinalizeRetryDelayMs === "number" ? finalize.lastFinalizeRetryDelayMs : null;
  const finalizingQueuedAt =
    typeof finalize.finalizingQueuedAt === "number" ? finalize.finalizingQueuedAt : null;
  const finalizeLastProgressAt =
    typeof finalize.finalizeLastProgressAt === "number" ? finalize.finalizeLastProgressAt : null;
  const finalizeStuckAgeThresholdMs = params.finalizeStuckAgeThresholdMs ?? 5 * 60_000;
  const dependencyIssue =
    params.dependencies.redis.status !== "healthy"
      ? "redis_unavailable"
      : params.dependencies.postgres.status === "unavailable"
        ? "postgres_unavailable"
        : params.dependencies.postgres.status === "degraded"
          ? "postgres_degraded"
          : null;
  const queueBacklogStalled = Boolean(
    params.finalizeQueue &&
      params.finalizeQueue.oldestQueuedAgeMs !== null &&
      params.finalizeQueue.pendingUnique > params.finalizeQueue.activeLocal &&
      params.finalizeQueue.oldestQueuedAgeMs >= finalizeStuckAgeThresholdMs
  );
  const expired = params.session ? params.session.expiresAt <= nowMs && status === "uploading" : false;
  const expiresInMs = params.session ? Math.max(0, params.session.expiresAt - nowMs) : null;
  const queuedAgeMs =
    finalizingQueuedAt !== null ? Math.max(0, nowMs - finalizingQueuedAt) : null;
  const lastProgressAgeMs =
    finalizeLastProgressAt !== null ? Math.max(0, nowMs - finalizeLastProgressAt) : null;
  const finalizeStalled = Boolean(
    status === "finalizing" &&
      lastProgressAgeMs !== null &&
      lastProgressAgeMs >= finalizeStuckAgeThresholdMs &&
      !params.finalizeActiveLock
  );

  let phase:
    | "uploading"
    | "ready_to_finalize"
    | "finalize_queued"
    | "finalize_active"
    | "finalize_retrying"
    | "completed"
    | "failed"
    | "canceled"
    | "expired"
    | "unknown" = "unknown";
  let issue: string | null = null;
  let recommendedAction:
    | "resume_upload"
    | "wait_for_finalize"
    | "inspect_dependencies"
    | "inspect_failure"
    | "cancel_or_cleanup"
    | "none" = "none";

  if (status === "completed") {
    phase = "completed";
  } else if (status === "failed") {
    phase = "failed";
    issue = failedReasonCode ?? "finalize_failed";
    recommendedAction = failedRetryable ? "inspect_dependencies" : "inspect_failure";
  } else if (status === "canceled") {
    phase = "canceled";
    recommendedAction = "cancel_or_cleanup";
  } else if (status === "expired" || expired) {
    phase = "expired";
    recommendedAction = "cancel_or_cleanup";
  } else if (status === "finalizing") {
    if (finalizeStalled) {
      phase = "finalize_queued";
      issue = "finalize_stalled";
      recommendedAction = "inspect_dependencies";
    } else if (finalizeAttemptState === "retryable_failure") {
      phase = "finalize_retrying";
      issue = failedReasonCode ?? "retryable_finalize_failure";
      recommendedAction =
        dependencyIssue || queueBacklogStalled ? "inspect_dependencies" : "wait_for_finalize";
    } else if (params.finalizeActiveLock) {
      phase = "finalize_active";
      issue = dependencyIssue;
      recommendedAction = dependencyIssue ? "inspect_dependencies" : "wait_for_finalize";
    } else if (params.finalizePending) {
      phase = "finalize_queued";
      issue = queueBacklogStalled ? "finalize_queue_stalled" : dependencyIssue;
      recommendedAction =
        queueBacklogStalled || dependencyIssue ? "inspect_dependencies" : "wait_for_finalize";
    } else {
      phase = "finalize_active";
      issue = dependencyIssue;
      recommendedAction = dependencyIssue ? "inspect_dependencies" : "wait_for_finalize";
    }
  } else if (status === "uploading") {
    if (uploadComplete) {
      phase = "ready_to_finalize";
      recommendedAction = "wait_for_finalize";
    } else {
      phase = "uploading";
      issue = "missing_chunks";
      recommendedAction = "resume_upload";
    }
  }

  if (!issue && dependencyIssue) {
    issue = dependencyIssue;
    if (recommendedAction === "none") {
      recommendedAction = "inspect_dependencies";
    }
  }

  return {
    status,
    phase,
    issue,
    recommendedAction,
    chunkProgress: {
      totalChunks,
      receivedCount,
      missingChunkCount,
      uploadComplete,
    },
    timing: {
      expiresInMs,
      queuedAgeMs,
      lastProgressAgeMs,
    },
    failure: {
      stage: failedStage,
      reasonCode: failedReasonCode,
      retryable: failedRetryable,
      retryAt: lastFinalizeRetryAt,
      retryDelayMs: lastFinalizeRetryDelayMs,
      warning: finalizeWarning,
      warningAt: finalizeWarningAt,
    },
    finalize: {
      pending: params.finalizePending,
      activeLock: params.finalizeActiveLock,
      lockTtlSeconds: params.finalizeLockTtlSeconds,
      attemptState: finalizeAttemptState,
      failedReasonCode,
      failedRetryable,
      queueBacklogStalled,
      stalled: finalizeStalled,
    },
  };
}
