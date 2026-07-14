import { parsePositiveIntEnv } from "../utils/parseEnv.js";

export const CircuitBreakerConfig = {
  /**
   * Number of consecutive failures before the Walrus aggregator circuit opens.
   */
  walrusFailureThreshold: parsePositiveIntEnv("FLOE_CB_WALRUS_FAILURE_THRESHOLD", 5, 1),

  /**
   * Number of consecutive successes in HALF_OPEN before closing the Walrus circuit.
   */
  walrusSuccessThreshold: parsePositiveIntEnv("FLOE_CB_WALRUS_SUCCESS_THRESHOLD", 3, 1),

  /**
   * Duration in ms the Walrus circuit stays OPEN before trying HALF_OPEN.
   */
  walrusOpenDurationMs: parsePositiveIntEnv("FLOE_CB_WALRUS_OPEN_DURATION_MS", 30_000, 1_000),

  /**
   * Number of consecutive failures before the Sui RPC circuit opens.
   */
  suiFailureThreshold: parsePositiveIntEnv("FLOE_CB_SUI_FAILURE_THRESHOLD", 3, 1),

  /**
   * Number of consecutive successes in HALF_OPEN before closing the Sui circuit.
   */
  suiSuccessThreshold: parsePositiveIntEnv("FLOE_CB_SUI_SUCCESS_THRESHOLD", 2, 1),

  /**
   * Duration in ms the Sui circuit stays OPEN before trying HALF_OPEN.
   */
  suiOpenDurationMs: parsePositiveIntEnv("FLOE_CB_SUI_OPEN_DURATION_MS", 60_000, 1_000),

  /**
   * Number of consecutive failures before the external auth circuit opens.
   */
  externalAuthFailureThreshold: parsePositiveIntEnv(
    "FLOE_CB_EXTERNAL_AUTH_FAILURE_THRESHOLD",
    5,
    1,
  ),

  /**
   * Number of consecutive successes in HALF_OPEN before closing the external auth circuit.
   */
  externalAuthSuccessThreshold: parsePositiveIntEnv(
    "FLOE_CB_EXTERNAL_AUTH_SUCCESS_THRESHOLD",
    3,
    1,
  ),

  /**
   * Duration in ms the external auth circuit stays OPEN before trying HALF_OPEN.
   */
  externalAuthOpenDurationMs: parsePositiveIntEnv(
    "FLOE_CB_EXTERNAL_AUTH_OPEN_DURATION_MS",
    30_000,
    1_000,
  ),
} as const;
