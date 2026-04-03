#!/usr/bin/env node

import { FloeApiError, FloeClient, createNodeFileResumeStore } from "@floehq/sdk";
import fs from "node:fs/promises";
import path from "node:path";

type CliOptions = {
  baseUrl: string;
  apiKey?: string;
  bearerToken?: string;
  ownerAddress?: string;
  authUser?: string;
  walletAddress?: string;
  json: boolean;
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
  | { kind: "config.show" };

function printHelp(topic?: string) {
  const normalized = (topic ?? "").toLowerCase();
  if (normalized === "upload") {
    process.stdout.write(`Floe CLI: upload

Usage:
  floe upload <file> [options]
  floe upload status <uploadId> [options]
  floe upload cancel <uploadId> [options]
  floe upload complete <uploadId> [options]
  floe upload wait <uploadId> [options]

Notes:
  upload resume is automatic by default through the local resume store
  use --no-resume to disable that behavior
`);
    return;
  }

  if (normalized === "file") {
    process.stdout.write(`Floe CLI: file

Usage:
  floe file metadata <fileId> [options]
  floe file manifest <fileId> [options]
  floe file stream-url <fileId> [options]
`);
    return;
  }

  if (normalized === "ops") {
    process.stdout.write(`Floe CLI: ops

Usage:
  floe ops health [options]
`);
    return;
  }

  process.stdout.write(`Floe CLI

Usage:
  floe <group> <command> [args] [options]

Groups:
  upload     upload, status, cancel, complete, and wait flows
  file       metadata, manifest, and stream URL lookups
  ops        health and operator-friendly checks
  config     show the effective local CLI configuration
  help       show top-level or group help

Primary Commands:
  floe upload <file>
  floe upload status <uploadId>
  floe upload cancel <uploadId>
  floe upload complete <uploadId>
  floe upload wait <uploadId>
  floe file metadata <fileId>
  floe file manifest <fileId>
  floe file stream-url <fileId>
  floe ops health
  floe config show

Shortcuts:
  floe status <uploadId>
  floe cancel <uploadId>
  floe metadata <fileId>
  floe manifest <fileId>
  floe stream-url <fileId>

Global Options:
  --base-url <url>        Floe API base URL
  --api-key <key>         x-api-key auth
  --bearer <token>        Authorization bearer token
  --owner-address <addr>  x-owner-address auth hint
  --wallet-address <addr> x-wallet-address auth hint
  --auth-user <id>        x-auth-user auth hint
  --json                  Print JSON only
  --include-blob-id       Ask Floe to include blobId when supported

Upload Options:
  --chunk-size <bytes>    Upload chunk size in bytes
  --epochs <n>            Walrus epochs for upload create
  --parallel <n>          Parallel chunk uploads (default: 3)
  --no-resume             Disable resume-store lookup for uploads
  --poll-interval-ms <n>  Finalize wait poll interval
  --max-wait-ms <n>       Finalize max wait time

Examples:
  floe upload ./movie.mp4 --base-url http://127.0.0.1:3001/v1
  floe upload wait 123e4567-e89b-12d3-a456-426614174000
  floe file metadata 0xabc...
  floe ops health
  floe config show
`);
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

function parseIntFlag(value?: string): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

function parseArgs(argv: string[]): {
  command: ResolvedCommand;
  options: CliOptions;
} {
  const tokens: string[] = [];
  const options: CliOptions = {
    baseUrl: process.env.FLOE_BASE_URL || "http://127.0.0.1:3001/v1",
    apiKey: process.env.FLOE_API_KEY,
    bearerToken: process.env.FLOE_BEARER_TOKEN,
    ownerAddress: process.env.FLOE_OWNER_ADDRESS,
    authUser: process.env.FLOE_AUTH_USER,
    walletAddress: process.env.FLOE_WALLET_ADDRESS,
    json: false,
    parallel: 3,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
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
        options.baseUrl = readValue() || options.baseUrl;
        break;
      case "--api-key":
        options.apiKey = readValue() || "";
        break;
      case "--bearer":
        options.bearerToken = readValue() || "";
        break;
      case "--owner-address":
        options.ownerAddress = readValue() || "";
        break;
      case "--wallet-address":
        options.walletAddress = readValue() || "";
        break;
      case "--auth-user":
        options.authUser = readValue() || "";
        break;
      case "--chunk-size":
        options.chunkSize = parseIntFlag(readValue());
        break;
      case "--epochs":
        options.epochs = parseIntFlag(readValue());
        break;
      case "--parallel":
        options.parallel = parseIntFlag(readValue());
        break;
      case "--poll-interval-ms":
        options.pollIntervalMs = parseIntFlag(readValue());
        break;
      case "--max-wait-ms":
        options.maxWaitMs = parseIntFlag(readValue());
        break;
      case "--include-blob-id":
        options.includeBlobId = true;
        break;
      case "--no-resume":
        options.noResume = true;
        break;
      case "--json":
        options.json = true;
        break;
      default:
        break;
    }
  }

  const [first, second, third] = tokens.map((v) => v.toLowerCase());
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
      command = second === "show" ? { kind: "config.show" } : { kind: "help" };
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

  return { command, options };
}

function printResult(value: unknown, json: boolean) {
  const text = JSON.stringify(value, null, 2);
  process.stdout.write(`${text}\n`);
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
      process.stderr.write(
        `uploaded ${progress.uploadedChunks}/${progress.totalChunks} chunks (${progress.uploadedBytes}/${progress.totalBytes} bytes)\n`
      );
    },
  });

  printResult(result, options.json);
}

async function runUploadStatus(uploadIdRaw: string | undefined, options: CliOptions) {
  const uploadId = requireValue(uploadIdRaw, "uploadId");
  const client = await buildClient(options);
  const result = await client.getUploadStatus(uploadId, {
    ...(options.includeBlobId ? { query: { includeBlobId: 1 } } : {}),
  });
  printResult(result, options.json);
}

async function runUploadCancel(uploadIdRaw: string | undefined, options: CliOptions) {
  const uploadId = requireValue(uploadIdRaw, "uploadId");
  const client = await buildClient(options);
  const result = await client.cancelUpload(uploadId);
  printResult(result, options.json);
}

async function runUploadComplete(uploadIdRaw: string | undefined, options: CliOptions) {
  const uploadId = requireValue(uploadIdRaw, "uploadId");
  const client = await buildClient(options);
  const result = await client.completeUpload(uploadId, {
    ...(options.includeBlobId ? { includeBlobId: true } : {}),
  });
  printResult(result, options.json);
}

async function runUploadWait(uploadIdRaw: string | undefined, options: CliOptions) {
  const uploadId = requireValue(uploadIdRaw, "uploadId");
  const client = await buildClient(options);
  const result = await client.waitForUploadReady(uploadId, {
    ...(options.includeBlobId ? { includeBlobId: true } : {}),
    ...(options.pollIntervalMs ? { pollIntervalMs: options.pollIntervalMs } : {}),
    ...(options.maxWaitMs ? { maxWaitMs: options.maxWaitMs } : {}),
  });
  printResult(result, options.json);
}

async function runFileMetadata(fileIdRaw: string | undefined, options: CliOptions) {
  const fileId = requireValue(fileIdRaw, "fileId");
  const client = await buildClient(options);
  const result = await client.getFileMetadata(fileId, {
    ...(options.includeBlobId ? { includeBlobId: true } : {}),
  });
  printResult(result, options.json);
}

async function runFileManifest(fileIdRaw: string | undefined, options: CliOptions) {
  const fileId = requireValue(fileIdRaw, "fileId");
  const client = await buildClient(options);
  const result = await client.getFileManifest(fileId);
  printResult(result, options.json);
}

async function runFileStreamUrl(fileIdRaw: string | undefined, options: CliOptions) {
  const fileId = requireValue(fileIdRaw, "fileId");
  const client = await buildClient(options);
  printResult({ fileId, streamUrl: client.getFileStreamUrl(fileId) }, options.json);
}

async function runOpsHealth(options: CliOptions) {
  const result = await fetchJson(`${rootApiUrl(options.baseUrl)}/health`, options);
  printResult(result, options.json);
}

async function runConfigShow(options: CliOptions) {
  printResult(
    {
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
    options.json
  );
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));

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
  }
}

main().catch((err) => {
  if (err instanceof FloeApiError) {
    process.stderr.write(
      `${JSON.stringify(
        {
          error: {
            message: err.message,
            status: err.status,
            code: err.code,
            retryable: err.retryable,
            requestId: err.requestId,
            details: err.details,
          },
        },
        null,
        2
      )}\n`
    );
    process.exitCode = 1;
    return;
  }

  process.stderr.write(`${String(err instanceof Error ? err.message : err)}\n`);
  process.exitCode = 1;
});
