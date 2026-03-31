import test from "node:test";
import assert from "node:assert/strict";

import { NativeRedisClient } from "../src/state/redis.native.ts";

class FakeSocket {
  readonly writes: string[] = [];

  write(payload: string, _encoding: BufferEncoding, callback?: (err?: Error | null) => void) {
    this.writes.push(payload);
    callback?.(null);
    return true;
  }
}

function appendReply(client: NativeRedisClient, chunk: string) {
  const current = (client as any).buffer as Buffer;
  (client as any).buffer = Buffer.concat([current, Buffer.from(chunk, "utf8")]);
  (client as any).drainResponses();
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("native redis client does not interleave commands into an active MULTI", async () => {
  const client = new NativeRedisClient({ url: "redis://127.0.0.1:6379" });
  const socket = new FakeSocket();
  (client as any).socket = socket;
  (client as any).connected = true;

  const txPromise = client.execMulti([
    ["SET", "floe:test:key", "value"],
    ["EXPIRE", "floe:test:key", 30],
  ]);
  await flushMicrotasks();

  const pingPromise = client.ping();
  await flushMicrotasks();

  assert.equal(socket.writes.length, 1);
  assert.match(socket.writes[0], /\r\nMULTI\r\n/);

  appendReply(client, "+OK\r\n");
  await flushMicrotasks();
  assert.equal(socket.writes.length, 2);
  assert.match(socket.writes[1], /\r\nSET\r\n/);

  appendReply(client, "+QUEUED\r\n");
  await flushMicrotasks();
  assert.equal(socket.writes.length, 3);
  assert.match(socket.writes[2], /\r\nEXPIRE\r\n/);

  appendReply(client, "+QUEUED\r\n");
  await flushMicrotasks();
  assert.equal(socket.writes.length, 4);
  assert.match(socket.writes[3], /\r\nEXEC\r\n/);

  appendReply(client, "*2\r\n+OK\r\n:1\r\n");
  await flushMicrotasks();
  assert.equal(socket.writes.length, 5);
  assert.match(socket.writes[4], /\r\nPING\r\n/);

  appendReply(client, "+PONG\r\n");

  assert.deepEqual(await txPromise, ["OK", 1]);
  assert.equal(await pingPromise, "PONG");
});
