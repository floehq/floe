#!/usr/bin/env node

import process from "node:process";

function usage() {
  console.error(
    "Usage: npm run measure:stream -- <fileId> [--base-url http://localhost:3001] [--range bytes=0-1048575] [--size-mib 5] [--random-start] [--runs 2] [--api-key <key>] [--bearer <token>]"
  );
}

function parseArgs(argv) {
  const args = [...argv];
  const out = {
    fileId: "",
    baseUrl: process.env.FLOE_MEASURE_BASE_URL ?? "http://localhost:3001",
    range: process.env.FLOE_MEASURE_RANGE ?? "",
    runs: Number(process.env.FLOE_MEASURE_RUNS ?? 2),
    apiKey: process.env.FLOE_API_KEY ?? "",
    bearer: process.env.FLOE_BEARER_TOKEN ?? "",
    sizeMib:
      process.env.FLOE_MEASURE_SIZE_MIB !== undefined
        ? Number(process.env.FLOE_MEASURE_SIZE_MIB)
        : null,
    randomStart: process.env.FLOE_MEASURE_RANDOM_START === "1",
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) break;

    if (!out.fileId && !arg.startsWith("--")) {
      out.fileId = arg;
      continue;
    }
    if (arg === "--base-url") {
      out.baseUrl = String(args.shift() ?? "");
      continue;
    }
    if (arg === "--range") {
      out.range = String(args.shift() ?? "");
      continue;
    }
    if (arg === "--size-mib") {
      out.sizeMib = Number(args.shift() ?? "");
      continue;
    }
    if (arg === "--random-start") {
      out.randomStart = true;
      continue;
    }
    if (arg === "--runs") {
      out.runs = Number(args.shift() ?? "");
      continue;
    }
    if (arg === "--api-key") {
      out.apiKey = String(args.shift() ?? "");
      continue;
    }
    if (arg === "--bearer") {
      out.bearer = String(args.shift() ?? "");
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!out.fileId) throw new Error("Missing required fileId");
  if (!Number.isInteger(out.runs) || out.runs < 1) {
    throw new Error("--runs must be an integer >= 1");
  }
  if (!/^https?:\/\//.test(out.baseUrl)) {
    throw new Error("--base-url must start with http:// or https://");
  }
  if (out.apiKey && out.bearer) {
    throw new Error("Use either --api-key or --bearer, not both");
  }
  if (out.sizeMib !== null && (!Number.isFinite(out.sizeMib) || out.sizeMib <= 0)) {
    throw new Error("--size-mib must be a number > 0");
  }
  if (out.range && out.sizeMib !== null) {
    throw new Error("Use either --range or --size-mib, not both");
  }
  if (!out.range && out.sizeMib === null) {
    out.range = "bytes=0-1048575";
  }

  return out;
}

function toMs(startNs, endNs) {
  return Number(endNs - startNs) / 1_000_000;
}

async function measureOne(url, headers) {
  const startedAt = process.hrtime.bigint();
  const res = await fetch(url, { headers });
  const responseAt = process.hrtime.bigint();

  if (!res.ok && res.status !== 206) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Request failed status=${res.status}${body ? ` body=${body.slice(0, 200)}` : ""}`
    );
  }

  let firstChunkAt = null;
  let bytesRead = 0;
  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("Response body missing");
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstChunkAt === null) firstChunkAt = process.hrtime.bigint();
    bytesRead += value.byteLength;
  }

  const finishedAt = process.hrtime.bigint();

  return {
    status: res.status,
    contentLength: res.headers.get("content-length"),
    contentRange: res.headers.get("content-range"),
    ttfbMs: toMs(startedAt, firstChunkAt ?? responseAt),
    headersMs: toMs(startedAt, responseAt),
    totalMs: toMs(startedAt, finishedAt),
    bytesRead,
  };
}

function summarize(results) {
  const sortedTtfb = [...results].map((r) => r.ttfbMs).sort((a, b) => a - b);
  const sortedTotal = [...results].map((r) => r.totalMs).sort((a, b) => a - b);
  const pick = (arr, p) => arr[Math.min(arr.length - 1, Math.floor((arr.length - 1) * p))];

  return {
    p50TtfbMs: pick(sortedTtfb, 0.5),
    p95TtfbMs: pick(sortedTtfb, 0.95),
    p50TotalMs: pick(sortedTotal, 0.5),
    p95TotalMs: pick(sortedTotal, 0.95),
  };
}

function parseContentRangeTotal(contentRange) {
  if (!contentRange) return null;
  const match = contentRange.match(/^bytes\s+\d+-\d+\/(\d+)$/i);
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isFinite(total) && total > 0 ? total : null;
}

function randomIntInclusive(min, max) {
  const span = max - min + 1;
  return min + Math.floor(Math.random() * span);
}

function buildRange(params) {
  if (params.fixedRange) return params.fixedRange;
  const sizeBytes = Math.floor(params.sizeMib * 1024 * 1024);
  if (!params.totalBytes || sizeBytes >= params.totalBytes) {
    return `bytes=0-${Math.max(0, (params.totalBytes ?? sizeBytes) - 1)}`;
  }
  const maxStart = params.totalBytes - sizeBytes;
  const start = params.randomStart ? randomIntInclusive(0, maxStart) : 0;
  const end = start + sizeBytes - 1;
  return `bytes=${start}-${end}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = `${args.baseUrl.replace(/\/+$/, "")}/v1/files/${encodeURIComponent(args.fileId)}/stream`;
  let discoveredTotalBytes = null;

  const results = [];
  for (let i = 0; i < args.runs; i++) {
    const range = buildRange({
      fixedRange: args.range || null,
      sizeMib: args.sizeMib,
      randomStart: args.randomStart,
      totalBytes: discoveredTotalBytes,
    });
    const headers = { Range: range };
    if (args.apiKey) {
      headers["x-api-key"] = args.apiKey;
    }
    if (args.bearer) {
      headers.authorization = `Bearer ${args.bearer}`;
    }

    const run = await measureOne(url, headers);
    discoveredTotalBytes = parseContentRangeTotal(run.contentRange) ?? discoveredTotalBytes;
    results.push(run);
    console.log(
      JSON.stringify(
        {
          run: i + 1,
          range,
          cold: i === 0,
          ...run,
        },
        null,
        2
      )
    );
  }

  console.log(
    JSON.stringify(
      {
        fileId: args.fileId,
        baseUrl: args.baseUrl,
        rangeMode: args.range ? "fixed" : args.randomStart ? "random_start" : "from_zero",
        range: args.range || null,
        sizeMib: args.sizeMib,
        runs: args.runs,
        summary: summarize(results),
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  if (
    message.startsWith("Unknown argument:") ||
    message.startsWith("Missing required fileId") ||
    message.startsWith("--")
  ) {
    usage();
  }
  process.exit(1);
});
