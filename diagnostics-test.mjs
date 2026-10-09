// Unit tests for the diagnostics store: it must group repeated failures, never
// leak credentials, and never let a feature bug claim the backend is down.
// Run: bun diagnostics-test.mjs
import {
  getDiagnostics,
  lastServiceErrorKind,
  recordServiceError,
  redactDiagnosticMessage,
  resetServiceDiagnostics,
} from "./src/lib/diagnostics.ts";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e?.message ?? e}`); };
const check = (name, fn) => { try { fn(); ok(name); } catch (e) { bad(name, e); } };
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ---------------------------------------------------------------------------
// redaction
// ---------------------------------------------------------------------------
check("a JWT is redacted", () => {
  const jwt =
    "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ.c2lnbmF0dXJlLWhlcmUtbG9uZy1lbm91Z2g";
  const out = redactDiagnosticMessage(`Auth failed for ${jwt}`);
  assert(!out.includes(jwt), "the token must be gone");
  assert(out.includes("[redacted]"), "should be marked as redacted");
});

check("bearer tokens, api keys and passwords are redacted", () => {
  for (const raw of [
    "Authorization: Bearer sk_live_1234567890abcdef",
    "apiKey=sk_021abb1e3b02a845714028cc21c9d5252255a2aafb625356b971c024a91586c8",
    "integration_key: sk_secret_value",
    "password=hunter2hunter2",
    "privateKey=-----BEGIN-PRIVATE-KEY-----",
  ]) {
    const out = redactDiagnosticMessage(raw);
    for (const secret of ["sk_live_1234567890abcdef", "sk_021abb1e3b02a845714028cc21c9d5252255a2aafb625356b971c024a91586c8", "sk_secret_value", "hunter2hunter2"]) {
      assert(!out.includes(secret), `${secret} leaked from: ${raw} -> ${out}`);
    }
  }
});

check("email addresses are redacted", () => {
  assert(!redactDiagnosticMessage("failed for someone@example.com").includes("someone@example.com"), "email must be redacted");
});

check("long opaque blobs (hashes/keys) are redacted", () => {
  const blob = "a".repeat(48);
  assert(!redactDiagnosticMessage(`hash ${blob}`).includes(blob), "long blob must be redacted");
});

check("ordinary error text is preserved for real diagnosis", () => {
  const out = redactDiagnosticMessage("WebSocket closed with code 1013: AuthProviderDiscoveryFailed");
  assert(out.includes("1013") && out.includes("AuthProviderDiscoveryFailed"), `useful detail must survive: ${out}`);
});

check("messages are truncated instead of unbounded", () => {
  const out = redactDiagnosticMessage("x".repeat(5000));
  assert(out.length <= 201, `expected at most 200 chars + ellipsis, got ${out.length}`);
});

// ---------------------------------------------------------------------------
// recording, grouping, sources
// ---------------------------------------------------------------------------
check("identical failures are grouped, not appended", () => {
  resetServiceDiagnostics();
  recordServiceError(new Error("WebSocket closed with code 1013: AuthProviderDiscoveryFailed"));
  recordServiceError(new Error("WebSocket closed with code 1013: AuthProviderDiscoveryFailed"));
  recordServiceError(new Error("WebSocket closed with code 1013: AuthProviderDiscoveryFailed"));
  const entries = getDiagnostics();
  assert(entries.length === 1, `expected 1 grouped entry, got ${entries.length}`);
  assert(entries[0].count === 3, `expected count 3, got ${entries[0].count}`);
  assert(entries[0].kind === "auth-discovery", `expected auth-discovery, got ${entries[0].kind}`);
});

check("different failures are kept apart", () => {
  resetServiceDiagnostics();
  recordServiceError(new Error("AuthProviderDiscoveryFailed"));
  recordServiceError(new Error("Missing environment variable `CONVEX_SITE_URL`"));
  assert(getDiagnostics().length === 2, "distinct failures must be separate entries");
});

check("a recorded failure drives the service status", () => {
  resetServiceDiagnostics();
  recordServiceError(new Error("This deployment has been disabled because it exceeded a configured usage limit"));
  assert(lastServiceErrorKind() === "deployment-disabled", `expected deployment-disabled, got ${lastServiceErrorKind()}`);
});

check("a FEATURE failure is reported but never claims the backend is down", () => {
  resetServiceDiagnostics();
  recordServiceError(new Error("Cannot read properties of undefined (reading 'map')"), "feature");
  assert(getDiagnostics().length === 1, "the failure is still visible for debugging");
  assert(lastServiceErrorKind() === null, "a feature bug must not drive the app-wide status");
});

check("a feature failure after a service failure does not mask the service cause", () => {
  resetServiceDiagnostics();
  recordServiceError(new Error("AuthProviderDiscoveryFailed"));
  recordServiceError(new Error("render blew up"), "feature");
  assert(lastServiceErrorKind() === "auth-discovery", "the last SERVICE failure must still be reported");
});

check("reset clears the report", () => {
  recordServiceError(new Error("AuthProviderDiscoveryFailed"));
  resetServiceDiagnostics();
  assert(getDiagnostics().length === 0, "report must be empty");
  assert(lastServiceErrorKind() === null, "kind must be cleared");
});

check("the report is bounded even under a flood of failures", () => {
  resetServiceDiagnostics();
  for (let i = 0; i < 200; i += 1) recordServiceError(new Error(`unique failure number ${i}`));
  assert(getDiagnostics().length <= 20, `expected a bounded report, got ${getDiagnostics().length}`);
});

check("callers cannot mutate the stored report", () => {
  resetServiceDiagnostics();
  recordServiceError(new Error("AuthProviderDiscoveryFailed"));
  const snapshot = getDiagnostics();
  snapshot[0].count = 999;
  assert(getDiagnostics()[0].count === 1, "the store must return copies");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
