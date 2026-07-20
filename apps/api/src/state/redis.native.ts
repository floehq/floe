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
  url?: string;
  sentinel?: {
    sentinels: Array<{ host: string; port: number }>;
    name: string;
    password?: string;
    sentinelPassword?: string;
  };
  connectTimeoutMs?: number;
  maxReconnectAttempts?: number;
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
      Object.entries(reply as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
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
    this.commands.push([
      "HSET",
      key,
      ...Object.entries(kv).flatMap(([field, value]) => [field, String(value)]),
    ]);
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

type ConnectionState = {
  connected: boolean;
  reconnecting: boolean;
  attempt: number;
  lastError: string | null;
};

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

export class NativeRedisClient implements RedisClient {
  private socket: SocketLike | null = null;
  private buffer = Buffer.alloc(0);
  private readonly pending: PendingRequest[] = [];
  private connected = false;
  private operationChain: Promise<void> = Promise.resolve();

  private reconnecting = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastError: string | null = null;
  private readonly maxAttempts: number;
  private readonly connectTimeoutMs: number;
  private manualClose = false;
  private pendingConnectSocket: SocketLike | null = null;
  private sentinelIndex = 0;
  private lastPrimaryAddress: { host: string; port: number } | null = null;

  constructor(private readonly options: NativeRedisOptions) {
    this.maxAttempts =
      options.maxReconnectAttempts ??
      (Number(process.env.FLOE_REDIS_RECONNECT_MAX_ATTEMPTS) ||
        DEFAULT_MAX_ATTEMPTS);
    this.connectTimeoutMs =
      options.connectTimeoutMs ??
      (Number(process.env.FLOE_REDIS_CONNECT_TIMEOUT_MS) ||
        DEFAULT_CONNECT_TIMEOUT_MS);
  }

  getRedisConnectionState(): ConnectionState {
    return {
      connected: this.connected,
      reconnecting: this.reconnecting,
      attempt: this.reconnectAttempt,
      lastError: this.lastError,
    };
  }

  private rejectPending(err: Error) {
    while (this.pending.length > 0) {
      this.pending.shift()?.reject(err);
    }
  }

  private parseUrl() {
    if (this.options.url) {
      return parseRedisUrl(this.options.url);
    }
    return null;
  }

  private async querySentinel(): Promise<{ host: string; port: number }> {
    if (!this.options.sentinel) {
      throw new Error("No Sentinel configuration");
    }
    const { sentinels, name, sentinelPassword } = this.options.sentinel;
    const startIdx = this.sentinelIndex;
    let lastErr: Error | null = null;

    for (let i = 0; i < sentinels.length; i++) {
      const idx = (startIdx + i) % sentinels.length;
      const sentinel = sentinels[idx]!;
      this.sentinelIndex = (idx + 1) % sentinels.length;

      try {
        const result = await this.querySingleSentinel(sentinel, name, sentinelPassword);
        console.info(`[Redis] Resolved primary from Sentinel ${sentinel.host}:${sentinel.port}: ${result.host}:${result.port}`);
        return result;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        console.warn(`[Redis] Sentinel ${sentinel.host}:${sentinel.port} failed: ${lastErr.message}`);
      }
    }
    throw new Error(`All Sentinels failed. Last error: ${lastErr?.message ?? "unknown"}`);
  }

  private querySingleSentinel(
    sentinel: { host: string; port: number },
    masterName: string,
    password?: string,
  ): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: sentinel.host, port: sentinel.port });
      let settled = false;
      const timeoutMs = 3000;

      const cleanup = () => {
        socket.removeAllListeners();
        socket.destroy();
      };

      const onError = (err: Error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      };

      socket.once("error", onError);
      socket.once("close", () => {
        if (!settled) {
          settled = true;
          reject(new Error(`Sentinel ${sentinel.host}:${sentinel.port} closed unexpectedly`));
        }
      });

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error(`Sentinel ${sentinel.host}:${sentinel.port} timed out`));
        }
      }, timeoutMs);

      socket.once("connect", async () => {
        try {
          if (password) {
            const authCmd = encodeCommand(["AUTH", password]);
            socket.write(authCmd);
            await new Promise<void>((res, rej) => {
              const onData = (chunk: Buffer) => {
                socket.off("error", onError);
                const reader = new RespReader(chunk);
                const parsed = reader.parse();
                if (parsed?.value instanceof Error) {
                  rej(parsed.value);
                } else {
                  res();
                }
                socket.off("data", onData);
              };
              socket.once("data", onData);
            });
          }

          const cmd = encodeCommand(["SENTINEL", "get-master-addr-by-name", masterName]);
          socket.write(cmd);

          let responseBuffer = Buffer.alloc(0);
          const onData = (chunk: Buffer) => {
            responseBuffer = Buffer.concat([responseBuffer, chunk]);
            const reader = new RespReader(responseBuffer);
            const parsed = reader.parse();
            if (!parsed) return;

            socket.off("data", onData);
            socket.off("error", onError);
            clearTimeout(timer);
            cleanup();

            if (parsed.value instanceof Error) {
              reject(parsed.value);
              return;
            }
            if (!Array.isArray(parsed.value) || parsed.value.length < 2) {
              reject(new Error(`Unexpected Sentinel response: ${JSON.stringify(parsed.value)}`));
              return;
            }
            resolve({
              host: String(parsed.value[0]),
              port: Number(parsed.value[1]),
            });
          };

          socket.on("data", onData);
        } catch (err) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            cleanup();
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        }
      });
    });
  }

  private registerSocketHandlers(socket: SocketLike) {
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drainResponses();
    });
    socket.on("error", (err) => {
      this.rejectPending(err instanceof Error ? err : new Error(String(err)));
    });
    socket.on("close", () => {
      this.rejectPending(new Error("Redis socket closed"));
      this.connected = false;
      this.socket = null;
      if (!this.manualClose) {
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect() {
    if (this.manualClose) return;
    if (this.reconnectTimer !== null) return;
    if (this.reconnectAttempt >= this.maxAttempts) {
      console.error(
        `[Redis] Reconnection failed after ${this.maxAttempts} attempts: ${this.lastError ?? "unknown"}`,
      );
      this.reconnecting = false;
      return;
    }

    this.reconnecting = true;
    const delay = Math.min(BASE_DELAY_MS * 2 ** this.reconnectAttempt, MAX_DELAY_MS);
    this.reconnectAttempt++;

    console.warn(
      `[Redis] Reconnection attempt ${this.reconnectAttempt}/${this.maxAttempts} after ${delay}ms`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.tryReconnect();
    }, delay);
  }

  private async tryReconnect() {
    try {
      if (this.options.sentinel) {
        this.lastPrimaryAddress = null;
      }
      await this.connectInternal();
      if (this.manualClose) {
        this.socket?.destroy();
        this.socket = null;
        this.connected = false;
        return;
      }
      this.reconnecting = false;
      this.reconnectAttempt = 0;
      this.lastError = null;
      console.info("[Redis] Reconnected successfully");
    } catch (err) {
      if (this.manualClose) return;
      this.connected = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.scheduleReconnect();
    }
  }

  async connect() {
    if (this.connected) return;
    this.manualClose = false;
    try {
      await this.connectInternal();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.connected = false;
      this.scheduleReconnect();
      throw err;
    }
  }

  private async connectInternal() {
    let host: string;
    let port: number;
    let tls = false;
    let password: string | undefined;
    let username: string | undefined;
    let db: number | undefined;

    if (this.options.sentinel) {
      const primary = this.lastPrimaryAddress
        ? this.lastPrimaryAddress
        : await this.querySentinel();
      host = primary.host;
      port = primary.port;
      password = this.options.sentinel.password;
      this.lastPrimaryAddress = { host, port };
    } else {
      const parsed = this.parseUrl();
      if (!parsed) {
        throw new Error("No REDIS_URL or Sentinel configuration provided");
      }
      host = parsed.host;
      port = parsed.port;
      tls = parsed.tls;
      password = parsed.password;
      username = parsed.username;
      db = parsed.db;
    }

    const socket = tls
      ? tls.connect({ host, port })
      : net.createConnection({ host, port });

    this.pendingConnectSocket = socket;

    let timedOut = false;
    const connectReady = new Promise<void>((resolve, reject) => {
      let settled = false;
      const onError = (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        if (!settled) {
          settled = true;
          socket.off("error", onError);
          resolve();
        }
      });
      socket.once("close", () => {
        if (!settled) {
          settled = true;
          reject(new Error("Redis connect timed out"));
        }
      });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      socket.destroy();
    }, this.connectTimeoutMs);

    try {
      await connectReady;
    } catch (err) {
      if (timedOut) throw new Error("Redis connect timed out");
      throw err;
    } finally {
      clearTimeout(timer);
      this.pendingConnectSocket = null;
    }

    this.socket = socket;
    this.registerSocketHandlers(socket);

    this.buffer = Buffer.alloc(0);
    this.connected = true;

    try {
      if (password || username) {
        if (username) {
          await this.send(["AUTH", username, password ?? ""]);
        } else if (password) {
          await this.send(["AUTH", password]);
        }
      }
      if (Number.isInteger(db)) {
        await this.send(["SELECT", db as number]);
      }
    } catch (authErr) {
      this.connected = false;
      this.socket = null;
      this.rejectPending(authErr instanceof Error ? authErr : new Error(String(authErr)));
      socket.destroy();
      throw authErr;
    }
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationChain.then(operation, operation);
    this.operationChain = run.then(
      () => undefined,
      () => undefined,
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
    return Number(
      await this.send([
        "HSET",
        key,
        ...Object.entries(kv).flatMap(([field, value]) => [field, String(value)]),
      ]),
    );
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
    this.manualClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnecting = false;
    if (this.pendingConnectSocket) {
      this.pendingConnectSocket.destroy();
      this.pendingConnectSocket = null;
    }
    if (!this.socket) return;
    this.rejectPending(new Error("Redis client closed"));
    this.socket.end();
    this.socket.destroy();
    this.socket = null;
    this.connected = false;
  }
}
