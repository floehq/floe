# Prometheus Alerting Rules — Floe

These rules are loaded by Prometheus via a `rules/floe.yml` file referenced
in the `rule_files` section of the Prometheus config:

```yaml
# prometheus.yml
rule_files:
  - rules/floe.yml
```

## Rule Groups

### `floe_service_health`

Alerts for overall service availability.

#### FloeApiDown

```yaml
alert: FloeApiDown
expr: |
  probe_success{job="floe"} == 0
  or
  absent(probe_success{job="floe"})
for: 1m
labels:
  severity: critical
annotations:
  summary: "Floe API is unreachable"
  description: |
    The Floe API at {{ $labels.instance }} has been unreachable for more than 1 minute.
    Check the reverse proxy, DNS, and the API process itself.
  runbook_url: "https://github.com/your-org/floe/docs/ops/alerting-rules.md#floeapidown"
```

**Runbook**: SSH into the host, check `docker ps` or `systemctl status floe`,
inspect logs, restart the process. Verify the reverse proxy is routing traffic
to the correct upstream port.

#### FloeHighErrorRate

```yaml
alert: FloeHighErrorRate
expr: |
  (
    sum(rate(floe_http_requests_total{status=~"5[0-9][0-9]"}[5m]))
    /
    sum(rate(floe_http_requests_total[5m]))
    > 0.05
  )
for: 5m
labels:
  severity: critical
annotations:
  summary: "Floe API error rate exceeds 5%"
  description: |
    The 5xx error rate over the last 5 minutes is {{ $value | humanizePercentage }}.
    This may indicate a code defect, dependency outage, or resource exhaustion.
  runbook_url: "https://github.com/your-org/floe/docs/ops/alerting-rules.md#floehigherrorrate"
```

**Runbook**:
1. Check Floe logs for stack traces grouped by route
2. Inspect downstream dependencies (Redis, Postgres, Sui RPC, Walrus)
3. Check circuit breaker metrics: `floe_circuit_breaker_state`
4. If errors are concentrated on a single route, roll back the most recent
   deployment for that component

### `floe_finalize_queue`

Alerts for the asynchronous finalization pipeline.

#### FloeFinalizeQueueGrowing

```yaml
alert: FloeFinalizeQueueGrowing
expr: floe_finalize_queue_depth > 10
for: 5m
labels:
  severity: warning
annotations:
  summary: "Finalize queue depth exceeds 10"
  description: |
    Queue depth is {{ $value }}. If this persists, finalization latency will
    degrade the user experience and may cause timeouts.
  runbook_url: "https://github.com/your-org/floe/docs/ops/alerting-rules.md#floefinalizequeuegrowing"
```

**Runbook**:
1. Inspect `floe_finalize_queue_oldest_age_ms` to determine if the queue is
   stuck or just busy
2. Check Walrus and Sui metrics for upstream failures:
   `floe_walrus_publish_total{outcome="failure"}`,
   `floe_sui_finalize_total{outcome="failure"}`
3. If downstream is healthy, tune `FLOE_FINALIZE_CONCURRENCY`
4. If downstream is failing, address the root cause first

#### FloeFinalizeStuckJobs

```yaml
alert: FloeFinalizeStuckJobs
expr: floe_finalize_queue_oldest_age_ms / 1000 > 600
for: 5m
labels:
  severity: critical
annotations:
  summary: "Finalize jobs stuck for more than 10 minutes"
  description: |
    The oldest queued finalize job is {{ $value | humanizeDuration }} old.
    Either the queue worker is stuck or downstream dependencies are hung.
  runbook_url: "https://github.com/your-org/floe/docs/ops/alerting-rules.md#floefinalizestuckjobs"
```

**Runbook**:
1. Check if the finalize worker is alive: `floe_finalize_workers_active`
2. Check circuit breaker states: `floe_circuit_breaker_state{state="3"}`
3. If Walrus is open, wait for the circuit breaker to half-close or
   manually reset by reducing pressure
4. If Sui is open, check signer balance and RPC health
5. As a last resort, restart the API process to re-queue stuck jobs

### `floe_circuit_breakers`

Alerts for the circuit breaker subsystem.

#### FloeCircuitBreakerOpen

```yaml
alert: FloeCircuitBreakerOpen
expr: floe_circuit_breaker_state{state="3"} > 0
for: 1m
labels:
  severity: warning
annotations:
  summary: "Circuit breaker {{ $labels.name }} is open"
  description: |
    The circuit breaker for {{ $labels.name }} has been open for over 1 minute.
    Requests to this dependency are being fast-failed.
  runbook_url: "https://github.com/your-org/floe/docs/ops/alerting-rules.md#floecircuitbreakeropen"
```

**Runbook**:
1. Identify the failed dependency from the `name` label (e.g.,
   `walrus_publish`, `sui_finalize`, `external_auth`)
2. Check the dependency's health and restore it
3. The circuit breaker will half-close after
   `FLOE_CB_{NAME}_OPEN_DURATION_MS` elapses; no manual action is needed
   once the downstream recovers
4. If the circuit breaker is toggling rapidly, investigate root cause
   rather than disabling the breaker

### `floe_signer`

Alerts for the Sui signer wallet.

#### FloeSuiBalanceLow

```yaml
alert: FloeSuiBalanceLow
expr: floe_signer_balance_sui < 100
for: 1m
labels:
  severity: critical
annotations:
  summary: "Sui signer balance below 100 SUI"
  description: |
    The Sui signer address has {{ $value }} SUI remaining. When the balance
    reaches zero, finalization will fail with insufficient gas errors.
  runbook_url: "https://github.com/your-org/floe/docs/ops/alerting-rules.md#floesuibalancelow"
```

**Note** — This alert consumes a metric (`floe_signer_balance_sui`) that Floe
does **not** export natively. You must produce it separately, for example
via a `cron` job or metric exporter that queries the Sui RPC:

```bash
#!/bin/bash
# /etc/cron.hourly/sui-balance-exporter
BALANCE=$(sui client gas --address 0x<SIGNER_ADDRESS> | grep -oP '[\d.]+(?= SUI)' | paste -sd+ | bc)
echo "floe_signer_balance_sui $BALANCE" > /var/lib/node_exporter/textfile/sui_balance.prom
```

**Runbook**:
1. Transfer SUI from the operational wallet to the signer address
2. Verify the transfer on-chain and check that finalization resumes
3. If balance drops repeatedly, review `floe_sui_finalize_total` volume
   and consider increasing the gas budget

### `floe_dependency_health`

Alerts for infrastructure dependencies.

#### FloeRedisDown

```yaml
alert: FloeRedisDown
expr: |
  floe_health_redis{status="unavailable"} == 1
for: 1m
labels:
  severity: critical
annotations:
  summary: "Redis is unavailable"
  description: |
    Floe reports Redis as unavailable. Upload control paths (create, chunk,
    complete) are blocked until Redis recovers.
  runbook_url: "https://github.com/your-org/floe/docs/ops/alerting-rules.md#floeredisdown"
```

**Note** — This rule uses a synthetic metric `floe_health_redis` that is not
exported by Floe natively. You can derive it from the `/health` endpoint or
create a blackbox probe. Alternatively, use Prometheus recording rules to
transform Floe's health status:

```yaml
# rules/floe.yml (recording rules section)
groups:
  - name: floe_health_recording
    rules:
      - record: floe_health_redis
        expr: |
          count by (status) (
            label_replace(
              count_over_time(
                {__name__=~"floe_instance_info"}[1m]
              ),
              "status",
              "healthy",
              "instance",
              ".*"
            )
          )
```

A simpler approach for production: configure Prometheus's
`blackbox_exporter` to probe `/health` and alert on non-200 responses:

```yaml
alert: FloeRedisDown
expr: |
  probe_success{target=~".*/health"} == 0
for: 1m
```

**Runbook**:
1. Check the managed Redis provider dashboard (Upstash, ElastiCache)
2. If self-hosted, SSH into the Redis host and check `redis-cli ping`
3. Restore Redis connectivity; Floe will recover automatically after
   startup re-queue
4. Restart one API instance after Redis returns

#### FloePostgresDown

```yaml
alert: FloePostgresDown
expr: |
  floe_health_postgres{status="unavailable"} == 1
for: 1m
labels:
  severity: warning
annotations:
  summary: "Postgres is unavailable"
  description: |
    Floe reports Postgres as unavailable. If FLOE_POSTGRES_REQUIRED=1 the
    API will be down. If FLOE_POSTGRES_REQUIRED=0 the API is degraded.
  runbook_url: "https://github.com/your-org/floe/docs/ops/alerting-rules.md#floepostgresdown"
```

**Runbook**:
1. Check the Postgres provider dashboard or `pg_isready`
2. If `FLOE_POSTGRES_REQUIRED=0`, the API will operate in degraded mode;
   read-model-backed features are non-authoritative
3. If `FLOE_POSTGRES_REQUIRED=1`, restore Postgres before the API can serve
4. After restoration, restart one API instance and confirm `/health` reports
   Postgres `healthy`

### `floe_slo`

Alerts for error budget consumption.

#### FloeSLOBudgetExhausted

```yaml
alert: FloeSLOBudgetExhausted
expr: |
  floe_sli_upload_error_budget_remaining < 0.10
  or
  floe_sli_stream_error_budget_remaining < 0.10
  or
  floe_sli_api_error_budget_remaining < 0.10
for: 5m
labels:
  severity: page
annotations:
  summary: "Error budget below 10% for {{ $labels.sli }}"
  description: |
    The error budget for {{ $labels.sli }} has {{ $value | humanizePercentage }} remaining.
    Burn rate is {{ with query "floe_sli_{$labels.sli}_burn_rate" }}{{ . | first | value }}{{ end }}.
    Action is required to avoid exhausting the SLO before the next window.
  runbook_url: "https://github.com/your-org/floe/docs/ops/alerting-rules.md#floeslobudgetexhausted"
```

**Runbook**:
1. Identify which SLI is burning budget: upload, stream, or API
2. For **upload** budget: inspect finalize failures and chunk upload errors
3. For **stream** budget: inspect Walrus segment fetch failures and TTFB
4. For **API** budget: inspect 5xx rates across all routes
5. If the burn rate is high, consider rolling back recent changes or
   reducing traffic (e.g., rate-limit public uploads)
6. Do not reset the error budget; the SLO window will roll naturally
7. Document the incident and consider adjusting SLO targets if the
   budget is consistently tight under normal operation

## Alert Summary Table

| Alert | Severity | Condition | Action |
|---|---|---|---|
| FloeApiDown | critical | `/health` 503 for 1m | Restart process / reverse proxy |
| FloeHighErrorRate | critical | 5xx > 5% for 5m | Inspect logs + dependencies |
| FloeFinalizeQueueGrowing | warning | depth > 10 for 5m | Check Walrus/Sui health |
| FloeFinalizeStuckJobs | critical | oldest job > 10m | Restart or clear stuck jobs |
| FloeCircuitBreakerOpen | warning | any CB open for 1m | Restore dependency |
| FloeSuiBalanceLow | critical | < 100 SUI | Top up signer wallet |
| FloeRedisDown | critical | redis unavailable | Restore Redis |
| FloePostgresDown | warning | postgres unavailable | Restore Postgres |
| FloeSLOBudgetExhausted | page | < 10% remaining | Investigate and roll back |

## Loading the Rules

Place the rules in a file that Prometheus can read:

```bash
mkdir -p /etc/prometheus/rules
cp rules/floe.yml /etc/prometheus/rules/

# prometheus.yml
rule_files:
  - rules/floe.yml
```

Reload Prometheus configuration:

```bash
curl -X POST http://localhost:9090/-/reload
```

Verify the rules are loaded at `http://localhost:9090/rules`.
