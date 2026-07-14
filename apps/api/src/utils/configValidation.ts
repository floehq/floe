/**
 * Startup configuration validation.
 *
 * Checks all required and optional environment variables at startup
 * and produces a grouped error message listing any missing or invalid
 * values before service initialization proceeds.
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

  const suiPrivateKey = requireEnv("SUI_PRIVATE_KEY");
  if (!suiPrivateKey) {
    errors.push("SUI_PRIVATE_KEY or SUI_SECRET_KEY is required for Sui signing");
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
  const authTokenSecret = requireEnv("FLOE_AUTH_TOKEN_SECRET");
  if (authTokenSecret && authTokenSecret.length < 16) {
    warnings.push("FLOE_AUTH_TOKEN_SECRET is too short (< 16 chars); consider a longer secret");
  }

  // -- Postgres (optional) --
  const databaseUrl = requireEnv("DATABASE_URL");
  if (!databaseUrl) {
    const postgresRequired = process.env.FLOE_POSTGRES_REQUIRED?.trim().toLowerCase();
    if (postgresRequired === "1" || postgresRequired === "true") {
      warnings.push(
        "FLOE_POSTGRES_REQUIRED is set but DATABASE_URL is not configured",
      );
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
