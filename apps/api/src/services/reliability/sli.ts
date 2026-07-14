/**
 * SLI (Service Level Indicator) / SLO (Service Level Objective) tracking.
 *
 * Provides sliding-window counters and histograms for:
 * - Success rate (good / total requests per window)
 * - Latency budget (requests within latency threshold)
 * - Burn rate (how fast error budget is consumed)
 *
 * All metrics are in-memory and reset on process restart.
 */

import { parsePositiveIntEnv } from "../../utils/parseEnv.js";

// ============================================================
// Configuration
// ============================================================

export const SliConfig = {
  /** Window size in seconds for SLI calculations. */
  windowSeconds: parsePositiveIntEnv("FLOE_SLI_WINDOW_SECONDS", 300, 60),

  /** Latency threshold in ms — requests above this count against budget. */
  latencyBudgetMs: parsePositiveIntEnv("FLOE_SLI_LATENCY_BUDGET_MS", 500, 1),

  /** SLO target as a fraction (e.g., 0.99 = 99%). */
  sloTargetUpload: (() => {
    const raw = process.env.FLOE_SLO_UPLOAD_TARGET;
    if (!raw) return 0.99;
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 0.99;
  })(),

  sloTargetStream: (() => {
    const raw = process.env.FLOE_SLO_STREAM_TARGET;
    if (!raw) return 0.99;
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 0.99;
  })(),

  sloTargetApi: (() => {
    const raw = process.env.FLOE_SLO_API_TARGET;
    if (!raw) return 0.995;
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 0.995;
  })(),
} as const;

// ============================================================
// Sliding window counters
// ============================================================

class SlidingWindow {
  private readonly buckets: Map<number, { total: number; good: number; slow: number }> =
    new Map();
  private readonly windowMs: number;
  private bucketMs: number;

  constructor(windowSeconds: number, bucketMs = 10_000) {
    this.windowMs = windowSeconds * 1000;
    this.bucketMs = bucketMs;
  }

  private bucketKey(ts: number): number {
    return Math.floor(ts / this.bucketMs) * this.bucketMs;
  }

  private prune(now: number) {
    const cutoff = now - this.windowMs;
    for (const [key] of this.buckets) {
      if (key < cutoff) this.buckets.delete(key);
    }
  }

  record(success: boolean, latencyMs: number) {
    const now = Date.now();
    const key = this.bucketKey(now);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { total: 0, good: 0, slow: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.total += 1;
    if (success) bucket.good += 1;
    if (latencyMs > SliConfig.latencyBudgetMs) bucket.slow += 1;
    this.prune(now);
  }

  snapshot(): { total: number; good: number; slow: number; successRate: number; withinBudgetRate: number } {
    this.prune(Date.now());
    let total = 0;
    let good = 0;
    let slow = 0;
    for (const bucket of this.buckets.values()) {
      total += bucket.total;
      good += bucket.good;
      slow += bucket.slow;
    }
    return {
      total,
      good,
      slow,
      successRate: total > 0 ? good / total : 1,
      withinBudgetRate: total > 0 ? (total - slow) / total : 1,
    };
  }
}

// ============================================================
// Per-operation SLI windows
// ============================================================

const uploadWindow = new SlidingWindow(SliConfig.windowSeconds);
const streamWindow = new SlidingWindow(SliConfig.windowSeconds);
const apiWindow = new SlidingWindow(SliConfig.windowSeconds);

export function recordUploadSli(success: boolean, latencyMs: number) {
  uploadWindow.record(success, latencyMs);
}

export function recordStreamSli(success: boolean, latencyMs: number) {
  streamWindow.record(success, latencyMs);
}

export function recordApiSli(success: boolean, latencyMs: number) {
  apiWindow.record(success, latencyMs);
}

// ============================================================
// SLO status
// ============================================================

export type SloStatus = {
  sli: {
    total: number;
    good: number;
    slow: number;
    successRate: number;
    withinBudgetRate: number;
  };
  target: number;
  errorBudgetRemaining: number; // fraction 0-1
  withinSlo: boolean;
  burnRate: number; // how fast error budget is consumed (1 = normal, >1 = burning)
};

function computeSloStatus(
  sli: ReturnType<typeof uploadWindow.snapshot>,
  target: number,
): SloStatus {
  const errorBudget = 1 - target;
  const actualErrorRate = sli.total > 0 ? 1 - sli.successRate : 0;
  const errorBudgetRemaining = errorBudget > 0 ? Math.max(0, (errorBudget - actualErrorRate) / errorBudget) : 0;
  const burnRate = sli.total > 0 && errorBudget > 0 ? actualErrorRate / errorBudget : 0;

  return {
    sli,
    target,
    errorBudgetRemaining,
    withinSlo: sli.successRate >= target,
    burnRate: Math.round(burnRate * 100) / 100,
  };
}

export function getUploadSloStatus(): SloStatus {
  return computeSloStatus(uploadWindow.snapshot(), SliConfig.sloTargetUpload);
}

export function getStreamSloStatus(): SloStatus {
  return computeSloStatus(streamWindow.snapshot(), SliConfig.sloTargetStream);
}

export function getApiSloStatus(): SloStatus {
  return computeSloStatus(apiWindow.snapshot(), SliConfig.sloTargetApi);
}

export function getAllSloStatuses() {
  return {
    upload: getUploadSloStatus(),
    stream: getStreamSloStatus(),
    api: getApiSloStatus(),
  };
}

// ============================================================
// Prometheus rendering
// ============================================================

export function renderSliMetrics(): string[] {
  const lines: string[] = [];

  for (const [name, status] of Object.entries(getAllSloStatuses())) {
    lines.push(`floe_sli_${name}_total ${status.sli.total}`);
    lines.push(`floe_sli_${name}_good ${status.sli.good}`);
    lines.push(`floe_sli_${name}_slow ${status.sli.slow}`);
    lines.push(`floe_sli_${name}_success_rate ${status.sli.successRate.toFixed(4)}`);
    lines.push(`floe_sli_${name}_within_budget_rate ${status.sli.withinBudgetRate.toFixed(4)}`);
    lines.push(`floe_sli_${name}_error_budget_remaining ${status.errorBudgetRemaining.toFixed(4)}`);
    lines.push(`floe_sli_${name}_burn_rate ${status.burnRate.toFixed(2)}`);
    lines.push(`floe_sli_${name}_within_slo ${status.withinSlo ? 1 : 0}`);
  }

  return lines;
}
