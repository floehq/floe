/**
 * Parse a boolean environment variable.
 *
 * Accepts "1", "true" (case-insensitive) → true
 * Accepts "0", "false" (case-insensitive) → false
 * Returns `fallback` when the variable is unset or empty.
 * Throws when the value is present but not a valid boolean string,
 * since this indicates a configuration error.
 */
export function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "1" || raw.toLowerCase() === "true") return true;
  if (raw === "0" || raw.toLowerCase() === "false") return false;
  throw new Error(`${name} must be one of: 1, 0, true, false`);
}

/**
 * Parse a positive integer environment variable.
 *
 * Returns `fallback` when the variable is unset or empty.
 * Throws when the value is present but not a positive integer >= min.
 */
export function parsePositiveIntEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return n;
}
