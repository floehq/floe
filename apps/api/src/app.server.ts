import Fastify from "fastify";
import multipart from "@fastify/multipart";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import fs from "fs/promises";
import os from "os";
import path from "path";

import uploadRoutes from "./routes/uploads.js";
import healthRoute from "./routes/health.js";
import { filesRoutes } from "./routes/files.js";
import opsApiKeysRoutes from "./routes/ops-api-keys.js";
import { closeRedis, initRedis } from "./state/redis.js";
import { closePostgres, initPostgres, isPostgresConfigured } from "./state/postgres.js";
import { initS3IfEnabled } from "./state/s3.js";
import { startUploadGc, stopUploadGc } from "./state/gc/upload.gc.scheduler.js";
import { reconcileOrphanUploads } from "./state/gc/upload.gc.reconcile.js";
import {
  startUploadFinalizeWorker,
  stopUploadFinalizeWorker,
} from "./services/uploads/finalize.queue.js";
import { startWalrusPoolMetrics, stopWalrusPoolMetrics } from "./services/walrus/read.js";
import { ChunkConfig, UploadConfig } from "./config/uploads.config.js";
import { createDefaultAuthProvider, type AuthProvider } from "./services/auth/auth.provider.js";
import {
  AuthOwnerPolicyConfig,
  AuthRateLimitConfig,
  AuthUploadPolicyConfig,
} from "./config/auth.config.js";
import { TopologyConfig } from "./config/topology.config.js";
import { recordHttpRequestAndSli } from "./services/metrics/runtime.metrics.js";
import { ensureFilesTable } from "./db/files.repository.js";
import { chunkStore } from "./store/index.js";
import { initStreamCache } from "./services/stream/stream.cache.js";
import { dumpConfig } from "./utils/configDump.js";
import {
  initErrorReporter,
  closeErrorReporter,
  captureException,
} from "./services/errors/error.reporter.js";
import { validateConfig } from "./utils/configValidation.js";

// Global HTTP request concurrency limiter.
// When active requests exceed FLOE_GLOBAL_REQUEST_CONCURRENCY, new requests
// receive an immediate 503 response to prevent resource exhaustion.
import { parsePositiveIntEnv } from "./utils/parseEnv.js";
const GLOBAL_REQUEST_CONCURRENCY = parsePositiveIntEnv("FLOE_GLOBAL_REQUEST_CONCURRENCY", 200, 1);

// Initialize before any other handlers so Sentry can hook into
// unhandledRejection / uncaughtException from the start.
initErrorReporter({
  info: (msg: string) => console.error("[error-reporter]", msg),
});

process.on("unhandledRejection", (reason) => {
  captureException(reason instanceof Error ? reason : new Error(String(reason)), {
    event: "unhandledRejection",
  });
  console.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (err) => {
  captureException(err, { event: "uncaughtException" });
  console.error("Uncaught exception:", err);

  // Stop accepting new requests and drain gracefully
  void (async () => {
    const forceExitTimer = setTimeout(() => {
      console.error("Graceful shutdown timed out after 10s, forcing exit");
      process.exit(1);
    }, 10_000);
    forceExitTimer.unref();

    try {
      await stopUploadGc();
      await stopUploadFinalizeWorker();
      await closePostgres();
      await closeRedis();
      await closeErrorReporter();
    } catch (drainErr) {
      console.error("Error during uncaughtException drain:", drainErr);
    }

    clearTimeout(forceExitTimer);
    process.exit(1);
  })();
});

function parseTrustProxy() {
  const raw = process.env.FLOE_TRUST_PROXY?.trim().toLowerCase();
  if (!raw) return false;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new Error("FLOE_TRUST_PROXY must be one of: 1, 0, true, false");
}

function createFastifyApp() {
  return Fastify({
    logger: {
      level: process.env.NODE_ENV === "production" ? "info" : "debug",
      redact: {
        paths: ["req.headers.authorization", "req.headers.x-api-key"],
        remove: true,
      },
      base: {
        role: TopologyConfig.role,
      },
    },
    bodyLimit: ChunkConfig.maxBytes + 1024 * 1024,
    trustProxy: parseTrustProxy(),
    // Global request timeout: 30 minutes. Chunk uploads (multipart) can take
    // this long for large files over slow connections. JSON-only routes have
    // a separate 64KB bodyLimit that will fail-fast for oversized payloads.
    requestTimeout: 30 * 60 * 1000,
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
  // Validate required configuration before any service initialization.
  const configCheck = validateConfig();
  if (!configCheck.valid) {
    throw new Error(
      `Configuration errors:\n${configCheck.errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }
  if (configCheck.warnings.length > 0) {
    console.warn(
      `Configuration warnings:\n${configCheck.warnings.map((w) => `  - ${w}`).join("\n")}`,
    );
  }

  const app = createFastifyApp();
  const corsOrigins = parseCorsOrigins();

  // Semaphore for global HTTP request concurrency limiting
  let activeRequests = 0;
  const requestQueue: Array<() => void> = [];

  function drainRequestQueue() {
    while (activeRequests < GLOBAL_REQUEST_CONCURRENCY && requestQueue.length > 0) {
      const next = requestQueue.shift();
      next?.();
    }
  }

  function acquireRequestSlot(): Promise<boolean> {
    if (activeRequests < GLOBAL_REQUEST_CONCURRENCY) {
      activeRequests += 1;
      return Promise.resolve(true);
    }

    // Queue is full — fast-reject
    if (requestQueue.length >= GLOBAL_REQUEST_CONCURRENCY) {
      return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      requestQueue.push(() => {
        activeRequests += 1;
        resolve(true);
      });
    });
  }

  function releaseRequestSlot() {
    activeRequests = Math.max(0, activeRequests - 1);
    drainRequestQueue();
  }

  app.decorate("authProvider", params?.authProvider ?? createDefaultAuthProvider());
  app.addHook("onRequest", async (req, reply) => {
    // Global concurrency gate — respond with 503 if overloaded
    const slotAcquired = await acquireRequestSlot();
    if (!slotAcquired) {
      reply.header("Retry-After", "5");
      return reply.code(503).send({
        error: {
          code: "SERVICE_OVERLOADED",
          message: "Server is at capacity, retry shortly",
          retryable: true,
        },
      });
    }

    reply.header("x-request-id", req.id);
    req.authContext = await req.server.authProvider.resolveIdentity(req);

    // Attach a child logger with request-scoped context for consistent
    // structured logging across all route handlers and services.
    const logContext: Record<string, unknown> = {
      requestId: req.id,
    };
    if (req.authContext?.authenticated) {
      logContext.authMethod = req.authContext.method;
      logContext.subject = req.authContext.subject;
      logContext.owner = req.authContext.owner;
    }
    (req as { childLogger?: ReturnType<typeof req.log.child> }).childLogger =
      req.log.child(logContext);
  });
  app.addHook("onResponse", async (req, reply) => {
    releaseRequestSlot();
    const route = req.routeOptions?.url ?? req.url.split("?")[0];
    recordHttpRequestAndSli({
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
        : async (origin: string | undefined) => {
            if (!origin) return true;
            return corsOrigins.includes(origin);
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
    exposedHeaders: [
      "x-request-id",
      "x-ratelimit-limit",
      "x-ratelimit-remaining",
      "x-ratelimit-window",
      "retry-after",
    ],
    maxAge: 600,
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "Floe API",
        description:
          "Resumable chunk uploads with S3 storage, Walrus blob publish, and Sui metadata finalization.",
        version: "0.2.5",
      },
      servers: [{ url: "http://localhost:3000", description: "Development" }],
      components: {
        securitySchemes: {
          apiKey: {
            type: "apiKey",
            name: "x-api-key",
            in: "header",
            description: "API key authentication",
          },
          bearerToken: {
            type: "http",
            scheme: "bearer",
            description: "Bearer token authentication",
          },
        },
      },
      tags: [
        { name: "Uploads", description: "Chunk upload lifecycle" },
        { name: "Files", description: "File metadata and streaming" },
        { name: "Health", description: "Service health and metrics" },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      defaultModelsExpandDepth: -1,
    },
  });

  await app.register(helmet, {
    // Disable cross-origin embedder policy to avoid breaking clients that
    // stream media from Floe through a web page.
    crossOriginEmbedderPolicy: false,

    // CSP: very restrictive for an API that serves no scripts or resources.
    // Inline styles are allowed for the 503 blob-unavailable error page.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        styleSrc: ["'unsafe-inline'"],
        frameAncestors: ["'none'"],
        formAction: ["'none'"],
        baseUri: ["'none'"],
        scriptSrc: ["'none'"],
        imgSrc: ["'none'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },

    // HSTS: 1 year, include subdomains, preload
    hsts: {
      maxAge: 365 * 24 * 60 * 60,
      includeSubDomains: true,
      preload: true,
    },

    // Referrer policy: no referrer info in downstream requests
    referrerPolicy: { policy: "no-referrer" },
  });

  await app.register(multipart, {
    attachFieldsToBody: false,
    throwFileSizeLimit: false,
    limits: {
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
    if (TopologyConfig.features.streamCache) {
      await initStreamCache();
    }
    // Start periodic Walrus connection pool metrics collection
    startWalrusPoolMetrics();

    app.log.info({ config: dumpConfig() }, "Resolved FLOE_* configuration");

    app.log.info(
      {
        role: TopologyConfig.role,
        features: TopologyConfig,
        limits: {
          uploadControl: AuthRateLimitConfig.limits.upload_control,
          uploadChunk: AuthRateLimitConfig.limits.upload_chunk,
          fileMetaRead: AuthRateLimitConfig.limits.file_meta_read,
          fileStreamRead: AuthRateLimitConfig.limits.file_stream_read,
          localReadLeaseSize: AuthRateLimitConfig.localLeaseSize,
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
      "Redis initialized and config loaded",
    );
  } catch (err) {
    app.log.error(err, "Failed to initialize dependencies");
    throw err;
  }

  if (TopologyConfig.workers.finalize) {
    const orphanRecovery = await reconcileOrphanUploads(app.log);
    const finalizeRecovery = await startUploadFinalizeWorker(app.log);
    app.log.info(
      {
        startupRecovery: {
          orphanUploads: orphanRecovery,
          finalizeQueue: finalizeRecovery,
        },
      },
      "Startup recovery completed",
    );
    startUploadGc(app.log);
  } else {
    app.log.info({ role: TopologyConfig.role }, "Write-path workers disabled for this node role");
  }

  if (TopologyConfig.routes.uploads) {
    await app.register(uploadRoutes);
  }
  if (TopologyConfig.routes.files) {
    await app.register(filesRoutes);
  }
  if (TopologyConfig.routes.ops) {
    await app.register(opsApiKeysRoutes);
  }
  await app.register(healthRoute);

  app.addHook("onClose", async () => {
    stopWalrusPoolMetrics();
    await stopUploadGc();
    await stopUploadFinalizeWorker();
    await closePostgres();
    await closeRedis();
    await closeErrorReporter();
  });

  app.setErrorHandler((err, req, reply) => {
    const fastifyErr = err as { statusCode?: number };
    const knownCodeByMessage: Record<string, string> = {
      FILE_BLOB_UNAVAILABLE: "FILE_BLOB_UNAVAILABLE",
      FILE_CONTENT_NOT_FOUND: "FILE_BLOB_UNAVAILABLE",
    };
    const statusCode =
      fastifyErr?.statusCode && Number.isInteger(fastifyErr.statusCode)
        ? fastifyErr.statusCode
        : 500;
    const knownCode = err instanceof Error ? knownCodeByMessage[err.message] : undefined;

    const errLogger =
      (req as { childLogger?: ReturnType<typeof req.log.child> }).childLogger ?? req.log;
    errLogger.error({ err, url: req.url, method: req.method }, "Request error");

    return reply.code(statusCode).send({
      error: {
        code: knownCode ?? (statusCode < 500 ? "REQUEST_ERROR" : "INTERNAL_ERROR"),
        message: statusCode < 500 && err instanceof Error ? err.message : "Unexpected server error",

        retryable: false,
      },
    });
  });

  return app;
}

export async function start() {
  const app = await createApiServer();
  const PORT = Number(process.env.PORT ?? 3000);

  try {
    await app.listen({
      port: PORT,
      host: "0.0.0.0",
    });

    app.log.info(
      { port: PORT, env: process.env.NODE_ENV ?? "development", role: TopologyConfig.role },
      "API server started",
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
      await closeRedis();
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error(err, "Error during shutdown");
      process.exit(1);
    }
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
