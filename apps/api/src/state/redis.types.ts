export type RedisSetOptions = { nx?: boolean; ex?: number };

export type RedisMulti = {
  hset: (key: string, kv: Record<string, unknown>) => RedisMulti;
  expire: (key: string, seconds: number) => RedisMulti;
  sadd: (key: string, member: string) => RedisMulti;
  del: (key: string) => RedisMulti;
  srem: (key: string, member: string) => RedisMulti;
  exec: () => Promise<unknown>;
};

export type RedisClient = {
  ping: () => Promise<unknown>;
  hgetall: <T = Record<string, string>>(key: string) => Promise<T>;
  hget: <T = string>(key: string, field: string) => Promise<T | null>;
  hset: (key: string, kv: Record<string, unknown>) => Promise<unknown>;
  scard: (key: string) => Promise<unknown>;
  smembers: <T = string[]>(key: string) => Promise<T>;
  sadd: (key: string, member: string) => Promise<unknown>;
  srem: (key: string, member: string) => Promise<unknown>;
  zrem: (key: string, member: string) => Promise<unknown>;
  ttl: (key: string) => Promise<unknown>;
  llen: (key: string) => Promise<unknown>;
  rpop: <T = string>(key: string) => Promise<T | null>;
  lrem: (key: string, count: number, value: string) => Promise<unknown>;
  exists: (key: string) => Promise<unknown>;
  del: (key: string) => Promise<unknown>;
  hincrby: (key: string, field: string, increment: number) => Promise<unknown>;
  expire: (key: string, seconds: number) => Promise<unknown>;
  set: (key: string, value: string, options?: RedisSetOptions) => Promise<unknown>;
  eval: (script: string, keys: string[], args: string[]) => Promise<unknown>;
  multi: () => RedisMulti;
  close?: () => Promise<void>;
};
