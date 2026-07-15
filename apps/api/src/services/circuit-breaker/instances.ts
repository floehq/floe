import { CircuitBreaker } from "./index.js";
import { CircuitBreakerConfig } from "../../config/circuit-breaker.config.js";
import {
  observeCircuitBreakerState,
  observeCircuitBreakerOutcome,
} from "../metrics/runtime.metrics.js";

function buildCircuit(name: string, threshold: number, successThreshold: number, openMs: number) {
  return new CircuitBreaker({
    name,
    failureThreshold: threshold,
    successThreshold,
    openDurationMs: openMs,
    onStateChange: (prev, next, circuitName) => {
      observeCircuitBreakerState({ name: circuitName, from: prev, to: next });
    },
    onOutcome: (params) => {
      observeCircuitBreakerOutcome(params);
    },
  });
}

/** Circuit breaker for Walrus aggregator blob reads. */
export const walrusReadCircuit = buildCircuit(
  "walrus_read",
  CircuitBreakerConfig.walrusFailureThreshold,
  CircuitBreakerConfig.walrusSuccessThreshold,
  CircuitBreakerConfig.walrusOpenDurationMs,
);

/** Circuit breaker for Walrus publisher blob writes. */
export const walrusPublishCircuit = buildCircuit(
  "walrus_publish",
  CircuitBreakerConfig.walrusFailureThreshold,
  CircuitBreakerConfig.walrusSuccessThreshold,
  CircuitBreakerConfig.walrusOpenDurationMs,
);

/** Circuit breaker for Sui RPC metadata finalization. */
export const suiCircuit = buildCircuit(
  "sui",
  CircuitBreakerConfig.suiFailureThreshold,
  CircuitBreakerConfig.suiSuccessThreshold,
  CircuitBreakerConfig.suiOpenDurationMs,
);

/** Circuit breaker for external auth provider verification. */
export const externalAuthCircuit = buildCircuit(
  "external_auth",
  CircuitBreakerConfig.externalAuthFailureThreshold,
  CircuitBreakerConfig.externalAuthSuccessThreshold,
  CircuitBreakerConfig.externalAuthOpenDurationMs,
);
