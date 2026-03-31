import net from "node:net";
import tls from "node:tls";

import type { RedisClient } from "./redis.types.js";

type SocketLike = net.Socket | tls.TLSSocket;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

type MultiCommand = Array<string | number>;

type NativeRedisOptions = {
  url: string;
};

function parseRedisUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("REDIS_URL must use redis:// or rediss://");
  }
  return {
    host: url.hostname || "127.0.0.1",
    port: Number(url.port || (url.protocol === "rediss:" ? 6380 : 6379)),
    password: url.password || undefined,
    username: url.username || undefined,
    db: url.pathname && url.pathname !== "/" ? Number(url.pathname.slice(1)) : undefined,
    tls: url.protocol === "rediss:",
  };
}

function encodeCommand(parts: Array<string | number>): string {
  let out = `*${parts.length}\r\n`;
  for (const part of parts) {
    const value = String(part);
    out += `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
  }
  return out;
}

class RespReader {
  private offset = 0;
  constructor(private readonly buffer: Buffer) {}

  private readLine(): string | null {
    const idx = this.buffer.indexOf("\r\n", this.offset);
    if (idx === -1) return null;
    const line = this.buffer.toString("utf8", this.offset, idx);
    this.offset = idx + 2;
    return line;
  }

  parse(): { value: unknown; bytesRead: number } | null {
    const start = this.offset;
    const prefix = this.readLine();
    if (prefix === null || prefix.length === 0) {
      this.offset = start;
      return null;
    }
    const type = prefix[0];
    const rest = prefix.slice(1);

    if (type === "+") {
      return { value: rest, bytesRead: this.offset - start };
    }
    if (type === ":") {
      return { value: Number(rest), bytesRead: this.offset - start };
    }
    if (type === "$") {
      const len = Number(rest);
      if (len === -1) {
        return { value: null, bytesRead: this.offset - start };
      }
      const end = this.offset + len;
      if (this.buffer.length < end + 2) {
        this.offset = start;
        return null;
      }
      const value = this.buffer.toString("utf8", this.offset, end);
      this.offset = end + 2;
      return { value, bytesRead: this.offset - start };
    }
    if (type === "*") {
      const len = Number(rest);
      if (len === -1) {
        return { value: null, bytesRead: this.offset - start };
      }
      const items: unknown[] = [];
      for (let i = 0; i < len; i++) {
        const nested = this.parse();
        if (!nested) {
          this.offset = start;
          return null;
        }
        items.push(nested.value);
      }
      return { value: items, bytesRead: this.offset - start };
    }
    if (type == "-") {
      return { value: new Error(rest), bytesRead: this.offset - start };
    }

    this.offset = start;
    return null;
  }
}

function normalizeExecReply(reply: unknown): unknown {
  if (!Array.isArray(reply)) return reply;
  return reply.map((entry) => {
    if (Array.isArray(entry) && entry.length === 2 && entry[0] === "OK") {
      return entry[1];
    }
    return entry;
  });
}

function normalizeHgetallReply(reply: unknown): Record<string, string> {
  if (!reply) return {};
  if (typeof reply === "object" && !Array.isArray(reply)) {
    return Object.fromEntries(
      Object.entries(reply as Record<string, unknown>).map(([k, v]) => [k, String(v)])
    );
  }
  if (Array.isArray(reply)) {
    const out: Record<string, string> = {};
    for (let i = 0; i < reply.length; i += 2) {
      const key = reply[i];
      const value = reply[i + 1];
      if (key !== undefined && value !== undefined) {
        out[String(key)] = String(value);
      }
    }
    return out;
  }
  return {};
}

class NativeRedisMulti {
  private readonly commands: MultiCommand[] = [];

  constructor(private readonly client: NativeRedisClient) {}

  hset(key: string, kv: Record<string, unknown>) {
    this.commands.push(["HSET", key, ...Object.entries(kv).flatMap(([field, value]) => [field, String(value)])]);
    return this;
  }

  expire(key: string, seconds: number) {
    this.commands.push(["EXPIRE", key, seconds]);
    return this;
  }

  sadd(key: string, member: string) {
    this.commands.push(["SADD", key, member]);
    return this;
  }

  del(key: string) {
    this.commands.push(["DEL", key]);
    return this;
  }

  srem(key: string, member: string) {
    this.commands.push(["SREM", key, member]);
    return this;
  }

  async exec() {
    return this.client.execMulti(this.commands);
  }
}

export class NativeRedisClient implements RedisClient {
  private socket: SocketLike | null = null;
  private buffer = Buffer.alloc(0);
  private readonly pending: PendingRequest[] = [];
  private connected = false;
  private operationChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: NativeRedisOptions) {}

  async connect() {
    if (this.connected) return;
    const parsed = parseRedisUrl(this.options.url);
    const socket = parsed.tls
      ? tls.connect({ host: parsed.host, port: parsed.port })
      : net.createConnection({ host: parsed.host, port: parsed.port });
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        resolve();
      });
    });

    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drainResponses();
    });
    socket.on("error", (err) => {
      while (this.pending.length > 0) {
        this.pending.shift()?.reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    socket.on("close", () => {
      this.connected = false;
      this.socket = null;
    });

    this.connected = true;
    if (parsed.password || parsed.username) {
      if (parsed.username) {
        await this.send(["AUTH", parsed.username, parsed.password ?? ""]);
      } else if (parsed.password) {
        await this.send(["AUTH", parsed.password]);
      }
    }
    if (Number.isInteger(parsed.db)) {
      await this.send(["SELECT", parsed.db as number]);
    }
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationChain.then(operation, operation);
    this.operationChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async sendRaw(parts: Array<string | number>): Promise<unknown> {
    if (!this.socket || !this.connected) {
      throw new Error("Redis socket is not connected");
    }
    const payload = encodeCommand(parts);
    return await new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket!.write(payload, "utf8", (err) => {
        if (err) {
          const pending = this.pending.pop();
          pending?.reject(err);
        }
      });
    });
  }

  private async send(parts: Array<string | number>): Promise<unknown> {
    return await this.enqueueOperation(() => this.sendRaw(parts));
  }

  private drainResponses() {
    while (this.pending.length > 0 && this.buffer.length > 0) {
      const reader = new RespReader(this.buffer);
      const parsed = reader.parse();
      if (!parsed) return;
      this.buffer = this.buffer.subarray(parsed.bytesRead);
      const pending = this.pending.shift();
      if (!pending) continue;
      if (parsed.value instanceof Error) {
        pending.reject(parsed.value);
      } else {
        pending.resolve(parsed.value);
      }
    }
  }

  async ping() {
    return String(await this.send(["PING"]));
  }

  async hgetall<T = Record<string, string>>(key: string): Promise<T> {
    return normalizeHgetallReply(await this.send(["HGETALL", key])) as T;
  }

  async hget<T = string>(key: string, field: string): Promise<T | null> {
    const reply = await this.send(["HGET", key, field]);
    return (reply === null ? null : String(reply)) as T | null;
  }

  async hset(key: string, kv: Record<string, unknown>) {
    return Number(await this.send(["HSET", key, ...Object.entries(kv).flatMap(([field, value]) => [field, String(value)])]));
  }

  async scard(key: string) {
    return Number(await this.send(["SCARD", key]));
  }

  async smembers<T = string[]>(key: string): Promise<T> {
    const reply = await this.send(["SMEMBERS", key]);
    return (Array.isArray(reply) ? reply.map((v) => String(v)) : []) as T;
  }

  async sismember(key: string, member: string) {
    return Number(await this.send(["SISMEMBER", key, member]));
  }

  async sadd(key: string, member: string) {
    return Number(await this.send(["SADD", key, member]));
  }

  async srem(key: string, member: string) {
    return Number(await this.send(["SREM", key, member]));
  }

  async zrem(key: string, member: string) {
    return Number(await this.send(["ZREM", key, member]));
  }

  async ttl(key: string) {
    return Number(await this.send(["TTL", key]));
  }

  async llen(key: string) {
    return Number(await this.send(["LLEN", key]));
  }

  async rpop<T = string>(key: string): Promise<T | null> {
    const reply = await this.send(["RPOP", key]);
    return (reply === null ? null : String(reply)) as T | null;
  }

  async lrem(key: string, count: number, value: string) {
    return Number(await this.send(["LREM", key, count, value]));
  }

  async exists(key: string) {
    return Number(await this.send(["EXISTS", key]));
  }

  async del(key: string) {
    return Number(await this.send(["DEL", key]));
  }

  async hincrby(key: string, field: string, increment: number) {
    return Number(await this.send(["HINCRBY", key, field, increment]));
  }

  async expire(key: string, seconds: number) {
    return Number(await this.send(["EXPIRE", key, seconds]));
  }

  async set(key: string, value: string, options?: { nx?: boolean; ex?: number }) {
    const parts: Array<string | number> = ["SET", key, value];
    if (options?.nx) parts.push("NX");
    if (options?.ex !== undefined) parts.push("EX", options.ex);
    const reply = await this.send(parts);
    return reply === null ? null : String(reply);
  }

  async eval(script: string, keys: string[], args: string[]) {
    return await this.send(["EVAL", script, keys.length, ...keys, ...args]);
  }

  multi() {
    return new NativeRedisMulti(this);
  }

  async execMulti(commands: MultiCommand[]) {
    return await this.enqueueOperation(async () => {
      await this.sendRaw(["MULTI"]);
      for (const command of commands) {
        await this.sendRaw(command);
      }
      return normalizeExecReply(await this.sendRaw(["EXEC"]));
    });
  }

  async close() {
    if (!this.socket) return;
    this.socket.end();
    this.socket.destroy();
    this.socket = null;
    this.connected = false;
  }
}
