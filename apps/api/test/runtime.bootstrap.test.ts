import test from "node:test";
import assert from "node:assert/strict";

import {
  applyRuntimeConfig,
  normalizeRuntimeConfig,
  parseBootstrapNodeRole,
  parseRuntimeArgs,
} from "../src/config/runtime.bootstrap.ts";

test("parseRuntimeArgs reads config path and role flags", () => {
  const parsed = parseRuntimeArgs([
    "--config",
    "./config/floe.yaml",
    "--role=write",
  ]);

  assert.equal(parsed.configPath, "./config/floe.yaml");
  assert.equal(parsed.role, "write");
});

test("normalizeRuntimeConfig validates structured topology config", () => {
  const config = normalizeRuntimeConfig({
    node: { role: "read" },
    http: { port: 4100, corsOrigins: ["http://localhost:3000"], trustProxy: true },
    walrus: {
      readers: ["https://reader-1.example.com", "https://reader-2.example.com"],
      writers: ["https://writer-1.example.com", "https://writer-2.example.com"],
    },
    metrics: { enabled: true },
  });

  assert.equal(config.node?.role, "read");
  assert.equal(config.http?.port, 4100);
  assert.deepEqual(config.http?.corsOrigins, ["http://localhost:3000"]);
  assert.equal(config.http?.trustProxy, true);
  assert.deepEqual(config.walrus?.readers, [
    "https://reader-1.example.com",
    "https://reader-2.example.com",
  ]);
  assert.deepEqual(config.walrus?.writers, [
    "https://writer-1.example.com",
    "https://writer-2.example.com",
  ]);
  assert.equal(config.metrics?.enabled, true);
});

test("applyRuntimeConfig projects yaml topology values into env defaults", () => {
  const original = {
    FLOE_NODE_ROLE: process.env.FLOE_NODE_ROLE,
    PORT: process.env.PORT,
    FLOE_CORS_ORIGINS: process.env.FLOE_CORS_ORIGINS,
    FLOE_TRUST_PROXY: process.env.FLOE_TRUST_PROXY,
    WALRUS_AGGREGATOR_URL: process.env.WALRUS_AGGREGATOR_URL,
    WALRUS_AGGREGATOR_FALLBACK_URLS: process.env.WALRUS_AGGREGATOR_FALLBACK_URLS,
    FLOE_WALRUS_SDK_BASE_URL: process.env.FLOE_WALRUS_SDK_BASE_URL,
    FLOE_WALRUS_SDK_BASE_URLS: process.env.FLOE_WALRUS_SDK_BASE_URLS,
    FLOE_ENABLE_METRICS: process.env.FLOE_ENABLE_METRICS,
  };

  delete process.env.FLOE_NODE_ROLE;
  delete process.env.PORT;
  delete process.env.FLOE_CORS_ORIGINS;
  delete process.env.FLOE_TRUST_PROXY;
  delete process.env.WALRUS_AGGREGATOR_URL;
  delete process.env.WALRUS_AGGREGATOR_FALLBACK_URLS;
  delete process.env.FLOE_WALRUS_SDK_BASE_URL;
  delete process.env.FLOE_WALRUS_SDK_BASE_URLS;
  delete process.env.FLOE_ENABLE_METRICS;

  try {
    applyRuntimeConfig(
      {
        node: { role: "full" },
        http: {
          port: 3001,
          corsOrigins: ["http://localhost:3000", "http://localhost:5173"],
          trustProxy: true,
        },
        walrus: {
          readers: ["https://reader-1.example.com", "https://reader-2.example.com"],
          writers: ["https://writer-1.example.com", "https://writer-2.example.com"],
        },
        metrics: { enabled: false },
      },
      "write"
    );

    assert.equal(process.env.FLOE_NODE_ROLE, "write");
    assert.equal(process.env.PORT, "3001");
    assert.equal(process.env.FLOE_CORS_ORIGINS, "http://localhost:3000,http://localhost:5173");
    assert.equal(process.env.FLOE_TRUST_PROXY, "1");
    assert.equal(process.env.WALRUS_AGGREGATOR_URL, "https://reader-1.example.com");
    assert.equal(
      process.env.WALRUS_AGGREGATOR_FALLBACK_URLS,
      "https://reader-2.example.com"
    );
    assert.equal(process.env.FLOE_WALRUS_SDK_BASE_URL, "https://writer-1.example.com");
    assert.equal(
      process.env.FLOE_WALRUS_SDK_BASE_URLS,
      "https://writer-1.example.com,https://writer-2.example.com"
    );
    assert.equal(process.env.FLOE_ENABLE_METRICS, "0");
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("parseBootstrapNodeRole rejects invalid roles", () => {
  assert.throws(() => parseBootstrapNodeRole("sidecar" as any), /FLOE_NODE_ROLE/);
});
