/**
 * Service status: turning raw connection/auth failures into an honest, useful
 * UI state.
 *
 * Freecord talks to a Convex deployment. When that deployment cannot serve
 * requests (network loss, a paused/disabled deployment, a broken auth provider,
 * a rate limit, …) the Convex client closes its WebSocket and retries. The app
 * used to render `null` while authentication resolved, so any failure to reach
 * the backend left a completely black page with a `1013
 * AuthProviderDiscoveryFailed` loop in the console and no explanation.
 *
 * This module is intentionally PURE and dependency-free so it can be unit
 * tested without a browser or a deployment. It does three things:
 *
 *   1. `classifyServiceError` — map an error message to a failure kind.
 *   2. `nextBackoffDelay` — capped exponential backoff with jitter, so a retry
 *      never turns into a request storm.
 *   3. `deriveServiceStatus` — decide which screen the app should show, and
 *      whether a Retry is currently allowed (cooldown protection).
 */

/** What the app should be showing right now. */
export type ServicePhase =
  /** First paint: authentication/connection is still resolving. */
  | "loading"
  /** Connected (and auth resolved) — render the product. */
  | "ready"
  /** Was connected, connection dropped, waiting for the client to recover. */
  | "reconnecting"
  /** The browser itself reports no network. */
  | "offline"
  /** Repeated failures: show a real explanation and a guarded Retry. */
  | "unavailable";

/** The distinct things that can go wrong, each with its own recovery. */
export type ServiceErrorKind =
  /** Deployment paused/disabled because a usage limit was crossed. */
  | "deployment-disabled"
  /** Convex could not discover/verify the auth provider (OIDC discovery). */
  | "auth-discovery"
  /** Missing/invalid deployment or auth configuration. */
  | "config"
  /** Server-side rate limit or overload. */
  | "rate-limit"
  /** Expired/invalid session or token. */
  | "auth-session"
  /** Transient network/websocket failure. */
  | "network"
  /** Anything we could not identify. */
  | "unknown";

export type ServiceErrorCopy = {
  /** Short headline for the status screen. */
  title: string;
  /** What actually happened, in plain language. */
  detail: string;
  /** What the user (or the owner) can do about it. */
  hint: string;
  /** Whether retrying from the browser can plausibly help. */
  retryable: boolean;
};

/**
 * Ordered classification. Order matters: a Convex response body that mentions
 * both a usage limit and auth must be reported as the usage limit, because
 * that is the cause and the rest is a symptom.
 */
const RULES: ReadonlyArray<{ kind: ServiceErrorKind; test: RegExp }> = [
  {
    kind: "deployment-disabled",
    test: /usage limit|exceeded a configured|deployment has been disabled|deployment is disabled|paused.*(limit|quota)|out of (credits|usage)/,
  },
  {
    kind: "auth-discovery",
    test: /authproviderdiscoveryfailed|auth provider discovery|openid|well-known|jwks|issuer|no auth provider/,
  },
  {
    kind: "config",
    test: /missing environment variable|is not configured|invalid auth config|invalid deployment|misconfigured|invalid convex deployment|no deployment (url|configured)/,
  },
  {
    kind: "rate-limit",
    test: /rate limit|too many requests|slow down|\b429\b|overloaded|too many .*in a short/,
  },
  {
    kind: "auth-session",
    test: /session (expired|not found)|token (expired|invalid|malformed)|invalid jwt|unauthenticated|\b401\b|sign in again|jwt (expired|signature)/,
  },
  {
    kind: "network",
    test: /websocket|networkerror|failed to fetch|connection (lost|closed|refused|error)|offline|timed? ?out|econn|socket|reconnect/,
  },
];

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || "";
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const candidate = error as { message?: unknown; error?: unknown; code?: unknown };
    for (const value of [candidate.message, candidate.error, candidate.code]) {
      if (typeof value === "string" && value) return value;
    }
  }
  return error == null ? "" : String(error);
}

/**
 * Identify what kind of failure a message describes. Unknown input is
 * classified as `network` when the text is empty (the client usually only knows
 * "the socket didn't come up") and `unknown` otherwise.
 */
export function classifyServiceError(error: unknown): ServiceErrorKind {
  const message = messageOf(error).toLowerCase();
  if (!message.trim()) return "network";
  for (const rule of RULES) {
    if (rule.test.test(message)) return rule.kind;
  }
  return "unknown";
}

/** User-facing copy for each failure kind. Never contains an amount, a token or a message body. */
export const SERVICE_ERROR_COPY: Record<ServiceErrorKind, ServiceErrorCopy> = {
  "deployment-disabled": {
    title: "Freecord is temporarily paused",
    detail:
      "The chat backend stopped serving requests because it reached its configured usage limit, so sign-in and messages can't load right now.",
    hint: "Your accounts, communities and messages are safe. The deployment's owner has to raise or reset the usage limit in the Convex dashboard; retrying here won't clear it on its own.",
    retryable: false,
  },
  "auth-discovery": {
    title: "Sign-in service unavailable",
    detail:
      "Freecord couldn't reach the authentication provider it uses to verify your session, so signing in can't complete.",
    hint: "This normally means the chat backend is paused or unreachable. It will reconnect by itself once the backend answers again.",
    retryable: true,
  },
  config: {
    title: "Freecord isn't configured correctly",
    detail:
      "The backend reported a missing or invalid configuration value, so it can't serve requests.",
    hint: "This needs a configuration fix on the deployment — retrying from the browser won't help.",
    retryable: false,
  },
  "rate-limit": {
    title: "Freecord is busy",
    detail: "The backend asked us to slow down because too many requests arrived at once.",
    hint: "Give it a few seconds and try again.",
    retryable: true,
  },
  "auth-session": {
    title: "Your session needs to be renewed",
    detail: "The session this browser is holding is no longer valid.",
    hint: "Sign in again to continue — no messages or settings are lost.",
    retryable: true,
  },
  network: {
    title: "Can't reach Freecord",
    detail: "The connection to the chat backend was lost.",
    hint: "Check your internet connection. Freecord keeps retrying with a widening delay and reconnects on its own.",
    retryable: true,
  },
  unknown: {
    title: "Freecord couldn't start",
    detail: "The connection to the chat backend didn't complete and the reason wasn't recognised.",
    hint: "Try again in a moment. If it keeps happening, the details below help identify the cause.",
    retryable: true,
  },
};

/** Short banner copy for states that should not take over the screen. */
export const PHASE_MESSAGES: Record<Exclude<ServicePhase, "loading" | "ready">, string> = {
  reconnecting: "Reconnecting to Freecord…",
  offline: "You're offline — Freecord will reconnect automatically.",
  unavailable: "Freecord can't reach its chat backend.",
};

/**
 * Capped exponential backoff with jitter.
 *
 * `base * 2^attempt`, hard-capped at `maxMs`, then randomized inside
 * `[base, capped]` so two tabs (or two users) never retry in lockstep.
 * The cap keeps the interval in the 30–60s range for long outages, exactly as
 * recommended for reconnect handling.
 */
export function nextBackoffDelay(
  attempt: number,
  opts: {
    baseMs?: number;
    maxMs?: number;
    /** Injectable randomness (0..1) so the behaviour is testable. */
    random?: () => number;
  } = {},
): number {
  const baseMs = Math.max(250, opts.baseMs ?? 1_500);
  const maxMs = Math.max(baseMs, opts.maxMs ?? 45_000);
  const random = opts.random ?? Math.random;
  // A non-finite attempt (NaN, Infinity) must still yield a usable delay.
  const rawAttempt = Number.isFinite(attempt) ? attempt : 0;
  const safeAttempt = Math.max(0, Math.min(Math.floor(rawAttempt), 16));
  const capped = Math.min(maxMs, baseMs * 2 ** safeAttempt);
  // Full jitter, but never shorter than the base interval.
  const jittered = baseMs + random() * (capped - baseMs);
  return Math.round(jittered);
}

export type ServiceStatusInput = {
  /** The browser believes it has a network connection. */
  online: boolean;
  /** The Convex WebSocket is currently open and ready. */
  isWebSocketConnected: boolean;
  /** The client has connected successfully at least once this page load. */
  hasEverConnected: boolean;
  /** Failed connection attempts by the Convex client. */
  connectionRetries: number;
  /** Authentication has not resolved yet. */
  authLoading: boolean;
  /** Milliseconds since this page's first render. */
  elapsedMs: number;
  /** Classified failure recorded from a real error (or null). */
  errorKind: ServiceErrorKind | null;
  /** Manual retries the user has already spent. */
  attempts: number;
  /** Epoch ms until which a new manual Retry is refused (0 = allowed now). */
  cooldownUntil: number;
  /** Current clock, injectable for tests. */
  now: number;
  /**
   * How long a first connection may stay unresolved before we escalate from
   * "connecting" to "reconnecting", then to "unavailable".
   */
  slowMs?: number;
  unavailableMs?: number;
};

export type ServiceStatus = {
  phase: ServicePhase;
  kind: ServiceErrorKind | null;
  copy: ServiceErrorCopy | null;
  retryable: boolean;
  /** Manual retries left before the next cooldown expires (0 = allowed now). */
  cooldownRemainingMs: number;
  /** Consecutive attempts already made. */
  attempts: number;
  /** Delay the next automatic suggestion should use (capped, jittered). */
  nextDelayMs: number;
};

export const INITIAL_SLOW_MS = 6_000;
export const INITIAL_UNAVAILABLE_MS = 20_000;
export const RETRY_COOLDOWN_MS = 10_000;
export const MAX_RETRY_COOLDOWN_MS = 60_000;

/**
 * The single decision point for what Freecord renders while it is not fully
 * usable. Pure: everything it needs is passed in, so the whole matrix of
 * failures can be unit tested.
 */
export function deriveServiceStatus(input: ServiceStatusInput): ServiceStatus {
  const slowMs = input.slowMs ?? INITIAL_SLOW_MS;
  const unavailableMs = input.unavailableMs ?? INITIAL_UNAVAILABLE_MS;
  const cooldownRemainingMs = Math.max(0, input.cooldownUntil - input.now);
  const kind = input.errorKind;
  const copy = kind ? SERVICE_ERROR_COPY[kind] : null;
  const nextDelayMs = nextBackoffDelay(input.attempts);

  const base = {
    kind,
    copy,
    attempts: input.attempts,
    cooldownRemainingMs,
    nextDelayMs,
  };

  // 1. A non-retryable failure (a paused deployment, a broken configuration) is
  //    reported immediately — but ONLY while the socket is actually down. An
  //    error recorded earlier in the session must never pin a healthy, working
  //    app to an error screen.
  if (kind && copy && !copy.retryable && !input.isWebSocketConnected) {
    return { ...base, phase: "unavailable", retryable: false };
  }

  // 2. No network at all: never claim the backend is broken.
  if (!input.online) {
    return { ...base, phase: "offline", retryable: true };
  }

  // 3. Connected: only authentication may still be resolving.
  if (input.isWebSocketConnected) {
    if (input.authLoading) {
      // Auth has been resolving for a long time on a healthy socket: keep the
      // UI honest rather than spinning forever.
      if (input.elapsedMs >= unavailableMs) {
        return { ...base, phase: "unavailable", retryable: true };
      }
      return { ...base, phase: "loading", retryable: false };
    }
    return { ...base, phase: "ready", retryable: false };
  }

  // 4. Socket down. A user who has explicitly retried and is still waiting on a
  //    cooldown gets the guarded retry screen.
  const spentRetries = input.attempts > 0;
  if (cooldownRemainingMs > 0 && spentRetries) {
    return { ...base, phase: "unavailable", retryable: false };
  }

  // 5. Never connected during this page load.
  if (!input.hasEverConnected) {
    if (input.elapsedMs < slowMs) return { ...base, phase: "loading", retryable: false };
    if (input.elapsedMs < unavailableMs) return { ...base, phase: "reconnecting", retryable: false };
    return { ...base, phase: "unavailable", retryable: true };
  }

  // 6. Reconnected before, connection dropped again.
  if (input.elapsedMs < unavailableMs || input.connectionRetries < 3) {
    return { ...base, phase: "reconnecting", retryable: false };
  }
  return { ...base, phase: "unavailable", retryable: true };
}

/** Copy used by the full-screen state, with a sane fallback per phase. */
export function statusCopy(status: ServiceStatus): ServiceErrorCopy {
  if (status.copy) return status.copy;
  if (status.phase === "offline") {
    return {
      title: "You're offline",
      detail: "This device has no network connection, so Freecord can't reach its chat backend.",
      hint: "Freecord keeps the interface and retries in the background — everything reconnects once you're back online.",
      retryable: true,
    };
  }
  if (status.phase === "reconnecting") {
    return {
      title: "Reconnecting to Freecord",
      detail: "The connection to the chat backend dropped. Freecord is retrying with a widening delay.",
      hint: "Nothing is lost — messages you send once reconnected are delivered in order.",
      retryable: false,
    };
  }
  return SERVICE_ERROR_COPY.network;
}

/** Cooldown for the next manual retry: grows with repeated attempts, capped at 60s. */
export function retryCooldownMs(attempts: number): number {
  const step = Math.max(0, Math.floor(attempts) - 1);
  return Math.min(MAX_RETRY_COOLDOWN_MS, RETRY_COOLDOWN_MS * 2 ** Math.min(step, 3));
}
