import Fastify from "fastify";
import multipart from "@fastify/multipart";
import cors from "@fastify/cors";
import fs from "fs/promises";
import os from "os";
import path from "path";

import uploadRoutes from "./routes/uploads.js";
import healthRoute from "./routes/health.js";
import { filesRoutes } from "./routes/files.js";
import { closeRedis, initRedis } from "./state/redis.js";
import {
  closePostgres,
  initPostgres,
  isPostgresConfigured,
} from "./state/postgres.js";
import { initS3IfEnabled } from "./state/s3.js";
import { startUploadGc, stopUploadGc } from "./state/gc/upload.gc.scheduler.js";
import { reconcileOrphanUploads } from "./state/gc/upload.gc.reconcile.js";
import {
  startUploadFinalizeWorker,
  stopUploadFinalizeWorker,
} from "./services/uploads/finalize.queue.js";
import { ChunkConfig, UploadConfig } from "./config/uploads.config.js";
import {
  createDefaultAuthProvider,
  type AuthProvider,
} from "./services/auth/auth.provider.js";
import {
  AuthOwnerPolicyConfig,
  AuthRateLimitConfig,
  AuthUploadPolicyConfig,
} from "./config/auth.config.js";
import { recordHttpRequest } from "./services/metrics/runtime.metrics.js";
import { ensureFilesTable } from "./db/files.repository.js";
import { chunkStore } from "./store/index.js";
import { initStreamCache } from "./services/stream/stream.cache.js";

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  process.exit(1);
});

function createFastifyApp() {
  return Fastify({
    logger: {
      level: process.env.NODE_ENV === "production" ? "info" : "debug",
      redact: {
        paths: ["req.headers.authorization", "req.headers.x-api-key"],
        remove: true,
      },
    },
    bodyLimit: ChunkConfig.maxBytes + 1024 * 1024,
  });
}

function parseCorsOrigins(): string[] {
  const raw = process.env.FLOE_CORS_ORIGINS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

async function validateUploadTmpDir() {
  if (chunkStore.backend() !== "disk") {
    return;
  }

  const dir = UploadConfig.tmpDir;
  const home = os.homedir();

  if (!path.isAbsolute(dir)) {
    throw new Error("UPLOAD_TMP_DIR must be an absolute path");
  }
  if (dir === "/" || dir === "/home" || dir === home) {
    throw new Error(`UPLOAD_TMP_DIR is unsafe: ${dir}`);
  }

  await fs.mkdir(dir, { recursive: true });

  const probe = path.join(dir, `.floe_write_test_${process.pid}_${Date.now()}`);
  await fs.writeFile(probe, "ok");
  await fs.unlink(probe);
}

export async function createApiServer(params?: { authProvider?: AuthProvider }) {
  const app = createFastifyApp();
  const corsOrigins = parseCorsOrigins();

  app.decorate("authProvider", params?.authProvider ?? createDefaultAuthProvider());
  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url ?? req.url.split("?")[0];
    recordHttpRequest({
      method: req.method,
      route,
      statusCode: reply.statusCode,
      durationMs: Number(reply.elapsedTime ?? 0),
    });
  });

  await app.register(cors, {
    origin:
      corsOrigins.length === 0
        ? false
        : (origin, cb) => {
            if (!origin) {
              cb(null, true);
              return;
            }
            cb(null, corsOrigins.includes(origin));
          },
    methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "content-type",
      "authorization",
      "x-api-key",
      "x-wallet-address",
      "x-owner-address",
      "x-auth-user",
      "x-chunk-sha256",
      "x-floe-sdk",
    ],
    exposedHeaders: ["x-request-id", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-window", "retry-after"],
    maxAge: 600,
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

  try {
    await initRedis();
    await initS3IfEnabled(app.log);
    await initPostgres(app.log);
    await ensureFilesTable();
    await validateUploadTmpDir();
    await initStreamCache();
    app.log.info(
      {
        limits: {
          uploadControl: AuthRateLimitConfig.limits.upload_control,
          uploadChunk: AuthRateLimitConfig.limits.upload_chunk,
          fileMetaRead: AuthRateLimitConfig.limits.file_meta_read,
          fileStreamRead: AuthRateLimitConfig.limits.file_stream_read,
          uploadMaxFileSizeBytes: UploadConfig.maxFileSizeBytes,
          publicMaxFileSizeBytes: AuthUploadPolicyConfig.maxFileSizeBytes.public,
          authMaxFileSizeBytes: AuthUploadPolicyConfig.maxFileSizeBytes.authenticated,
          enforceUploadOwner: AuthOwnerPolicyConfig.enforceUploadOwner,
        },
        postgres: {
          configured: isPostgresConfigured(),
        },
        chunkStore: {
          backend: chunkStore.backend(),
        },
      },
      "Redis initialized and config loaded"
    );
  } catch (err) {
    app.log.error(err, "Failed to initialize dependencies");
    throw err;
  }

  const orphanRecovery = await reconcileOrphanUploads(app.log);
  const finalizeRecovery = await startUploadFinalizeWorker(app.log);
  app.log.info(
    {
      startupRecovery: {
        orphanUploads: orphanRecovery,
        finalizeQueue: finalizeRecovery,
      },
    },
    "Startup recovery completed"
  );
  startUploadGc(app.log);

  await app.register(uploadRoutes);
  await app.register(filesRoutes);
  await app.register(healthRoute);

  app.addHook("onClose", async () => {
    await stopUploadGc();
    await stopUploadFinalizeWorker();
    await closePostgres();
    await closeRedis();
  });

  app.setErrorHandler((err, req, reply) => {
    const statusCode =
      (err as any)?.statusCode && Number.isInteger((err as any).statusCode)
        ? (err as any).statusCode
        : 500;
    const knownCodeByMessage: Record<string, string> = {
      FILE_BLOB_UNAVAILABLE: "FILE_BLOB_UNAVAILABLE",
      FILE_CONTENT_NOT_FOUND: "FILE_BLOB_UNAVAILABLE",
    };
    const knownCode = err instanceof Error ? knownCodeByMessage[err.message] : undefined;

    req.log.error(
      { err, url: req.url, method: req.method, requestId: req.id },
      "Request error"
    );

    return reply.code(statusCode).send({
      error: {
        code: knownCode ?? (statusCode < 500 ? "REQUEST_ERROR" : "INTERNAL_ERROR"),
        message:
          statusCode < 500 && err instanceof Error
            ? err.message
            : "Unexpected server error",

        retryable: false,
      },
    });
  });

  return app;
}

async function start() {
  const app = await createApiServer();
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
      await stopUploadFinalizeWorker();
      await closePostgres();
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error(err, "Shutdown failed");
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

await start();
