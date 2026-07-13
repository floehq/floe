#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const out = {
    base: "http://localhost:3001",
    file: "",
    runs: 5,
    mode: "both",
    range: "bytes=0-1048575",
    outDir: "",
    beforeAfter: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--base" && next) {
      out.base = next;
      i += 1;
      continue;
    }
    if (arg === "--file" && next) {
      out.file = next;
      i += 1;
      continue;
    }
    if (arg === "--runs" && next) {
      out.runs = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--mode" && next) {
      out.mode = next;
      i += 1;
      continue;
    }
    if (arg === "--range" && next) {
      out.range = next;
      i += 1;
      continue;
    }
    if (arg === "--out-dir" && next) {
      out.outDir = next;
      i += 1;
      continue;
    }
    if (arg === "--before-after") {
      out.beforeAfter = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  if (!out.file) {
    printHelp();
    throw new Error("--file is required");
  }
  if (!Number.isInteger(out.runs) || out.runs <= 0) {
    throw new Error("--runs must be a positive integer");
  }
  if (!["full", "range", "both"].includes(out.mode)) {
    throw new Error("--mode must be one of: full, range, both");
  }

  return out;
}

function printHelp() {
  console.log(`Usage: node scripts/stream-bench.mjs --file <fileId> [options]

Options:
  --base <url>        API base URL without /v1 suffix (default: http://localhost:3001)
  --runs <count>      Runs per mode (default: 5)
  --mode <mode>       full | range | both (default: both)
  --range <header>    Range header for range mode (default: bytes=0-1048575)
  --out-dir <path>    Directory for CSV output (default: tmp/stream-load/<timestamp>)
  --before-after      Run two passes (cold then warm) and compute improvement
`);
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function csvEscape(value) {
  const raw = String(value ?? "");
  if (!/[ ,"\n]/.test(raw) && !raw.includes(",")) return raw;
  return `"${raw.replace(/"/g, '""')}"`;
}

async function runOnce({ url, rangeHeader, mode, pass }) {
  const startedAt = Date.now();
  let ttfbMs = null;
  let bytes = 0;
  let status = 0;
  let ok = false;
  let error = "";
  let cacheStatus = "";
  let etag = "";
  let contentType = "";

  try {
    const res = await fetch(url, {
      headers: rangeHeader ? { Range: rangeHeader } : {},
    });
    status = res.status;
    ok = res.ok;
    cacheStatus = res.headers.get("cache-control") ?? "";
    etag = res.headers.get("etag") ?? "";
    contentType = res.headers.get("content-type") ?? "";

    // Detect 304 Not Modified (conditional request optimization)
    if (status === 304) {
      // No body for 304; skip reading
      return {
        pass,
        mode,
        status,
        ok,
        bytes: 0,
        ttfbMs: Date.now() - startedAt,
        totalMs: Date.now() - startedAt,
        rangeHeader: rangeHeader ?? "",
        cacheStatus,
        etag,
        contentType,
        error,
      };
    }

    if (!res.body) {
      throw new Error("missing response body");
    }

    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (ttfbMs === null) {
        ttfbMs = Date.now() - startedAt;
      }
      bytes += value.byteLength;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return {
    pass,
    mode,
    status,
    ok,
    bytes,
    ttfbMs,
    totalMs: Date.now() - startedAt,
    rangeHeader: rangeHeader ?? "",
    cacheStatus,
    etag,
    contentType,
    error,
  };
}

function summarize(results) {
  if (results.length === 0) return null;
  const totals = results.reduce(
    (acc, item) => {
      acc.totalMs += item.totalMs;
      acc.bytes += item.bytes;
      if (item.ttfbMs !== null) {
        acc.ttfbMs += item.ttfbMs;
        acc.ttfbCount += 1;
      }
      if (item.status === 304) acc.num304 += 1;
      return acc;
    },
    { totalMs: 0, bytes: 0, ttfbMs: 0, ttfbCount: 0, num304: 0 }
  );

  return {
    avgTotalMs: Math.round((totals.totalMs / results.length) * 100) / 100,
    avgTtfbMs:
      totals.ttfbCount > 0
        ? Math.round((totals.ttfbMs / totals.ttfbCount) * 100) / 100
        : null,
    avgBytes: Math.round((totals.bytes / results.length) * 100) / 100,
    num304: totals.num304,
    count: results.length,
  };
}

function pctChange(before, after) {
  if (before === 0) return "inf";
  return `${Math.round(((after - before) / before) * 10000) / 100}%`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const modes = args.mode === "both" ? ["full", "range"] : [args.mode];
  const outputDir = args.outDir || path.join("tmp", "stream-load", timestampSlug());
  const base = args.base.replace(/\/$/, "");
  const url = `${base}/v1/files/${encodeURIComponent(args.file)}/stream`;
  const passes = args.beforeAfter ? ["before", "after"] : ["single"];
  const rows = [];

  for (const pass of passes) {
    for (const mode of modes) {
      for (let run = 1; run <= args.runs; run += 1) {
        const row = await runOnce({
          url,
          rangeHeader: mode === "range" ? args.range : "",
          mode,
          pass,
        });
        rows.push({ run, ...row });
      }
    }
  }

  await fs.mkdir(outputDir, { recursive: true });
  const csvPath = path.join(outputDir, "stream-bench.csv");
  const headers = [
    "run",
    "pass",
    "mode",
    "status",
    "ok",
    "bytes",
    "ttfbMs",
    "totalMs",
    "rangeHeader",
    "cacheStatus",
    "etag",
    "error",
  ];
  const csv = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n");
  await fs.writeFile(csvPath, `${csv}\n`);

  if (args.beforeAfter) {
    for (const mode of modes) {
      const before = summarize(rows.filter((r) => r.pass === "before" && r.mode === mode));
      const after = summarize(rows.filter((r) => r.pass === "after" && r.mode === mode));
      if (!before || !after) continue;
      console.log(
        `${mode} (before vs after):\n` +
        `  avg_ttfb_ms:    ${before.avgTtfbMs ?? "n/a"} → ${after.avgTtfbMs ?? "n/a"} (${before.avgTtfbMs != null && after.avgTtfbMs != null ? pctChange(before.avgTtfbMs, after.avgTtfbMs) : "n/a"})\n` +
        `  avg_total_ms:   ${before.avgTotalMs} → ${after.avgTotalMs} (${pctChange(before.avgTotalMs, after.avgTotalMs)})\n` +
        `   304 count:      ${before.num304} / ${before.count} → ${after.num304} / ${after.count}\n` +
        `   avg_bytes:     ${before.avgBytes} → ${after.avgBytes}\n`
      );
    }
  } else {
    for (const mode of modes) {
      const summary = summarize(rows.filter((row) => row.mode === mode));
      if (!summary) continue;
      console.log(
        `${mode}: avg_ttfb_ms=${summary.avgTtfbMs ?? "n/a"} avg_total_ms=${summary.avgTotalMs} avg_bytes=${summary.avgBytes} 304=${summary.num304}/${summary.count}`
      );
    }
  }

  console.log(`wrote ${csvPath}`);
}

await main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
