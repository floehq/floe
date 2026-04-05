#!/usr/bin/env node

import { FloeApiError, FloeClient, createNodeFileResumeStore } from "@floehq/sdk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type CliOptions = {
  baseUrl: string;
  apiKey?: string;
  bearerToken?: string;
  ownerAddress?: string;
  authUser?: string;
  walletAddress?: string;
  json: boolean;
  verbose: boolean;
  chunkSize?: number;
  epochs?: number;
  parallel?: number;
  includeBlobId?: boolean;
  noResume?: boolean;
  pollIntervalMs?: number;
  maxWaitMs?: number;
};

type ResolvedCommand =
  | { kind: "help"; topic?: string }
  | { kind: "upload.upload"; filePath?: string }
  | { kind: "upload.status"; uploadId?: string }
  | { kind: "upload.cancel"; uploadId?: string }
  | { kind: "upload.complete"; uploadId?: string }
  | { kind: "upload.wait"; uploadId?: string }
  | { kind: "file.metadata"; fileId?: string }
  | { kind: "file.manifest"; fileId?: string }
  | { kind: "file.stream-url"; fileId?: string }
  | { kind: "ops.health" }
  | { kind: "config.show" }
  | { kind: "config.path" }
  | { kind: "config.set"; key?: string; value?: string }
  | { kind: "config.unset"; key?: string };

type StoredConfig = {
  baseUrl?: string;
  apiKey?: string;
  bearerToken?: string;
  ownerAddress?: string;
  authUser?: string;
  walletAddress?: string;
};

type ParsedArgState = {
  tokens: string[];
  overrides: Partial<CliOptions>;
};

const CONFIG_KEY_MAP = {
  "base-url": "baseUrl",
  "api-key": "apiKey",
  bearer: "bearerToken",
  "owner-address": "ownerAddress",
  "auth-user": "authUser",
  "wallet-address": "walletAddress",
} as const;

type ConfigKey = keyof typeof CONFIG_KEY_MAP;

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

const COLOR_ENABLED = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);

function paint(text: string, ...codes: string[]): string {
  if (!COLOR_ENABLED || codes.length === 0) return text;
  return `${codes.join("")}${text}${ANSI.reset}`;
}

function headline(text: string): string {
  return paint(text, ANSI.bold, ANSI.cyan);
}

function section(title: string): string {
  return `\n${paint(title, ANSI.bold, ANSI.blue)}`;
}

function valueLine(label: string, value: unknown): string {
  const rendered =
    value === null || value === undefined || value === "" ? paint("none", ANSI.gray) : String(value);
  return `  ${paint(label.padEnd(16), ANSI.dim)} ${rendered}`;
}

function pushOptionalLine(lines: string[], label: string, value: unknown) {
  if (value === null || value === undefined || value === "") return;
  lines.push(valueLine(label, value));
}

function infoLine(message: string) {
  process.stderr.write(`${paint(">", ANSI.bold, ANSI.cyan)} ${message}\n`);
}

function verboseLine(options: CliOptions, label: string, value?: unknown) {
  if (!options.verbose || options.json) return;
  const suffix = value === undefined ? "" : ` ${String(value)}`;
  process.stderr.write(`${paint("verbose", ANSI.dim, ANSI.gray)} ${label}${suffix}\n`);
}

function statusBadge(status: string | null | undefined): string {
  const normalized = (status ?? "unknown").toLowerCase();
  if (["ready", "up", "healthy", "ok"].includes(normalized)) {
    return paint(normalized.toUpperCase(), ANSI.bold, ANSI.green);
  }
  if (["pending", "processing", "queued", "partial"].includes(normalized)) {
    return paint(normalized.toUpperCase(), ANSI.bold, ANSI.yellow);
  }
  return paint(normalized.toUpperCase(), ANSI.bold, ANSI.red);
}

function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatPercent(part: number, total: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return "0%";
  return `${Math.min(100, Math.max(0, (part / total) * 100)).toFixed(0)}%`;
}

function progressBar(current: number, total: number, width = 28): string {
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) {
    return `[${"-".repeat(width)}]`;
  }
  const ratio = Math.min(1, Math.max(0, current / total));
  const filled = Math.round(ratio * width);
  return `[${"=".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}]`;
}

function writeLines(lines: string[]) {
  process.stdout.write(`${lines.join("\n")}\n`);
}

function printHelp(topic?: string) {
  const normalized = (topic ?? "").toLowerCase();
  if (normalized === "config") {
    writeLines([
      headline("Floe CLI  Config"),
      "Persist defaults for the CLI so you do not have to repeat flags.",
      section("Usage"),
      "  floe config show",
      "  floe config path",
      "  floe config set <key> <value>",
      "  floe config unset <key>",
      section("Keys"),
      "  base-url",
      "  api-key",
      "  bearer",
      "  owner-address",
      "  auth-user",
      "  wallet-address",
      section("Precedence"),
      "  flags override env vars, env vars override config, config overrides defaults",
      section("Examples"),
      "  floe config set base-url https://api.floehq.com/v1",
      "  floe config set api-key sk_live_xxx",
      "  floe config unset api-key",
      "  floe config path",
    ]);
    return;
  }

  if (normalized === "upload") {
    writeLines([
      headline("Floe CLI  Upload"),
      "Ship a file, inspect the upload, or finish an interrupted flow.",
      section("Usage"),
      "  floe upload <file> [options]",
      "  floe upload status <uploadId> [options]",
      "  floe upload cancel <uploadId> [options]",
      "  floe upload complete <uploadId> [options]",
      "  floe upload wait <uploadId> [options]",
      section("Notes"),
      "  resume is enabled by default through the local resume store",
      "  use --no-resume when you want a clean upload session",
      section("Examples"),
      "  floe upload ./movie.mp4",
      "  floe upload wait 123e4567-e89b-12d3-a456-426614174000",
    ]);
    return;
  }

  if (normalized === "file") {
    writeLines([
      headline("Floe CLI  File"),
      "Inspect file metadata, fetch manifests, and derive stream URLs.",
      section("Usage"),
      "  floe file metadata <fileId> [options]",
      "  floe file manifest <fileId> [options]",
      "  floe file stream-url <fileId> [options]",
    ]);
    return;
  }

  if (normalized === "ops") {
    writeLines([
      headline("Floe CLI  Ops"),
      "Check whether the Floe deployment is alive and ready to serve traffic.",
      section("Usage"),
      "  floe ops health [options]",
    ]);
    return;
  }

  writeLines([
    headline("Floe CLI"),
    "Developer tooling for uploads, file inspection, and operator checks.",
    section("Usage"),
    "  floe <group> <command> [args] [options]",
    section("Groups"),
    "  upload     upload files, resume flows, and finalize sessions",
    "  file       inspect metadata, manifests, and stream URLs",
    "  ops        health and deployment checks",
    "  config     show the effective local CLI configuration",
    "  help       show top-level or group help",
    section("Primary Commands"),
    "  floe upload <file>",
    "  floe upload status <uploadId>",
    "  floe upload cancel <uploadId>",
    "  floe upload complete <uploadId>",
    "  floe upload wait <uploadId>",
    "  floe file metadata <fileId>",
    "  floe file manifest <fileId>",
    "  floe file stream-url <fileId>",
    "  floe ops health",
    "  floe config show",
    "  floe config path",
    "  floe config set <key> <value>",
    "  floe config unset <key>",
    section("Shortcuts"),
    "  floe status <uploadId>",
    "  floe cancel <uploadId>",
    "  floe metadata <fileId>",
    "  floe manifest <fileId>",
    "  floe stream-url <fileId>",
    section("Global Options"),
    "  --base-url <url>        Floe API base URL",
    "  --api-key <key>         x-api-key auth",
    "  --bearer <token>        Authorization bearer token",
    "  --owner-address <addr>  x-owner-address auth hint",
    "  --wallet-address <addr> x-wallet-address auth hint",
    "  --auth-user <id>        x-auth-user auth hint",
    "  -v, --verbose           Show request-stage details",
    "  --json                  Print JSON only",
    "  --include-blob-id       Ask Floe to include blobId when supported",
    section("Upload Options"),
    "  --chunk-size <bytes>    Upload chunk size in bytes",
    "  --epochs <n>            Walrus epochs for upload create",
    "  --parallel <n>          Parallel chunk uploads (default: 3)",
    "  --no-resume             Disable resume-store lookup for uploads",
    "  --poll-interval-ms <n>  Finalize wait poll interval",
    "  --max-wait-ms <n>       Finalize max wait time",
    section("Examples"),
    "  floe upload ./movie.mp4 --base-url http://127.0.0.1:3001/v1",
    "  floe upload wait 123e4567-e89b-12d3-a456-426614174000",
    "  floe file metadata 0xabc...",
    "  floe ops health",
    "  floe config show",
    "  floe config set base-url https://api.floehq.com/v1",
  ]);
}

function inferContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".json") return "application/json";
  if (ext === ".txt") return "text/plain";
  if (ext === ".mkv") return "video/x-matroska";
  return "application/octet-stream";
}

function parsePositiveIntegerFlag(name: string, value?: string): number {
  if (!value?.trim()) {
    throw new Error(`${name} requires a value`);
  }
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${name} must be a positive integer`);
  }

  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

function defaultOptions(): CliOptions {
  return {
    baseUrl: "http://127.0.0.1:3001/v1",
    json: false,
    verbose: false,
    parallel: 3,
  };
}

function getConfigPath(): string {
  const root = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(root, "floe", "config.json");
}

async function readStoredConfig(): Promise<StoredConfig> {
  try {
    const raw = await fs.readFile(getConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as StoredConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw error;
  }
}

async function writeStoredConfig(config: StoredConfig): Promise<void> {
  const configPath = getConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function applyStoredConfig(options: CliOptions, config: StoredConfig) {
  if (config.baseUrl) options.baseUrl = config.baseUrl;
  if (config.apiKey) options.apiKey = config.apiKey;
  if (config.bearerToken) options.bearerToken = config.bearerToken;
  if (config.ownerAddress) options.ownerAddress = config.ownerAddress;
  if (config.authUser) options.authUser = config.authUser;
  if (config.walletAddress) options.walletAddress = config.walletAddress;
}

function applyEnvConfig(options: CliOptions) {
  if (process.env.FLOE_BASE_URL) options.baseUrl = process.env.FLOE_BASE_URL;
  if (process.env.FLOE_API_KEY) options.apiKey = process.env.FLOE_API_KEY;
  if (process.env.FLOE_BEARER_TOKEN) options.bearerToken = process.env.FLOE_BEARER_TOKEN;
  if (process.env.FLOE_OWNER_ADDRESS) options.ownerAddress = process.env.FLOE_OWNER_ADDRESS;
  if (process.env.FLOE_AUTH_USER) options.authUser = process.env.FLOE_AUTH_USER;
  if (process.env.FLOE_WALLET_ADDRESS) options.walletAddress = process.env.FLOE_WALLET_ADDRESS;
}

function parseArgState(argv: string[]): ParsedArgState {
  const tokens: string[] = [];
  const overrides: Partial<CliOptions> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("-")) {
      tokens.push(arg);
      continue;
    }

    const readValue = () => {
      const value = argv[i + 1];
      i += 1;
      return value;
    };

    switch (arg) {
      case "--base-url":
        overrides.baseUrl = readValue() || defaultOptions().baseUrl;
        break;
      case "--api-key":
        overrides.apiKey = readValue() || "";
        break;
      case "--bearer":
        overrides.bearerToken = readValue() || "";
        break;
      case "--owner-address":
        overrides.ownerAddress = readValue() || "";
        break;
      case "--wallet-address":
        overrides.walletAddress = readValue() || "";
        break;
      case "--auth-user":
        overrides.authUser = readValue() || "";
        break;
      case "--chunk-size":
        overrides.chunkSize = parsePositiveIntegerFlag("--chunk-size", readValue());
        break;
      case "--epochs":
        overrides.epochs = parsePositiveIntegerFlag("--epochs", readValue());
        break;
      case "--parallel":
        overrides.parallel = parsePositiveIntegerFlag("--parallel", readValue());
        break;
      case "--poll-interval-ms":
        overrides.pollIntervalMs = parsePositiveIntegerFlag("--poll-interval-ms", readValue());
        break;
      case "--max-wait-ms":
        overrides.maxWaitMs = parsePositiveIntegerFlag("--max-wait-ms", readValue());
        break;
      case "--include-blob-id":
        overrides.includeBlobId = true;
        break;
      case "--no-resume":
        overrides.noResume = true;
        break;
      case "--json":
        overrides.json = true;
        break;
      case "--verbose":
      case "-v":
        overrides.verbose = true;
        break;
      default:
        break;
    }
  }

  return { tokens, overrides };
}

function resolveCommand(tokens: string[]): ResolvedCommand {
  const [first, second] = tokens.map((v) => v.toLowerCase());
  let command: ResolvedCommand;

  switch (first ?? "help") {
    case "upload":
      switch (second) {
        case "status":
          command = { kind: "upload.status", uploadId: tokens[2] };
          break;
        case "cancel":
          command = { kind: "upload.cancel", uploadId: tokens[2] };
          break;
        case "complete":
          command = { kind: "upload.complete", uploadId: tokens[2] };
          break;
        case "wait":
          command = { kind: "upload.wait", uploadId: tokens[2] };
          break;
        case "help":
          command = { kind: "help", topic: "upload" };
          break;
        default:
          command = { kind: "upload.upload", filePath: tokens[1] ?? tokens[0] };
      }
      break;
    case "file":
      switch (second) {
        case "metadata":
          command = { kind: "file.metadata", fileId: tokens[2] };
          break;
        case "manifest":
          command = { kind: "file.manifest", fileId: tokens[2] };
          break;
        case "stream-url":
          command = { kind: "file.stream-url", fileId: tokens[2] };
          break;
        case "help":
          command = { kind: "help", topic: "file" };
          break;
        default:
          command = { kind: "help", topic: "file" };
      }
      break;
    case "ops":
      command = second === "health" ? { kind: "ops.health" } : { kind: "help", topic: "ops" };
      break;
    case "config":
      switch (second) {
        case "show":
          command = { kind: "config.show" };
          break;
        case "path":
          command = { kind: "config.path" };
          break;
        case "set":
          command = { kind: "config.set", key: tokens[2], value: tokens[3] };
          break;
        case "unset":
          command = { kind: "config.unset", key: tokens[2] };
          break;
        case "help":
          command = { kind: "help", topic: "config" };
          break;
        default:
          command = { kind: "help", topic: "config" };
          break;
      }
      break;
    case "status":
      command = { kind: "upload.status", uploadId: tokens[1] };
      break;
    case "cancel":
      command = { kind: "upload.cancel", uploadId: tokens[1] };
      break;
    case "metadata":
      command = { kind: "file.metadata", fileId: tokens[1] };
      break;
    case "manifest":
      command = { kind: "file.manifest", fileId: tokens[1] };
      break;
    case "stream-url":
      command = { kind: "file.stream-url", fileId: tokens[1] };
      break;
    case "help":
      command = { kind: "help", topic: tokens[1] };
      break;
    default:
      command = { kind: "help" };
      break;
  }

  return command;
}

async function parseArgs(argv: string[]): Promise<{
  command: ResolvedCommand;
  options: CliOptions;
}> {
  const { tokens } = parseArgState(argv);
  const options = defaultOptions();
  applyStoredConfig(options, await readStoredConfig());
  applyEnvConfig(options);
  const { overrides: overrideOptions } = parseArgState(argv);
  Object.assign(options, overrideOptions);
  return { command: resolveCommand(tokens), options };
}

function requireConfigKey(key: string | undefined): ConfigKey {
  if (!key) throw new Error("config key is required");
  const normalized = key.toLowerCase() as ConfigKey;
  if (!(normalized in CONFIG_KEY_MAP)) {
    throw new Error(`unsupported config key: ${key}`);
  }
  return normalized;
}

function printResult(value: unknown, json: boolean) {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printUploadResult(
  value: {
    uploadId?: string;
    fileId?: string;
    sizeBytes?: number;
    status?: string;
    chunkSize?: number;
    totalChunks?: number;
    walrusEndEpoch?: number;
  },
  options: CliOptions
) {
  if (options.json) {
    printResult(value, true);
    return;
  }

  const lines = [
    headline("Upload Complete"),
    valueLine("status", statusBadge(value.status)),
    valueLine("uploadId", value.uploadId),
    valueLine("fileId", value.fileId),
    valueLine("size", formatBytes(value.sizeBytes)),
    valueLine("chunkSize", formatBytes(value.chunkSize)),
    valueLine("chunks", value.totalChunks),
  ];
  pushOptionalLine(lines, "walrusEndEpoch", value.walrusEndEpoch);
  writeLines(lines);
}

function printSimpleActionResult(
  title: string,
  value: Record<string, unknown>,
  options: CliOptions
) {
  if (options.json) {
    printResult(value, true);
    return;
  }

  const lines = [headline(title)];
  for (const [key, rawValue] of Object.entries(value)) {
    lines.push(valueLine(key, rawValue));
  }
  writeLines(lines);
}

function printUploadStatusResult(value: Record<string, unknown>, options: CliOptions) {
  if (options.json) {
    printResult(value, true);
    return;
  }

  const lines = [
    headline("Upload Status"),
    valueLine("status", statusBadge(String(value.status ?? "unknown"))),
    valueLine("uploadId", value.uploadId),
    valueLine("fileId", value.fileId),
    valueLine("uploaded", formatBytes(typeof value.uploadedBytes === "number" ? value.uploadedBytes : null)),
    valueLine("total", formatBytes(typeof value.sizeBytes === "number" ? value.sizeBytes : null)),
    valueLine("chunks", value.totalChunks),
  ];
  pushOptionalLine(lines, "walrusEndEpoch", value.walrusEndEpoch);
  if (options.includeBlobId) {
    pushOptionalLine(lines, "blobId", value.blobId);
  }
  writeLines(lines);
}

function printManifestResult(value: Record<string, unknown>, options: CliOptions) {
  if (options.json) {
    printResult(value, true);
    return;
  }

  const lines = [
    headline("File Manifest"),
    valueLine("fileId", value.fileId),
    valueLine("manifestVersion", value.manifestVersion),
    valueLine("container", value.container),
    valueLine("tracks", Array.isArray(value.tracks) ? value.tracks.length : value.tracks),
    valueLine("segmentCount", Array.isArray(value.segments) ? value.segments.length : value.segments),
  ];
  pushOptionalLine(lines, "walrusEndEpoch", value.walrusEndEpoch);
  if (options.includeBlobId) {
    pushOptionalLine(lines, "blobId", value.blobId);
  }
  writeLines(lines);
}

function printFileMetadataResult(value: Record<string, unknown>, options: CliOptions) {
  if (options.json) {
    printResult(value, true);
    return;
  }

  const lines = [
    headline("File Metadata"),
    valueLine("fileId", value.fileId),
    valueLine("mimeType", value.mimeType),
    valueLine("size", formatBytes(typeof value.sizeBytes === "number" ? value.sizeBytes : null)),
    valueLine("owner", value.owner),
    valueLine("createdAt", value.createdAt),
  ];
  pushOptionalLine(lines, "walrusEndEpoch", value.walrusEndEpoch);
  if (options.includeBlobId) {
    pushOptionalLine(lines, "blobId", value.blobId);
  }
  writeLines(lines);
}

function printStreamUrlResult(fileId: string, streamUrl: string, options: CliOptions) {
  if (options.json) {
    printResult({ fileId, streamUrl }, true);
    return;
  }

  writeLines([
    headline("Stream URL"),
    valueLine("fileId", fileId),
    valueLine("url", streamUrl),
  ]);
}

function printHealthResult(value: Record<string, unknown>, options: CliOptions) {
  if (options.json) {
    printResult(value, true);
    return;
  }

  const checks = (value.checks ?? {}) as Record<string, unknown>;
  const redis = checks.redis as Record<string, unknown> | undefined;
  const postgres = checks.postgres as Record<string, unknown> | undefined;
  const finalizeQueue = checks.finalizeQueue as Record<string, unknown> | undefined;

  writeLines([
    headline("Deployment Health"),
    valueLine("status", statusBadge(String(value.status ?? "unknown"))),
    valueLine("service", value.service),
    valueLine("role", value.role),
    valueLine("ready", value.ready),
    valueLine("degraded", value.degraded),
    valueLine("timestamp", value.timestamp),
    section("Dependencies"),
    valueLine("redis", redis?.status ?? redis?.ok),
    valueLine("postgres", postgres?.status ?? postgres?.ok),
    valueLine("queueDepth", finalizeQueue?.depth),
    valueLine("queueWorkers", finalizeQueue?.concurrency),
    valueLine("oldestQueued", finalizeQueue?.oldestQueuedAgeMs),
  ]);
}

function printConfigResult(
  value: {
    baseUrl: string;
    path: string;
    auth: Record<string, unknown>;
    upload: Record<string, unknown>;
  },
  options: CliOptions
) {
  if (options.json) {
    printResult(value, true);
    return;
  }

  writeLines([
    headline("CLI Configuration"),
    valueLine("path", value.path),
    valueLine("baseUrl", value.baseUrl),
    section("Auth"),
    valueLine("apiKey", value.auth.apiKey),
    valueLine("bearer", value.auth.bearerToken),
    valueLine("owner", value.auth.ownerAddress),
    valueLine("authUser", value.auth.authUser),
    valueLine("wallet", value.auth.walletAddress),
    section("Upload"),
    valueLine("chunkSize", value.upload.chunkSize),
    valueLine("epochs", value.upload.epochs),
    valueLine("parallel", value.upload.parallel),
    valueLine("includeBlobId", value.upload.includeBlobId),
    valueLine("resumeDisabled", value.upload.noResume),
    valueLine("pollIntervalMs", value.upload.pollIntervalMs),
    valueLine("maxWaitMs", value.upload.maxWaitMs),
    section("Output"),
    valueLine("json", options.json),
    valueLine("verbose", options.verbose),
  ]);
}

async function runConfigPath(options: CliOptions) {
  const configPath = getConfigPath();
  if (options.json) {
    printResult({ path: configPath }, true);
    return;
  }
  writeLines([headline("CLI Config Path"), valueLine("path", configPath)]);
}

async function runConfigSet(keyRaw: string | undefined, valueRaw: string | undefined, options: CliOptions) {
  const key = requireConfigKey(keyRaw);
  const value = requireValue(valueRaw, "config value");
  const config = await readStoredConfig();
  config[CONFIG_KEY_MAP[key]] = value;
  await writeStoredConfig(config);
  if (!options.json) infoLine(`saved ${key} in ${getConfigPath()}`);
  printSimpleActionResult(
    "Config Updated",
    { key, value: key.includes("key") || key === "bearer" ? "[configured]" : value, path: getConfigPath() },
    options
  );
}

async function runConfigUnset(keyRaw: string | undefined, options: CliOptions) {
  const key = requireConfigKey(keyRaw);
  const config = await readStoredConfig();
  delete config[CONFIG_KEY_MAP[key]];
  await writeStoredConfig(config);
  if (!options.json) infoLine(`removed ${key} from ${getConfigPath()}`);
  printSimpleActionResult("Config Updated", { key, removed: true, path: getConfigPath() }, options);
}

async function readFileAsBlob(filePath: string, contentType: string): Promise<Blob> {
  const openAsBlob = (
    fs as unknown as {
      openAsBlob?: (path: string, options?: { type?: string }) => Promise<Blob>;
    }
  ).openAsBlob;
  if (typeof openAsBlob === "function") {
    return await openAsBlob(filePath, { type: contentType });
  }

  const bytes = await fs.readFile(filePath);
  return new Blob([bytes], { type: contentType });
}

async function buildClient(options: CliOptions): Promise<FloeClient> {
  const resumeStore = options.noResume ? undefined : await createNodeFileResumeStore();

  return new FloeClient({
    baseUrl: options.baseUrl,
    auth: {
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.bearerToken ? { bearerToken: options.bearerToken } : {}),
      ...(options.ownerAddress ? { ownerAddress: options.ownerAddress } : {}),
      ...(options.authUser ? { authUser: options.authUser } : {}),
      ...(options.walletAddress ? { walletAddress: options.walletAddress } : {}),
    },
    resumeStore,
    userAgent: "@floehq/cli",
  });
}

function requireValue(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function rootApiUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}

async function fetchJson(
  url: string,
  options: CliOptions
): Promise<unknown> {
  const headers = new Headers();
  if (options.apiKey) headers.set("x-api-key", options.apiKey);
  if (options.bearerToken) headers.set("authorization", `Bearer ${options.bearerToken}`);
  if (options.authUser) headers.set("x-auth-user", options.authUser);
  if (options.ownerAddress) headers.set("x-owner-address", options.ownerAddress);
  if (options.walletAddress) headers.set("x-wallet-address", options.walletAddress);
  headers.set("x-floe-sdk", "@floehq/cli");

  const response = await fetch(url, { headers });
  verboseLine(options, "request", url);
  verboseLine(options, "auth", headers.get("authorization") ? "bearer" : headers.get("x-api-key") ? "api-key" : "none");
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${text}`);
  }
  return data;
}

async function runUpload(filePathRaw: string | undefined, options: CliOptions) {
  const rawFile = requireValue(filePathRaw, "file path");
  const filePath = path.resolve(rawFile);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);

  const contentType = inferContentType(filePath);
  const blob = await readFileAsBlob(filePath, contentType);
  const client = await buildClient(options);
  let progressLineOpen = false;

  if (!options.json) {
    infoLine(`preparing ${path.basename(filePath)}  ${formatBytes(stat.size)}  ${contentType}`);
    infoLine(`target ${options.baseUrl}`);
  }
  verboseLine(options, "file", filePath);
  verboseLine(options, "resume", options.noResume ? "disabled" : "enabled");
  verboseLine(options, "parallel", options.parallel);
  verboseLine(options, "chunkSize", options.chunkSize ?? "default");

  const result = await client.uploadBlob(blob, {
    filename: path.basename(filePath),
    contentType,
    ...(options.chunkSize ? { chunkSize: options.chunkSize } : {}),
    ...(options.epochs ? { epochs: options.epochs } : {}),
    ...(options.parallel ? { parallel: options.parallel } : {}),
    ...(options.includeBlobId ? { includeBlobId: true } : {}),
    ...(options.pollIntervalMs ? { finalizePollIntervalMs: options.pollIntervalMs } : {}),
    ...(options.maxWaitMs ? { finalizeMaxWaitMs: options.maxWaitMs } : {}),
    onProgress(progress) {
      if (options.json) return;
      progressLineOpen = true;
      const line = [
        paint("uploading", ANSI.bold, ANSI.cyan),
        progressBar(progress.uploadedBytes, progress.totalBytes),
        paint(formatPercent(progress.uploadedBytes, progress.totalBytes), ANSI.bold),
        `${progress.uploadedChunks}/${progress.totalChunks} chunks`,
        `${formatBytes(progress.uploadedBytes)} / ${formatBytes(progress.totalBytes)}`,
      ].join("  ");
      process.stderr.write(`\r\x1b[2K${line}`);
    },
  });

  if (!options.json && progressLineOpen) {
    process.stderr.write("\r\x1b[2K");
    infoLine("finalizing upload and waiting for readiness");
  }

  printUploadResult(result, options);
}

async function runUploadStatus(uploadIdRaw: string | undefined, options: CliOptions) {
  const uploadId = requireValue(uploadIdRaw, "uploadId");
  if (!options.json) infoLine(`checking upload ${uploadId}`);
  const client = await buildClient(options);
  const result = await client.getUploadStatus(uploadId, {
    ...(options.includeBlobId ? { query: { includeBlobId: 1 } } : {}),
  });
  printUploadStatusResult(result as Record<string, unknown>, options);
}

async function runUploadCancel(uploadIdRaw: string | undefined, options: CliOptions) {
  const uploadId = requireValue(uploadIdRaw, "uploadId");
  if (!options.json) infoLine(`canceling upload ${uploadId}`);
  const client = await buildClient(options);
  const result = await client.cancelUpload(uploadId);
  printSimpleActionResult("Upload Canceled", result as Record<string, unknown>, options);
}

async function runUploadComplete(uploadIdRaw: string | undefined, options: CliOptions) {
  const uploadId = requireValue(uploadIdRaw, "uploadId");
  if (!options.json) infoLine(`completing upload ${uploadId}`);
  const client = await buildClient(options);
  const result = await client.completeUpload(uploadId, {
    ...(options.includeBlobId ? { includeBlobId: true } : {}),
  });
  printUploadStatusResult(result as Record<string, unknown>, options);
}

async function runUploadWait(uploadIdRaw: string | undefined, options: CliOptions) {
  const uploadId = requireValue(uploadIdRaw, "uploadId");
  if (!options.json) infoLine(`waiting for upload ${uploadId}`);
  verboseLine(options, "pollIntervalMs", options.pollIntervalMs ?? "default");
  verboseLine(options, "maxWaitMs", options.maxWaitMs ?? "default");
  const client = await buildClient(options);
  const result = await client.waitForUploadReady(uploadId, {
    ...(options.includeBlobId ? { includeBlobId: true } : {}),
    ...(options.pollIntervalMs ? { pollIntervalMs: options.pollIntervalMs } : {}),
    ...(options.maxWaitMs ? { maxWaitMs: options.maxWaitMs } : {}),
  });
  printUploadStatusResult(result as Record<string, unknown>, options);
}

async function runFileMetadata(fileIdRaw: string | undefined, options: CliOptions) {
  const fileId = requireValue(fileIdRaw, "fileId");
  if (!options.json) infoLine(`fetching metadata for ${fileId}`);
  const client = await buildClient(options);
  const result = await client.getFileMetadata(fileId, {
    ...(options.includeBlobId ? { includeBlobId: true } : {}),
  });
  printFileMetadataResult(result as Record<string, unknown>, options);
}

async function runFileManifest(fileIdRaw: string | undefined, options: CliOptions) {
  const fileId = requireValue(fileIdRaw, "fileId");
  if (!options.json) infoLine(`fetching manifest for ${fileId}`);
  const client = await buildClient(options);
  const result = await client.getFileManifest(fileId);
  printManifestResult(result as Record<string, unknown>, options);
}

async function runFileStreamUrl(fileIdRaw: string | undefined, options: CliOptions) {
  const fileId = requireValue(fileIdRaw, "fileId");
  const client = await buildClient(options);
  if (!options.json) infoLine(`building stream URL for ${fileId}`);
  printStreamUrlResult(fileId, client.getFileStreamUrl(fileId), options);
}

async function runOpsHealth(options: CliOptions) {
  if (!options.json) infoLine(`checking deployment health at ${rootApiUrl(options.baseUrl)}/health`);
  const result = await fetchJson(`${rootApiUrl(options.baseUrl)}/health`, options);
  printHealthResult(result as Record<string, unknown>, options);
}

async function runConfigShow(options: CliOptions) {
  printConfigResult(
    {
      path: getConfigPath(),
      baseUrl: options.baseUrl,
      auth: {
        apiKey: options.apiKey ? "[configured]" : null,
        bearerToken: options.bearerToken ? "[configured]" : null,
        ownerAddress: options.ownerAddress ?? null,
        authUser: options.authUser ?? null,
        walletAddress: options.walletAddress ?? null,
      },
      upload: {
        chunkSize: options.chunkSize ?? null,
        epochs: options.epochs ?? null,
        parallel: options.parallel ?? null,
        includeBlobId: options.includeBlobId ?? false,
        noResume: options.noResume ?? false,
        pollIntervalMs: options.pollIntervalMs ?? null,
        maxWaitMs: options.maxWaitMs ?? null,
      },
    },
    options
  );
}

async function main() {
  const { command, options } = await parseArgs(process.argv.slice(2));

  switch (command.kind) {
    case "help":
      printHelp(command.topic);
      return;
    case "upload.upload":
      await runUpload(command.filePath, options);
      return;
    case "upload.status":
      await runUploadStatus(command.uploadId, options);
      return;
    case "upload.cancel":
      await runUploadCancel(command.uploadId, options);
      return;
    case "upload.complete":
      await runUploadComplete(command.uploadId, options);
      return;
    case "upload.wait":
      await runUploadWait(command.uploadId, options);
      return;
    case "file.metadata":
      await runFileMetadata(command.fileId, options);
      return;
    case "file.manifest":
      await runFileManifest(command.fileId, options);
      return;
    case "file.stream-url":
      await runFileStreamUrl(command.fileId, options);
      return;
    case "ops.health":
      await runOpsHealth(options);
      return;
    case "config.show":
      await runConfigShow(options);
      return;
    case "config.path":
      await runConfigPath(options);
      return;
    case "config.set":
      await runConfigSet(command.key, command.value, options);
      return;
    case "config.unset":
      await runConfigUnset(command.key, options);
      return;
  }
}

main().catch((err) => {
  if (err instanceof FloeApiError) {
    process.stderr.write(`${paint("Request Failed", ANSI.bold, ANSI.red)}\n`);
    process.stderr.write(`  ${paint("message".padEnd(16), ANSI.dim)} ${err.message}\n`);
    process.stderr.write(`  ${paint("status".padEnd(16), ANSI.dim)} ${String(err.status ?? "unknown")}\n`);
    process.stderr.write(`  ${paint("code".padEnd(16), ANSI.dim)} ${String(err.code ?? "unknown")}\n`);
    process.stderr.write(`  ${paint("retryable".padEnd(16), ANSI.dim)} ${String(Boolean(err.retryable))}\n`);
    if (err.requestId) {
      process.stderr.write(`  ${paint("requestId".padEnd(16), ANSI.dim)} ${err.requestId}\n`);
    }
    if (err.details) {
      process.stderr.write(`${section("Details")}\n${JSON.stringify(err.details, null, 2)}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stderr.write(`${paint("Error", ANSI.bold, ANSI.red)} ${String(err instanceof Error ? err.message : err)}\n`);
  process.exitCode = 1;
});
