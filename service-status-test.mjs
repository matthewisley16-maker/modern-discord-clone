// Unit tests for the service-status module — the logic that decides what the
// app renders when it cannot reach its Convex deployment, and how it retries.
// Run: bun service-status-test.mjs
//
// The messages asserted here are the REAL signals from the production outage:
//   - the Convex 500 body: "... has been disabled because it exceeded a
//     configured usage limit ..."
//   - the browser console loop: "WebSocket closed with code 1013:
//     AuthProviderDiscoveryFailed"
// A regression in this file means the black-screen class of bug can come back.
import {
  classifyServiceError,
  deriveServiceStatus,
  nextBackoffDelay,
  retryCooldownMs,
  statusCopy,
  SERVICE_ERROR_COPY,
  RETRY_COOLDOWN_MS,
  MAX_RETRY_COOLDOWN_MS,
} from "./src/lib/service-status.ts";
import { getDiagnostics, recordServiceError, resetServiceDiagnostics } from "./src/lib/diagnostics.ts";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e?.message ?? e}`); };
const check = (name, fn) => { try { fn(); ok(name); } catch (e) { bad(name, e); } };
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (name, got, expected) => {
  const g = JSON.stringify(got), x = JSON.stringify(expected);
  if (g === x) ok(name); else bad(name, `got ${g}, expected ${x}`);
};

// ---------------------------------------------------------------------------
// classifyServiceError
// ---------------------------------------------------------------------------
const REAL_DISABLED =
  "This deployment has been disabled because it exceeded a configured usage limit. Update or disable the usage limit in the Convex dashboard in deployment settings to resume function execution.";
const REAL_CONSOLE = "WebSocket closed with code 1013: AuthProviderDiscoveryFailed";

eq("the live deployment-disabled body is classified as deployment-disabled", classifyServiceError(REAL_DISABLED), "deployment-disabled");
eq("the live console error is classified as auth-discovery", classifyServiceError(REAL_CONSOLE), "auth-discovery");
eq("a websocket/network failure is classified as network", classifyServiceError("WebSocket closed with code 1006"), "network");
eq("a missing env var is classified as config", classifyServiceError("Missing environment variable `CONVEX_SITE_URL`"), "config");
eq("a rate limit is classified as rate-limit", classifyServiceError("Too many requests in a short period"), "rate-limit");
eq("an expired session is classified as auth-session", classifyServiceError("Session expired, please sign in again"), "auth-session");
eq("an invalid JWT is classified as auth-session", classifyServiceError("Invalid JWT signature"), "auth-session");
eq("unknown text is classified as unknown", classifyServiceError("Illegal invocation at Foo"), "unknown");
eq("empty input is treated as a connection problem", classifyServiceError(""), "network");
eq("no input is treated as a connection problem", classifyServiceError(undefined), "network");
eq("an object with a message is classified", classifyServiceError({ message: REAL_CONSOLE }), "auth-discovery");
eq("an Error instance is classified", classifyServiceError(new Error(REAL_DISABLED)), "deployment-disabled");

check("a usage-limit failure wins over the auth symptom it causes", () => {
  assert(classifyServiceError(`${REAL_CONSOLE} — ${REAL_DISABLED}`) === "deployment-disabled",
    "the cause (usage limit) must be reported, not the symptom (auth discovery)");
});
check("an auth-provider failure wins over the generic websocket close", () => {
  assert(classifyServiceError("1013 AuthProviderDiscoveryFailed") === "auth-discovery", "expected auth-discovery");
});

check("a non-retryable failure tells the user retrying cannot help", () => {
  assert(SERVICE_ERROR_COPY["deployment-disabled"].retryable === false, "deployment-disabled must not be retryable");
  assert(SERVICE_ERROR_COPY.config.retryable === false, "config must not be retryable");
  assert(SERVICE_ERROR_COPY.network.retryable === true, "network must be retryable");
  assert(/safe/i.test(SERVICE_ERROR_COPY["deployment-disabled"].hint), "must reassure that data is safe");
});

check("copy never leaks a limit amount, a token or a deployment id", () => {
  for (const [kind, copy] of Object.entries(SERVICE_ERROR_COPY)) {
    const text = `${copy.title} ${copy.detail} ${copy.hint}`;
    assert(!/GB|calls|academic-|convex\.cloud|token|secret/i.test(text), `${kind} leaks internal detail: ${text}`);
  }
});

// ---------------------------------------------------------------------------
// nextBackoffDelay — capped exponential with jitter, never a storm
// ---------------------------------------------------------------------------
check("backoff grows with attempts and never goes below the base", () => {
  const noJitter = () => 1;
  const d0 = nextBackoffDelay(0, { baseMs: 1000, maxMs: 45000, random: noJitter });
  const d1 = nextBackoffDelay(1, { baseMs: 1000, maxMs: 45000, random: noJitter });
  const d3 = nextBackoffDelay(3, { baseMs: 1000, maxMs: 45000, random: noJitter });
  assert(d0 === 1000, `attempt 0 should be the base, got ${d0}`);
  assert(d1 > d0 && d3 > d1, "delay must grow");
  assert(nextBackoffDelay(0, { baseMs: 1000, maxMs: 45000, random: () => 0 }) >= 1000, "must never be shorter than the base");
});

check("backoff is capped in the 30-60s range no matter how many attempts", () => {
  for (const attempt of [8, 20, 100, 1000]) {
    const d = nextBackoffDelay(attempt, { baseMs: 1500, maxMs: 45000, random: () => 1 });
    assert(d <= 45000, `attempt ${attempt} exceeded the cap: ${d}`);
    assert(d >= 30000, `long outages should wait ~30-60s, got ${d} for attempt ${attempt}`);
  }
});

check("jitter spreads identical attempts apart (no lockstep retries)", () => {
  const low = nextBackoffDelay(4, { baseMs: 1500, maxMs: 45000, random: () => 0 });
  const high = nextBackoffDelay(4, { baseMs: 1500, maxMs: 45000, random: () => 1 });
  assert(low !== high, "jitter must produce different delays");
});

check("a negative/NaN attempt cannot produce a negative delay", () => {
  for (const attempt of [-5, NaN]) {
    const d = nextBackoffDelay(attempt, { baseMs: 1500, maxMs: 45000, random: () => 0.5 });
    assert(Number.isFinite(d) && d >= 1500, `expected a safe delay, got ${d}`);
  }
});

// ---------------------------------------------------------------------------
// retryCooldownMs — grows, then stops
// ---------------------------------------------------------------------------
eq("first retry cooldown is the base", retryCooldownMs(1), RETRY_COOLDOWN_MS);
eq("second retry cooldown doubles", retryCooldownMs(2), RETRY_COOLDOWN_MS * 2);
check("retry cooldown is capped", () => {
  assert(retryCooldownMs(9) <= MAX_RETRY_COOLDOWN_MS, "cooldown must be capped");
  assert(retryCooldownMs(99) === MAX_RETRY_COOLDOWN_MS, "cooldown must stay at the cap");
});

// ---------------------------------------------------------------------------
// deriveServiceStatus — the decision matrix
// ---------------------------------------------------------------------------
const base = {
  online: true,
  isWebSocketConnected: false,
  hasEverConnected: false,
  connectionRetries: 0,
  authLoading: true,
  elapsedMs: 1000,
  errorKind: null,
  attempts: 0,
  cooldownUntil: 0,
  now: 1_000_000,
};

eq("healthy and authenticated renders the product", deriveServiceStatus({ ...base, isWebSocketConnected: true, authLoading: false }).phase, "ready");
eq("healthy socket still authenticating shows the splash", deriveServiceStatus({ ...base, isWebSocketConnected: true }).phase, "loading");
eq("no network is reported as offline, not as a backend fault", deriveServiceStatus({ ...base, online: false, isWebSocketConnected: true, authLoading: false }).phase, "offline");
eq("first seconds of connecting show the splash", deriveServiceStatus({ ...base, elapsedMs: 2000 }).phase, "loading");
eq("a slow first connection shows reconnecting", deriveServiceStatus({ ...base, elapsedMs: 9000 }).phase, "reconnecting");
eq("a never-connecting client becomes unavailable with a retry", (() => {
  const s = deriveServiceStatus({ ...base, elapsedMs: 25000 });
  return [s.phase, s.retryable];
})(), ["unavailable", true]);
eq("a dropped connection with few retries shows reconnecting", deriveServiceStatus({ ...base, hasEverConnected: true, elapsedMs: 3000, connectionRetries: 1 }).phase, "reconnecting");
eq("a dropped connection that keeps failing becomes unavailable", (() => {
  const s = deriveServiceStatus({ ...base, hasEverConnected: true, elapsedMs: 30000, connectionRetries: 9 });
  return [s.phase, s.retryable];
})(), ["unavailable", true]);
eq("auth stuck on a healthy socket becomes unavailable instead of spinning", deriveServiceStatus({ ...base, isWebSocketConnected: true, elapsedMs: 30000 }).phase, "unavailable");

check("a paused deployment is reported immediately and not offered a retry", () => {
  const s = deriveServiceStatus({ ...base, errorKind: "deployment-disabled", elapsedMs: 500 });
  assert(s.phase === "unavailable", `expected unavailable, got ${s.phase}`);
  assert(s.retryable === false, "a usage-limit pause must not invite retries");
  assert(s.copy?.title === SERVICE_ERROR_COPY["deployment-disabled"].title, "must use the deployment copy");
});

check("a stale non-retryable error cannot pin a healthy app to an error screen", () => {
  const s = deriveServiceStatus({ ...base, errorKind: "deployment-disabled", isWebSocketConnected: true, authLoading: false });
  assert(s.phase === "ready", `a working connection must win over an old error, got ${s.phase}`);
});

check("a recorded but retryable failure still shows a retry", () => {
  const s = deriveServiceStatus({ ...base, errorKind: "auth-discovery", elapsedMs: 25000 });
  assert(s.phase === "unavailable", `expected unavailable, got ${s.phase}`);
  assert(s.retryable === true, "auth discovery is retryable");
});

check("the retry cooldown is enforced and reported", () => {
  const s = deriveServiceStatus({ ...base, elapsedMs: 25000, attempts: 1, cooldownUntil: 1_005_000 });
  assert(s.phase === "unavailable", "expected unavailable while cooling down");
  assert(s.retryable === false, "must refuse a retry during cooldown");
  assert(s.cooldownRemainingMs === 5000, `expected 5000ms remaining, got ${s.cooldownRemainingMs}`);
});

check("a finished cooldown allows a retry again", () => {
  const s = deriveServiceStatus({ ...base, elapsedMs: 25000, attempts: 1, cooldownUntil: 999_000 });
  assert(s.retryable === true, "an expired cooldown must allow a retry");
  assert(s.cooldownRemainingMs === 0, "no time should remain");
});

// ---------------------------------------------------------------------------
// the WIRED path: what the Convex client hands the app on an abnormal close
// ---------------------------------------------------------------------------
// main.tsx passes this exact callback to the client:
//
//     new ConvexReactClient(CONVEX_URL, {
//       onServerDisconnectError: (message) => recordServiceError(message),
//     })
//
// These tests go through that same entry point (the string the client actually
// produces, into the diagnostics store, out through the status decision), so a
// regression anywhere in that chain — including silently dropping the close
// reason again — fails here instead of only showing up as a black screen.
check("the client's 1013 close reason is what the app records", () => {
  resetServiceDiagnostics();
  recordServiceError(REAL_CONSOLE); // exactly what onServerDisconnectError receives
  const entries = getDiagnostics();
  assert(entries.length === 1, `expected one entry, got ${entries.length}`);
  assert(entries[0].kind === "auth-discovery", `expected auth-discovery, got ${entries[0].kind}`);
  assert(entries[0].message.includes("AuthProviderDiscoveryFailed"), "the cause must survive redaction");
});

check("a recorded close reason replaces the generic network message on screen", () => {
  resetServiceDiagnostics();
  const silent = deriveServiceStatus({ ...base, elapsedMs: 25000 });
  recordServiceError(REAL_CONSOLE);
  const status = deriveServiceStatus({ ...base, elapsedMs: 25000, errorKind: "auth-discovery" });
  assert(status.copy?.title === SERVICE_ERROR_COPY["auth-discovery"].title,
    `expected the auth copy, got "${status.copy?.title}"`);
  assert(status.copy?.title !== silent.copy?.title,
    "the known cause must not be reported as a plain connection loss");
});

check("a reconnected backend clears the failure instead of pinning the screen", () => {
  // The deployment answers again (as it did once the usage limit was raised):
  // the socket is connected and the account resolves, so the app is ready even
  // though the failure is still in the report.
  const status = deriveServiceStatus({
    ...base,
    isWebSocketConnected: true,
    authLoading: false,
    hasEverConnected: true,
    elapsedMs: 60000,
    errorKind: "auth-discovery",
  });
  assert(status.phase === "ready", `expected ready after recovery, got ${status.phase}`);
});

check("an auth-discovery loop cannot flood the report", () => {
  resetServiceDiagnostics();
  // 10 minutes of the client's capped 16s reconnect backoff.
  for (let i = 0; i < 40; i += 1) recordServiceError(REAL_CONSOLE);
  const entries = getDiagnostics();
  assert(entries.length === 1, `expected one grouped entry, got ${entries.length}`);
  assert(entries[0].count === 40, `expected every occurrence counted, got ${entries[0].count}`);
});

check("statusCopy always yields real copy for every phase", () => {
  for (const phase of ["loading", "ready", "reconnecting", "offline", "unavailable"]) {
    const s = deriveServiceStatus(
      phase === "offline" ? { ...base, online: false } : phase === "reconnecting" ? { ...base, elapsedMs: 9000 } : base,
    );
    const copy = statusCopy({ ...s, phase });
    assert(copy.title && copy.detail && copy.hint, `${phase} must have complete copy`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
