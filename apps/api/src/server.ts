// src/server.ts

import Fastify from "fastify";
import multipart from "@fastify/multipart";
import fs from "fs/promises";
import os from "os";
import path from "path";

import uploadRoutes from "./routes/uploads.routes.js";
import healthRoute from "./routes/health.js";
import { filesRoutes } from "./routes/files.routes.js";
import { initRedis } from "./state/client.js";
import { startUploadGc, stopUploadGc } from "./state/gc/upload.gc.scheduler.js";
import { reconcileOrphanUploads } from "./state/gc/upload.gc.reconcile.js";
import { ChunkConfig, UploadConfig } from "./config/uploads.config.js";

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  process.exit(1);
});

const app = Fastify({
  logger: {
    level: process.env.NODE_ENV === "production" ? "info" : "debug",
    redact: {
      paths: ["req.headers.authorization", "req.headers.x-api-key"],
      remove: true,
    },
  },
  // Requests should be chunk-sized (multipart) or small JSON.
  bodyLimit: ChunkConfig.maxBytes + 1024 * 1024,
});

await app.register(multipart, {
  attachFieldsToBody: false,
  throwFileSizeLimit: false,
  limits: {
    // One chunk per request.
    fileSize: ChunkConfig.maxBytes,
    files: 1,
  },
});

async function validateUploadTmpDir() {
  const dir = UploadConfig.tmpDir;
  const home = os.homedir();

  if (!path.isAbsolute(dir)) {
    throw new Error("UPLOAD_TMP_DIR must be an absolute path");
  }
  if (dir === "/" || dir === "/home" || dir === home) {
    throw new Error(`UPLOAD_TMP_DIR is unsafe: ${dir}`);
  }

  await fs.mkdir(dir, { recursive: true });

  // Verify we can write to the directory. This prevents starting with a
  // misconfigured path that will later fail during uploads/GC/cancel.
  const probe = path.join(dir, `.floe_write_test_${process.pid}_${Date.now()}`);
  await fs.writeFile(probe, "ok");
  await fs.unlink(probe);
}

try {
  await initRedis();
  await validateUploadTmpDir();
  app.log.info("Redis initialized");
} catch (err) {
  app.log.error(err, "Failed to initialize Redis");
  process.exit(1);
}

await reconcileOrphanUploads(app.log);
startUploadGc(app.log);

await app.register(uploadRoutes);
await app.register(filesRoutes);
await app.register(healthRoute);

app.setErrorHandler((err, req, reply) => {
  const statusCode =
    (err as any)?.statusCode && Number.isInteger((err as any).statusCode)
      ? (err as any).statusCode
      : 500;

  req.log.error(
    { err, url: req.url, method: req.method, requestId: req.id },
    "Request error"
  );

  return reply.code(statusCode).send({
    error: {
      code: statusCode < 500 ? "REQUEST_ERROR" : "INTERNAL_ERROR",
      message:
        statusCode < 500 && err instanceof Error
          ? err.message
          : "Unexpected server error",

      retryable: false,
    },
  });
});

const PORT = Number(process.env.PORT ?? 3000);

try {
  await app.listen({
    port: PORT,
    host: "0.0.0.0",
  });

  app.log.info(
    { port: PORT, env: process.env.NODE_ENV ?? "development" },
    "API server started"
  );
} catch (err) {
  app.log.error(err, "Failed to start server");
  process.exit(1);
}

async function shutdown(signal: string) {
  app.log.info({ signal }, "Shutting down server");

  try {
    await stopUploadGc();
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error(err, "Shutdown failed");
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
