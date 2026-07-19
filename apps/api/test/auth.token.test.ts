import crypto from "node:crypto";

// Set env vars BEFORE any config import (auth.config.ts runs side effects at load time)
process.env.FLOE_ACCESS_POLICY = "hybrid";
process.env.FLOE_AUTH_PROVIDER = "token";
process.env.FLOE_API_KEY_STORE = "env";
process.env.FLOE_AUTH_TOKEN_SECRET = "test-secret-key-for-unit-tests";

const { buildTokenAuthContext, signDelegatedAuthTokenForTests } = await import(
  "../src/services/auth/auth.token.ts"
);
const { AuthTokenConfig } = await import("../src/config/auth.config.ts");

import test from "node:test";
import assert from "node:assert/strict";

const SECRET = "test-secret-key-for-unit-tests";
const ISSUER = "https://floe.test";
const AUDIENCE = "floe-api";

function base64UrlEncode(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sign(claims: Record<string, unknown>, secret = SECRET): string {
  return signDelegatedAuthTokenForTests(claims as any, secret);
}

function reqWithAuthHeader(token: string) {
  return { headers: { authorization: `Bearer ${token}` } } as any;
}

function reqWithApiKey(key: string) {
  return { headers: { "x-api-key": key } } as any;
}

function reqNoAuth() {
  return { headers: {} } as any;
}

function withConfig<T>(overrides: Partial<typeof AuthTokenConfig>, fn: () => T): T {
  const saved = {
    secret: AuthTokenConfig.secret,
    issuer: AuthTokenConfig.issuer,
    audience: AuthTokenConfig.audience,
  };
  try {
    Object.assign(AuthTokenConfig, overrides);
    return fn();
  } finally {
    Object.assign(AuthTokenConfig, saved);
  }
}

// ─── signDelegatedAuthTokenForTests ───

test("signDelegatedAuthTokenForTests produces a valid two-part token", () => {
  const claims = {
    sub: "user-1",
    scopes: ["uploads:write"],
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const token = sign(claims);
  const parts = token.split(".");
  assert.equal(parts.length, 2, "token must have exactly 2 parts");
  assert.ok(parts[0].length > 0, "payload part must not be empty");
  assert.ok(parts[1].length > 0, "signature part must not be empty");
});

test("signDelegatedAuthTokenForTests is deterministic for same input", () => {
  const claims = { sub: "user-2", scopes: ["files:read"], exp: 1700000000 };
  assert.equal(sign(claims), sign(claims));
});

test("signDelegatedAuthTokenForTests differs for different secrets", () => {
  const claims = { sub: "u", scopes: ["s"], exp: 1700000000 };
  assert.notEqual(sign(claims, "secret-a"), sign(claims, "secret-b"));
});

// ─── base64url round-trip (via various padding lengths) ───

test("base64url round-trip handles all padding edge cases", () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  for (const s of ["a", "ab", "abc", "abcd", "abcde", "abcdef"]) {
    const claims = { sub: s, scopes: ["x"], exp: futureExp };
    const ctx = buildTokenAuthContext(reqWithAuthHeader(sign(claims)));
    assert.ok(ctx, `round-trip must work for sub="${s}"`);
  }
});

// ─── buildTokenAuthContext: happy paths ───

test("returns valid AuthContext for a well-formed token", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const claims = {
      sub: "user-123",
      subjectType: "user",
      scopes: ["uploads:write", "files:read"],
      exp,
    };
    const ctx = buildTokenAuthContext(reqWithAuthHeader(sign(claims)));
    assert.ok(ctx);
    assert.equal(ctx.authenticated, true);
    assert.equal(ctx.provider, "token");
    assert.equal(ctx.method, "token");
    assert.equal(ctx.subjectType, "user");
    assert.equal(ctx.subjectId, "user-123");
    assert.equal(ctx.subject, "user:user-123");
    assert.deepEqual(ctx.scopes, ["uploads:write", "files:read"]);
    assert.equal(ctx.tier, "authenticated");
    assert.equal(ctx.credentialType, "bearer");
    assert.ok(ctx.expiresAt);
    assert.equal(new Date(ctx.expiresAt!).getTime(), exp * 1000);
  });
});

test("defaults subjectType to 'user' when omitted", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: "u1", scopes: ["s1"], exp: Math.floor(Date.now() / 1000) + 600 };
    const ctx = buildTokenAuthContext(reqWithAuthHeader(sign(claims)));
    assert.ok(ctx);
    assert.equal(ctx.subjectType, "user");
    assert.equal(ctx.subject, "user:u1");
  });
});

test("defaults tier to 'authenticated' when omitted", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: "u1", scopes: ["s1"], exp: Math.floor(Date.now() / 1000) + 600 };
    const ctx = buildTokenAuthContext(reqWithAuthHeader(sign(claims)));
    assert.ok(ctx);
    assert.equal(ctx.tier, "authenticated");
  });
});

test("passes through subjectType='service'", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = {
      sub: "svc-1",
      subjectType: "service",
      scopes: ["ops:read"],
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const ctx = buildTokenAuthContext(reqWithAuthHeader(sign(claims)));
    assert.ok(ctx);
    assert.equal(ctx.subjectType, "service");
    assert.equal(ctx.subject, "service:svc-1");
  });
});

test("passes through subjectType='api_key'", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = {
      sub: "ak-1",
      subjectType: "api_key",
      scopes: ["files:read"],
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const ctx = buildTokenAuthContext(reqWithAuthHeader(sign(claims)));
    assert.ok(ctx);
    assert.equal(ctx.subjectType, "api_key");
  });
});

test("preserves optional fields: keyId, orgId, projectId, ownerAddress, walletAddress", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = {
      sub: "u1",
      scopes: ["s"],
      keyId: "key-99",
      orgId: "org-42",
      projectId: "proj-7",
      ownerAddress: "0xabc",
      walletAddress: "0xdef",
      tier: "public",
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const ctx = buildTokenAuthContext(reqWithAuthHeader(sign(claims)));
    assert.ok(ctx);
    assert.equal(ctx.keyId, "key-99");
    assert.equal(ctx.orgId, "org-42");
    assert.equal(ctx.projectId, "proj-7");
    assert.equal(ctx.ownerAddress, "0xabc");
    assert.equal(ctx.owner, "0xabc");
    assert.equal(ctx.walletAddress, "0xdef");
    assert.equal(ctx.tier, "public");
  });
});

test("reads token from x-api-key header as api_key credential type", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: "u1", scopes: ["s"], exp: Math.floor(Date.now() / 1000) + 600 };
    const ctx = buildTokenAuthContext(reqWithApiKey(sign(claims)));
    assert.ok(ctx);
    assert.equal(ctx.credentialType, "api_key");
  });
});

test("preserves order and content of multiple scopes", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const scopes = ["files:read", "uploads:write", "ops:admin", "stream:read"];
    const claims = { sub: "u1", scopes, exp: Math.floor(Date.now() / 1000) + 3600 };
    const ctx = buildTokenAuthContext(reqWithAuthHeader(sign(claims)));
    assert.ok(ctx);
    assert.deepEqual(ctx.scopes, scopes);
  });
});

test("accepts tier='public'", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: "u1", scopes: ["s"], tier: "public", exp: Math.floor(Date.now() / 1000) + 3600 };
    const ctx = buildTokenAuthContext(reqWithAuthHeader(sign(claims)));
    assert.ok(ctx);
    assert.equal(ctx.tier, "public");
  });
});

test("accepts tier='authenticated'", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: "u1", scopes: ["s"], tier: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 };
    const ctx = buildTokenAuthContext(reqWithAuthHeader(sign(claims)));
    assert.ok(ctx);
    assert.equal(ctx.tier, "authenticated");
  });
});

// ─── issuer / audience ───

test("accepts token when issuer matches config", () => {
  withConfig({ secret: SECRET, issuer: ISSUER, audience: undefined }, () => {
    const claims = { sub: "u1", scopes: ["s"], iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 3600 };
    assert.ok(buildTokenAuthContext(reqWithAuthHeader(sign(claims))));
  });
});

test("rejects token when issuer does not match config", () => {
  withConfig({ secret: SECRET, issuer: ISSUER, audience: undefined }, () => {
    const claims = { sub: "u1", scopes: ["s"], iss: "https://evil.test", exp: Math.floor(Date.now() / 1000) + 3600 };
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(sign(claims))), null);
  });
});

test("rejects token when issuer is missing but config requires it", () => {
  withConfig({ secret: SECRET, issuer: ISSUER, audience: undefined }, () => {
    const claims = { sub: "u1", scopes: ["s"], exp: Math.floor(Date.now() / 1000) + 3600 };
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(sign(claims))), null);
  });
});

test("accepts token when audience matches config", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: AUDIENCE }, () => {
    const claims = { sub: "u1", scopes: ["s"], aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 3600 };
    assert.ok(buildTokenAuthContext(reqWithAuthHeader(sign(claims))));
  });
});

test("rejects token when audience does not match config", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: AUDIENCE }, () => {
    const claims = { sub: "u1", scopes: ["s"], aud: "wrong-audience", exp: Math.floor(Date.now() / 1000) + 3600 };
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(sign(claims))), null);
  });
});

test("rejects token when audience is missing but config requires it", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: AUDIENCE }, () => {
    const claims = { sub: "u1", scopes: ["s"], exp: Math.floor(Date.now() / 1000) + 3600 };
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(sign(claims))), null);
  });
});

// ─── expiration ───

test("rejects an expired token", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: "u1", scopes: ["s"], exp: Math.floor(Date.now() / 1000) - 100 };
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(sign(claims))), null);
  });
});

test("rejects token with exp=0", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(sign({ sub: "u1", scopes: ["s"], exp: 0 }))), null);
  });
});

test("accepts token with exp in milliseconds (code only checks exp*1000 <= now)", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: "u1", scopes: ["s"], exp: Date.now() + 3600000 };
    const ctx = buildTokenAuthContext(reqWithAuthHeader(sign(claims)));
    assert.ok(ctx, "code does not reject ms-scale exp since exp*1000 >> Date.now()");
  });
});

test("rejects token with non-finite exp (NaN)", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(sign({ sub: "u1", scopes: ["s"], exp: NaN }))), null);
  });
});

test("rejects token with Infinity exp", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(sign({ sub: "u1", scopes: ["s"], exp: Infinity }))), null);
  });
});

test("accepts token expiring 1s in the future (boundary)", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: "u1", scopes: ["s"], exp: Math.floor(Date.now() / 1000) + 1 };
    assert.ok(buildTokenAuthContext(reqWithAuthHeader(sign(claims))));
  });
});

test("rejects token missing exp entirely", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(sign({ sub: "u1", scopes: ["s"] } as any))), null);
  });
});

// ─── signature verification ───

test("rejects token with tampered payload", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: "u1", scopes: ["s"], exp: Math.floor(Date.now() / 1000) + 3600 };
    const token = sign(claims);
    const [payload, sig] = token.split(".");
    const tampered = payload.slice(0, -1) + (payload.slice(-1) === "A" ? "B" : "A");
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(`${tampered}.${sig}`)), null);
  });
});

test("rejects token signed with wrong secret", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: "u1", scopes: ["s"], exp: Math.floor(Date.now() / 1000) + 3600 };
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(sign(claims, "wrong-secret"))), null);
  });
});

test("rejects token with empty signature part", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: "u1", scopes: ["s"], exp: Math.floor(Date.now() / 1000) + 3600 };
    const [payload] = sign(claims).split(".");
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(`${payload}.`)), null);
  });
});

test("rejects signature with same length but different content (timing-safe)", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: "u1", scopes: ["s"], exp: Math.floor(Date.now() / 1000) + 3600 };
    const [payload] = sign(claims).split(".");
    const fakeSig = base64UrlEncode(crypto.randomBytes(32));
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(`${payload}.${fakeSig}`)), null);
  });
});

test("rejects SHA-512 signature (must use SHA-256)", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: "u1", scopes: ["s"], exp: Math.floor(Date.now() / 1000) + 3600 };
    const payloadPart = base64UrlEncode(Buffer.from(JSON.stringify(claims), "utf8"));
    const wrongSig = base64UrlEncode(crypto.createHmac("sha512", SECRET).update(payloadPart).digest());
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(`${payloadPart}.${wrongSig}`)), null);
  });
});

// ─── malformed tokens ───

test("returns null when no authorization header is present", () => {
  assert.equal(buildTokenAuthContext(reqNoAuth()), null);
});

test("returns null for empty string token", () => {
  assert.equal(buildTokenAuthContext(reqWithAuthHeader("")), null);
});

test("returns null for token with no dot separator", () => {
  assert.equal(buildTokenAuthContext(reqWithAuthHeader("onlypayload")), null);
});

test("returns null for token with three parts", () => {
  assert.equal(buildTokenAuthContext(reqWithAuthHeader("a.b.c")), null);
});

test("returns null for random garbage", () => {
  assert.equal(buildTokenAuthContext(reqWithAuthHeader("not-a-jwt.at-all")), null);
});

test("returns null for base64 payload that is not valid JSON", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const payload = base64UrlEncode(Buffer.from("not json at all", "utf8"));
    const sig = base64UrlEncode(crypto.randomBytes(32));
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(`${payload}.${sig}`)), null);
  });
});

// ─── validateClaims ───

test("rejects claims with empty sub", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: "", scopes: ["s"], exp: Math.floor(Date.now() / 1000) + 3600 };
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(sign(claims))), null);
  });
});

test("rejects claims with whitespace-only sub", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: "   ", scopes: ["s"], exp: Math.floor(Date.now() / 1000) + 3600 };
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(sign(claims))), null);
  });
});

test("rejects claims with numeric sub", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: 12345, scopes: ["s"], exp: Math.floor(Date.now() / 1000) + 3600 };
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(sign(claims as any))), null);
  });
});

test("rejects claims with missing sub", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(sign({ scopes: ["s"], exp: Math.floor(Date.now() / 1000) + 3600 } as any))), null);
  });
});

test("rejects claims with invalid subjectType", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: "u1", subjectType: "admin", scopes: ["s"], exp: Math.floor(Date.now() / 1000) + 3600 };
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(sign(claims as any))), null);
  });
});

test("rejects claims with invalid tier", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: "u1", tier: "premium", scopes: ["s"], exp: Math.floor(Date.now() / 1000) + 3600 };
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(sign(claims as any))), null);
  });
});

test("rejects claims with scopes as a string instead of array", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: "u1", scopes: "uploads:write", exp: Math.floor(Date.now() / 1000) + 3600 };
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(sign(claims as any))), null);
  });
});

test("rejects claims with empty scopes array", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(sign({ sub: "u1", scopes: [], exp: Math.floor(Date.now() / 1000) + 3600 }))), null);
  });
});

test("rejects claims with missing scopes", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(sign({ sub: "u1", exp: Math.floor(Date.now() / 1000) + 3600 } as any))), null);
  });
});

test("rejects claims with empty string in scopes array", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: "u1", scopes: ["valid", ""], exp: Math.floor(Date.now() / 1000) + 3600 };
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(sign(claims))), null);
  });
});

test("rejects claims with whitespace-only scope", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: "u1", scopes: ["  "], exp: Math.floor(Date.now() / 1000) + 3600 };
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(sign(claims))), null);
  });
});

test("rejects claims with non-string scope element", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: "u1", scopes: [123], exp: Math.floor(Date.now() / 1000) + 3600 };
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(sign(claims as any))), null);
  });
});

test("rejects claims with empty orgId", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: "u1", scopes: ["s"], orgId: "", exp: Math.floor(Date.now() / 1000) + 3600 };
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(sign(claims))), null);
  });
});

test("rejects claims with whitespace-only projectId", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: "u1", scopes: ["s"], projectId: "   ", exp: Math.floor(Date.now() / 1000) + 3600 };
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(sign(claims))), null);
  });
});

test("rejects payload that is a JSON string (not object)", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const payload = base64UrlEncode(Buffer.from(JSON.stringify("just a string"), "utf8"));
    const sig = base64UrlEncode(crypto.createHmac("sha256", SECRET).update(payload).digest());
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(`${payload}.${sig}`)), null);
  });
});

test("rejects payload that is a JSON array", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const payload = base64UrlEncode(Buffer.from(JSON.stringify([1, 2, 3]), "utf8"));
    const sig = base64UrlEncode(crypto.createHmac("sha256", SECRET).update(payload).digest());
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(`${payload}.${sig}`)), null);
  });
});

test("rejects payload that is JSON null", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const payload = base64UrlEncode(Buffer.from(JSON.stringify(null), "utf8"));
    const sig = base64UrlEncode(crypto.createHmac("sha256", SECRET).update(payload).digest());
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(`${payload}.${sig}`)), null);
  });
});

// ─── no secret configured ───

test("returns null when secret is not configured", () => {
  withConfig({ secret: undefined, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: "u1", scopes: ["s"], exp: Math.floor(Date.now() / 1000) + 3600 };
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(sign(claims))), null);
  });
});

// ─── secret rotation ───

test("token signed with old secret is rejected after rotation", () => {
  const claims = { sub: "u1", scopes: ["s"], exp: Math.floor(Date.now() / 1000) + 3600 };
  const tokenA = sign(claims, "secret-A");
  withConfig({ secret: "secret-B", issuer: undefined, audience: undefined }, () => {
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(tokenA)), null);
  });
});

// ─── verifySignature uses length check ───

test("rejects signature of different length (shorter)", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: "u1", scopes: ["s"], exp: Math.floor(Date.now() / 1000) + 3600 };
    const [payload] = sign(claims).split(".");
    const shortSig = base64UrlEncode(crypto.randomBytes(16)); // 16 bytes, not 32
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(`${payload}.${shortSig}`)), null);
  });
});

test("rejects signature of different length (longer)", () => {
  withConfig({ secret: SECRET, issuer: undefined, audience: undefined }, () => {
    const claims = { sub: "u1", scopes: ["s"], exp: Math.floor(Date.now() / 1000) + 3600 };
    const [payload] = sign(claims).split(".");
    const longSig = base64UrlEncode(crypto.randomBytes(64)); // 64 bytes, not 32
    assert.equal(buildTokenAuthContext(reqWithAuthHeader(`${payload}.${longSig}`)), null);
  });
});
