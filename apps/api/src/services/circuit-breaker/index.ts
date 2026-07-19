/**
 * Generic circuit breaker for upstream dependency protection.
 *
 * States:
 *   CLOSED  — normal operation, requests pass through
 *   OPEN    — failures exceed threshold, requests are fast-rejected
 *   HALF_OPEN — probing after open duration, one test request allowed
 *
 * Each circuit breaker emits metric callbacks on state transitions
 * so the runtime metrics module can track state across all dependencies.
 */

export type CircuitState = "closed" | "open" | "half_open";

export type CircuitBreakerOptions = {
  /** Name for metrics and logging (e.g. "walrus_aggregator"). */
  name: string;
  /** Number of consecutive failures before opening the circuit. */
  failureThreshold: number;
  /** Number of consecutive successes in HALF_OPEN to close the circuit. */
  successThreshold: number;
  /** Duration in ms the circuit stays OPEN before transitioning to HALF_OPEN. */
  openDurationMs: number;
  /** Optional callback fired on every state transition. */
  onStateChange?: (prev: CircuitState, next: CircuitState, name: string) => void;
  /** Optional callback fired on every invocation outcome. */
  onOutcome?: (params: {
    name: string;
    state: CircuitState;
    success: boolean;
    durationMs: number;
  }) => void;
};

type CircuitBreakerState = {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  openedAt: number;
};

export class CircuitBreaker {
  private readonly opts: Required<CircuitBreakerOptions>;
  private state: CircuitState = "closed";
  private failureCount = 0;
  private successCount = 0;
  private openedAt = 0;
  /** Serializes probes so only one call runs fn() during half_open. */
  private probeLock: Promise<void> = Promise.resolve();

  constructor(opts: CircuitBreakerOptions) {
    this.opts = {
      failureThreshold: opts.failureThreshold,
      successThreshold: opts.successThreshold,
      openDurationMs: opts.openDurationMs,
      name: opts.name,
      onStateChange: opts.onStateChange ?? (() => {}),
      onOutcome: opts.onOutcome ?? (() => {}),
    };
  }

  get name(): string {
    return this.opts.name;
  }

  get currentState(): CircuitState {
    return this.state;
  }

  get failureRate(): number {
    const total = this.failureCount + this.successCount;
    if (total === 0) return 0;
    return this.failureCount / total;
  }

  /**
   * Execute an operation under circuit breaker protection.
   *
   * - If OPEN: rejects immediately with CircuitBreakerError
   * - If HALF_OPEN: allows one probe; success closes, failure re-opens
   * - If CLOSED: normal pass-through; failures may open the circuit
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    const durationMs = Date.now();

    if (this.state === "open") {
      if (Date.now() - this.openedAt >= this.opts.openDurationMs) {
        this.transitionTo("half_open");
      } else {
        const elapsed = Date.now() - durationMs;
        this.opts.onOutcome({
          name: this.opts.name,
          state: "open",
          success: false,
          durationMs: elapsed,
        });
        throw new CircuitBreakerError(this.opts.name, "open");
      }
    }

    if (this.state === "half_open") {
      await this.probeLock;
      if (this.state === "open") {
        const elapsed = Date.now() - durationMs;
        this.opts.onOutcome({
          name: this.opts.name,
          state: "open",
          success: false,
          durationMs: elapsed,
        });
        throw new CircuitBreakerError(this.opts.name, "open");
      }
    }

    let resolveProbe: (() => void) | undefined;
    if (this.state === "half_open") {
      this.probeLock = new Promise<void>((resolve) => {
        resolveProbe = resolve;
      });
    }

    let success = false;
    try {
      const result = await fn();
      success = true;
      return result;
    } finally {
      const elapsed = Date.now() - durationMs;
      this.recordOutcome(success, elapsed);
      resolveProbe?.();
    }
  }

  /**
   * Force the circuit into a specific state (useful for testing).
   */
  forceState(newState: CircuitState): void {
    const prev = this.state;
    this.state = newState;
    if (newState === "closed") {
      this.failureCount = 0;
      this.successCount = 0;
    }
    if (newState === "open") {
      this.openedAt = Date.now();
    }
    this.opts.onStateChange(prev, newState, this.opts.name);
  }

  /**
   * Reset the circuit to closed state (useful for testing / manual recovery).
   */
  reset(): void {
    this.forceState("closed");
  }

  private recordOutcome(success: boolean, durationMs: number): void {
    const prevState = this.state;

    if (success) {
      this.successCount += 1;
      this.failureCount = 0;

      if (this.state === "half_open" && this.successCount >= this.opts.successThreshold) {
        this.transitionTo("closed");
      }
    } else {
      this.failureCount += 1;
      this.successCount = 0;

      if (this.state === "half_open") {
        this.transitionTo("open");
      } else if (this.state === "closed" && this.failureCount >= this.opts.failureThreshold) {
        this.transitionTo("open");
      }
    }

    this.opts.onOutcome({
      name: this.opts.name,
      state: prevState,
      success,
      durationMs,
    });
  }

  private transitionTo(newState: CircuitState): void {
    const prev = this.state;
    this.state = newState;
    if (newState === "open") {
      this.openedAt = Date.now();
      this.failureCount = this.opts.failureThreshold; // prevent instant re-open on stale counts
    }
    if (newState === "closed") {
      this.failureCount = 0;
      this.successCount = 0;
    }
    if (newState === "half_open") {
      this.failureCount = 0;
      this.successCount = 0;
    }
    this.opts.onStateChange(prev, newState, this.opts.name);
  }
}

export class CircuitBreakerError extends Error {
  readonly circuitName: string;
  readonly circuitState: CircuitState;

  constructor(circuitName: string, circuitState: CircuitState) {
    super(`Circuit breaker OPEN for ${circuitName}`);
    this.name = "CircuitBreakerError";
    this.circuitName = circuitName;
    this.circuitState = circuitState;
  }
}
