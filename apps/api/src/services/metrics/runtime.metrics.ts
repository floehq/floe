type LabelValue = string | number | boolean;
type Labels = Record<string, LabelValue>;

type CounterState = Map<string, number>;
type GaugeState = Map<string, number>;
type HistogramEntry = {
  count: number;
  sum: number;
  buckets: number[];
};
type HistogramState = Map<string, HistogramEntry>;

const countersByMetric = new Map<string, CounterState>();
const gaugesByMetric = new Map<string, GaugeState>();
const histogramsByMetric = new Map<
  string,
  { buckets: number[]; entries: HistogramState }
>();

function labelsToSortedPairs(labels?: Labels): Array<[string, string]> {
  if (!labels) return [];
  return Object.entries(labels)
    .map(([k, v]) => [k, String(v)] as [string, string])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function labelsToKey(labels?: Labels): string {
  const pairs = labelsToSortedPairs(labels);
  if (pairs.length === 0) return "";
  return pairs.map(([k, v]) => `${k}=${v}`).join(",");
}

function labelsToProm(labels?: Labels): string {
  const pairs = labelsToSortedPairs(labels);
  if (pairs.length === 0) return "";
  const rendered = pairs.map(
    ([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  );
  return `{${rendered.join(",")}}`;
}

function ensureCounter(metric: string): CounterState {
  const state = countersByMetric.get(metric);
  if (state) return state;
  const created = new Map<string, number>();
  countersByMetric.set(metric, created);
  return created;
}

function ensureGauge(metric: string): GaugeState {
  const state = gaugesByMetric.get(metric);
  if (state) return state;
  const created = new Map<string, number>();
  gaugesByMetric.set(metric, created);
  return created;
}

function ensureHistogram(metric: string, buckets: number[]) {
  const existing = histogramsByMetric.get(metric);
  const sanitized = [...new Set(buckets.filter((v) => Number.isFinite(v) && v > 0))].sort(
    (a, b) => a - b
  );
  if (existing) return existing;
  const created = {
    buckets: sanitized,
    entries: new Map<string, HistogramEntry>(),
  };
  histogramsByMetric.set(metric, created);
  return created;
}

function incrementCounter(metric: string, value = 1, labels?: Labels) {
  const state = ensureCounter(metric);
  const key = labelsToKey(labels);
  state.set(key, (state.get(key) ?? 0) + value);
}

function setGauge(metric: string, value: number, labels?: Labels) {
  const state = ensureGauge(metric);
  const key = labelsToKey(labels);
  state.set(key, value);
}

function observeHistogram(metric: string, value: number, buckets: number[], labels?: Labels) {
  if (!Number.isFinite(value) || value < 0) return;
  const hist = ensureHistogram(metric, buckets);
  const key = labelsToKey(labels);
  const entry =
    hist.entries.get(key) ??
    ({
      count: 0,
      sum: 0,
      buckets: new Array(hist.buckets.length).fill(0),
    } satisfies HistogramEntry);

  entry.count += 1;
  entry.sum += value;
  for (let i = 0; i < hist.buckets.length; i++) {
    if (value <= hist.buckets[i]) {
      entry.buckets[i] += 1;
    }
  }
  hist.entries.set(key, entry);
}

const HTTP_DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const FINALIZE_DURATION_BUCKETS_MS = [
  50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 180000, 600000,
];
const UPSTREAM_DURATION_BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];
const LOOKUP_DURATION_BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500];

export function recordHttpRequest(params: {
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
}) {
  const labels = {
    method: params.method.toUpperCase(),
    route: params.route,
    status: params.statusCode,
  };
  incrementCounter("floe_http_requests_total", 1, labels);
  observeHistogram(
    "floe_http_request_duration_ms",
    params.durationMs,
    HTTP_DURATION_BUCKETS_MS,
    labels
  );
}

export function setFinalizeQueueMetrics(params: {
  depth: number;
  pendingUnique: number;
  activeLocal: number;
}) {
  setGauge("floe_finalize_queue_depth", params.depth);
  setGauge("floe_finalize_queue_pending_unique", params.pendingUnique);
  setGauge("floe_finalize_workers_active", params.activeLocal);
}

export function recordFinalizeEnqueue(params: {
  result: "enqueued" | "duplicate" | "rejected_backpressure";
}) {
  incrementCounter("floe_finalize_enqueue_total", 1, { result: params.result });
}

export function recordFinalizeJobResult(params: {
  outcome: "success" | "failed" | "retry_lock";
  reason?: string;
  durationMs: number;
}) {
  incrementCounter("floe_finalize_jobs_total", 1, {
    outcome: params.outcome,
    reason: params.reason ?? "none",
  });
  observeHistogram(
    "floe_finalize_job_duration_ms",
    params.durationMs,
    FINALIZE_DURATION_BUCKETS_MS,
    {
      outcome: params.outcome,
    }
  );
}

export function observeWalrusPublish(params: {
  durationMs: number;
  outcome: "success" | "failure";
  mode: "sdk" | "cli";
  source?: "newly_created" | "already_certified" | "unknown";
}) {
  incrementCounter("floe_walrus_publish_total", 1, {
    outcome: params.outcome,
    mode: params.mode,
    source: params.source ?? "unknown",
  });
  observeHistogram(
    "floe_walrus_publish_duration_ms",
    params.durationMs,
    UPSTREAM_DURATION_BUCKETS_MS,
    {
      outcome: params.outcome,
      mode: params.mode,
    }
  );
}

export function observeSuiFinalize(params: {
  durationMs: number;
  outcome: "success" | "failure";
}) {
  incrementCounter("floe_sui_finalize_total", 1, { outcome: params.outcome });
  observeHistogram(
    "floe_sui_finalize_duration_ms",
    params.durationMs,
    UPSTREAM_DURATION_BUCKETS_MS,
    { outcome: params.outcome }
  );
}

export function recordStreamReadError(reason: string) {
  incrementCounter("floe_stream_read_errors_total", 1, {
    reason: reason || "unknown",
  });
}

export function observeMetadataLookup(params: {
  endpoint: "metadata" | "manifest" | "stream";
  source: "memory" | "redis" | "postgres" | "sui" | "unknown";
  durationMs: number;
}) {
  observeHistogram(
    "floe_metadata_lookup_duration_ms",
    params.durationMs,
    LOOKUP_DURATION_BUCKETS_MS,
    {
      endpoint: params.endpoint,
      source: params.source,
    }
  );
}

export function observeStreamTtfb(params: {
  range: "full" | "partial";
  durationMs: number;
}) {
  observeHistogram(
    "floe_stream_ttfb_ms",
    params.durationMs,
    LOOKUP_DURATION_BUCKETS_MS,
    {
      range: params.range,
    }
  );
}

export function observeWalrusSegmentFetch(params: {
  outcome:
    | "success"
    | "not_found"
    | "retryable_status"
    | "network_error"
    | "aborted"
    | "other_error";
  durationMs: number;
  statusClass?: "2xx" | "4xx" | "5xx" | "none";
}) {
  incrementCounter("floe_walrus_segment_fetch_total", 1, {
    outcome: params.outcome,
    statusClass: params.statusClass ?? "none",
  });
  observeHistogram(
    "floe_walrus_segment_fetch_duration_ms",
    params.durationMs,
    UPSTREAM_DURATION_BUCKETS_MS,
    {
      outcome: params.outcome,
      statusClass: params.statusClass ?? "none",
    }
  );
}

function renderCounter(metric: string, help: string): string[] {
  const lines = [
    `# HELP ${metric} ${help}`,
    `# TYPE ${metric} counter`,
  ];
  const state = countersByMetric.get(metric);
  if (!state) return lines;

  for (const [key, value] of [...state.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const labels = key
      ? Object.fromEntries(key.split(",").map((kv) => kv.split("=")))
      : undefined;
    lines.push(`${metric}${labelsToProm(labels)} ${value}`);
  }
  return lines;
}

function renderGauge(metric: string, help: string): string[] {
  const lines = [
    `# HELP ${metric} ${help}`,
    `# TYPE ${metric} gauge`,
  ];
  const state = gaugesByMetric.get(metric);
  if (!state) return lines;

  for (const [key, value] of [...state.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const labels = key
      ? Object.fromEntries(key.split(",").map((kv) => kv.split("=")))
      : undefined;
    lines.push(`${metric}${labelsToProm(labels)} ${value}`);
  }
  return lines;
}

function renderHistogram(metric: string, help: string): string[] {
  const lines = [
    `# HELP ${metric} ${help}`,
    `# TYPE ${metric} histogram`,
  ];
  const hist = histogramsByMetric.get(metric);
  if (!hist) return lines;

  for (const [key, entry] of [...hist.entries.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const baseLabels = key
      ? Object.fromEntries(key.split(",").map((kv) => kv.split("=")))
      : {};

    for (let i = 0; i < hist.buckets.length; i++) {
      const labels = { ...baseLabels, le: hist.buckets[i] };
      lines.push(`${metric}_bucket${labelsToProm(labels)} ${entry.buckets[i]}`);
    }
    lines.push(`${metric}_bucket${labelsToProm({ ...baseLabels, le: "+Inf" })} ${entry.count}`);
    lines.push(`${metric}_sum${labelsToProm(baseLabels)} ${entry.sum}`);
    lines.push(`${metric}_count${labelsToProm(baseLabels)} ${entry.count}`);
  }

  return lines;
}

export function renderPrometheusMetrics(): string {
  const lines: string[] = [];

  lines.push(
    ...renderCounter("floe_http_requests_total", "Total HTTP requests by route and status"),
    ...renderHistogram(
      "floe_http_request_duration_ms",
      "HTTP request duration in milliseconds"
    ),
    ...renderGauge("floe_finalize_queue_depth", "Current finalize queue depth"),
    ...renderGauge(
      "floe_finalize_queue_pending_unique",
      "Unique uploads pending finalization"
    ),
    ...renderGauge("floe_finalize_workers_active", "Active finalize workers in this process"),
    ...renderCounter(
      "floe_finalize_enqueue_total",
      "Finalize enqueue attempts by result"
    ),
    ...renderCounter("floe_finalize_jobs_total", "Finalize job outcomes"),
    ...renderHistogram(
      "floe_finalize_job_duration_ms",
      "Finalize job duration in milliseconds"
    ),
    ...renderCounter("floe_walrus_publish_total", "Walrus publish outcomes"),
    ...renderHistogram(
      "floe_walrus_publish_duration_ms",
      "Walrus publish duration in milliseconds"
    ),
    ...renderCounter("floe_sui_finalize_total", "Sui metadata finalize outcomes"),
    ...renderHistogram(
      "floe_sui_finalize_duration_ms",
      "Sui metadata finalize duration in milliseconds"
    ),
    ...renderCounter("floe_stream_read_errors_total", "Stream read errors by reason")
    ,
    ...renderHistogram(
      "floe_metadata_lookup_duration_ms",
      "File metadata lookup duration by endpoint and source in milliseconds"
    ),
    ...renderHistogram(
      "floe_stream_ttfb_ms",
      "Stream time-to-first-byte in milliseconds"
    ),
    ...renderCounter(
      "floe_walrus_segment_fetch_total",
      "Walrus segment fetch outcomes"
    ),
    ...renderHistogram(
      "floe_walrus_segment_fetch_duration_ms",
      "Walrus segment fetch duration in milliseconds"
    )
  );

  return `${lines.join("\n")}\n`;
}
