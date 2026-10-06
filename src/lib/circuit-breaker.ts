/**
 * A small, dependency-free circuit breaker for OPTIONAL services (GIPHY, and
 * any future metadata fetch). It stops an optional feature from turning a burst
 * of failures into an unbounded retry loop:
 *
 *   closed    → normal; requests flow.
 *   open      → too many consecutive failures; requests are refused until the
 *               cooldown elapses, so nothing is hammered.
 *   half-open → after cooldown, exactly ONE probe is allowed through. Success
 *               closes the circuit; failure re-opens it (and restarts cooldown).
 *
 * It never disables Freecord itself — callers decide the feature-specific
 * fallback. Purely in-memory, so every browser tab keeps its own breaker.
 */
export type CircuitState = "closed" | "open" | "half-open";

export type CircuitBreaker = {
  readonly state: CircuitState;
  /** True when a request may proceed (and reserves the single half-open probe). */
  canRequest: () => boolean;
  onSuccess: () => void;
  onFailure: () => void;
  reset: () => void;
};

export function createCircuitBreaker(opts: {
  /** Consecutive failures that trip the breaker. Default 3. */
  failureThreshold?: number;
  /** How long the breaker stays open before allowing one probe. Default 30s. */
  cooldownMs?: number;
  /** Injectable clock (used by tests). */
  now?: () => number;
} = {}): CircuitBreaker {
  const failureThreshold = Math.max(1, opts.failureThreshold ?? 3);
  const cooldownMs = Math.max(1, opts.cooldownMs ?? 30_000);
  const now = opts.now ?? (() => Date.now());

  let failures = 0;
  let openedAt = 0;
  let probing = false;

  function currentState(): CircuitState {
    if (failures < failureThreshold) return "closed";
    if (probing) return "open"; // a probe is already in flight
    return now() - openedAt < cooldownMs ? "open" : "half-open";
  }

  return {
    get state() {
      return currentState();
    },
    canRequest() {
      const s = currentState();
      if (s === "closed") return true;
      if (s === "half-open") {
        probing = true; // reserve the single probe
        return true;
      }
      return false;
    },
    onSuccess() {
      failures = 0;
      openedAt = 0;
      probing = false;
    },
    onFailure() {
      failures += 1;
      probing = false;
      if (failures >= failureThreshold) openedAt = now();
    },
    reset() {
      failures = 0;
      openedAt = 0;
      probing = false;
    },
  };
}
