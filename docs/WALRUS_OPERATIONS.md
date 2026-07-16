# Walrus Operations

This document covers self-hosted aggregator and publisher deployment, nginx caching in front of aggregators, and the publisher `--max-body-size` constraint that must be respected for large uploads to succeed.

## Self-Hosted Aggregator + Publisher Deployment

When Floe is configured with `FLOE_WALRUS_STORE_MODE=publisher`, uploads hit a self-hosted Walrus publisher directly (via `FLOE_WALRUS_PUBLISHER_BASE_URL[S]`). This gives the operator full control over upload bandwidth, retry behavior, and acceptance thresholds.

### Publisher `--max-body-size` Requirement

The Walrus publisher process enforces an HTTP body size limit via its `--max-body-size` flag (or `--max-body-size-bytes` on some builds). Floe's `FLOE_AUTH_MAX_FILE_SIZE_BYTES` must not exceed the publisher's accepted size, otherwise the publisher will reject large uploads with an HTTP `413` before any Walrus protocol processing occurs.

The default `FLOE_AUTH_MAX_FILE_SIZE_BYTES` is `15 GiB` for authenticated uploads.

When starting the publisher, set the corresponding flag:

```bash
walrus-publisher --max-body-size 15GiB   # or --max-body-size-bytes 16106127360
```

At startup, Floe emits a warning when `FLOE_AUTH_MAX_FILE_SIZE_BYTES` exceeds `10 MiB` in publisher mode, reminding operators to confirm the publisher is started with a matching `--max-body-size`.

For public-facing instances where `FLOE_PUBLIC_MAX_FILE_SIZE_BYTES` is the effective limit, confirm that the publisher's `--max-body-size` covers the larger of the two thresholds.

## Self-Hosted Aggregator Caching with nginx

Floe reads blobs via `WALRUS_AGGREGATOR_URL` (primary) and `WALRUS_AGGREGATOR_FALLBACK_URLS` (fallbacks). Public aggregators have rate limits and variable latency. Running your own aggregator behind nginx with `proxy_cache` provides:

- Consistent low-latency reads for hot content
- Reduced egress to upstream aggregators
- Immunity from public aggregator rate limits and downtime

### Recommended nginx Configuration

```nginx
upstream walrus_aggregator {
    server 10.0.0.5:3141;   # your aggregator node
    keepalive 32;
}

proxy_cache_path /var/cache/walrus
    levels=1:2
    keys_zone=walrus_cache:64m
    max_size=500g
    inactive=7d
    use_temp_path=off;

server {
    listen 3142;
    server_name _;

    # Proxy blob reads; cache responses from upstream
    location /v1/blobs/ {
        proxy_pass http://walrus_aggregator;

        proxy_http_version 1.1;
        proxy_set_header Connection "";

        # Cache successful reads for 24h; revalidate in background
        proxy_cache walrus_cache;
        proxy_cache_valid 200 24h;
        proxy_cache_valid 404 1m;
        proxy_cache_use_stale error timeout updating http_500 http_502 http_503;
        proxy_cache_lock on;
        proxy_cache_lock_timeout 5s;

        add_header X-Cache-Status $upstream_cache_status always;
    }

    # Proxy cache-management endpoints through to the aggregator
    location /v1/blobs {
        proxy_pass http://walrus_aggregator;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
    }

    # Health endpoint for monitoring
    location /v1/health {
        proxy_pass http://walrus_aggregator;
    }
}
```

Then point Floe at the nginx cache:

```dotenv
WALRUS_AGGREGATOR_URL=http://your-nginx-host:3142
WALRUS_AGGREGATOR_FALLBACK_URLS=https://aggregator.walrus-testnet.walrus.space,https://aggregator.walrus.mainnet.walrus.space
```

### Cache Storage on NVMe / tmpfs

For high-throughput deployments, use fast local storage:

- **NVMe RAID0**: Mount at `/var/cache/walrus`, run `proxy_cache_path` against it. Provides high IOPS for large blob reads under concurrent load.
- **tmpfs**: If blobs are small enough to fit in RAM (e.g., < 100 GiB working set), mount a tmpfs at `/var/cache/walrus`. This avoids disk I/O entirely but requires sufficient memory.

For NVMe RAID0, the filesystem is typically ext4 or xfs. For tmpfs, ensure the memory allocation is sufficient for your working set:

```bash
# tmpfs example: 128 GB RAM allocation
mount -t tmpfs -o size=128G tmpfs /var/cache/walrus
```

### Cache-Control and Expires Behavior

The nginx `proxy_cache` layer respects upstream `Cache-Control` and `Expires` headers from the aggregator. If the upstream aggregator does not set these headers, nginx falls back to the `proxy_cache_valid` directive values.

When using `proxy_cache_valid 200 24h`, nginx caches every successful response for 24 hours regardless of upstream headers. Set a shorter duration (e.g., `1h`) if upstream blobs are frequently updated or if storage is constrained.

### Fallback URL Semantics

Floe's read path tries `WALRUS_AGGREGATOR_URL` first. On failure or timeout (default `600000ms`), it falls through to `WALRUS_AGGREGATOR_FALLBACK_URLS` in order.

When running a self-hosted aggregator, always configure public aggregators as fallbacks to avoid data loss during self-hosted aggregator maintenance.

## Deploying Publisher + Aggregator on the Same Node

When the publisher and aggregator run on the same machine:

1. The publisher accepts uploads on `FLOE_WALRUS_PUBLISHER_BASE_URL`
2. The aggregator serves reads on a different port
3. nginx sits in front of the aggregator for caching

A combined setup on one node:

```
Floe API (port 3001)
    ├── PUT → Walrus Publisher (port 3141)
    └── GET → nginx cache (port 3142)
                └── upstream: Walrus Aggregator (port 3143)
```

Ensure the publisher and aggregator use separate ports. The publisher does not serve read requests and the aggregator does not accept uploads.

## Health Monitoring

Monitor both the aggregator and publisher:

```bash
# Aggregator health
curl -s http://localhost:3143/v1/health | jq .

# nginx cache status (enable in your location block)
curl -sI http://localhost:3142/v1/blobs/<blob-id> | grep X-Cache-Status
# HIT = served from cache, MISS = fetched from aggregator, STALE = served stale during upstream failure
```

Alert on:
- Sustained cache MISS rate above 50% (indicates cold content or cache sizing issue)
- `X-Cache-Status: UPDATING` for extended periods (indicates slow upstream)
- Publisher HTTP 413 responses (indicates `--max-body-size` misalignment)
