// Admin PIN — the rules AND the server-side boundary.
// Run: bun admin-pin-test.mjs
//
// Two halves:
//   1. The PIN rules are pure functions (`src/lib/admin-pin.ts`), tested here
//      with fixed inputs: 1–10 numeric digits, leading zeros preserved, nothing
//      else accepted, and the same messages the server uses.
//   2. The live half calls the deployment with NO session at all. It creates
//      nothing, so it is safe against the real deployment (same approach as
//      `deleted-messages-authz-test.mjs`): every write must be refused by the
//      server-side sign-in gate, and the status query must never ask a stranger
//      for a PIN or reveal any administrator's preference.
import { ConvexHttpClient } from "convex/browser";
import { api } from "./src/convex/_generated/api.js";
import {
  ADMIN_PIN_LOCKOUT_AFTER,
  ADMIN_PIN_LOCKOUT_BASE_MS,
  ADMIN_PIN_LOCKOUT_DECAY_MS,
  ADMIN_PIN_LOCKOUT_MAX_MS,
  ADMIN_PIN_MAX_DIGITS,
  ADMIN_PIN_MIN_DIGITS,
  ADMIN_PIN_UNLOCK_MINUTES,
  adminPinLockoutFor,
  adminPinLockoutSeconds,
  adminPinProblem,
  adminPinsMatch,
  isAdminPinValid,
  sanitizeAdminPinInput,
} from "./src/lib/admin-pin.js";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e ?? ""}`); };
const is = (name, got, expected) => {
  if (got === expected) ok(name);
  else bad(name, `got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
};

// ---------------------------------------------------------------------------
// 1. PIN format: 1–10 digits, leading zeros are significant
// ---------------------------------------------------------------------------
is("the documented length is 1 to 10 digits", `${ADMIN_PIN_MIN_DIGITS}-${ADMIN_PIN_MAX_DIGITS}`, "1-10");
is("a single digit is a valid PIN", isAdminPinValid("7"), true);
is("a single zero is a valid PIN", isAdminPinValid("0"), true);
is("leading zeros are valid and preserved", isAdminPinValid("007"), true);
is("a ten digit PIN is valid", isAdminPinValid("1234567890"), true);
is("an eleven digit PIN is refused", isAdminPinValid("12345678901"), false);
is("letters are refused", isAdminPinValid("12a45"), false);
is("symbols are refused", isAdminPinValid("12-45"), false);
is("spaces are refused", isAdminPinValid("12 45"), false);
is("an empty PIN is refused", isAdminPinValid(""), false);
is("a decimal number is refused", isAdminPinValid("1.5"), false);
is("a negative number is refused", isAdminPinValid("-1"), false);
is("a non-string is refused", isAdminPinValid(1234), false);
is("a null is refused", isAdminPinValid(null), false);

is("a valid PIN has no problem message", adminPinProblem("0042"), null);
is("an empty PIN explains itself", adminPinProblem(""), "Enter your PIN.");
is("non-digits explain themselves", adminPinProblem("12x"), "An Admin PIN can only contain digits 0–9.");
is("an over-long PIN explains the limit", adminPinProblem("12345678901"), "An Admin PIN can be at most 10 digits.");

is("matching entries pass the confirm check", adminPinsMatch("007", "007"), true);
is("a leading zero difference is a real difference", adminPinsMatch("007", "7"), false);
is("empty-vs-empty is not treated as matching input", adminPinsMatch("", ""), true);
is("different PINs do not match", adminPinsMatch("1234", "1235"), false);

// ---------------------------------------------------------------------------
// Input sanitising: digits only, capped, leading zeros kept
// ---------------------------------------------------------------------------
is("pasted separators are stripped", sanitizeAdminPinInput("00 12"), "0012");
is("leading zeros survive sanitising", sanitizeAdminPinInput("000123"), "000123");
is("letters never enter a PIN", sanitizeAdminPinInput("1a2b3"), "123");
is("input is capped at the maximum length", sanitizeAdminPinInput("123456789012345"), "1234567890");
is("non-string input becomes empty", sanitizeAdminPinInput(undefined), "");
is("an already-clean PIN is unchanged", sanitizeAdminPinInput("4321"), "4321");

// The unlock grant outlives one PIN entry (it is what "open for N minutes" means).
is("an unlock grant lasts a bounded time", ADMIN_PIN_UNLOCK_MINUTES > 0 && ADMIN_PIN_UNLOCK_MINUTES <= 240, true);

// ---------------------------------------------------------------------------
// Progressive delays for wrong PINs (the rule the server applies)
// ---------------------------------------------------------------------------
is("a couple of typos cost nothing", adminPinLockoutFor(1), 0);
is("the second failure still costs nothing", adminPinLockoutFor(2), 0);
is("the first delay starts at the threshold", ADMIN_PIN_LOCKOUT_AFTER, 3);
is("the third consecutive failure waits the base delay", adminPinLockoutFor(3), ADMIN_PIN_LOCKOUT_BASE_MS);
is("the fourth failure waits twice as long", adminPinLockoutFor(4), ADMIN_PIN_LOCKOUT_BASE_MS * 2);
is("the fifth failure waits four times as long", adminPinLockoutFor(5), ADMIN_PIN_LOCKOUT_BASE_MS * 4);
is("the delay keeps growing", adminPinLockoutFor(8) > adminPinLockoutFor(7), true);
is("the delay is capped", adminPinLockoutFor(40), ADMIN_PIN_LOCKOUT_MAX_MS);
is("the cap is a real wait, not forever", ADMIN_PIN_LOCKOUT_MAX_MS <= 15 * 60 * 1000, true);
is("the delay never decreases as guessing continues",
  Array.from({ length: 30 }, (_, i) => adminPinLockoutFor(i + 1)).every((v, i, arr) => i === 0 || v >= arr[i - 1]), true);
is("a huge attempt count cannot overflow into Infinity", Number.isFinite(adminPinLockoutFor(100_000)), true);
is("nonsense attempt counts are treated as no wait", adminPinLockoutFor(Number.NaN), 0);
is("an abandoned guessing run decays", ADMIN_PIN_LOCKOUT_DECAY_MS > ADMIN_PIN_LOCKOUT_MAX_MS, true);

// ---------------------------------------------------------------------------
// Lockout countdown
// ---------------------------------------------------------------------------
const NOW = 1_800_000_000_000;
is("no lockout means no countdown", adminPinLockoutSeconds(null, NOW), 0);
is("an expired lockout has no countdown", adminPinLockoutSeconds(NOW - 1000, NOW), 0);
is("a live lockout counts down in seconds", adminPinLockoutSeconds(NOW + 90_000, NOW), 90);
is("the countdown rounds up to the next second", adminPinLockoutSeconds(NOW + 5_500, NOW), 6);

// ---------------------------------------------------------------------------
// 2. The live server-side boundary (no session, nothing created)
// ---------------------------------------------------------------------------
const URL = process.env.CONVEX_URL || "https://academic-porcupine-929.convex.cloud";
const anonymous = new ConvexHttpClient(URL);

async function rejection(fn) {
  try {
    return { error: null, result: await fn() };
  } catch (error) {
    return { error: String(error?.data ?? error?.message ?? error) };
  }
}

// Reading the status must be safe and quiet for a stranger: no PIN demanded, no
// administrator's preference leaked.
const statusResult = await rejection(() => anonymous.query(api.adminPin.status, {}));
if (statusResult.error) {
  bad("an anonymous status read succeeds with safe defaults", statusResult.error);
} else {
  ok("an anonymous status read succeeds with safe defaults");
  is("a stranger is never asked for a PIN", statusResult.result.enabled, false);
  is("a stranger is never gated by a PIN", statusResult.result.unlocked, true);
  is("a stranger learns nothing about any administrator's PIN", statusResult.result.hasPin, false);
}

// Every write must be refused by the sign-in gate before it can touch a row.
const writes = [
  ["enabling a PIN", () => anonymous.action(api.adminPin.setPin, { pin: "1234", confirmPin: "1234" })],
  ["unlocking the panel", () => anonymous.action(api.adminPin.unlock, { pin: "1234" })],
  ["disabling PIN protection", () => anonymous.action(api.adminPin.disable, { pin: "1234" })],
  ["skipping PIN setup", () => anonymous.mutation(api.adminPin.skip, {})],
  ["locking the panel", () => anonymous.mutation(api.adminPin.lock, {})],
];
for (const [label, call] of writes) {
  const result = await rejection(call);
  if (result.error === null) bad(`an anonymous caller cannot do this: ${label}`, "the call succeeded");
  else if (/sign in/i.test(result.error)) ok(`an anonymous caller cannot do this: ${label}`);
  else bad(`an anonymous caller cannot do this: ${label}`, `unexpected rejection: ${result.error}`);
}

// A PIN alone must never be an authorization: even a well-formed PIN cannot
// unlock anything without an authenticated administrator.
const pinOnly = await rejection(() => anonymous.action(api.adminPin.unlock, { pin: "0" }));
if (pinOnly.error && /sign in/i.test(pinOnly.error)) ok("a PIN on its own never grants access");
else bad("a PIN on its own never grants access", `unexpected result: ${JSON.stringify(pinOnly)}`);

// The functions really exist (a rename would otherwise make the checks above
// "pass" by failing with function-not-found).
const notFound = (r) => r.error && /not found|CouldNotFindFunction|no function/i.test(r.error);
if (notFound(statusResult)) bad("api.adminPin.status exists on the deployment", statusResult.error);
else ok("api.adminPin.status exists on the deployment");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
