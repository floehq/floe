import test from "node:test";
import assert from "node:assert/strict";

import { setRedisForTests } from "../src/state/redis.js";
import {
  setPostgresForTests,
  isPostgresConfigured,
  isPostgresRequired,
} from "../src/state/postgres.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubRedis(pingFn?: () => Promise<unknown>) {
  setRedisForTests({
    ping: pingFn ?? (async () => "PONG"),
  } as any);
}

function stubPostgresPool(opts?: { queryFn?: () => Promise<unknown> }) {
  return {
    query: opts?.queryFn ?? (async () => ({ rows: [], rowCount: 1 })),
    connect: async () => ({ release: () => {} }),
    end: async () => {},
  } as any;
}

// ---------------------------------------------------------------------------
// checkRedisDependencyHealth
// ---------------------------------------------------------------------------

test("checkRedisDependencyHealth returns healthy when ping succeeds", async () => {
  stubRedis(async () => "PONG");
  const { checkRedisDependencyHealth } = await import(
    "../src/services/health/dependencies.ts"
  );

  const result = await checkRedisDependencyHealth();
  assert.equal(result.ok, true);
  assert.equal(result.status, "healthy");
  assert.equal(typeof result.latencyMs, "number");
  assert.ok(result.latencyMs! >= 0);
  assert.equal(typeof result.timestamp, "string");
});

test("checkRedisDependencyHealth returns unavailable when redis not initialized", async () => {
  setRedisForTests(null);
  const { checkRedisDependencyHealth } = await import(
    "../src/services/health/dependencies.ts"
  );

  const result = await checkRedisDependencyHealth();
  assert.equal(result.ok, false);
  assert.equal(result.status, "unavailable");
  assert.equal(result.latencyMs, null);
  assert.equal(typeof result.timestamp, "string");
});

test("checkRedisDependencyHealth returns unavailable when ping throws", async () => {
  stubRedis(async () => {
    throw new Error("ECONNREFUSED");
  });
  const { checkRedisDependencyHealth } = await import(
    "../src/services/health/dependencies.ts"
  );

  const result = await checkRedisDependencyHealth();
  assert.equal(result.ok, false);
  assert.equal(result.status, "unavailable");
  assert.equal(result.latencyMs, null);
});

test("checkRedisDependencyHealth reports latency on success", async () => {
  stubRedis(async () => {
    await new Promise((r) => setTimeout(r, 10));
    return "PONG";
  });
  const { checkRedisDependencyHealth } = await import(
    "../src/services/health/dependencies.ts"
  );

  const result = await checkRedisDependencyHealth();
  assert.equal(result.ok, true);
  assert.ok(result.latencyMs! >= 5, `expected latencyMs >= 5, got ${result.latencyMs}`);
});

// ---------------------------------------------------------------------------
// checkPostgresDependencyHealth
// ---------------------------------------------------------------------------

test("checkPostgresDependencyHealth returns disabled when DATABASE_URL not set", async () => {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  setPostgresForTests(null, false);

  const { checkPostgresDependencyHealth } = await import(
    "../src/services/health/dependencies.ts"
  );

  try {
    assert.equal(isPostgresConfigured(), false);
    const result = await checkPostgresDependencyHealth();
    assert.equal(result.configured, false);
    assert.equal(result.enabled, false);
    assert.equal(result.ok, null);
    assert.equal(result.latencyMs, null);
    assert.equal(result.status, "disabled");
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
  }
});

test("checkPostgresDependencyHealth returns disabled when not configured even if required", async () => {
  const prevUrl = process.env.DATABASE_URL;
  const prevReq = process.env.FLOE_POSTGRES_REQUIRED;
  delete process.env.DATABASE_URL;
  process.env.FLOE_POSTGRES_REQUIRED = "true";
  setPostgresForTests(null, false);

  const { checkPostgresDependencyHealth } = await import(
    "../src/services/health/dependencies.ts"
  );

  try {
    assert.equal(isPostgresRequired(), true);
    const result = await checkPostgresDependencyHealth();
    assert.equal(result.configured, false);
    assert.equal(result.status, "disabled");
    assert.equal(result.required, true);
  } finally {
    if (prevUrl !== undefined) process.env.DATABASE_URL = prevUrl;
    else delete process.env.DATABASE_URL;
    if (prevReq !== undefined) process.env.FLOE_POSTGRES_REQUIRED = prevReq;
    else delete process.env.FLOE_POSTGRES_REQUIRED;
  }
});

test("checkPostgresDependencyHealth returns healthy when pool responds to select 1", async () => {
  process.env.DATABASE_URL = "postgresql://localhost:5432/test";
  const mockPool = stubPostgresPool({
    queryFn: async () => ({ rows: [{ "?column?": 1 }], rowCount: 1 }),
  });
  setPostgresForTests(mockPool, true);

  const { checkPostgresDependencyHealth } = await import(
    "../src/services/health/dependencies.ts"
  );

  const result = await checkPostgresDependencyHealth();
  assert.equal(result.configured, true);
  assert.equal(result.enabled, true);
  assert.equal(result.ok, true);
  assert.equal(typeof result.latencyMs, "number");
  assert.ok(result.latencyMs! >= 0);
  assert.equal(result.status, "healthy");
});

test("checkPostgresDependencyHealth returns unavailable when configured but pool.query fails and required", async () => {
  process.env.DATABASE_URL = "postgresql://localhost:5432/test";
  process.env.FLOE_POSTGRES_REQUIRED = "true";
  const mockPool = stubPostgresPool({
    queryFn: async () => {
      throw new Error("connection refused");
    },
  });
  setPostgresForTests(mockPool, true);

  const { checkPostgresDependencyHealth } = await import(
    "../src/services/health/dependencies.ts"
  );

  try {
    const result = await checkPostgresDependencyHealth();
    assert.equal(result.configured, true);
    assert.equal(result.ok, false);
    assert.equal(result.status, "unavailable");
    assert.equal(result.required, true);
  } finally {
    delete process.env.FLOE_POSTGRES_REQUIRED;
  }
});

test("checkPostgresDependencyHealth returns degraded when configured but pool.query fails and not required", async () => {
  process.env.DATABASE_URL = "postgresql://localhost:5432/test";
  delete process.env.FLOE_POSTGRES_REQUIRED;
  const mockPool = stubPostgresPool({
    queryFn: async () => {
      throw new Error("connection refused");
    },
  });
  setPostgresForTests(mockPool, true);

  const { checkPostgresDependencyHealth } = await import(
    "../src/services/health/dependencies.ts"
  );

  const result = await checkPostgresDependencyHealth();
  assert.equal(result.configured, true);
  assert.equal(result.ok, false);
  assert.equal(result.status, "degraded");
  assert.equal(result.required, false);
});

test("checkPostgresDependencyHealth returns unavailable when DATABASE_URL set but pool not initialized", async () => {
  process.env.DATABASE_URL = "postgresql://localhost:5432/test";
  setPostgresForTests(null, false);

  const { checkPostgresDependencyHealth } = await import(
    "../src/services/health/dependencies.ts"
  );

  const result = await checkPostgresDependencyHealth();
  assert.equal(result.configured, true);
  assert.equal(result.ok, false);
  assert.equal(result.status, "degraded");
});

// ---------------------------------------------------------------------------
// checkWalrusDependencyHealth
// ---------------------------------------------------------------------------

test("checkWalrusDependencyHealth returns healthy when aggregator responds 200", async () => {
  const url = "https://aggregator.example.com";
  process.env.WALRUS_AGGREGATOR_URL = url;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 200 }) as any;

  try {
    const { checkWalrusDependencyHealth } = await import(
      "../src/services/health/dependencies.ts"
    );

    const result = await checkWalrusDependencyHealth();
    assert.equal(result.configured, true);
    assert.equal(result.ok, true);
    assert.equal(result.status, "healthy");
    assert.equal(result.primaryUrl, url);
    assert.equal(typeof result.latencyMs, "number");
    assert.ok(result.latencyMs! >= 0);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.WALRUS_AGGREGATOR_URL;
  }
});

test("checkWalrusDependencyHealth returns healthy for 4xx (status < 500)", async () => {
  process.env.WALRUS_AGGREGATOR_URL = "https://agg.example.com";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 404 }) as any;

  try {
    const { checkWalrusDependencyHealth } = await import(
      "../src/services/health/dependencies.ts"
    );

    const result = await checkWalrusDependencyHealth();
    assert.equal(result.ok, true);
    assert.equal(result.status, "healthy");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.WALRUS_AGGREGATOR_URL;
  }
});

test("checkWalrusDependencyHealth returns degraded for 5xx (status >= 500)", async () => {
  process.env.WALRUS_AGGREGATOR_URL = "https://agg.example.com";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 500 }) as any;

  try {
    const { checkWalrusDependencyHealth } = await import(
      "../src/services/health/dependencies.ts"
    );

    const result = await checkWalrusDependencyHealth();
    assert.equal(result.ok, false);
    assert.equal(result.status, "degraded");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.WALRUS_AGGREGATOR_URL;
  }
});

test("checkWalrusDependencyHealth returns unavailable when fetch throws", async () => {
  process.env.WALRUS_AGGREGATOR_URL = "https://agg.example.com";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("fetch failed");
  };

  try {
    const { checkWalrusDependencyHealth } = await import(
      "../src/services/health/dependencies.ts"
    );

    const result = await checkWalrusDependencyHealth();
    assert.equal(result.configured, true);
    assert.equal(result.ok, false);
    assert.equal(result.status, "unavailable");
    assert.equal(typeof result.latencyMs, "number");
    assert.ok(result.latencyMs! >= 0);
    assert.equal(result.primaryUrl, "https://agg.example.com");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.WALRUS_AGGREGATOR_URL;
  }
});

test("checkWalrusDependencyHealth uses first URL as primary", async () => {
  process.env.WALRUS_AGGREGATOR_URL = "https://primary.example.com";
  process.env.WALRUS_AGGREGATOR_FALLBACK_URLS = "https://fallback.example.com";

  const originalFetch = globalThis.fetch;
  let requestedUrl: string | undefined;
  globalThis.fetch = async (url: any) => {
    requestedUrl = String(url);
    return new Response(null, { status: 200 }) as any;
  };

  try {
    const { checkWalrusDependencyHealth } = await import(
      "../src/services/health/dependencies.ts"
    );

    const result = await checkWalrusDependencyHealth();
    assert.equal(result.primaryUrl, "https://primary.example.com");
    assert.ok(requestedUrl!.startsWith("https://primary.example.com/v1"));
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.WALRUS_AGGREGATOR_URL;
    delete process.env.WALRUS_AGGREGATOR_FALLBACK_URLS;
  }
});

test("checkWalrusDependencyHealth reports latency on success", async () => {
  process.env.WALRUS_AGGREGATOR_URL = "https://agg.example.com";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    await new Promise((r) => setTimeout(r, 15));
    return new Response(null, { status: 200 }) as any;
  };

  try {
    const { checkWalrusDependencyHealth } = await import(
      "../src/services/health/dependencies.ts"
    );

    const result = await checkWalrusDependencyHealth();
    assert.ok(
      result.latencyMs! >= 10,
      `expected latencyMs >= 10, got ${result.latencyMs}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.WALRUS_AGGREGATOR_URL;
  }
});

test("checkWalrusDependencyHealth returns unavailable on abort timeout", async () => {
  process.env.WALRUS_AGGREGATOR_URL = "https://slow.example.com";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url: any, init: any) => {
    const signal = init?.signal as AbortSignal | undefined;
    return await new Promise((_resolve, reject) => {
      if (signal) {
        signal.addEventListener("abort", () => {
          reject(
            Object.assign(new Error("The operation was aborted"), {
              name: "AbortError",
            }),
          );
        });
      }
    });
  };

  try {
    const { checkWalrusDependencyHealth } = await import(
      "../src/services/health/dependencies.ts"
    );

    const result = await checkWalrusDependencyHealth();
    assert.equal(result.ok, false);
    assert.equal(result.status, "unavailable");
    assert.equal(result.configured, true);
    assert.equal(typeof result.latencyMs, "number");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.WALRUS_AGGREGATOR_URL;
  }
});

// ---------------------------------------------------------------------------
// checkS3Health (re-exported from s3.ts)
// ---------------------------------------------------------------------------

test("checkS3Health returns disabled when FLOE_CHUNK_STORE_MODE is not s3", async () => {
  const prev = process.env.FLOE_CHUNK_STORE_MODE;
  process.env.FLOE_CHUNK_STORE_MODE = "memory";

  const { checkS3Health } = await import("../src/services/health/dependencies.ts");

  try {
    const result = await checkS3Health();
    assert.equal(result.configured, false);
    assert.equal(result.ok, null);
    assert.equal(result.latencyMs, null);
    assert.equal(result.status, "disabled");
  } finally {
    if (prev !== undefined) process.env.FLOE_CHUNK_STORE_MODE = prev;
    else delete process.env.FLOE_CHUNK_STORE_MODE;
  }
});

test("checkS3Health returns disabled when FLOE_S3_BUCKET is empty", async () => {
  const prevMode = process.env.FLOE_CHUNK_STORE_MODE;
  const prevBucket = process.env.FLOE_S3_BUCKET;
  process.env.FLOE_CHUNK_STORE_MODE = "s3";
  delete process.env.FLOE_S3_BUCKET;

  const { checkS3Health } = await import("../src/services/health/dependencies.ts");

  try {
    const result = await checkS3Health();
    assert.equal(result.configured, false);
    assert.equal(result.ok, null);
    assert.equal(result.latencyMs, null);
    assert.equal(result.status, "disabled");
  } finally {
    if (prevMode !== undefined) process.env.FLOE_CHUNK_STORE_MODE = prevMode;
    else delete process.env.FLOE_CHUNK_STORE_MODE;
    if (prevBucket !== undefined) process.env.FLOE_S3_BUCKET = prevBucket;
    else delete process.env.FLOE_S3_BUCKET;
  }
});

test("checkS3Health returns unavailable when S3 endpoint is unreachable", async () => {
  process.env.FLOE_CHUNK_STORE_MODE = "s3";
  process.env.FLOE_S3_BUCKET = "test-bucket";
  process.env.FLOE_S3_ENDPOINT = "http://localhost:19999";

  const { checkS3Health } = await import("../src/services/health/dependencies.ts");

  try {
    const result = await checkS3Health();
    assert.equal(result.configured, true);
    assert.equal(result.ok, false);
    assert.equal(result.status, "unavailable");
    assert.equal(typeof result.latencyMs, "number");
  } finally {
    delete process.env.FLOE_CHUNK_STORE_MODE;
    delete process.env.FLOE_S3_BUCKET;
    delete process.env.FLOE_S3_ENDPOINT;
  }
});
