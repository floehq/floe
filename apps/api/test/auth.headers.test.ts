import test from "node:test";
import assert from "node:assert/strict";

import { applyRateLimitHeaders } from "../src/services/auth/auth.headers.ts";

test("applyRateLimitHeaders uses remaining time until reset for Retry-After", () => {
  const headers: Record<string, string> = {};
  const reply = {
    header(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return this;
    },
  } as any;

  applyRateLimitHeaders(reply, {
    allowed: false,
    current: 11,
    limit: 10,
    windowSeconds: 60,
    retryAfterSeconds: 2,
    identity: {
      authenticated: false,
      method: "public",
      subject: "public:test",
      scopes: [],
      tier: "public",
    },
  });

  assert.equal(headers["x-ratelimit-limit"], "10");
  assert.equal(headers["x-ratelimit-remaining"], "0");
  assert.equal(headers["x-ratelimit-window"], "60");
  assert.equal(headers["retry-after"], "2");
});
