import { createCircuitBreaker } from "@/lib/circuit-breaker";
import {
  deriveServiceStatus,
  retryCooldownMs,
  type ServiceErrorKind,
  type ServiceStatus,
} from "@/lib/service-status";
import { lastServiceErrorKind, resetServiceDiagnostics, subscribeDiagnostics } from "@/lib/diagnostics";
import { useConvexAuth, useConvexConnectionState } from "convex/react";
import { useCallback, useEffect, useState } from "react";

export type ServiceStatusHandle = {
  status: ServiceStatus;
  /**
   * Ask the app to try again. It does NOT create a second reconnect loop and it
   * never reloads the page: the Convex client owns the socket, so a retry just
   * clears the recorded failure and remounts the affected subtree
   * (`retryEpoch` as a React key) so its subscriptions re-run against the
   * existing, correctly configured client.
   *
   * Guarded by a cooldown that grows with repeated attempts (10s → 20s → 40s →
   * 60s) plus a circuit breaker, so a stuck outage can't be turned into a
   * request burst by button mashing.
   */
  retry: () => void;
  /** Bumped by each accepted manual retry — use as a React key. */
  retryEpoch: number;
  /** Milliseconds until the next manual retry is allowed (0 = allowed now). */
  cooldownRemainingMs: number;
};

/**
 * Single source of truth for "is Freecord usable right now, and if not, why?".
 *
 * It reads the Convex client's own connection state (no probing, no polling of
 * the backend), the browser's online state, the auth state, and the recorded
 * error report. Loop prevention comes from only ticking the clock while the app
 * is NOT ready.
 */
export function useServiceStatus(): ServiceStatusHandle {
  const { isLoading: authLoading } = useConvexAuth();
  const connection = useConvexConnectionState();

  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [errorKind, setErrorKind] = useState<ServiceErrorKind | null>(() => lastServiceErrorKind());
  const [now, setNow] = useState(() => Date.now());
  const [retryEpoch, setRetryEpoch] = useState(0);
  // Time this page started resolving, and the retry bookkeeping (attempts +
  // cooldown). All state, so they are read during render instead of through a
  // ref. Held in state (not a ref) so it is never read during render.
  const [startedAt] = useState(() => Date.now());
  const [retryState, setRetryState] = useState(() => ({ generation: connection.connectionCount, attempts: 0, cooldownUntil: 0 }));
  // One breaker per hook instance: after repeated manual retries that don't
  // help, further retries wait for a longer cooldown instead of hammering the
  // backend.
  const [breaker] = useState(() => createCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 }));

  // The Convex client increments `connectionCount` on every successful connect.
  // A different generation means the backend answered again, so the retry
  // history is stale and is reported as empty — no effect, no extra render.
  const generation = connection.connectionCount;
  const attempts = retryState.generation === generation ? retryState.attempts : 0;
  const cooldownUntil = retryState.generation === generation ? retryState.cooldownUntil : 0;

  // Network state (offline is never the backend's fault).
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  // Failures recorded anywhere in the app feed the status.
  useEffect(() => subscribeDiagnostics(() => setErrorKind(lastServiceErrorKind())), []);

  const status = deriveServiceStatus({
    online,
    isWebSocketConnected: connection.isWebSocketConnected,
    hasEverConnected: connection.hasEverConnected,
    connectionRetries: connection.connectionRetries,
    authLoading,
    elapsedMs: now - startedAt,
    errorKind,
    attempts,
    cooldownUntil,
    now,
  });

  // Tick only while not ready: a healthy app installs no timer at all.
  useEffect(() => {
    if (status.phase === "ready") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [status.phase]);

  const retry = useCallback(() => {
    const at = Date.now();
    if (at < cooldownUntil) return; // still cooling down
    if (!breaker.canRequest()) {
      // Circuit open: refuse without touching the backend.
      setRetryState({ generation, attempts, cooldownUntil: at + 60_000 });
      setNow(at);
      return;
    }
    breaker.onFailure();
    const nextAttempts = attempts + 1;
    setRetryState({ generation, attempts: nextAttempts, cooldownUntil: at + retryCooldownMs(nextAttempts) });
    // Clear the recorded failure so the next read reflects the retry, not the
    // old error.
    resetServiceDiagnostics();
    setErrorKind(null);
    setRetryEpoch((epoch) => epoch + 1);
    setNow(at);
  }, [attempts, breaker, cooldownUntil, generation]);

  return {
    status,
    retry,
    retryEpoch,
    cooldownRemainingMs: status.cooldownRemainingMs,
  };
}
