#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// ─── CLI Parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    base: "http://localhost:3001",
    apiKey: "",
    sessions: 10,
    concurrency: 5,
    chunkSize: 1048576,
    fileChunks: 4,
    runs: 1,
    outDir: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--base" && next) {
      out.base = next;
      i += 1;
      continue;
    }
    if (arg === "--api-key" && next) {
      out.apiKey = next;
      i += 1;
      continue;
    }
    if (arg === "--sessions" && next) {
      out.sessions = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--concurrency" && next) {
      out.concurrency = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--chunk-size" && next) {
      out.chunkSize = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--file-chunks" && next) {
      out.fileChunks = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--runs" && next) {
      out.runs = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--out-dir" && next) {
      out.outDir = next;
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  if (!Number.isInteger(out.sessions) || out.sessions <= 0) {
    throw new Error("--sessions must be a positive integer");
  }
  if (!Number.isInteger(out.concurrency) || out.concurrency <= 0) {
    throw new Error("--concurrency must be a positive integer");
  }
  if (!Number.isInteger(out.chunkSize) || out.chunkSize <= 0) {
    throw new Error("--chunk-size must be a positive integer");
  }
  if (!Number.isInteger(out.fileChunks) || out.fileChunks <= 0) {
    throw new Error("--file-chunks must be a positive integer");
  }
  if (!Number.isInteger(out.runs) || out.runs <= 0) {
    throw new Error("--runs must be a positive integer");
  }

  return out;
}

function printHelp() {
  console.log(`Usage: node scripts/upload-load.mjs [options]

Options:
  --base <url>          API base URL (default: http://localhost:3001)
  --api-key <key>       API key for authentication
  --sessions <n>        Number of upload sessions (default: 10)
  --concurrency <n>     Max concurrent operations (default: 5)
  --chunk-size <bytes>  Chunk size in bytes (default: 1048576 = 1 MiB)
  --file-chunks <n>     Chunks per file (default: 4)
  --runs <n>            Number of full test rounds (default: 1)
  --out-dir <dir>       Custom output directory
  -h, --help            Print this help message
`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toMs(ns) {
  return Number(ns) / 1_000_000;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

function summarize(latencies) {
  if (latencies.length === 0) {
    return { min: 0, p50: 0, p95: 0, p99: 0, max: 0, avg: 0, count: 0 };
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: Math.round(sorted[0] * 100) / 100,
    p50: Math.round(percentile(sorted, 0.5) * 100) / 100,
    p95: Math.round(percentile(sorted, 0.95) * 100) / 100,
    p99: Math.round(percentile(sorted, 0.99) * 100) / 100,
    max: Math.round(sorted[sorted.length - 1] * 100) / 100,
    avg: Math.round((sum / sorted.length) * 100) / 100,
    count: sorted.length,
  };
}

function makeHeaders(apiKey) {
  const h = { "content-type": "application/json" };
  if (apiKey) h["x-api-key"] = apiKey;
  return h;
}

async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ─── API Functions ────────────────────────────────────────────────────────────

async function createSession(base, apiKey, chunkSize, fileChunks, fileIndex) {
  const startedAt = process.hrtime.bigint();
  let status = 0;
  let error = "";
  let uploadId = "";

  try {
    const res = await fetch(`${base}/v1/uploads/create`, {
      method: "POST",
      headers: makeHeaders(apiKey),
      body: JSON.stringify({
        filename: `load-test-${fileIndex}-${Date.now()}.bin`,
        contentType: "application/octet-stream",
        totalSize: chunkSize * fileChunks,
        chunkSize,
      }),
    });
    status = res.status;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`create session failed status=${status} body=${body.slice(0, 200)}`);
    }
    const data = await res.json();
    uploadId = data.uploadId ?? data.id ?? "";
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const totalMs = toMs(process.hrtime.bigint() - startedAt);
  return { totalMs, status, uploadId, error };
}

async function uploadChunk(base, apiKey, uploadId, index, chunkBytes) {
  const startedAt = process.hrtime.bigint();
  let status = 0;
  let error = "";

  try {
    const data = crypto.randomBytes(chunkBytes);
    const hash = crypto.createHash("sha256").update(data).digest("hex");

    const res = await fetch(`${base}/v1/uploads/${uploadId}/chunk/${index}`, {
      method: "PUT",
      headers: {
        ...makeHeaders(apiKey),
        "content-type": "application/octet-stream",
        "x-chunk-sha256": hash,
      },
      body: data,
    });
    status = res.status;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`upload chunk failed status=${status} body=${body.slice(0, 200)}`);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const totalMs = toMs(process.hrtime.bigint() - startedAt);
  return { totalMs, status, error };
}

async function completeSession(base, apiKey, uploadId) {
  const startedAt = process.hrtime.bigint();
  let status = 0;
  let error = "";

  try {
    const res = await fetch(`${base}/v1/uploads/${uploadId}/complete`, {
      method: "POST",
      headers: makeHeaders(apiKey),
    });
    status = res.status;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`complete session failed status=${status} body=${body.slice(0, 200)}`);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const totalMs = toMs(process.hrtime.bigint() - startedAt);
  return { totalMs, status, error };
}

async function waitForFinalization(base, apiKey, uploadId, timeoutMs = 60_000) {
  const startedAt = process.hrtime.bigint();
  let status = 0;
  let error = "";
  let finalStatus = "unknown";
  const deadline = startedAt + BigInt(Math.round(timeoutMs * 1_000_000));

  try {
    while (process.hrtime.bigint() < deadline) {
      const res = await fetch(`${base}/v1/uploads/${uploadId}/status`, {
        method: "GET",
        headers: makeHeaders(apiKey),
      });
      status = res.status;
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`status poll failed status=${status} body=${body.slice(0, 200)}`);
      }
      const data = await res.json();
      finalStatus = data.status ?? "unknown";
      if (finalStatus === "completed" || finalStatus === "failed" || finalStatus === "error") {
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const totalMs = toMs(process.hrtime.bigint() - startedAt);
  return { totalMs, status, finalStatus, error };
}

// ─── CSV ──────────────────────────────────────────────────────────────────────

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function csvEscape(value) {
  const raw = String(value ?? "");
  if (!/[ ,"\n]/.test(raw)) return raw;
  return `"${raw.replace(/"/g, '""')}"`;
}

// ─── Main Test Flow ───────────────────────────────────────────────────────────

async function runLoadTest(args) {
  const base = args.base.replace(/\/$/, "");
  const allRows = [];
  let errorCount = 0;

  function addRow(phase, sessionIndex, chunkIndex, operationMs, status) {
    allRows.push({ phase, sessionIndex, chunkIndex, operationMs, status });
  }

  for (let run = 0; run < args.runs; run++) {
    console.log(`\n── Run ${run + 1}/${args.runs} ──`);

    // Phase 1: Create sessions
    console.log(`\nPhase 1: Creating ${args.sessions} sessions...`);
    const sessionItems = Array.from({ length: args.sessions }, (_, i) => i);
    const createResults = await runWithConcurrency(sessionItems, args.concurrency, (_, idx) =>
      createSession(base, args.apiKey, args.chunkSize, args.fileChunks, idx)
    );

    const createLatencies = [];
    for (let i = 0; i < createResults.length; i++) {
      const r = createResults[i];
      createLatencies.push(r.totalMs);
      addRow("create", i, "", Math.round(r.totalMs * 100) / 100, r.status);
      if (r.error) {
        errorCount++;
        console.error(`  create error: ${r.error}`);
      }
    }
    const createStats = summarize(createLatencies);
    console.log(`  create: p50=${createStats.p50}ms p95=${createStats.p95}ms p99=${createStats.p99}ms`);

    // Phase 2: Upload chunks
    console.log(`\nPhase 2: Uploading chunks...`);
    const chunkItems = [];
    for (let s = 0; s < args.sessions; s++) {
      if (!createResults[s].uploadId) continue;
      for (let c = 0; c < args.fileChunks; c++) {
        chunkItems.push({ sessionIndex: s, chunkIndex: c, uploadId: createResults[s].uploadId });
      }
    }

    const chunkWallStart = performance.now();
    const totalChunkBytes = chunkItems.length * args.chunkSize;
    const chunkResults = await runWithConcurrency(chunkItems, args.concurrency, (item) =>
      uploadChunk(base, args.apiKey, item.uploadId, item.chunkIndex, args.chunkSize)
    );
    const chunkWallMs = performance.now() - chunkWallStart;

    const chunkLatencies = [];
    for (let i = 0; i < chunkItems.length; i++) {
      const r = chunkResults[i];
      chunkLatencies.push(r.totalMs);
      addRow("chunk", chunkItems[i].sessionIndex, chunkItems[i].chunkIndex, Math.round(r.totalMs * 100) / 100, r.status);
      if (r.error) {
        errorCount++;
        console.error(`  chunk error [session=${chunkItems[i].sessionIndex} chunk=${chunkItems[i].chunkIndex}]: ${r.error}`);
      }
    }
    const chunkStats = summarize(chunkLatencies);
    const throughputMib = (totalChunkBytes / (chunkWallMs / 1000)) / 1024 / 1024;
    console.log(`  chunk: p50=${chunkStats.p50}ms p95=${chunkStats.p95}ms p99=${chunkStats.p99}ms throughput=${throughputMib.toFixed(1)} MiB/s`);

    // Phase 3: Complete sessions
    console.log(`\nPhase 3: Completing ${args.sessions} sessions...`);
    const completeItems = createResults
      .map((r, i) => ({ sessionIndex: i, uploadId: r.uploadId }))
      .filter((r) => r.uploadId);
    const completeResults = await runWithConcurrency(completeItems, args.concurrency, (item) =>
      completeSession(base, args.apiKey, item.uploadId)
    );

    const completeLatencies = [];
    for (let i = 0; i < completeItems.length; i++) {
      const r = completeResults[i];
      completeLatencies.push(r.totalMs);
      addRow("complete", completeItems[i].sessionIndex, "", Math.round(r.totalMs * 100) / 100, r.status);
      if (r.error) {
        errorCount++;
        console.error(`  complete error [session=${completeItems[i].sessionIndex}]: ${r.error}`);
      }
    }
    const completeStats = summarize(completeLatencies);
    console.log(`  complete: p50=${completeStats.p50}ms p95=${completeStats.p95}ms p99=${completeStats.p99}ms`);

    // Phase 4: Wait for finalization
    console.log(`\nPhase 4: Waiting for finalization...`);
    const finalizeItems = createResults
      .map((r, i) => ({ sessionIndex: i, uploadId: r.uploadId }))
      .filter((r) => r.uploadId);
    const finalizeResults = await runWithConcurrency(finalizeItems, args.concurrency, (item) =>
      waitForFinalization(base, args.apiKey, item.uploadId)
    );

    const finalizeLatencies = [];
    for (let i = 0; i < finalizeItems.length; i++) {
      const r = finalizeResults[i];
      finalizeLatencies.push(r.totalMs);
      addRow("finalize", finalizeItems[i].sessionIndex, "", Math.round(r.totalMs * 100) / 100, r.status);
      if (r.error) {
        errorCount++;
        console.error(`  finalize error [session=${finalizeItems[i].sessionIndex}]: ${r.error}`);
      }
    }
    const finalizeStats = summarize(finalizeLatencies);
    console.log(`  finalize: p50=${finalizeStats.p50}ms p95=${finalizeStats.p95}ms p99=${finalizeStats.p99}ms`);
  }

  return { allRows, errorCount };
}

// ─── Entry ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = args.outDir || path.join("tmp", "upload-load", timestampSlug());

  console.log(`Upload Load Test`);
  console.log(`  base:         ${args.base}`);
  console.log(`  sessions:     ${args.sessions}`);
  console.log(`  concurrency:  ${args.concurrency}`);
  console.log(`  chunk-size:   ${args.chunkSize} bytes`);
  console.log(`  file-chunks:  ${args.fileChunks}`);
  console.log(`  runs:         ${args.runs}`);

  const { allRows, errorCount } = await runLoadTest(args);

  // Write CSV
  await fs.mkdir(outputDir, { recursive: true });
  const csvPath = path.join(outputDir, "upload-load.csv");
  const headers = ["phase", "sessionIndex", "chunkIndex", "operationMs", "status"];
  const lines = [
    headers.join(","),
    ...allRows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ];

  for (const phase of ["create", "chunk", "complete", "finalize"]) {
    const phaseRows = allRows.filter((r) => r.phase === phase);
    const latencies = phaseRows.map((r) => r.operationMs);
    if (latencies.length === 0) continue;
    const s = summarize(latencies);
    const ok = latencies.length - phaseRows.filter((r) => !r.status || r.status >= 400).length;
    const errors = phaseRows.filter((r) => !r.status || r.status >= 400).length;
    const stats = `p50=${s.p50} p95=${s.p95} p99=${s.p99} ok=${ok} errors=${errors}`;
    lines.push(["summary", phase, "", stats, ""].map(csvEscape).join(","));
  }

  await fs.writeFile(csvPath, lines.join("\n") + "\n");

  // Overall summary
  for (const phase of ["create", "chunk", "complete", "finalize"]) {
    const latencies = allRows.filter((r) => r.phase === phase).map((r) => r.operationMs);
    if (latencies.length === 0) continue;
    const s = summarize(latencies);
    console.log(`\n${phase}: min=${s.min}ms p50=${s.p50}ms p95=${s.p95}ms p99=${s.p99}ms max=${s.max}ms avg=${s.avg}ms count=${s.count}`);
  }

  console.log(`\nwrote ${csvPath}`);

  if (errorCount > 0) {
    console.error(`\n${errorCount} operation(s) failed`);
    process.exitCode = 1;
  }
}

await main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
