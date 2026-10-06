// Unit tests for the optional-service circuit breaker (no backend needed).
// Run: bun circuit-breaker-test.mjs
import { createCircuitBreaker } from "./src/lib/circuit-breaker.ts";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e?.message ?? e}`); };
const check = (name, fn) => { try { fn(); ok(name); } catch (e) { bad(name, e); } };
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

check("starts closed and allows requests", () => {
  const b = createCircuitBreaker();
  assert(b.state === "closed", "expected closed");
  assert(b.canRequest() === true, "expected requests allowed");
});

check("stays closed below the failure threshold", () => {
  const b = createCircuitBreaker({ failureThreshold: 3 });
  b.onFailure();
  b.onFailure();
  assert(b.state === "closed", "two failures should not trip a 3-threshold breaker");
  assert(b.canRequest() === true, "should still allow requests");
});

check("opens after consecutive failures and refuses requests", () => {
  const b = createCircuitBreaker({ failureThreshold: 3, now: () => 1000 });
  b.onFailure(); b.onFailure(); b.onFailure();
  assert(b.state === "open", "expected open after threshold");
  assert(b.canRequest() === false, "open breaker must refuse requests");
});

check("a success resets the failure count", () => {
  const b = createCircuitBreaker({ failureThreshold: 3, now: () => 1000 });
  b.onFailure(); b.onFailure();
  b.onSuccess();
  b.onFailure(); b.onFailure();
  assert(b.state === "closed", "success should reset the streak");
});

check("re-opens and restarts cooldown when the probe fails", () => {
  let t = 0;
  const b = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => t });
  b.onFailure(); b.onFailure();
  t = 1000;
  assert(b.state === "half-open", "expected half-open after cooldown");
  assert(b.canRequest() === true, "one probe should be allowed");
  // A probe in flight blocks further probes.
  assert(b.canRequest() === false, "second concurrent probe must be refused");
  b.onFailure();
  assert(b.state === "open", "failed probe must re-open the circuit");
  t = 1500;
  assert(b.state === "open", "cooldown restarts after a failed probe");
});

check("recovers (closes) after a successful probe", () => {
  let t = 0;
  const b = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => t });
  b.onFailure(); b.onFailure();
  t = 1000;
  assert(b.canRequest() === true, "probe allowed");
  b.onSuccess();
  assert(b.state === "closed", "successful probe closes the circuit");
  assert(b.canRequest() === true, "requests flow again");
});

check("only one probe is allowed per cooldown window", () => {
  let t = 0;
  const b = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 500, now: () => t });
  b.onFailure();
  assert(b.canRequest() === false, "open immediately at threshold 1");
  t = 500;
  assert(b.canRequest() === true, "first probe allowed");
  assert(b.canRequest() === false, "second probe blocked while the first is in flight");
});

check("reset() fully restores normal operation", () => {
  const b = createCircuitBreaker({ failureThreshold: 1, now: () => 1000 });
  b.onFailure();
  assert(b.state === "open", "expected open");
  b.reset();
  assert(b.state === "closed", "reset should close");
  assert(b.canRequest() === true, "reset should allow requests");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
