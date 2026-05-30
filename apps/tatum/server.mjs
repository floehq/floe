import http from "node:http";
import { Readable } from "node:stream";

const port = Number(process.env.PORT ?? 3002);
const coreApiBaseUrl = (process.env.FLOE_API_BASE_URL ?? "http://localhost:3001").replace(/\/+$/, "");
const cookieName = "floe_wallet";
const publicUploadMaxBytes = Number(process.env.TATUM_PUBLIC_MAX_FILE_SIZE_BYTES ?? 5 * 1024 * 1024);
const walletUploadMaxBytes = Number(process.env.TATUM_WALLET_MAX_FILE_SIZE_BYTES ?? 10 * 1024 * 1024);

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatDate(ms) {
  if (!Number.isFinite(Number(ms))) return "unknown";
  return new Date(Number(ms)).toLocaleString();
}

function normalizeChain(raw) {
  return (raw ?? "sui").toString().trim().toLowerCase() || "sui";
}

function chainLabel(raw) {
  const chain = normalizeChain(raw);
  if (chain === "sui") return "Sui";
  if (chain === "eth") return "Ethereum";
  if (chain === "eth_base") return "Base";
  if (chain === "eth_op") return "Optimism";
  if (chain === "eth_arb") return "Arbitrum";
  if (chain === "matic") return "Polygon";
  if (chain === "avax") return "Avalanche";
  if (chain === "ftm") return "Fantom";
  return chain.charAt(0).toUpperCase() + chain.slice(1);
}

function explorerTxUrl(chain, txId) {
  if (!txId) return null;
  const normalized = normalizeChain(chain);
  const explorers = {
    polygon: "https://polygonscan.com/tx/",
    matic: "https://polygonscan.com/tx/",
    base: "https://basescan.org/tx/",
    eth_base: "https://basescan.org/tx/",
    arbitrum: "https://arbiscan.io/tx/",
    eth_arb: "https://arbiscan.io/tx/",
    optimism: "https://optimistic.etherscan.io/tx/",
    eth_op: "https://optimistic.etherscan.io/tx/",
    celo: "https://celoscan.io/tx/",
    avax: "https://snowtrace.io/tx/",
    bsc: "https://bscscan.com/tx/",
    fantom: "https://ftmscan.com/tx/",
    sui: "https://suivision.xyz/txblock/",
  };
  const base = explorers[normalized];
  return base ? `${base}${encodeURIComponent(txId)}` : null;
}

function parseCookies(cookieHeader = "") {
  const cookies = {};
  for (const pair of cookieHeader.split(";")) {
    const index = pair.indexOf("=");
    if (index === -1) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function fetchJson(pathname, params = {}) {
  const url = new URL(`${coreApiBaseUrl}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`core_api_${response.status}`);
  }
  return response.json();
}

async function listFiles(query) {
  return fetchJson("/v1/files", query);
}

async function getProvenance(fileId) {
  return fetchJson(`/v1/files/${encodeURIComponent(fileId)}/provenance`);
}

async function getUploadStatus(uploadId) {
  return fetchJson(`/v1/uploads/${encodeURIComponent(uploadId)}/status`);
}

function dashboardSessionOwner(req) {
  return parseCookies(req.headers.cookie || "")[cookieName] || null;
}

function forwardUploadHeaders(req, extraHeaders = {}) {
  const headers = {
    ...extraHeaders,
  };
  const owner = typeof req.headers["x-owner-address"] === "string" ? req.headers["x-owner-address"].trim() : "";
  const wallet = typeof req.headers["x-wallet-address"] === "string" ? req.headers["x-wallet-address"].trim() : "";
  if (owner) headers["x-owner-address"] = owner;
  if (wallet) headers["x-wallet-address"] = wallet;
  const apiKey = typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"].trim() : "";
  const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization.trim() : "";
  if (apiKey) headers["x-api-key"] = apiKey;
  if (authorization) headers.authorization = authorization;
  return headers;
}

async function sendCoreResponse(res, response) {
  const headers = {};
  for (const [key, value] of response.headers.entries()) {
    if (key === "transfer-encoding" || key === "content-length") continue;
    headers[key] = value;
  }
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const readable = Readable.fromWeb(response.body);
  readable.pipe(res);
}

async function proxyJsonToCore(req, res, targetPath, method, body) {
  const response = await fetch(`${coreApiBaseUrl}${targetPath}`, {
    method,
    headers: forwardUploadHeaders(req, {
      accept: "application/json",
      "content-type": "application/json",
    }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await sendCoreResponse(res, response);
}

async function proxyStreamToCore(req, res, targetPath) {
  const response = await fetch(`${coreApiBaseUrl}${targetPath}`, {
    method: req.method,
    headers: forwardUploadHeaders(req, {
      accept: req.headers.accept || "application/json",
      "content-type": req.headers["content-type"] || "application/octet-stream",
      "x-chunk-sha256": typeof req.headers["x-chunk-sha256"] === "string" ? req.headers["x-chunk-sha256"] : "",
    }),
    body: req,
    duplex: "half",
  });
  await sendCoreResponse(res, response);
}

function parseUploadMode(raw) {
  return raw === "wallet" ? "wallet" : "public";
}

function resolveUploadLimitForRequest(body, req) {
  if (body?.uploadMode === "public") return publicUploadMaxBytes;
  if (body?.uploadMode === "wallet") return walletUploadMaxBytes;
  const owner =
    (typeof body?.owner === "string" && body.owner.trim()) ||
    (typeof req.headers["x-owner-address"] === "string" && req.headers["x-owner-address"].trim()) ||
    dashboardSessionOwner(req);
  return owner ? walletUploadMaxBytes : publicUploadMaxBytes;
}

function renderCard(file) {
  const chain = chainLabel(file.targetChain);
  const txUrl = explorerTxUrl(file.targetChain, file.anchorTxId);
  const metadataUrl = `/api/files/${encodeURIComponent(file.fileId)}/metadata.json`;
  const provenanceUrl = `/api/files/${encodeURIComponent(file.fileId)}/provenance`;
  const streamUrl = `${coreApiBaseUrl}/v1/files/${encodeURIComponent(file.fileId)}/stream`;
  const txMarkup = file.anchorTxId
    ? txUrl
      ? `<a class="text-cyan-300 hover:text-cyan-200 break-all" href="${txUrl}" target="_blank" rel="noreferrer">${escapeHtml(file.anchorTxId)}</a>`
      : `<span class="break-all">${escapeHtml(file.anchorTxId)}</span>`
    : `<span class="text-gray-500">Pending</span>`;

  return `
    <article class="group rounded-3xl border border-white/10 bg-white/[0.06] p-5 shadow-[0_24px_90px_rgba(0,0,0,0.24)] transition hover:-translate-y-1 hover:border-cyan-400/40 hover:bg-white/[0.09]">
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <div class="flex flex-wrap gap-2">
            <span class="rounded-full border border-cyan-400/25 bg-cyan-400/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-200">${escapeHtml(chain)}</span>
            <span class="rounded-full border border-white/10 bg-black/30 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-300">${escapeHtml(file.mimeType ?? "application/octet-stream")}</span>
          </div>
          <h3 class="mt-4 truncate text-xl font-semibold text-white">${escapeHtml(file.filename ?? `Upload ${String(file.fileId).slice(0, 8)}`)}</h3>
          <p class="mt-2 text-sm text-gray-400">Uploaded ${escapeHtml(formatDate(file.createdAtMs))}</p>
        </div>
        <a class="shrink-0 rounded-2xl border border-white/10 bg-white px-4 py-2 text-sm font-semibold text-black transition hover:bg-cyan-300" href="${provenanceUrl}" target="_blank" rel="noreferrer">Open</a>
      </div>
      <dl class="mt-5 grid gap-3 text-sm text-gray-300 sm:grid-cols-2">
        <div class="rounded-2xl border border-white/8 bg-black/20 p-3">
          <dt class="text-xs uppercase tracking-[0.18em] text-gray-500">Owner</dt>
          <dd class="mt-1 break-all font-mono text-gray-200">${escapeHtml(file.ownerAddress ?? "public")}</dd>
        </div>
        <div class="rounded-2xl border border-white/8 bg-black/20 p-3">
          <dt class="text-xs uppercase tracking-[0.18em] text-gray-500">Size</dt>
          <dd class="mt-1 text-gray-200">${escapeHtml(formatBytes(Number(file.sizeBytes)))}</dd>
        </div>
        <div class="rounded-2xl border border-white/8 bg-black/20 p-3">
          <dt class="text-xs uppercase tracking-[0.18em] text-gray-500">File ID</dt>
          <dd class="mt-1 break-all font-mono text-gray-200">${escapeHtml(file.fileId)}</dd>
        </div>
        <div class="rounded-2xl border border-white/8 bg-black/20 p-3">
          <dt class="text-xs uppercase tracking-[0.18em] text-gray-500">Anchor Tx</dt>
          <dd class="mt-1 break-all text-gray-200">${txMarkup}</dd>
        </div>
      </dl>
      <div class="mt-5 flex flex-wrap gap-2 text-xs font-semibold">
        <a class="rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-gray-200 transition hover:border-cyan-400/30 hover:text-cyan-200" href="${metadataUrl}" target="_blank" rel="noreferrer">Metadata JSON</a>
        <a class="rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-gray-200 transition hover:border-cyan-400/30 hover:text-cyan-200" href="${provenanceUrl}" target="_blank" rel="noreferrer">Provenance JSON</a>
        <button type="button" data-provenance-file="${escapeHtml(file.fileId)}" class="rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-gray-200 transition hover:border-cyan-400/30 hover:text-cyan-200">Inspect provenance</button>
        <a class="rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-gray-200 transition hover:border-cyan-400/30 hover:text-cyan-200" href="${streamUrl}" target="_blank" rel="noreferrer">Stream</a>
      </div>
    </article>
  `;
}

function renderPage({ owner, chain, result }) {
  const cards = result.data.map(renderCard).join("");
  const ownerValue = owner ?? "";
  const chainValue = chain ?? "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Tatum x Walrus Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body {
      background:
        radial-gradient(circle at top left, rgba(34, 211, 238, 0.18), transparent 26%),
        radial-gradient(circle at top right, rgba(168, 85, 247, 0.16), transparent 22%),
        radial-gradient(circle at bottom center, rgba(59, 130, 246, 0.16), transparent 24%),
        linear-gradient(180deg, #040615 0%, #02040a 100%);
    }
  </style>
</head>
<body class="min-h-screen text-white">
  <div class="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
    <header class="rounded-[2rem] border border-white/10 bg-white/[0.05] p-6 shadow-[0_28px_120px_rgba(0,0,0,0.35)] backdrop-blur-xl sm:p-8">
      <div class="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div class="max-w-3xl">
          <div class="inline-flex items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/10 px-4 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-cyan-200">Hackathon dashboard</div>
          <h1 class="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">Tatum x Walrus mini dashboard</h1>
          <p class="mt-4 max-w-2xl text-base leading-7 text-gray-300">Wallet auth, owner-scoped uploads, provenance views, and live finalize status. This is a separate Tatum service on top of the generic Floe API.</p>
        </div>
        <div class="grid gap-3 text-sm text-gray-300">
          <div class="rounded-2xl border border-white/10 bg-black/25 px-4 py-3">Core API: <span class="text-white">${escapeHtml(coreApiBaseUrl)}</span></div>
          <div class="rounded-2xl border border-white/10 bg-black/25 px-4 py-3">Results: <span id="result-count" class="text-white">${result.data.length}</span></div>
        </div>
      </div>

      <div class="mt-8 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div class="rounded-3xl border border-white/10 bg-black/25 p-5">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p class="text-sm font-semibold text-gray-200">Wallet connection</p>
              <p id="wallet-status" class="mt-1 text-sm text-gray-400">Connect MetaMask, Phantom, or paste an owner address to filter uploads.</p>
            </div>
            <div class="flex flex-wrap gap-2">
              <button id="connect-wallet" class="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-black transition hover:bg-cyan-300">Connect wallet</button>
              <button id="show-all" class="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-gray-200 transition hover:border-cyan-400/30 hover:text-cyan-200">Show all</button>
            </div>
          </div>

          <div class="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
            <input id="owner-input" value="${escapeHtml(ownerValue)}" placeholder="0x owner address" class="w-full rounded-2xl border border-white/10 bg-black/30 px-4 py-3 font-mono text-sm text-white placeholder:text-gray-500 outline-none transition focus:border-cyan-400/40" />
            <div class="flex gap-2">
              <select id="chain-input" class="rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-400/40">
                <option value="">All chains</option>
                <option value="sui" ${chainValue === "sui" ? "selected" : ""}>Sui</option>
                <option value="polygon" ${chainValue === "polygon" ? "selected" : ""}>Polygon</option>
                <option value="base" ${chainValue === "base" ? "selected" : ""}>Base</option>
                <option value="arbitrum" ${chainValue === "arbitrum" ? "selected" : ""}>Arbitrum</option>
                <option value="optimism" ${chainValue === "optimism" ? "selected" : ""}>Optimism</option>
                <option value="celo" ${chainValue === "celo" ? "selected" : ""}>Celo</option>
                <option value="avax" ${chainValue === "avax" ? "selected" : ""}>Avalanche</option>
                <option value="bsc" ${chainValue === "bsc" ? "selected" : ""}>BSC</option>
                <option value="fantom" ${chainValue === "fantom" ? "selected" : ""}>Fantom</option>
              </select>
              <button id="refresh-feed" class="rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-sm font-semibold text-gray-200 transition hover:border-cyan-400/30 hover:text-cyan-200">Refresh</button>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2">
          <div class="rounded-3xl border border-white/10 bg-black/25 p-4">
            <p class="text-xs uppercase tracking-[0.18em] text-gray-500">Uploads</p>
            <p id="stat-count" class="mt-2 text-3xl font-semibold">${result.data.length}</p>
          </div>
          <div class="rounded-3xl border border-white/10 bg-black/25 p-4">
            <p class="text-xs uppercase tracking-[0.18em] text-gray-500">Bytes</p>
            <p id="stat-bytes" class="mt-2 text-3xl font-semibold">${escapeHtml(formatBytes(result.data.reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0)))}</p>
          </div>
          <div class="rounded-3xl border border-white/10 bg-black/25 p-4">
            <p class="text-xs uppercase tracking-[0.18em] text-gray-500">Chains</p>
            <p id="stat-chains" class="mt-2 text-3xl font-semibold">${new Set(result.data.map((item) => normalizeChain(item.targetChain))).size}</p>
          </div>
          <div class="rounded-3xl border border-white/10 bg-black/25 p-4">
            <p class="text-xs uppercase tracking-[0.18em] text-gray-500">Latest</p>
            <p id="stat-latest" class="mt-2 truncate text-lg font-semibold">${escapeHtml(result.data[0]?.filename ?? result.data[0]?.fileId ?? "none")}</p>
          </div>
        </div>
      </div>
    </header>

    <section class="mt-8 rounded-[2rem] border border-white/10 bg-white/[0.05] p-6 shadow-[0_28px_120px_rgba(0,0,0,0.25)] backdrop-blur-xl sm:p-8">
      <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div class="max-w-3xl">
          <div class="inline-flex items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/10 px-4 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-cyan-200">Upload</div>
          <h2 class="mt-4 text-3xl font-semibold tracking-tight">Public or wallet-scoped uploads</h2>
          <p class="mt-3 max-w-2xl text-sm leading-6 text-gray-300">Use public mode for a clean demo upload, or connect a wallet to set owner-based provenance automatically. The UI enforces the hackathon size cap before the file ever leaves the browser.</p>
        </div>
        <div class="grid gap-2 text-sm text-gray-300">
          <div class="rounded-2xl border border-white/10 bg-black/25 px-4 py-3">Public cap: <span id="upload-limit-public" class="text-white">${escapeHtml(formatBytes(publicUploadMaxBytes))}</span></div>
          <div class="rounded-2xl border border-white/10 bg-black/25 px-4 py-3">Wallet cap: <span id="upload-limit-wallet" class="text-white">${escapeHtml(formatBytes(walletUploadMaxBytes))}</span></div>
        </div>
      </div>

      <div class="mt-6 grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
        <form id="upload-form" class="rounded-3xl border border-white/10 bg-black/25 p-5">
          <div class="grid gap-4 sm:grid-cols-2">
            <label class="grid gap-2">
              <span class="text-xs uppercase tracking-[0.18em] text-gray-500">Mode</span>
              <select id="upload-mode" class="rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-400/40">
                <option value="public">Public upload</option>
                <option value="wallet">Wallet upload</option>
              </select>
            </label>
            <label class="grid gap-2">
              <span class="text-xs uppercase tracking-[0.18em] text-gray-500">Target chain</span>
              <select id="upload-chain" class="rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-400/40">
                <option value="sui">Sui</option>
                <option value="polygon" selected>Polygon</option>
                <option value="base">Base</option>
                <option value="arbitrum">Arbitrum</option>
                <option value="optimism">Optimism</option>
                <option value="celo">Celo</option>
                <option value="avax">Avalanche</option>
                <option value="bsc">BSC</option>
                <option value="fantom">Fantom</option>
              </select>
            </label>
            <label class="grid gap-2 sm:col-span-2">
              <span class="text-xs uppercase tracking-[0.18em] text-gray-500">File</span>
              <input id="upload-file" type="file" class="rounded-2xl border border-dashed border-white/15 bg-black/30 px-4 py-3 text-sm text-gray-300 file:mr-4 file:rounded-full file:border-0 file:bg-white file:px-4 file:py-2 file:text-sm file:font-semibold file:text-black" />
            </label>
            <label class="grid gap-2 sm:col-span-2">
              <span class="text-xs uppercase tracking-[0.18em] text-gray-500">Owner</span>
              <input id="upload-owner" value="${escapeHtml(ownerValue)}" placeholder="Wallet address for wallet mode" class="rounded-2xl border border-white/10 bg-black/30 px-4 py-3 font-mono text-sm text-white placeholder:text-gray-500 outline-none transition focus:border-cyan-400/40" />
            </label>
          </div>

          <div class="mt-5 flex flex-wrap gap-2">
            <button id="upload-submit" type="submit" class="rounded-2xl bg-white px-5 py-3 text-sm font-semibold text-black transition hover:bg-cyan-300">Upload and anchor</button>
            <button id="upload-reset" type="button" class="rounded-2xl border border-white/10 bg-white/[0.04] px-5 py-3 text-sm font-semibold text-gray-200 transition hover:border-cyan-400/30 hover:text-cyan-200">Clear</button>
          </div>

          <div class="mt-5 space-y-3">
            <div class="h-2 w-full overflow-hidden rounded-full bg-black/40">
              <div id="upload-progress" class="h-full w-0 rounded-full bg-gradient-to-r from-cyan-400 via-sky-400 to-violet-400 transition-all"></div>
            </div>
            <div class="flex items-center justify-between gap-4 text-sm text-gray-300">
              <p id="upload-status">Pick a file to upload.</p>
              <p id="upload-meta" class="font-mono text-gray-500">0%</p>
            </div>
          </div>
        </form>

        <aside class="rounded-3xl border border-white/10 bg-black/25 p-5">
          <div class="flex items-center justify-between gap-3">
            <div>
              <p class="text-sm font-semibold text-gray-200">Upload result</p>
              <p class="text-sm text-gray-400">A successful upload will expose provenance and metadata links here.</p>
            </div>
            <span class="rounded-full border border-cyan-400/25 bg-cyan-400/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-200">Live</span>
          </div>
          <div id="upload-result" class="mt-5 rounded-2xl border border-white/10 bg-black/30 p-4 text-sm text-gray-300">
            No upload yet.
          </div>
        </aside>
      </div>
    </section>

    <main class="mt-8 grid gap-5 lg:grid-cols-[1fr_1fr] xl:grid-cols-3">
      <section class="grid gap-5 lg:col-span-2 xl:col-span-2" id="results">
        ${cards || `<div class="rounded-3xl border border-dashed border-white/10 bg-white/[0.05] p-10 text-center text-gray-400">No uploads yet. Connect a wallet or paste an owner address to populate the dashboard.</div>`}
      </section>
      <aside class="rounded-3xl border border-white/10 bg-white/[0.05] p-6 backdrop-blur-xl">
        <div class="flex items-center justify-between gap-3">
          <div>
            <p class="text-sm font-semibold text-gray-200">Provenance</p>
            <p class="text-sm text-gray-400">Select an upload to inspect chain, blob, and links.</p>
          </div>
          <span class="rounded-full border border-cyan-400/25 bg-cyan-400/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-200">Live</span>
        </div>
        <pre id="provenance-panel" class="mt-5 overflow-auto rounded-2xl border border-white/10 bg-black/30 p-4 text-xs leading-6 text-gray-200">Click a provenance button to inspect a file.</pre>
        <div class="mt-4 rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-gray-300">
          <p class="font-semibold text-white">Live finalize status</p>
          <p class="mt-1">Use the <code>/api/uploads/:uploadId/events</code> SSE endpoint for real-time anchor updates.</p>
        </div>
      </aside>
    </main>

    <footer class="mt-10 flex flex-col gap-3 border-t border-white/10 pt-6 text-sm text-gray-500 sm:flex-row sm:items-center sm:justify-between">
      <p>Tatum x Walrus hackathon surface. Floe remains the generic storage layer.</p>
      <div class="flex flex-wrap items-center gap-4">
        <a class="hover:text-white" href="/dashboard">Dashboard</a>
        <a class="hover:text-white" href="${coreApiBaseUrl}/v1/files" target="_blank" rel="noreferrer">Core files feed</a>
      </div>
    </footer>
  </div>

  <script>
    const ownerInput = document.getElementById("owner-input");
    const chainInput = document.getElementById("chain-input");
    const connectButton = document.getElementById("connect-wallet");
    const showAllButton = document.getElementById("show-all");
    const refreshButton = document.getElementById("refresh-feed");
    const walletStatus = document.getElementById("wallet-status");
    const provenancePanel = document.getElementById("provenance-panel");
    const resultCount = document.getElementById("result-count");
    const statCount = document.getElementById("stat-count");
    const statBytes = document.getElementById("stat-bytes");
    const statChains = document.getElementById("stat-chains");
    const statLatest = document.getElementById("stat-latest");
    const uploadForm = document.getElementById("upload-form");
    const uploadMode = document.getElementById("upload-mode");
    const uploadChain = document.getElementById("upload-chain");
    const uploadFile = document.getElementById("upload-file");
    const uploadOwner = document.getElementById("upload-owner");
    const uploadSubmit = document.getElementById("upload-submit");
    const uploadReset = document.getElementById("upload-reset");
    const uploadProgress = document.getElementById("upload-progress");
    const uploadStatus = document.getElementById("upload-status");
    const uploadMeta = document.getElementById("upload-meta");
    const uploadResult = document.getElementById("upload-result");
    const uploadLimitPublic = Number(${publicUploadMaxBytes});
    const uploadLimitWallet = Number(${walletUploadMaxBytes});
    const initialData = ${JSON.stringify(result.data).replace(/</g, "\\u003c")};

    function normalizeChain(raw) {
      return (raw || "sui").toString().trim().toLowerCase() || "sui";
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes)) return "unknown";
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + " KB";
      if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + " MB";
      return (bytes / 1024 ** 3).toFixed(1) + " GB";
    }

    function currentUrl(owner, chain) {
      const url = new URL(window.location.href);
      if (owner) url.searchParams.set("owner", owner);
      else url.searchParams.delete("owner");
      if (!owner) url.searchParams.set("all", "1");
      else url.searchParams.delete("all");
      if (chain) url.searchParams.set("chain", chain);
      else url.searchParams.delete("chain");
      return url;
    }

    function currentUploadLimit(mode) {
      return mode === "wallet" ? uploadLimitWallet : uploadLimitPublic;
    }

    function updateUploadUi() {
      const mode = uploadMode.value;
      const limit = currentUploadLimit(mode);
      uploadOwner.disabled = mode !== "wallet";
      uploadOwner.placeholder = mode === "wallet" ? "Wallet address for wallet mode" : "Not used in public mode";
      uploadOwner.classList.toggle("opacity-60", mode !== "wallet");
      uploadMode.setAttribute("data-limit", String(limit));
      uploadMeta.textContent = mode === "wallet" ? "Wallet cap " + formatBytes(limit) : "Public cap " + formatBytes(limit);
    }

    function escapeText(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]);
    }

    async function sha256Hex(bytes) {
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }

    async function readChunkSha256(blob) {
      const buffer = await blob.arrayBuffer();
      return { buffer, sha256: await sha256Hex(buffer) };
    }

    function renderUploadResult(html) {
      uploadResult.innerHTML = html;
    }

    async function fetchJson(url, options) {
      const init = { ...(options || {}) };
      const body = init.body;
      if (
        body &&
        typeof body === "object" &&
        !(body instanceof FormData) &&
        !(body instanceof Blob) &&
        !(body instanceof ArrayBuffer) &&
        !(body instanceof URLSearchParams)
      ) {
        init.body = JSON.stringify(body);
        init.headers = {
          ...(init.headers || {}),
          "content-type": "application/json",
        };
      }
      const response = await fetch(url, init);
      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (err) {
        json = { raw: text };
      }
      if (!response.ok) {
        const message = json?.error?.message || json?.message || response.statusText || "Request failed";
        const error = new Error(message);
        error.response = response;
        error.body = json;
        throw error;
      }
      return json;
    }

    function reloadWithFilters() {
      const owner = ownerInput.value.trim();
      const chain = chainInput.value.trim();
      window.location.href = currentUrl(owner, chain).toString();
    }

    async function connectWallet() {
      if (!window.ethereum) {
        walletStatus.textContent = "No injected wallet detected. Paste an owner address to inspect uploads.";
        return;
      }

      try {
        walletStatus.textContent = "Requesting wallet access...";
        const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
        const address = (accounts && accounts[0]) || "";
        ownerInput.value = address;
        uploadMode.value = "wallet";
        updateUploadUi();
        await fetch("/api/auth/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ owner: address }),
        });
        walletStatus.textContent = "Connected wallet " + address.slice(0, 8) + "...";
        window.location.href = currentUrl(address, chainInput.value.trim()).toString();
      } catch (err) {
        walletStatus.textContent = "Wallet connection was cancelled or failed.";
      }
    }

    async function loadProvenance(fileId) {
      try {
        const response = await fetch("/api/files/" + encodeURIComponent(fileId) + "/provenance");
        const provenance = await response.json();
        provenancePanel.textContent = JSON.stringify(provenance, null, 2);
      } catch (err) {
        provenancePanel.textContent = "Failed to load provenance.";
      }
    }

    async function uploadFileToCore(file) {
      const mode = uploadMode.value === "wallet" ? "wallet" : "public";
      const chain = uploadChain.value || "polygon";
      const owner = uploadOwner.value.trim();
      const limit = currentUploadLimit(mode);

      if (!file) {
        throw new Error("Choose a file first");
      }
      if (file.size > limit) {
        throw new Error("File is too large for " + mode + " mode. Max " + formatBytes(limit) + ".");
      }
      if (mode === "wallet" && !owner) {
        throw new Error("Connect a wallet or paste an owner address first");
      }

      uploadProgress.style.width = "0%";
      uploadMeta.textContent = "0%";
      uploadStatus.textContent = "Creating upload session...";
      renderUploadResult("<div class=\"text-gray-400\">Preparing upload...</div>");

      const chunkSize = Math.max(512 * 1024, Math.min(1024 * 1024, limit));
      const uploadBody = {
        uploadMode: mode,
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        chunkSize,
        epochs: 1,
        targetChain: chain,
        ...(mode === "wallet" && owner ? { owner } : {}),
      };

      const uploadHeaders = {
        "content-type": "application/json",
      };
      if (mode === "wallet" && owner) {
        uploadHeaders["x-owner-address"] = owner;
        uploadHeaders["x-wallet-address"] = owner;
      }

      const created = await fetchJson("/api/uploads/create", {
        method: "POST",
        headers: uploadHeaders,
        body: uploadBody,
      });

      const uploadId = created.uploadId;
      const totalChunks = Math.max(1, Number(created.totalChunks || 1));
      for (let index = 0; index < totalChunks; index += 1) {
        const start = index * chunkSize;
        const end = Math.min(file.size, start + chunkSize);
        const chunkBlob = file.slice(start, end);
        const { buffer, sha256 } = await readChunkSha256(chunkBlob);
        const formData = new FormData();
        formData.append("file", new Blob([buffer], { type: file.type || "application/octet-stream" }), file.name);

        uploadStatus.textContent = "Uploading chunk " + (index + 1) + "/" + totalChunks + "...";
        uploadMeta.textContent = Math.round((index / totalChunks) * 100) + "%";

        const chunkResponse = await fetchJson("/api/uploads/" + encodeURIComponent(uploadId) + "/chunk/" + index, {
          method: "PUT",
          headers: {
            "x-chunk-sha256": sha256,
            ...(mode === "wallet" && owner ? {
              "x-owner-address": owner,
              "x-wallet-address": owner,
            } : {}),
          },
          body: formData,
        });
        uploadProgress.style.width = Math.round(((index + 1) / totalChunks) * 100) + "%";
        uploadMeta.textContent = Math.round(((index + 1) / totalChunks) * 100) + "%";
      }

      uploadStatus.textContent = "Finalizing on chain...";
      const complete = await fetchJson("/api/uploads/" + encodeURIComponent(uploadId) + "/complete", {
        method: "POST",
        headers: {
          ...(mode === "wallet" && owner ? {
            "x-owner-address": owner,
            "x-wallet-address": owner,
          } : {}),
        },
        body: {},
      });

      let finalStatus = complete;
      let attempts = 0;
      while (finalStatus && finalStatus.status !== "completed" && attempts < 60) {
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 2000));
        finalStatus = await fetchJson("/api/uploads/" + encodeURIComponent(uploadId) + "/status", {
          method: "GET",
          headers: mode === "wallet" && owner ? {
            "x-owner-address": owner,
            "x-wallet-address": owner,
          } : {},
        });
        uploadStatus.textContent = finalStatus.status === "finalizing" ? "Anchoring on chain..." : "Upload " + finalStatus.status;
      }

      if (finalStatus?.status === "completed" && finalStatus.fileId) {
        uploadProgress.style.width = "100%";
        uploadMeta.textContent = "100%";
        const metadataHref = "/api/files/" + encodeURIComponent(finalStatus.fileId) + "/metadata.json";
        const provenanceHref = "/api/files/" + encodeURIComponent(finalStatus.fileId) + "/provenance";
        renderUploadResult(
          '<div class="space-y-3">' +
            '<div class="text-white font-semibold">Upload complete</div>' +
            '<div class="break-all font-mono text-xs text-gray-400">' + escapeText(finalStatus.fileId) + '</div>' +
            '<div class="flex flex-wrap gap-2 text-xs font-semibold">' +
              '<a class="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-gray-200 hover:border-cyan-400/30 hover:text-cyan-200" href="' + metadataHref + '" target="_blank" rel="noreferrer">Metadata JSON</a>' +
              '<a class="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-gray-200 hover:border-cyan-400/30 hover:text-cyan-200" href="' + provenanceHref + '" target="_blank" rel="noreferrer">Provenance JSON</a>' +
            '</div>' +
          '</div>'
        );
        uploadStatus.textContent = "Upload finalized.";
        window.setTimeout(() => reloadWithFilters(), 2000);
        return finalStatus;
      }

      renderUploadResult(
        '<div class="text-gray-300">Upload submitted. Current status: <span class="text-white">' +
          escapeText((finalStatus && finalStatus.status) || "finalizing") +
          '</span></div>'
      );
      return finalStatus;
    }

    connectButton.addEventListener("click", connectWallet);
    refreshButton.addEventListener("click", reloadWithFilters);
    showAllButton.addEventListener("click", () => {
      ownerInput.value = "";
      chainInput.value = "";
      reloadWithFilters();
    });
    ownerInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        reloadWithFilters();
      }
    });
    chainInput.addEventListener("change", reloadWithFilters);
    document.querySelectorAll("[data-provenance-file]").forEach((button) => {
      button.addEventListener("click", () => {
        loadProvenance(button.getAttribute("data-provenance-file"));
      });
    });
    uploadMode.addEventListener("change", updateUploadUi);
    uploadReset.addEventListener("click", () => {
      uploadFile.value = "";
      uploadResult.textContent = "No upload yet.";
      uploadProgress.style.width = "0%";
      uploadStatus.textContent = "Pick a file to upload.";
      uploadMeta.textContent = "0%";
    });
    uploadForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const file = uploadFile.files && uploadFile.files[0];
      uploadSubmit.disabled = true;
      uploadSubmit.classList.add("opacity-60", "cursor-not-allowed");
      try {
        const mode = uploadMode.value === "wallet" ? "wallet" : "public";
        if (mode === "wallet") {
          const owner = uploadOwner.value.trim();
          if (!owner) {
            if (!window.ethereum) {
              throw new Error("Connect a wallet first");
            }
            const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
            const address = (accounts && accounts[0]) || "";
            uploadOwner.value = address;
            await fetch("/api/auth/session", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ owner: address }),
            });
          }
        }
        const finalStatus = await uploadFileToCore(file);
        if (finalStatus?.fileId) {
          await loadProvenance(finalStatus.fileId);
          window.location.href = currentUrl(uploadOwner.value.trim(), uploadChain.value.trim()).toString();
        }
      } catch (err) {
        uploadStatus.textContent = err?.message || "Upload failed.";
        renderUploadResult('<div class="text-red-300">' + escapeText((err && err.message) || "Upload failed.") + '</div>');
      } finally {
        uploadSubmit.disabled = false;
        uploadSubmit.classList.remove("opacity-60", "cursor-not-allowed");
      }
    });

    const data = Array.isArray(initialData) ? initialData : [];
    statCount.textContent = String(data.length);
    statBytes.textContent = formatBytes(data.reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0));
    statChains.textContent = String(new Set(data.map((item) => normalizeChain(item.targetChain))).size);
    statLatest.textContent = data[0]?.filename || data[0]?.fileId || "none";
    resultCount.textContent = String(data.length);

    const owner = ownerInput.value.trim();
    const chain = chainInput.value.trim();
    walletStatus.textContent = owner
      ? "Showing uploads for " + owner.slice(0, 8) + "..." + (chain ? " on " + chain : "")
      : "Showing all uploads.";

    if (data[0]) {
      loadProvenance(data[0].fileId);
    }
    updateUploadUi();
  </script>
</body>
</html>`;
}

async function parseRequest(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const cookies = parseCookies(req.headers.cookie || "");
  const ownerFromCookie = cookies[cookieName] || null;
  return { url, cookies, ownerFromCookie };
}

async function handleSse(req, res, uploadId) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  res.write("\n");

  let lastPayload = "";
  const emit = async () => {
    try {
      const status = await getUploadStatus(uploadId);
      const payload = JSON.stringify(status);
      if (payload !== lastPayload) {
        lastPayload = payload;
        res.write(`event: status\ndata: ${payload}\n\n`);
      }
    } catch (err) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: String(err?.message ?? err) })}\n\n`);
    }
  };

  await emit();
  const timer = setInterval(emit, 2000);
  req.on("close", () => {
    clearInterval(timer);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const { url, ownerFromCookie } = await parseRequest(req);

    if (url.pathname === "/" || url.pathname === "/dashboard") {
      const ownerParam = url.searchParams.get("owner");
      const owner = url.searchParams.get("all") === "1" ? ownerParam : (ownerParam || ownerFromCookie);
      const chain = url.searchParams.get("chain");
      const result = await listFiles({ owner, chain, limit: 24 });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderPage({ owner, chain, result }));
      return;
    }

    if (url.pathname === "/api/auth/session" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ owner: ownerFromCookie }));
      return;
    }

    if (url.pathname === "/api/auth/session" && req.method === "POST") {
      const body = await readJsonBody(req);
      const owner = typeof body.owner === "string" ? body.owner.trim() : "";
      const cookie = owner
        ? `${cookieName}=${encodeURIComponent(owner)}; Path=/; SameSite=Lax; Max-Age=2592000`
        : `${cookieName}=; Path=/; SameSite=Lax; Max-Age=0`;
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": cookie,
      });
      res.end(JSON.stringify({ owner }));
      return;
    }

    if (url.pathname === "/api/uploads/create" && req.method === "POST") {
      const body = await readJsonBody(req);
      const sizeBytes = Number(body?.sizeBytes);
      const limit = resolveUploadLimitForRequest(body, req);
      if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Invalid sizeBytes" }));
        return;
      }
      if (sizeBytes > limit) {
        res.writeHead(413, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          error: `Upload exceeds demo cap of ${formatBytes(limit)}`,
          limitBytes: limit,
        }));
        return;
      }
      await proxyJsonToCore(req, res, "/v1/uploads/create", "POST", body);
      return;
    }

    if (url.pathname.match(/^\/api\/uploads\/[^/]+\/chunk\/[^/]+$/) && req.method === "PUT") {
      const [, , , uploadId, , index] = url.pathname.split("/");
      await proxyStreamToCore(req, res, `/v1/uploads/${encodeURIComponent(uploadId)}/chunk/${encodeURIComponent(index)}`);
      return;
    }

    if (url.pathname.match(/^\/api\/uploads\/[^/]+\/complete$/) && req.method === "POST") {
      const body = await readJsonBody(req);
      await proxyJsonToCore(req, res, `/v1/uploads/${encodeURIComponent(url.pathname.split("/")[3] || "")}/complete`, "POST", body);
      return;
    }

    if (url.pathname.match(/^\/api\/uploads\/[^/]+\/cancel$/) && req.method === "POST") {
      const body = await readJsonBody(req);
      await proxyJsonToCore(req, res, `/v1/uploads/${encodeURIComponent(url.pathname.split("/")[3] || "")}/cancel`, "POST", body);
      return;
    }

    if (url.pathname.match(/^\/api\/uploads\/[^/]+\/status$/) && req.method === "GET") {
      await proxyJsonToCore(req, res, `/v1/uploads/${encodeURIComponent(url.pathname.split("/")[3] || "")}/status`, "GET");
      return;
    }

    if (url.pathname === "/api/files" || url.pathname === "/api/search") {
      const owner = url.searchParams.get("owner") || ownerFromCookie;
      const chain = url.searchParams.get("chain");
      const cursor = url.searchParams.get("cursor");
      const limit = Number(url.searchParams.get("limit") || 24);
      const result = await listFiles({ owner, chain, cursor, limit });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ source: "tatum-service", ...result }));
      return;
    }

    if (url.pathname.startsWith("/api/files/") && url.pathname.endsWith("/provenance")) {
      const fileId = decodeURIComponent(url.pathname.split("/")[3] || "");
      const provenance = await getProvenance(fileId);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(provenance));
      return;
    }

    if (url.pathname.startsWith("/api/files/") && url.pathname.endsWith("/metadata.json")) {
      const fileId = decodeURIComponent(url.pathname.split("/")[3] || "");
      const response = await fetch(`${coreApiBaseUrl}/v1/files/${encodeURIComponent(fileId)}/metadata.json`);
      const text = await response.text();
      res.writeHead(response.status, { "content-type": response.headers.get("content-type") || "application/json; charset=utf-8" });
      res.end(text);
      return;
    }

    if (url.pathname.startsWith("/api/uploads/") && url.pathname.endsWith("/status")) {
      const uploadId = decodeURIComponent(url.pathname.split("/")[3] || "");
      const status = await getUploadStatus(uploadId);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(status));
      return;
    }

    if (url.pathname.startsWith("/api/uploads/") && url.pathname.endsWith("/events")) {
      const uploadId = decodeURIComponent(url.pathname.split("/")[3] || "");
      await handleSse(req, res, uploadId);
      return;
    }

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, coreApiBaseUrl, port }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Not Found" }));
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: String(err?.message ?? err) }));
  }
});

server.listen(port, () => {
  console.log(`Tatum service listening on http://localhost:${port}`);
});
