import test from "node:test";
import assert from "node:assert/strict";

// ============================================================
// Postgres state tests
// ============================================================
test("postgres - isPostgresConfigured returns false when DATABASE_URL is empty", async () => {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const mod = await import("../src/state/postgres.js");
    assert.equal(mod.isPostgresConfigured(), false);
    assert.equal(mod.isPostgresEnabled(), false);
    assert.equal(mod.getPostgres(), null);
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
    else delete process.env.DATABASE_URL;
  }
});

test("postgres - isPostgresConfigured returns true when DATABASE_URL is set", async () => {
  const prev = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://localhost:5432/test";
  try {
    const mod = await import("../src/state/postgres.js");
    assert.equal(mod.isPostgresConfigured(), true);
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
    else delete process.env.DATABASE_URL;
  }
});

test("postgres - isPostgresRequired parses FLOE_POSTGRES_REQUIRED env", async () => {
  const prev = process.env.FLOE_POSTGRES_REQUIRED;
  delete process.env.FLOE_POSTGRES_REQUIRED;
  try {
    const mod = await import("../src/state/postgres.js");
    assert.equal(mod.isPostgresRequired(), false);
  } finally {
    if (prev !== undefined) process.env.FLOE_POSTGRES_REQUIRED = prev;
    else delete process.env.FLOE_POSTGRES_REQUIRED;
  }
});

test("postgres - initPostgres returns null when no DATABASE_URL", async () => {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const mod = await import("../src/state/postgres.js");
    const result = await mod.initPostgres();
    assert.equal(result, null);
    assert.equal(mod.isPostgresEnabled(), false);
    assert.equal(mod.getPostgres(), null);
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
    else delete process.env.DATABASE_URL;
  }
});

test("postgres - setPostgresForTests enables/disables correctly", async () => {
  const mod = await import("../src/state/postgres.js");
  const mockClient = {
    query: async () => ({ rows: [], rowCount: 0 }),
    end: async () => {},
  };

  mod.setPostgresForTests(mockClient as unknown as NonNullable<Parameters<typeof postgresModule.setPostgresForTests>[0]>, true);
  assert.equal(mod.getPostgres(), mockClient);
  assert.equal(mod.isPostgresEnabled(), true);

  mod.setPostgresForTests(null, false);
  assert.equal(mod.getPostgres(), null);
  assert.equal(mod.isPostgresEnabled(), false);
});

test("postgres - checkPostgresHealth with no DATABASE_URL", async () => {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const mod = await import("../src/state/postgres.js");
    const health = await mod.checkPostgresHealth();
    assert.equal(health.enabled, false);
    assert.equal(health.ok, null);
    assert.equal(health.latencyMs, null);
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
    else delete process.env.DATABASE_URL;
  }
});

test("postgres - checkPostgresHealth with disabled pool returns ok=false", async () => {
  const prev = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://localhost:5432/test";
  try {
    const mod = await import("../src/state/postgres.js");
    mod.setPostgresForTests(null, false);
    const health = await mod.checkPostgresHealth();
    assert.equal(health.enabled, false);
    assert.equal(health.ok, false);
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
    else delete process.env.DATABASE_URL;
  }
});

test("postgres - checkPostgresHealth with working pool returns ok=true", async () => {
  const prev = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://localhost:5432/test";
  try {
    const mod = await import("../src/state/postgres.js");  const mockClient = {
    query: async () => ({ rows: [], rowCount: 0 }),
    end: async () => {},
  };
    mod.setPostgresForTests(mockClient as unknown as NonNullable<Parameters<typeof mod.setPostgresForTests>[0]>, true);
    const health = await mod.checkPostgresHealth();
    assert.equal(health.enabled, true);
    assert.equal(health.ok, true);
    assert.equal(typeof health.latencyMs, "number");
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
    else delete process.env.DATABASE_URL;
  }
});

test("postgres - checkPostgresHealth with failing query returns ok=false", async () => {
  const prev = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://localhost:5432/test";
  try {
    const mod = await import("../src/state/postgres.js");
    const mockClient = {
      query: async () => {
        throw new Error("connection failed");
      },
      end: async () => {},
    };
    mod.setPostgresForTests(mockClient as unknown as NonNullable<Parameters<typeof mod.setPostgresForTests>[0]>, true);
    const health = await mod.checkPostgresHealth();
    assert.equal(health.enabled, true);
    assert.equal(health.ok, false);
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
    else delete process.env.DATABASE_URL;
  }
});

test("postgres - closePostgres works with null pool", async () => {
  const mod = await import("../src/state/postgres.js");
  mod.setPostgresForTests(null, false);
  // Should not throw
  await mod.closePostgres();
});

test("postgres - closePostgres works with active pool", async () => {
  const mod = await import("../src/state/postgres.js");
  let ended = false;
  const mockClient = {
    query: async () => ({ rows: [], rowCount: 0 }),
    end: async () => {
      ended = true;
    },
  };
  mod.setPostgresForTests(mockClient as unknown as NonNullable<Parameters<typeof mod.setPostgresForTests>[0]>, true);
  await mod.closePostgres();
  assert.equal(ended, true);
  assert.equal(mod.getPostgres(), null);
  assert.equal(mod.isPostgresEnabled(), false);
});

// ============================================================
// Redis state tests
// ============================================================
test("redis - getRedis throws when not initialized", async () => {
  const mod = await import("../src/state/redis.js");
  try {
    mod.getRedis();
    assert.fail("Should have thrown");
  } catch (err: unknown) {
    assert.ok(err.message.includes("Redis not initialized"));
  }
});

test("redis - closeRedis with null client is a noop", async () => {
  const mod = await import("../src/state/redis.js");
  mod.setRedisForTests(null);
  await mod.closeRedis();
  // Should not throw
});

test("redis - closeRedis with mock client calls close", async () => {
  const mod = await import("../src/state/redis.js");
  let closed = false;
  const mock = {
    close: async () => {
      closed = true;
    },
    ping: async () => "PONG",
    hgetall: async () => ({}),
    hget: async () => null,
    hset: async () => 0,
    scard: async () => 0,
    smembers: async () => [],
    sismember: async () => 0,
    sadd: async () => 0,
    srem: async () => 0,
    zrem: async () => 0,
    ttl: async () => -1,
    llen: async () => 0,
    rpop: async () => null,
    lrem: async () => 0,
    exists: async () => 0,
    del: async () => 0,
    hincrby: async () => 0,
    expire: async () => 0,
    set: async () => "OK",
    eval: async () => null,
    multi: () => {
      throw new Error("not implemented");
    },
    execMulti: async () => [],
  } as unknown as NonNullable<Parameters<typeof mod.setRedisForTests>[0]>;
  mod.setRedisForTests(mock);
  await mod.closeRedis();
  assert.equal(closed, true);
});

test("redis - setRedisForTests allows overriding the client", async () => {
  const mod = await import("../src/state/redis.js");
  const mock = {
    ping: async () => "PONG",
    hgetall: async () => ({}),
    hget: async () => null,
    hset: async () => 0,
    scard: async () => 0,
    smembers: async () => [],
    sismember: async () => 0,
    sadd: async () => 0,
    srem: async () => 0,
    zrem: async () => 0,
    ttl: async () => -1,
    llen: async () => 0,
    rpop: async () => null,
    lrem: async () => 0,
    exists: async () => 0,
    del: async () => 0,
    hincrby: async () => 0,
    expire: async () => 0,
    set: async () => "OK",
    eval: async () => null,
    multi: () => {
      throw new Error("not implemented");
    },
    execMulti: async () => [],
  } as unknown as NonNullable<Parameters<typeof mod.setRedisForTests>[0]>;
  mod.setRedisForTests(mock);
  assert.equal(mod.getRedis(), mock);
});

// ============================================================
// Sui state tests
// ============================================================
test("sui - getSuiNetwork throws when FLOE_NETWORK is not set", async () => {
  const prev = process.env.FLOE_NETWORK;
  const mod = await import("../src/state/sui.js");
  mod.resetSuiStateForTests();
  delete process.env.FLOE_NETWORK;
  try {
    assert.throws(() => mod.getSuiNetwork(), /FLOE_NETWORK/);
  } finally {
    if (prev !== undefined) process.env.FLOE_NETWORK = prev;
    else delete process.env.FLOE_NETWORK;
  }
});
