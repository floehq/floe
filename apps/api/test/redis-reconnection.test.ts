import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { NativeRedisClient } from "../src/state/redis.native.ts";

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve(addr.port);
      } else {
        reject(new Error("Failed to get server address"));
      }
    });
    server.once("error", reject);
  });
}

function waitForCondition(
  check: () => boolean,
  timeoutMs: number,
  intervalMs = 10,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (check()) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`Condition not met within ${timeoutMs}ms`));
      }
    }, intervalMs);
  });
}

function drainEnv(...keys: string[]) {
  for (const k of keys) delete process.env[k];
}

function setupEnv(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) {
    process.env[k] = v;
  }
}

function makeServer(onConnection?: (socket: net.Socket) => void): net.Server {
  return net.createServer((socket) => {
    socket.on("data", () => {
      socket.write("+PONG\r\n");
    });
    onConnection?.(socket);
  });
}

async function findOpenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() => {
        if (addr && typeof addr === "object") {
          resolve(addr.port);
        } else {
          reject(new Error("Failed to get address"));
        }
      });
    });
    server.once("error", reject);
  });
}

test("reconnection after socket close", async () => {
  setupEnv({
    FLOE_REDIS_RECONNECT_MAX_ATTEMPTS: "5",
    FLOE_REDIS_CONNECT_TIMEOUT_MS: "1000",
  });

  const serverSockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    serverSockets.push(socket);
    socket.on("data", () => {
      socket.write("+PONG\r\n");
    });
  });
  const port = await listen(server);

  const client = new NativeRedisClient({ url: `redis://127.0.0.1:${port}` });
  await client.connect();

  assert.equal(client.getRedisConnectionState().connected, true);
  assert.equal(client.getRedisConnectionState().reconnecting, false);

  for (const s of serverSockets) s.destroy();

  await waitForCondition(() => client.getRedisConnectionState().connected === false, 2000);
  assert.equal(client.getRedisConnectionState().reconnecting, true);

  const state = client.getRedisConnectionState();
  assert.ok(state.attempt >= 1, `expected attempt >= 1, got ${state.attempt}`);

  await client.close();
  server.close();
  drainEnv("FLOE_REDIS_RECONNECT_MAX_ATTEMPTS", "FLOE_REDIS_CONNECT_TIMEOUT_MS");
});

test("exponential backoff timing", async () => {
  setupEnv({
    FLOE_REDIS_RECONNECT_MAX_ATTEMPTS: "5",
    FLOE_REDIS_CONNECT_TIMEOUT_MS: "200",
  });

  const connectionTimestamps: number[] = [];

  const port = await findOpenPort();
  const server = net.createServer((socket) => {
    connectionTimestamps.push(Date.now());
    if (connectionTimestamps.length === 1) {
      socket.destroy();
      return;
    }
    socket.on("data", () => {
      socket.write("+PONG\r\n");
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));

  const client = new NativeRedisClient({ url: `redis://127.0.0.1:${port}` });
  await client.connect();

  assert.equal(client.getRedisConnectionState().connected, true);
  assert.equal(connectionTimestamps.length, 1);

  const socket = (client as unknown as { socket: net.Socket }).socket;
  socket.destroy();

  await waitForCondition(
    () => client.getRedisConnectionState().connected === true &&
      client.getRedisConnectionState().reconnecting === false,
    15000,
  );

  assert.ok(connectionTimestamps.length >= 2, `expected at least 2 connections, got ${connectionTimestamps.length}`);

  const result = await client.ping();
  assert.equal(result, "PONG");

  if (connectionTimestamps.length >= 3) {
    const gap1 = connectionTimestamps[1]! - connectionTimestamps[0]!;
    const gap2 = connectionTimestamps[2]! - connectionTimestamps[1]!;
    assert.ok(gap1 >= 900, `expected first backoff >= 900ms, got ${gap1}ms`);
    assert.ok(gap2 >= 1800, `expected second backoff >= 1800ms, got ${gap2}ms`);
    assert.ok(gap2 > gap1, `expected increasing backoff: gap1=${gap1}ms, gap2=${gap2}ms`);
  }

  await client.close();
  server.close();
  drainEnv("FLOE_REDIS_RECONNECT_MAX_ATTEMPTS", "FLOE_REDIS_CONNECT_TIMEOUT_MS");
});

test("max retry limit stops reconnection", async () => {
  setupEnv({
    FLOE_REDIS_RECONNECT_MAX_ATTEMPTS: "3",
    FLOE_REDIS_CONNECT_TIMEOUT_MS: "200",
  });

  const deadPort = await findOpenPort();
  const client = new NativeRedisClient({ url: `redis://127.0.0.1:${deadPort}` });

  await assert.rejects(client.connect(), /ECONNREFUSED|timed out/);

  await waitForCondition(
    () => client.getRedisConnectionState().reconnecting === false &&
      client.getRedisConnectionState().attempt >= 3,
    10000,
  );

  const state = client.getRedisConnectionState();
  assert.equal(state.connected, false);
  assert.equal(state.reconnecting, false);
  assert.ok(state.attempt >= 3, `expected attempt >= 3, got ${state.attempt}`);
  assert.ok(state.lastError !== null, "expected lastError to be set");

  await client.close();
  drainEnv("FLOE_REDIS_RECONNECT_MAX_ATTEMPTS", "FLOE_REDIS_CONNECT_TIMEOUT_MS");
});

test("connect timeout triggers reconnection", async () => {
  setupEnv({
    FLOE_REDIS_RECONNECT_MAX_ATTEMPTS: "3",
    FLOE_REDIS_CONNECT_TIMEOUT_MS: "200",
  });

  const blackHoleServer = net.createServer((socket) => {
    socket.destroy();
  });
  const port = await listen(blackHoleServer);

  const client = new NativeRedisClient({ url: `redis://:secret@127.0.0.1:${port}` });

  await assert.rejects(client.connect(), /timed out|ECONNRESET|EPIPE|socket is not connected|socket closed/);

  await waitForCondition(() => client.getRedisConnectionState().reconnecting === true, 2000);
  assert.equal(client.getRedisConnectionState().connected, false);
  assert.equal(client.getRedisConnectionState().reconnecting, true);

  await client.close();
  blackHoleServer.close();
  drainEnv("FLOE_REDIS_RECONNECT_MAX_ATTEMPTS", "FLOE_REDIS_CONNECT_TIMEOUT_MS");
});

test("state reporting through reconnection lifecycle", async () => {
  setupEnv({
    FLOE_REDIS_RECONNECT_MAX_ATTEMPTS: "5",
    FLOE_REDIS_CONNECT_TIMEOUT_MS: "500",
  });

  const client = new NativeRedisClient({ url: "redis://127.0.0.1:59998" });
  let state = client.getRedisConnectionState();
  assert.equal(state.connected, false);
  assert.equal(state.reconnecting, false);
  assert.equal(state.attempt, 0);
  assert.equal(state.lastError, null);

  const port = await findOpenPort();
  const serverSockets1: net.Socket[] = [];
  const server = net.createServer((socket) => {
    serverSockets1.push(socket);
    socket.on("data", () => {
      socket.write("+PONG\r\n");
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));

  const client2 = new NativeRedisClient({ url: `redis://127.0.0.1:${port}` });
  await client2.connect();

  state = client2.getRedisConnectionState();
  assert.equal(state.connected, true);
  assert.equal(state.reconnecting, false);
  assert.equal(state.attempt, 0);
  assert.equal(state.lastError, null);

  for (const s of serverSockets1) s.destroy();
  server.close();

  await waitForCondition(() => client2.getRedisConnectionState().reconnecting === true, 2000);

  state = client2.getRedisConnectionState();
  assert.equal(state.connected, false);
  assert.equal(state.reconnecting, true);
  assert.ok(state.attempt >= 1);

  const server2 = net.createServer((socket) => {
    socket.on("data", () => {
      socket.write("+PONG\r\n");
    });
  });
  await new Promise<void>((r) => server2.listen(port, "127.0.0.1", () => r()));

  await waitForCondition(() => client2.getRedisConnectionState().connected === true, 5000);

  state = client2.getRedisConnectionState();
  assert.equal(state.connected, true);
  assert.equal(state.reconnecting, false);
  assert.equal(state.attempt, 0);
  assert.equal(state.lastError, null);

  await client2.close();
  server2.close();
  drainEnv("FLOE_REDIS_RECONNECT_MAX_ATTEMPTS", "FLOE_REDIS_CONNECT_TIMEOUT_MS");
});

test("manual close prevents reconnection", async () => {
  setupEnv({
    FLOE_REDIS_RECONNECT_MAX_ATTEMPTS: "5",
    FLOE_REDIS_CONNECT_TIMEOUT_MS: "500",
  });

  const server = makeServer();
  const port = await listen(server);

  const client = new NativeRedisClient({ url: `redis://127.0.0.1:${port}` });
  await client.connect();

  assert.equal(client.getRedisConnectionState().connected, true);

  await client.close();

  assert.equal(client.getRedisConnectionState().connected, false);
  assert.equal(client.getRedisConnectionState().reconnecting, false);

  await new Promise((resolve) => setTimeout(resolve, 500));

  assert.equal(client.getRedisConnectionState().reconnecting, false);
  assert.equal(client.getRedisConnectionState().attempt, 0);

  server.close();
  drainEnv("FLOE_REDIS_RECONNECT_MAX_ATTEMPTS", "FLOE_REDIS_CONNECT_TIMEOUT_MS");
});

test("sendRaw throws during reconnection", async () => {
  setupEnv({
    FLOE_REDIS_RECONNECT_MAX_ATTEMPTS: "5",
    FLOE_REDIS_CONNECT_TIMEOUT_MS: "500",
  });

  const serverSockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    serverSockets.push(socket);
    socket.on("data", () => {
      socket.write("+PONG\r\n");
    });
  });
  const port = await listen(server);

  const client = new NativeRedisClient({ url: `redis://127.0.0.1:${port}` });
  await client.connect();

  for (const s of serverSockets) s.destroy();

  await waitForCondition(() => client.getRedisConnectionState().reconnecting === true, 2000);

  await assert.rejects(client.ping(), /Redis socket is not connected/);

  await client.close();
  server.close();
  drainEnv("FLOE_REDIS_RECONNECT_MAX_ATTEMPTS", "FLOE_REDIS_CONNECT_TIMEOUT_MS");
});
