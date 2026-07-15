/**
 * Startup config dump utility.
 *
 * Scans all FLOE_* environment variables, redacts known secret values,
 * and returns a structured object suitable for logging at startup.
 * This gives operators a single log line showing the full resolved
 * configuration (redacting secrets) for debugging and audit.
 */

/** Env var names whose values should always be redacted. */
const SENSITIVE_NAMES = new Set([
  "FLOE_API_KEYS_JSON",
  "FLOE_SENTRY_DSN",
  "FLOE_AUTH_TOKEN_SECRET",
  "FLOE_AUTH_EXTERNAL_SHARED_SECRET",
  "FLOE_AUTH_EXTERNAL_AUTH_TOKEN",
]);

/**
 * Heuristic: if the env var name contains any of these substrings
 * (case-insensitive), the value is treated as a secret.
 */
const SENSITIVE_PATTERNS = [/KEY/i, /SECRET/i, /TOKEN/i, /PASSWORD/i, /DSN/i];

function isSensitiveName(name: string): boolean {
  if (SENSITIVE_NAMES.has(name)) return true;
  return SENSITIVE_PATTERNS.some((pat) => pat.test(name));
}

/**
 * Build a flat record of FLOE_* env vars with secret values redacted.
 *
 * Non-sensitive values are included as-is so operators can see the
 * resolved configuration at a glance. Sensitive values show only
 * `"***REDACTED***"` — the key itself is preserved so you know which
 * variables are set.
 */
export function dumpConfig(): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("FLOE_")) continue;
    if (value === undefined || value === "") continue;

    out[key] = isSensitiveName(key) ? "***REDACTED***" : value;
  }

  return out;
}
