/**
 * Client-side diagnostics for connection / authentication / render failures.
 *
 * Goals, in order:
 *   - make a future outage diagnosable BEFORE it becomes a long outage,
 *   - never leak credentials, tokens or message contents,
 *   - never generate network traffic (no remote logging service, no beacon),
 *   - never let logging itself become a problem: identical failures are
 *     grouped and counted, and each group is logged to the console once.
 *
 * The store is in-memory and per tab. A reload starts a fresh, clean report —
 * the same behaviour the Convex client has for its connection counters.
 */

import { classifyServiceError, type ServiceErrorKind } from "./service-status";
import { DEPLOYMENT_NAME } from "./deployment";

export type DiagnosticEntry = {
  kind: ServiceErrorKind;
  /** Redacted, truncated message used as the grouping key. */
  message: string;
  count: number;
  firstAt: number;
  lastAt: number;
};

/**
 * Where a failure came from. Only `service` entries are allowed to drive the
 * app-wide status screen: a bug inside one feature must never be presented as
 * "the backend is down".
 */
export type DiagnosticSource = "service" | "feature";

const sources = new Map<DiagnosticEntry, DiagnosticSource>();

const MAX_ENTRIES = 20;
const MAX_MESSAGE_LENGTH = 200;

const entries: DiagnosticEntry[] = [];
const listeners = new Set<() => void>();

/** Keys in an error message that must never reach a log or the UI. */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  // JWTs / signed tokens
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // bearer/authorization headers — consumes the scheme AND the token
  /\b(?:authorization|bearer)\b\s*[:=]?\s*(?:bearer\s+)?\S+/gi,
  // key=value pairs for anything named like a secret
  /\b(api[_-]?key|secret|token|password|passwd|pwd|private[_-]?key|client[_-]?secret|integration[_-]?key)\b\s*[:=]\s*["']?[^\s"',;)]+/gi,
  // long opaque hex/base64 blobs (hashes, keys, signatures)
  /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g,
  // email addresses
  /\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b/gi,
];

/** Strip anything that looks like a credential and bound the length. */
export function redactDiagnosticMessage(raw: string): string {
  let out = raw;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > MAX_MESSAGE_LENGTH) out = `${out.slice(0, MAX_MESSAGE_LENGTH)}…`;
  return out;
}

/** Current report, newest last. The array is a copy — callers can't mutate it. */
export function getDiagnostics(): DiagnosticEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

/** Total recorded failures across all groups. */
export function diagnosticFailureCount(): number {
  return entries.reduce((sum, entry) => sum + entry.count, 0);
}

/** The most recently seen failure kind, or null. */
export function lastServiceErrorKind(): ServiceErrorKind | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (sources.get(entries[i]) !== "feature") return entries[i].kind;
  }
  return null;
}

export function subscribeDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Record a failure. Identical (kind + redacted message) failures are grouped and
 * counted instead of appended, so a reconnect loop cannot flood the console.
 * Returns the entry that was touched.
 */
export function recordServiceError(error: unknown, source: DiagnosticSource = "service"): DiagnosticEntry {
  const kind = classifyServiceError(error);
  const message = redactDiagnosticMessage(
    error instanceof Error ? error.message : typeof error === "string" ? error : String((error as { message?: unknown })?.message ?? ""),
  ) || "(no message)";
  const now = Date.now();

  const existing = entries.find((entry) => entry.kind === kind && entry.message === message);
  if (existing) {
    existing.count += 1;
    existing.lastAt = now;
    notify();
    return { ...existing };
  }

  const entry: DiagnosticEntry = { kind, message, count: 1, firstAt: now, lastAt: now };
  sources.set(entry, source);
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  // Logged exactly once per distinct failure — never per occurrence.
  console.warn(`[Freecord] ${kind}: ${message}`);
  notify();
  return { ...entry };
}

/**
 * The deployment every failure in this report was produced against. Reported
 * alongside the entries so an operational problem can name the affected backend
 * — and, because Convex puts the function in the message itself
 * (`[CONVEX Q(users:currentUser)] …`), the function too — without one extra
 * request. The name is public (it is in the client bundle) and never a secret.
 */
export function diagnosticDeploymentName(): string {
  return DEPLOYMENT_NAME;
}

/** Clear the report (called after a manual retry or a successful connection). */
export function resetServiceDiagnostics(): void {
  if (entries.length === 0) return;
  for (const entry of entries) sources.delete(entry);
  entries.length = 0;
  notify();
}

/**
 * Observe the browser's own failure channels so an uncaught error still ends up
 * in the report instead of only in a console nobody reads. Listeners are passive:
 * they never trigger a request and never re-throw. Returns a cleanup function.
 */
export function installGlobalDiagnostics(target: Window = window): () => void {
  // A recognised connection/auth failure is a service problem; anything we
  // can't classify is treated as feature noise so it never claims the whole
  // app is down.
  const record = (value: unknown) => {
    recordServiceError(value, classifyServiceError(value) === "unknown" ? "feature" : "service");
  };
  const onError = (event: ErrorEvent) => {
    record(event.error ?? event.message);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    record(event.reason);
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
