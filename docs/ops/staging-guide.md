# Staging Environment Guide

## 1. Purpose

Staging is a production-like environment for validating changes before they
touch the production Floe API. It runs the same code — same Docker images, same
git revision — but targets **testnet** Sui and **testnet** Walrus, so
finalization costs are negligible and no real assets are at risk.

Use staging for:

- Integration testing of code changes before production rollout
- Load testing against isolated Redis/Postgres instances
- Playbook rehearsal (key rotation, failover, restore)
- Operator training

## 2. Configuration Diff

The table below shows every `.env` value that differs between production and
staging. Copy the production `.env`, then override these keys.

| Variable | Production | Staging |
|---|---|---|
| `FLOE_NETWORK` | `mainnet` | `testnet` |
| `SUI_RPC_URL` | `https://fullnode.mainnet.sui.io:443` | `https://fullnode.testnet.sui.io:443` |
| `SUI_PACKAGE_ID` | mainnet package ID | testnet package ID |
| `WALRUS_AGGREGATOR_URL` | `https://aggregator.mainnet.walrus.space` | `https://aggregator.testnet.walrus.space` |
| `FLOE_WALRUS_SDK_BASE_URL` | publisher.mainnet | publisher.testnet |
| `FLOE_SIGNER_BACKEND` | `kms` | `env` |
| `SUI_PRIVATE_KEY` | KMS key ID | testnet keypair |
| `REDIS_URL` / `UPSTASH_REDIS_REST_URL` | prod Redis | staging Redis (different DB index) |
| `DATABASE_URL` | prod Postgres | staging Postgres (different database name) |
| `FLOE_HEALTH_CACHE_TTL_MS` | `1000` | `0` |
| `FLOE_PUBLIC_HEALTH_DETAILS` | `0` | `1` |

### Key Decisions Explained

**`FLOE_SIGNER_BACKEND=env`** — Staging uses testnet Sui, where gas has no
monetary value. There is no need for KMS. A locally configured testnet keypair
(obtained from the Sui faucet) is sufficient. This avoids KMS cost and
latency during development cycles.

**`FLOE_HEALTH_CACHE_TTL_MS=0`** — Disable the health-check result cache so
every probe reflects real-time dependency state. This makes debugging faster
because a stale "UP" response will not mask a recent failure.

**`FLOE_PUBLIC_HEALTH_DETAILS=1`** — The `/health` endpoint returns full
dependency detail (Redis, Postgres, S3, Walrus, queue stats) without
requiring an auth token. This simplifies curl-based debugging.

## 3. Infrastructure

Staging can run on:

- **Single VPS** — A small VM (2 vCPU, 4 GB RAM) is sufficient for most
  staging workloads. Run the same Docker Compose file as production, but
  with a staging `.env` override.
- **Same Compose as production** — If you already run production via Docker
  Compose, you can add a second set of services (`floe-api-staging`,
  `redis-staging`, `postgres-staging`) in the same compose file. Use the
  `--profile staging` mechanism or a separate override file.

Regardless of approach, staging should mirror the production deployment
model (same reverse proxy, same chunk store mode) so that deployment
tooling and runbooks are validated before production use.

## 4. Data Isolation

Staging **must not** share state with production.

| Resource | Isolation Strategy |
|---|---|
| **Redis** | Use a different Redis DB index (e.g., `SELECT 1` via `REDIS_URL`) or a completely separate Redis instance. |
| **Postgres** | Use a separate database name (e.g., `floe_staging`). Never share a database between prod and staging. |
| **Chunk staging (S3)** | Use a separate bucket or a `FLOE_S3_PREFIX` like `staging/`. |
| **Sui/Walrus** | Inherently isolated — testnet vs mainnet. |

## 5. Promotion

When you are ready to promote tested configuration to production:

```bash
# Diff the current staging .env against production
diff .env.staging .env.production
```

The diff should only show the variables listed in section 2. If it shows
more, investigate before promoting.

### Promotion Steps

1. Confirm the staging checksum (git SHA) matches what you intend to deploy
2. Copy staging config values for the non-secret keys into production config
3. Deploy secrets (SUI_PRIVATE_KEY, DATABASE_URL, etc.) from the secrets
   manager — never copy secret values from `.env` files
4. Perform a rolling restart of production instances
5. Run smoke tests (section 6) against production

## 6. Smoke Tests

After deploying staging, verify the following curl commands succeed:

### 6.1 Health Check

```bash
# Full detail because FLOE_PUBLIC_HEALTH_DETAILS=1
curl -s http://localhost:3001/health | jq .
```

Expected: `"status": "UP"`, `"ready": true`

### 6.2 Upload and Finalize

```bash
# Create an upload session
UPLOAD=$(curl -s -X POST http://localhost:3001/v1/uploads/create \
  -H "Content-Type: application/json" \
  -d '{"fileSizeBytes": 1048576}' | jq -r '.uploadId')
echo "Upload ID: $UPLOAD"

# Upload a chunk (1 MiB of zeroes)
dd if=/dev/zero bs=1024 count=1024 | \
  curl -s -X PUT "http://localhost:3001/v1/uploads/$UPLOAD/chunk/0" \
    --data-binary @- | jq .

# Complete the upload
curl -s -X POST "http://localhost:3001/v1/uploads/$UPLOAD/complete" | jq .

# Poll status until terminal
for i in $(seq 1 30); do
  STATUS=$(curl -s "http://localhost:3001/v1/uploads/$UPLOAD/status" | jq -r '.status')
  echo "Attempt $i: $STATUS"
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then break; fi
  sleep 2
done
```

### 6.3 Metrics Endpoint

```bash
curl -s http://localhost:3001/metrics | grep -E '^(floe_http_requests_total|floe_finalize_)'
```

Expected: non-empty metric output.

### 6.4 Redis and Postgres Health

```bash
curl -s http://localhost:3001/health | jq '.checks.redis, .checks.postgres'
```

Expected: both should show `"healthy"` (or `"disabled"` for Postgres if
`FLOE_POSTGRES_REQUIRED=0`).

### 6.5 Finalize Queue

```bash
curl -s http://localhost:3001/health | jq '.checks.finalizeQueue'
```

Expected: `"depth"` should be 0 after the test upload finishes.
