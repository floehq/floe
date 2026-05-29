import { FastifyInstance } from "fastify";
import { getFileFieldsCached, normalizeFileIdParam } from "../services/files/file.read-model.js";
import { findFileByBlobId } from "../db/files.repository.js";

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default async function viewRoutes(app: FastifyInstance) {
  app.get("/files/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    
    let fileId = normalizeFileIdParam(id);
    let fields: any = null;
    let indexed: any = null;

    if (fileId) {
      try {
        const out = await getFileFieldsCached(fileId);
        fields = out.fields;
      } catch (err) {
        // Fallback to blob search if Sui lookup fails
      }
    }

    if (!fields) {
      // Try looking up by Blob ID in local index
      indexed = await findFileByBlobId(id).catch(() => null);
      if (indexed) {
        fileId = indexed.fileId;
        fields = {
          blob_id: indexed.blobId,
          blob_object_id: indexed.blobObjectId,
          checksum: indexed.checksum,
          size_bytes: indexed.sizeBytes,
          mime: indexed.mimeType,
          created_at: indexed.createdAtMs,
          owner: indexed.ownerAddress,
          target_chain: indexed.targetChain,
          anchor_tx_id: indexed.anchorTxId,
          filename: indexed.filename,
        };
      }
    }

    if (!fields) {
      return reply.status(404).type("text/html").send(`
        <body style="background:#050505;color:#fff;display:flex;align-items:center;justify-center:center;height:100vh;font-family:sans-serif;">
          <div style="text-align:center;">
            <h1 style="font-size:4rem;margin:0;">404</h1>
            <p style="color:#666;">File not found on Sui or Walrus index.</p>
            <a href="/" style="color:#4F46E5;text-decoration:none;margin-top:20px;display:inline-block;">Go Home</a>
          </div>
        </body>
      `);
    }

    const resolvedFileId = fileId ?? indexed?.fileId ?? id;
    const filename = fields.filename || `File ${resolvedFileId.slice(0, 8)}`;
    const sizeMB = (Number(fields.size_bytes) / (1024 * 1024)).toFixed(2);
    const mimeType = fields.mime || "application/octet-stream";
    const blobId = fields.blob_id;
    const isVideo = mimeType.startsWith("video/");
    const isImage = mimeType.startsWith("image/");
    const targetChain = fields.target_chain || indexed?.targetChain || "sui";
    const anchorTxId = fields.anchor_tx_id || indexed?.anchorTxId || null;
    
    const baseUrl = (process.env.FLOE_PUBLIC_BASE_URL || `http://${req.hostname}`).replace(/\/$/, "");
    const streamUrl = `${baseUrl}/v1/files/${encodeURIComponent(resolvedFileId)}/stream`;

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(filename)} | Tatum x Walrus Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; background-color: #050505; color: #fff; }
        .glass { background: rgba(255, 255, 255, 0.03); backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.1); }
        .accent-gradient { background: linear-gradient(135deg, #4F46E5 0%, #9333EA 100%); }
    </style>
</head>
<body class="min-h-screen flex flex-col items-center justify-center p-4">
    <div class="w-full max-w-4xl space-y-8">
        <!-- Header -->
        <div class="flex items-center justify-between">
            <div class="flex items-center space-x-3">
                <div class="w-10 h-10 accent-gradient rounded-xl flex items-center justify-center font-bold text-xl">F</div>
                <h1 class="text-2xl font-bold tracking-tight">Tatum <span class="text-gray-500 font-medium">x Walrus</span></h1>
            </div>
            <div class="flex items-center gap-3">
                <a href="/discover" class="px-4 py-1.5 glass rounded-full text-xs font-semibold text-cyan-300 hover:text-cyan-200 transition">
                    DASHBOARD
                </a>
                <div class="px-4 py-1.5 glass rounded-full text-xs font-semibold text-purple-400">
                    HACKATHON DEMO
                </div>
            </div>
        </div>

        <!-- Main Content Card -->
        <div class="glass rounded-3xl overflow-hidden shadow-2xl">
            <!-- Preview Area -->
            <div class="aspect-video bg-black flex items-center justify-center border-b border-white/5">
                ${isVideo ? `
                    <video controls class="w-full h-full" poster="">
                        <source src="${escapeHtml(streamUrl)}" type="${escapeHtml(mimeType)}">
                        Your browser does not support the video tag.
                    </video>
                ` : isImage ? `
                    <img src="${escapeHtml(streamUrl)}" alt="${escapeHtml(filename)}" class="max-w-full max-h-full object-contain">
                ` : `
                    <div class="text-center space-y-4">
                        <div class="w-20 h-20 bg-white/5 rounded-2xl mx-auto flex items-center justify-center">
                            <svg class="w-10 h-10 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
                        </div>
                        <p class="text-gray-400">Preview not available for this file type</p>
                    </div>
                `}
            </div>

            <!-- Details Area -->
            <div class="p-8 space-y-6">
                <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                        <h2 class="text-2xl font-bold">${escapeHtml(filename)}</h2>
                        <p class="text-gray-400 text-sm mt-1">${escapeHtml(mimeType)} • ${escapeHtml(sizeMB)} MB</p>
                    </div>
                    <div class="flex space-x-3">
                        <a href="${escapeHtml(streamUrl)}" download="${escapeHtml(filename)}" class="px-6 py-2.5 bg-white text-black font-semibold rounded-xl hover:bg-gray-200 transition">
                            Download
                        </a>
                    </div>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 gap-4 pt-6 border-t border-white/5">
                    <div class="space-y-1">
                        <p class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Walrus Blob ID</p>
                        <p class="text-sm font-mono break-all text-gray-300">${escapeHtml(blobId)}</p>
                    </div>
                    <div class="space-y-1">
                        <p class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Sui Object ID</p>
                        <p class="text-sm font-mono break-all text-gray-300">${escapeHtml(resolvedFileId)}</p>
                    </div>
                    <div class="space-y-1">
                        <p class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Chain</p>
                        <p class="text-sm font-mono break-all text-gray-300">${escapeHtml(targetChain)}</p>
                    </div>
                    <div class="space-y-1">
                        <p class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Anchor Tx</p>
                        <p class="text-sm font-mono break-all text-gray-300">${escapeHtml(anchorTxId ?? "pending")}</p>
                    </div>
                </div>
            </div>
        </div>

        <!-- Footer / Technical Info -->
        <div class="flex flex-col md:flex-row items-center justify-between text-gray-600 text-xs px-2 gap-4">
            <div class="flex items-center space-x-4">
                <span>Powered by <strong class="text-gray-400">Walrus</strong> & <strong class="text-gray-400">Tatum</strong></span>
            </div>
            <div class="flex items-center space-x-4">
                <a href="/dashboard" class="hover:text-gray-400 transition">Dashboard</a>
                <a href="/discover" class="hover:text-gray-400 transition">Discover</a>
                <a href="https://sui.io" class="hover:text-gray-400 transition">Sui Network</a>
                <span>•</span>
                <a href="https://tatum.io" class="hover:text-gray-400 transition">Multi-Chain Anchor</a>
            </div>
        </div>
    </div>
</body>
</html>
    `;

    return reply.type("text/html").send(html);
  });
}
