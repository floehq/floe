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

function encodeRespArray(items: string[]): string {
  let out = `*${items.length}\r\n`;
  for (const item of items) {
    out += `$${Buffer.byteLength(item)}\r\n${item}\r\n`;
  }
  return out;
}

function parseRespArray(data: string): string[] | null {
  if (!data.startsWith("*")) return null;
  const parts = data.split("\r\n");
  const count = Number(parts[0]!.slice(1));
  if (isNaN(count)) return null;
  const result: string[] = [];
  let idx = 1;
  for (let i = 0; i < count; i++) {
    if (!parts[idx]?.startsWith("$")) return null;
    const val = parts[idx + 1] ?? "";
    result.push(val);
    idx += 2;
  }
  return result;
}

function makeSentinelServer(
  masterAddr: { host: string; port: number },
  password?: string,
) {
  return net.createServer((socket) => {
    let authenticated = !password;

    socket.on("data", (chunk) => {
      const msg = chunk.toString("utf8");
      const commands = msg.split(/(?=\*\d+\r\n)/).filter(Boolean);

      for (const cmd of commands) {
        const parts = parseRespArray(cmd);
        if (!parts) continue;

        if (!authenticated && parts[0] === "AUTH") {
          if (parts[1] === password) {
            authenticated = true;
            socket.write("+OK\r\n");
          } else {
            socket.write("-ERR invalid password\r\n");
          }
          continue;
        }

        if (
          parts[0] === "SENTINEL" &&
          parts[1] === "get-master-addr-by-name" &&
          authenticated
        ) {
          socket.write(encodeRespArray([masterAddr.host, String(masterAddr.port)]));
          continue;
        }

        if (parts[0] === "PING") {
          socket.write("+PONG\r\n");
          continue;
        }

        socket.write("-ERR unknown command\r\n");
      }
    });
  });
}

function makeRedisServer() {
  return net.createServer((socket) => {
    socket.on("data", () => {
      socket.write("+PONG\r\n");
    });
  });
}

async function waitForCondition(
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

test("sentinel resolves primary address and connects", async () => {
  const redisServer = makeRedisServer();
  const redisPort = await listen(redisServer);

  const sentinelServer = makeSentinelServer({ host: "127.0.0.1", port: redisPort });
  const sentinelPort = await listen(sentinelServer);

  const client = new NativeRedisClient({
    sentinel: {
      sentinels: [{ host: "127.0.0.1", port: sentinelPort }],
      name: "mymaster",
    },
  });

  await client.connect();
  assert.equal(client.getRedisConnectionState().connected, true);

  const result = await client.ping();
  assert.equal(result, "PONG");

  await client.close();
  redisServer.close();
  sentinelServer.close();
});

test("sentinel with password authentication", async () => {
  const redisServer = makeRedisServer();
  const redisPort = await listen(redisServer);

  const sentinelServer = makeSentinelServer(
    { host: "127.0.0.1", port: redisPort },
    "sentinel-secret",
  );
  const sentinelPort = await listen(sentinelServer);

  const client = new NativeRedisClient({
    sentinel: {
      sentinels: [{ host: "127.0.0.1", port: sentinelPort }],
      name: "mymaster",
      sentinelPassword: "sentinel-secret",
    },
  });

  await client.connect();
  assert.equal(client.getRedisConnectionState().connected, true);

  const result = await client.ping();
  assert.equal(result, "PONG");

  await client.close();
  redisServer.close();
  sentinelServer.close();
});

test("sentinel failover detection - primary address changes", async () => {
  const redisServer1 = makeRedisServer();
  const redisPort1 = await listen(redisServer1);

  const redisServer2 = makeRedisServer();
  const redisPort2 = await listen(redisServer2);

  let currentMaster = { host: "127.0.0.1", port: redisPort1 };

  const sentinelServer = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      const msg = chunk.toString("utf8");
      const commands = msg.split(/(?=\*\d+\r\n)/).filter(Boolean);

      for (const cmd of commands) {
        const parts = parseRespArray(cmd);
        if (!parts) continue;

        if (parts[0] === "SENTINEL" && parts[1] === "get-master-addr-by-name") {
          socket.write(encodeRespArray([currentMaster.host, String(currentMaster.port)]));
          continue;
        }

        if (parts[0] === "PING") {
          socket.write("+PONG\r\n");
          continue;
        }

        socket.write("-ERR unknown\r\n");
      }
    });
  });
  const sentinelPort = await listen(sentinelServer);

  const client = new NativeRedisClient({
    sentinel: {
      sentinels: [{ host: "127.0.0.1", port: sentinelPort }],
      name: "mymaster",
    },
    maxReconnectAttempts: 5,
    connectTimeoutMs: 1000,
  });

  await client.connect();
  assert.equal(client.getRedisConnectionState().connected, true);

  const result1 = await client.ping();
  assert.equal(result1, "PONG");

  const sock1 = (client as unknown as { socket: net.Socket }).socket;
  sock1.destroy();

  await waitForCondition(() => client.getRedisConnectionState().reconnecting === true, 2000);

  currentMaster = { host: "127.0.0.1", port: redisPort2 };

  await waitForCondition(() => client.getRedisConnectionState().connected === true, 5000);

  const result2 = await client.ping();
  assert.equal(result2, "PONG");

  await client.close();
  redisServer1.close();
  redisServer2.close();
  sentinelServer.close();
});

test("sentinel fallback - tries next sentinel on failure", async () => {
  const redisServer = makeRedisServer();
  const redisPort = await listen(redisServer);

  const deadSentinel = net.createServer((socket) => {
    socket.destroy();
  });
  const deadPort = await listen(deadSentinel);

  const aliveSentinel = makeSentinelServer({ host: "127.0.0.1", port: redisPort });
  const alivePort = await listen(aliveSentinel);

  const client = new NativeRedisClient({
    sentinel: {
      sentinels: [
        { host: "127.0.0.1", port: deadPort },
        { host: "127.0.0.1", port: alivePort },
      ],
      name: "mymaster",
    },
  });

  await client.connect();
  assert.equal(client.getRedisConnectionState().connected, true);

  const result = await client.ping();
  assert.equal(result, "PONG");

  await client.close();
  redisServer.close();
  deadSentinel.close();
  aliveSentinel.close();
});

test("all sentinels unavailable throws error", async () => {
  const server1 = net.createServer((socket) => {
    socket.destroy();
  });
  const port1 = await listen(server1);

  const server2 = net.createServer((socket) => {
    socket.destroy();
  });
  const port2 = await listen(server2);

  const client = new NativeRedisClient({
    sentinel: {
      sentinels: [
        { host: "127.0.0.1", port: port1 },
        { host: "127.0.0.1", port: port2 },
      ],
      name: "mymaster",
    },
  });

  await assert.rejects(client.connect(), /All Sentinels failed/);

  await client.close();
  server1.close();
  server2.close();
});

test("sentinel reconnection re-queries sentinel for new primary", async () => {
  const redisServer1 = makeRedisServer();
  const redisPort1 = await listen(redisServer1);

  const redisServer2 = makeRedisServer();
  const redisPort2 = await listen(redisServer2);

  let currentMaster = { host: "127.0.0.1", port: redisPort1 };

  const sentinelServer = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      const msg = chunk.toString("utf8");
      const commands = msg.split(/(?=\*\d+\r\n)/).filter(Boolean);

      for (const cmd of commands) {
        const parts = parseRespArray(cmd);
        if (!parts) continue;

        if (parts[0] === "SENTINEL" && parts[1] === "get-master-addr-by-name") {
          socket.write(encodeRespArray([currentMaster.host, String(currentMaster.port)]));
          continue;
        }

        if (parts[0] === "PING") {
          socket.write("+PONG\r\n");
          continue;
        }

        socket.write("-ERR unknown\r\n");
      }
    });
  });
  const sentinelPort = await listen(sentinelServer);

  const client = new NativeRedisClient({
    sentinel: {
      sentinels: [{ host: "127.0.0.1", port: sentinelPort }],
      name: "mymaster",
    },
    maxReconnectAttempts: 5,
    connectTimeoutMs: 1000,
  });

  await client.connect();
  assert.equal(client.getRedisConnectionState().connected, true);

  const sock1 = (client as unknown as { socket: net.Socket }).socket;
  sock1.destroy();

  await waitForCondition(() => client.getRedisConnectionState().reconnecting === true, 2000);

  currentMaster = { host: "127.0.0.1", port: redisPort2 };

  await waitForCondition(() => client.getRedisConnectionState().connected === true, 5000);

  const sock2 = (client as unknown as { socket: net.Socket }).socket;
  assert.ok(sock2, "should have a socket connected to new primary");

  await client.close();
  redisServer1.close();
  redisServer2.close();
  sentinelServer.close();
});

test("missing sentinel config throws on connect", async () => {
  const client = new NativeRedisClient({});
  await assert.rejects(client.connect(), /No REDIS_URL or Sentinel configuration/);
  await client.close();
});
