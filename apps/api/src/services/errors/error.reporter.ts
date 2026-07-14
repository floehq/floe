/**
 * Optional Sentry error reporter.
 *
 * Initializes Sentry when FLOE_SENTRY_DSN is configured. When the DSN is
 * missing, errors are logged to console only — no crash, no telemetry.
 *
 * Uses createRequire for dynamic loading so @sentry/node is never loaded
 * at import time — only when FLOE_SENTRY_DSN is present.
 */
import { createRequire } from "module";

const _require = createRequire(import.meta.url);

let sentryInitialized = false;
let sentryModule: any = null;
let activeDsn: string | undefined;

/** DSN string, read once at init time. */
function sentryDsn(): string | undefined {
  return process.env.FLOE_SENTRY_DSN?.trim() || undefined;
}

/**
 * Initialize the Sentry SDK.
 *
 * Safe to call multiple times — only the first call with a DSN takes effect.
 * If FLOE_SENTRY_DSN is not set, this is a no-op and logs a hint for operators.
 */
export function initErrorReporter(log: { info: (msg: string) => void }): void {
  if (sentryInitialized) return;

  const dsn = sentryDsn();
  activeDsn = dsn;

  if (!dsn) {
    log.info(
      "Sentry error reporter not configured — set FLOE_SENTRY_DSN to enable error tracking",
    );
    return;
  }

  try {
    sentryModule = _require("@sentry/node");

    sentryModule.init({
      dsn,
      // At minimum capture errors — tracing is opt-in via env vars below.
      tracesSampleRate: parseTracesSampleRate(),
      environment: process.env.NODE_ENV ?? "development",
      serverName: process.env.FLOE_NODE_ROLE ?? "unknown",
    });

    sentryInitialized = true;
    log.info(
      `Sentry error reporter initialized (environment=${process.env.NODE_ENV ?? "development"})`,
    );
  } catch (err) {
    sentryModule = null;
    log.info(
      `Sentry error reporter unavailable: ${(err as Error)?.message ?? "unknown"}. ` +
        "Errors will be logged to console only.",
    );
  }
}

/**
 * Parse an optional traces sample rate from the environment.
 * Defaults to 0 (no performance tracing) unless explicitly set.
 */
function parseTracesSampleRate(): number {
  const raw = process.env.FLOE_SENTRY_TRACES_SAMPLE_RATE?.trim();
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0;
}

/**
 * Capture an exception and send it to Sentry (if initialized).
 *
 * When Sentry is not configured, the error is logged to stderr via
 * console.error so it still appears in process logs.
 */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!sentryInitialized || !sentryModule || !activeDsn) {
    return;
  }

  try {
    sentryModule.withScope((scope: any) => {
      if (context) {
        scope.setExtras(context);
      }
      sentryModule.captureException(error);
    });
  } catch {
    // Best-effort — if Sentry fails to report, we still have the
    // original console.error in the caller.
  }
}

/**
 * Gracefully flush pending events and close the Sentry client.
 * Call during server shutdown.
 */
export async function closeErrorReporter(): Promise<void> {
  if (!sentryInitialized || !sentryModule) return;

  try {
    await sentryModule.close(2_000);
  } catch {
    // Best-effort flush.
  } finally {
    sentryInitialized = false;
    sentryModule = null;
  }
}
