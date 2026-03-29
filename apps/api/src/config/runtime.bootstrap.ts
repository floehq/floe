import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

type NodeRole = "read" | "write" | "full";

export type RuntimeFileConfig = {
  node?: {
    role?: NodeRole;
  };
  http?: {
    port?: number;
    corsOrigins?: string[];
    trustProxy?: boolean;
  };
  walrus?: {
    readers?: string[];
    writers?: string[];
  };
  metrics?: {
    enabled?: boolean;
  };
};

export function parseRuntimeArgs(argv: string[]): { configPath?: string; role?: NodeRole } {
  let configPath: string | undefined;
  let role: NodeRole | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if ((arg === "--config" || arg === "-c") && next) {
      configPath = next;
      i += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
      continue;
    }
    if (arg === "--role" && next) {
      role = parseBootstrapNodeRole(next);
      i += 1;
      continue;
    }
    if (arg.startsWith("--role=")) {
      role = parseBootstrapNodeRole(arg.slice("--role=".length));
    }
  }

  return { configPath, role };
}

export function parseBootstrapNodeRole(raw?: string): NodeRole | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === "read" || value === "write" || value === "full") {
    return value;
  }
  throw new Error("FLOE_NODE_ROLE must be one of: read, write, full");
}

function normalizeStringList(values: unknown, fieldName: string): string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) {
    throw new Error(`${fieldName} must be an array`);
  }
  const out = values
    .map((value) => {
      if (typeof value !== "string") {
        throw new Error(`${fieldName} entries must be strings`);
      }
      return value.trim();
    })
    .filter(Boolean);
  return out.length > 0 ? out : undefined;
}

export function normalizeRuntimeConfig(raw: unknown): RuntimeFileConfig {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Config file must contain a top-level object");
  }

  const value = raw as Record<string, unknown>;

  const role = parseBootstrapNodeRole((value.node as any)?.role);
  const portRaw = (value.http as any)?.port;
  if (portRaw !== undefined && (!Number.isInteger(portRaw) || Number(portRaw) <= 0)) {
    throw new Error("http.port must be a positive integer");
  }
  const trustProxyRaw = (value.http as any)?.trustProxy;
  if (trustProxyRaw !== undefined && typeof trustProxyRaw !== "boolean") {
    throw new Error("http.trustProxy must be a boolean");
  }

  const metricsEnabled = (value.metrics as any)?.enabled;
  if (
    metricsEnabled !== undefined &&
    typeof metricsEnabled !== "boolean"
  ) {
    throw new Error("metrics.enabled must be a boolean");
  }

  return {
    node: role ? { role } : undefined,
    http: {
      port: portRaw as number | undefined,
      corsOrigins: normalizeStringList((value.http as any)?.corsOrigins, "http.corsOrigins"),
      trustProxy: trustProxyRaw as boolean | undefined,
    },
    walrus: {
      readers: normalizeStringList((value.walrus as any)?.readers, "walrus.readers"),
      writers: normalizeStringList((value.walrus as any)?.writers, "walrus.writers"),
    },
    metrics: metricsEnabled === undefined ? undefined : { enabled: metricsEnabled },
  };
}

async function loadConfigFile(configPath: string): Promise<RuntimeFileConfig> {
  const resolved = path.resolve(configPath);
  const text = await fs.readFile(resolved, "utf8");
  const parsed = parseYaml(text);
  return normalizeRuntimeConfig(parsed);
}

function setEnvDefault(name: string, value: string | undefined) {
  if (!value) return;
  if (process.env[name] === undefined || process.env[name] === "") {
    process.env[name] = value;
  }
}

export function applyRuntimeConfig(config: RuntimeFileConfig, argvRole?: NodeRole) {
  setEnvDefault("FLOE_NODE_ROLE", config.node?.role);
  if (argvRole) {
    process.env.FLOE_NODE_ROLE = argvRole;
  }

  setEnvDefault(
    "PORT",
    config.http?.port !== undefined ? String(config.http.port) : undefined
  );
  setEnvDefault("FLOE_CORS_ORIGINS", config.http?.corsOrigins?.join(","));
  if (config.http?.trustProxy !== undefined) {
    setEnvDefault("FLOE_TRUST_PROXY", config.http.trustProxy ? "1" : "0");
  }

  const readers = config.walrus?.readers ?? [];
  if (readers.length > 0) {
    setEnvDefault("WALRUS_AGGREGATOR_URL", readers[0]);
    setEnvDefault("WALRUS_AGGREGATOR_FALLBACK_URLS", readers.slice(1).join(","));
  }

  const writers = config.walrus?.writers ?? [];
  if (writers.length > 0) {
    setEnvDefault("FLOE_WALRUS_SDK_BASE_URL", writers[0]);
    setEnvDefault("FLOE_WALRUS_SDK_BASE_URLS", writers.join(","));
  }

  if (config.metrics?.enabled !== undefined) {
    setEnvDefault("FLOE_ENABLE_METRICS", config.metrics.enabled ? "1" : "0");
  }
}

export async function bootstrapRuntimeConfig() {
  const { configPath: argConfigPath, role } = parseRuntimeArgs(process.argv.slice(2));
  const explicitConfigPath = argConfigPath ?? process.env.FLOE_CONFIG;
  if (explicitConfigPath) {
    const config = await loadConfigFile(explicitConfigPath);
    applyRuntimeConfig(config, role);
    return;
  }

  if (role) {
    process.env.FLOE_NODE_ROLE = role;
  }
}
