/**
 * Startup configuration validation.
 *
 * Checks all required and optional environment variables at startup
 * and produces a grouped error message listing any missing or invalid
 * values before service initialization proceeds.
 *
 * The server MUST NOT start when `errors` is non-empty (fail-closed).
 * `warnings` are advisory only.
 */

export type ConfigValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

function requireEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
  return value;
}

function lowerEnv(name: string): string | undefined {
  return process.env[name]?.trim().toLowerCase();
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(0)} MiB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(0)} KiB`;
  }
  return `${bytes} B`;
}

/**
 * Validate critical configuration values.
 *
 * Returns a ConfigValidationResult with:
 * - `valid`: false if any REQUIRED vars are missing or invalid
 * - `errors`: list of human-readable error messages
 * - `warnings`: list of non-fatal issues
 */
export function validateConfig(): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // -- Redis --
  const redisUrl = requireEnv("REDIS_URL");
  if (!redisUrl) {
    // REDIS_URL is constructed from REDIS_HOST + REDIS_PORT if not set directly
    const host = requireEnv("REDIS_HOST");
    const port = requireEnv("REDIS_PORT");
    if (!host && !port) {
      // Defaults: localhost:6379 — not an error
    }
  }

  // -- Walrus aggregator --
  const walrusAgg = requireEnv("WALRUS_AGGREGATOR_URL");
  if (!walrusAgg) {
    errors.push("WALRUS_AGGREGATOR_URL is required");
  }

  // -- Sui --
  const suiPackageId = requireEnv("SUI_PACKAGE_ID");
  if (!suiPackageId) {
    errors.push("SUI_PACKAGE_ID is required for Sui metadata operations");
  }

  const signerBackend = lowerEnv("FLOE_SIGNER_BACKEND") ?? "env";
  if (signerBackend === "kms") {
    const kmsKeyId = requireEnv("FLOE_KMS_KEY_ID");
    if (!kmsKeyId) {
      errors.push("FLOE_KMS_KEY_ID is required when FLOE_SIGNER_BACKEND=kms");
    }
    const signerAddress = requireEnv("FLOE_SIGNER_ADDRESS");
    if (!signerAddress) {
      errors.push("FLOE_SIGNER_ADDRESS is required when FLOE_SIGNER_BACKEND=kms");
    } else if (!/^0x[0-9a-fA-F]{64}$/.test(signerAddress)) {
      errors.push("FLOE_SIGNER_ADDRESS must be a 0x-prefixed 64 hex character Sui address");
    }
  } else {
    const suiPrivateKey = requireEnv("SUI_PRIVATE_KEY");
    if (!suiPrivateKey) {
      errors.push("SUI_PRIVATE_KEY or SUI_SECRET_KEY is required for Sui signing");
    }
  }

  // -- S3 (optional) --
  const s3Bucket = requireEnv("FLOE_S3_BUCKET");
  if (s3Bucket) {
    const s3Region = requireEnv("FLOE_S3_REGION");
    if (!s3Region) {
      warnings.push("FLOE_S3_BUCKET is set but FLOE_S3_REGION is not; defaulting to us-east-1");
    }
  }

  // -- Auth --
  const authProvider = lowerEnv("FLOE_AUTH_PROVIDER");
  const authTokenSecret = requireEnv("FLOE_AUTH_TOKEN_SECRET");
  if (authProvider === "token") {
    if (!authTokenSecret) {
      errors.push("FLOE_AUTH_TOKEN_SECRET is required when FLOE_AUTH_PROVIDER=token");
    } else if (authTokenSecret.length < 16) {
      errors.push(
        "FLOE_AUTH_TOKEN_SECRET must be at least 16 characters when FLOE_AUTH_PROVIDER=token" +
          " (current length: " +
          authTokenSecret.length +
          ")",
      );
    }
  } else {
    if (authTokenSecret && authTokenSecret.length < 16) {
      warnings.push("FLOE_AUTH_TOKEN_SECRET is too short (< 16 chars); consider a longer secret");
    }
  }

  // -- Public access in production requires explicit opt-in --
  const nodeEnv = lowerEnv("NODE_ENV");
  const accessPolicy = lowerEnv("FLOE_ACCESS_POLICY") ?? lowerEnv("FLOE_AUTH_MODE") ?? "hybrid";
  if (nodeEnv === "production" && accessPolicy === "public") {
    const allowPublicInProd = lowerEnv("FLOE_ALLOW_PUBLIC_IN_PROD");
    if (allowPublicInProd !== "1" && allowPublicInProd !== "true") {
      errors.push(
        "FLOE_ACCESS_POLICY=public with NODE_ENV=production requires " +
          "FLOE_ALLOW_PUBLIC_IN_PROD=1 as an explicit opt-in",
      );
    }
  }

  // -- Postgres (optional) --
  const databaseUrl = requireEnv("DATABASE_URL");
  if (!databaseUrl) {
    const postgresRequired = process.env.FLOE_POSTGRES_REQUIRED?.trim().toLowerCase();
    if (postgresRequired === "1" || postgresRequired === "true") {
      warnings.push("FLOE_POSTGRES_REQUIRED is set but DATABASE_URL is not configured");
    }
  }

  // -- Overload protection circuit breaker thresholds --
  const cbWalrusFailure = requireEnv("FLOE_CB_WALRUS_FAILURE_THRESHOLD");
  if (cbWalrusFailure && Number(cbWalrusFailure) < 1) {
    errors.push("FLOE_CB_WALRUS_FAILURE_THRESHOLD must be >= 1");
  }
  const cbSuiFailure = requireEnv("FLOE_CB_SUI_FAILURE_THRESHOLD");
  if (cbSuiFailure && Number(cbSuiFailure) < 1) {
    errors.push("FLOE_CB_SUI_FAILURE_THRESHOLD must be >= 1");
  }
  const globalReqConcurrency = requireEnv("FLOE_GLOBAL_REQUEST_CONCURRENCY");
  if (globalReqConcurrency && Number(globalReqConcurrency) < 1) {
    errors.push("FLOE_GLOBAL_REQUEST_CONCURRENCY must be >= 1");
  }

  // -- Metrics token (must be strong enough to resist brute-force) --
  const metricsEnabled = lowerEnv("FLOE_ENABLE_METRICS");
  const metricsToken = requireEnv("FLOE_METRICS_TOKEN");
  if (metricsEnabled !== "0" && metricsEnabled !== "false") {
    if (!metricsToken) {
      warnings.push("FLOE_METRICS_TOKEN is not set; metrics endpoint will be unavailable");
    } else if (metricsToken.length < 16) {
      errors.push(
        "FLOE_METRICS_TOKEN must be at least 16 characters" +
          " (current length: " +
          metricsToken.length +
          ")",
      );
    }
  }

  // -- Walrus publisher mode: max-body-size alignment --
  const walrusStoreMode = (process.env.FLOE_WALRUS_STORE_MODE ?? "publisher").trim().toLowerCase();
  if (walrusStoreMode === "publisher" || walrusStoreMode === "sdk") {
    const maxFileBytes = requireEnv("FLOE_AUTH_MAX_FILE_SIZE_BYTES");
    if (maxFileBytes) {
      const parsed = Number(maxFileBytes);
      if (Number.isFinite(parsed) && parsed > 10 * 1024 * 1024) {
        warnings.push(
          "FLOE_AUTH_MAX_FILE_SIZE_BYTES exceeds 10 MiB in publisher mode — confirm the Walrus publisher " +
            "is started with --max-body-size set to at least " +
            formatBytes(parsed) +
            "; otherwise large uploads will be rejected upstream",
        );
      }
    }
  }

  // -- Upload tmp dir --
  const tmpDir = requireEnv("UPLOAD_TMP_DIR");
  if (!tmpDir) {
    warnings.push("UPLOAD_TMP_DIR is not set; disk chunk store will use default");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
