import http from "node:http";

const port = Number(process.env.PORT ?? 3002);
const apiBaseUrl = (process.env.FLOE_API_BASE_URL ?? "http://localhost:3001").replace(/\/+$/, "");

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeJs(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
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

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function cardHtml(file) {
  const chain = chainLabel(file.targetChain);
  const txUrl = explorerTxUrl(file.targetChain, file.anchorTxId);
  const metadataUrl = `${apiBaseUrl}/v1/files/${encodeURIComponent(file.fileId)}/metadata.json`;
  const streamUrl = `${apiBaseUrl}/v1/files/${encodeURIComponent(file.fileId)}/stream`;
  const fileUrl = `${apiBaseUrl}/files/${encodeURIComponent(file.fileId)}`;
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
        <a class="shrink-0 rounded-2xl border border-white/10 bg-white px-4 py-2 text-sm font-semibold text-black transition hover:bg-cyan-300" href="${fileUrl}" target="_blank" rel="noreferrer">Open</a>
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
        <a class="rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-gray-200 transition hover:border-cyan-400/30 hover:text-cyan-200" href="${streamUrl}" target="_blank" rel="noreferrer">Stream</a>
      </div>
    </article>
  `;
}

function renderPage({ owner, chain, result }) {
  const initial = escapeJs({ owner, chain, data: result.data, nextCursor: result.nextCursor, hasNextPage: result.hasNextPage });
  const cards = result.data.map(cardHtml).join("");
  const apiBase = apiBaseUrl;
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
          <p class="mt-4 max-w-2xl text-base leading-7 text-gray-300">Connect a wallet, inspect your uploads, open metadata, jump to the file view, and trace the anchor transaction in one place. This runs as a separate dashboard service, not inside the Floe API.</p>
        </div>
        <div class="grid gap-3 text-sm text-gray-300">
          <div class="rounded-2xl border border-white/10 bg-black/25 px-4 py-3">API base: <span class="text-white">${escapeHtml(apiBase)}</span></div>
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

    <main class="mt-8 grid gap-5 lg:grid-cols-[1fr_1fr] xl:grid-cols-3" id="results">
      ${cards || `<div class="rounded-3xl border border-dashed border-white/10 bg-white/[0.05] p-10 text-center text-gray-400 lg:col-span-2 xl:col-span-3">No uploads yet. Connect a wallet or paste an owner address to populate the dashboard.</div>`}
    </main>

    <footer class="mt-10 flex flex-col gap-3 border-t border-white/10 pt-6 text-sm text-gray-500 sm:flex-row sm:items-center sm:justify-between">
      <p>Tatum x Walrus hackathon surface. Floe provides the storage and metadata plumbing.</p>
      <div class="flex flex-wrap items-center gap-4">
        <a class="hover:text-white" href="/dashboard">Dashboard</a>
        <a class="hover:text-white" href="${apiBase}/v1/search" target="_blank" rel="noreferrer">JSON feed</a>
      </div>
    </footer>
  </div>

  <script>
    window.__FLOE_DASHBOARD__ = ${initial};
    const apiBaseUrl = ${escapeJs(apiBase)};
    const ownerInput = document.getElementById("owner-input");
    const chainInput = document.getElementById("chain-input");
    const connectButton = document.getElementById("connect-wallet");
    const showAllButton = document.getElementById("show-all");
    const refreshButton = document.getElementById("refresh-feed");
    const walletStatus = document.getElementById("wallet-status");
    const results = document.getElementById("results");
    const resultCount = document.getElementById("result-count");
    const statCount = document.getElementById("stat-count");
    const statBytes = document.getElementById("stat-bytes");
    const statChains = document.getElementById("stat-chains");
    const statLatest = document.getElementById("stat-latest");

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes)) return "unknown";
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + " KB";
      if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + " MB";
      return (bytes / 1024 ** 3).toFixed(1) + " GB";
    }

    function normalizeChain(raw) {
      return (raw || "sui").toString().trim().toLowerCase() || "sui";
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
      return base ? base + encodeURIComponent(txId) : null;
    }

    function renderCard(file) {
      const chain = chainLabel(file.targetChain);
      const txUrl = explorerTxUrl(file.targetChain, file.anchorTxId);
      const metadataUrl = apiBaseUrl + "/v1/files/" + encodeURIComponent(file.fileId) + "/metadata.json";
      const streamUrl = apiBaseUrl + "/v1/files/" + encodeURIComponent(file.fileId) + "/stream";
      const fileUrl = apiBaseUrl + "/files/" + encodeURIComponent(file.fileId);
      const anchorMarkup = file.anchorTxId
        ? txUrl
          ? '<a class="text-cyan-300 hover:text-cyan-200 break-all" href="' + txUrl + '" target="_blank" rel="noreferrer">' + file.anchorTxId + '</a>'
          : '<span class="break-all">' + file.anchorTxId + '</span>'
        : '<span class="text-gray-500">Pending</span>';

      return [
        '<article class="group rounded-3xl border border-white/10 bg-white/[0.06] p-5 shadow-[0_24px_90px_rgba(0,0,0,0.24)] transition hover:-translate-y-1 hover:border-cyan-400/40 hover:bg-white/[0.09]">',
        '  <div class="flex items-start justify-between gap-4">',
        '    <div class="min-w-0">',
        '      <div class="flex flex-wrap gap-2">',
        '        <span class="rounded-full border border-cyan-400/25 bg-cyan-400/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-200">' + chain + '</span>',
        '        <span class="rounded-full border border-white/10 bg-black/30 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-300">' + (file.mimeType || "application/octet-stream") + '</span>',
        '      </div>',
        '      <h3 class="mt-4 truncate text-xl font-semibold text-white">' + (file.filename || ('Upload ' + String(file.fileId).slice(0, 8))) + '</h3>',
        '      <p class="mt-2 text-sm text-gray-400">Uploaded ' + new Date(Number(file.createdAtMs)).toLocaleString() + '</p>',
        '    </div>',
        '    <a class="shrink-0 rounded-2xl border border-white/10 bg-white px-4 py-2 text-sm font-semibold text-black transition hover:bg-cyan-300" href="' + fileUrl + '" target="_blank" rel="noreferrer">Open</a>',
        '  </div>',
        '  <dl class="mt-5 grid gap-3 text-sm text-gray-300 sm:grid-cols-2">',
        '    <div class="rounded-2xl border border-white/8 bg-black/20 p-3">',
        '      <dt class="text-xs uppercase tracking-[0.18em] text-gray-500">Owner</dt>',
        '      <dd class="mt-1 break-all font-mono text-gray-200">' + (file.ownerAddress || "public") + '</dd>',
        '    </div>',
        '    <div class="rounded-2xl border border-white/8 bg-black/20 p-3">',
        '      <dt class="text-xs uppercase tracking-[0.18em] text-gray-500">Size</dt>',
        '      <dd class="mt-1 text-gray-200">' + formatBytes(Number(file.sizeBytes)) + '</dd>',
        '    </div>',
        '    <div class="rounded-2xl border border-white/8 bg-black/20 p-3">',
        '      <dt class="text-xs uppercase tracking-[0.18em] text-gray-500">File ID</dt>',
        '      <dd class="mt-1 break-all font-mono text-gray-200">' + file.fileId + '</dd>',
        '    </div>',
        '    <div class="rounded-2xl border border-white/8 bg-black/20 p-3">',
        '      <dt class="text-xs uppercase tracking-[0.18em] text-gray-500">Anchor Tx</dt>',
        '      <dd class="mt-1 break-all text-gray-200">' + anchorMarkup + '</dd>',
        '    </div>',
        '  </dl>',
        '  <div class="mt-5 flex flex-wrap gap-2 text-xs font-semibold">',
        '    <a class="rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-gray-200 transition hover:border-cyan-400/30 hover:text-cyan-200" href="' + metadataUrl + '" target="_blank" rel="noreferrer">Metadata JSON</a>',
        '    <a class="rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-gray-200 transition hover:border-cyan-400/30 hover:text-cyan-200" href="' + streamUrl + '" target="_blank" rel="noreferrer">Stream</a>',
        '  </div>',
        '</article>',
      ].join("");
    }

    function renderResults(data) {
      if (!data || data.length === 0) {
        results.innerHTML = '<div class="rounded-3xl border border-dashed border-white/10 bg-white/[0.05] p-10 text-center text-gray-400 lg:col-span-2 xl:col-span-3">No uploads yet. Connect a wallet or paste an owner address to populate the dashboard.</div>';
        return;
      }
      results.innerHTML = data.map(renderCard).join("");
    }

    function updateStats(data) {
      const totalBytes = data.reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0);
      const uniqueChains = new Set(data.map((item) => normalizeChain(item.targetChain))).size;
      statCount.textContent = String(data.length);
      statBytes.textContent = formatBytes(totalBytes);
      statChains.textContent = String(uniqueChains);
      statLatest.textContent = data[0]?.filename || data[0]?.fileId || "none";
      resultCount.textContent = String(data.length);
    }

    async function loadFeed() {
      const owner = ownerInput.value.trim();
      const chain = chainInput.value.trim();
      const params = new URLSearchParams();
      if (owner) params.set("owner", owner);
      if (chain) params.set("chain", chain);
      params.set("limit", "24");
      walletStatus.textContent = "Loading uploads...";
      try {
        const response = await fetch("/api/search?" + params.toString());
        const json = await response.json();
        renderResults(json.data || []);
        updateStats(json.data || []);
        walletStatus.textContent = owner ? "Showing uploads for " + owner.slice(0, 8) + "..." : "Showing all uploads.";
      } catch (err) {
        walletStatus.textContent = "Failed to load uploads.";
      }
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
        walletStatus.textContent = "Connected wallet " + address.slice(0, 8) + "...";
        await loadFeed();
      } catch (err) {
        walletStatus.textContent = "Wallet connection was cancelled or failed.";
      }
    }

    connectButton.addEventListener("click", connectWallet);
    refreshButton.addEventListener("click", loadFeed);
    showAllButton.addEventListener("click", () => {
      ownerInput.value = "";
      loadFeed();
    });
    ownerInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        loadFeed();
      }
    });
    chainInput.addEventListener("change", loadFeed);

    renderResults(window.__FLOE_DASHBOARD__.data || []);
    updateStats(window.__FLOE_DASHBOARD__.data || []);
  </script>
</body>
</html>`;
}

async function fetchFeed(query) {
  const params = new URLSearchParams();
  if (query.owner) params.set("owner", query.owner);
  if (query.chain) params.set("chain", query.chain);
  if (query.cursor) params.set("cursor", query.cursor);
  params.set("limit", String(query.limit ?? 24));
  const response = await fetch(`${apiBaseUrl}/v1/search?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`API search failed: ${response.status}`);
  }
  return response.json();
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/" || url.pathname === "/dashboard") {
      const owner = url.searchParams.get("owner");
      const chain = url.searchParams.get("chain");
      const result = await fetchFeed({ owner, chain, limit: 24 });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderPage({ owner, chain, result }));
      return;
    }

    if (url.pathname === "/api/search") {
      const result = await fetchFeed({
        owner: url.searchParams.get("owner"),
        chain: url.searchParams.get("chain"),
        cursor: url.searchParams.get("cursor"),
        limit: Number(url.searchParams.get("limit") || 24),
      });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(result));
      return;
    }

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, apiBaseUrl, port }));
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
  console.log(`Dashboard listening on http://localhost:${port}`);
});
