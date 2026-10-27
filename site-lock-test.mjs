// Optional site locks (PIN and/or password) — the rules, the wiring and the
// server-side boundary.
//
// Run: bun site-lock-test.mjs
//
// Four layers, none of which creates an account (the deployment guard forbids
// synthetic users in production, and this feature has nothing to do with
// creating accounts anyway):
//   1. the pure rules (`src/lib/site-lock.ts`): PIN format with significant
//      leading zeros, password rules that allow symbols, the four enabled/disabled
//      configurations, the progressive guessing delay and the recovery-code rules,
//   2. the SERVER (`src/convex/siteLock.ts` + the schema): hashing, session-scoped
//      verification, rate limits, recovery, and the fact that nothing plain-text
//      is ever stored or returned,
//   3. the UI wiring (`SiteLockGate`, `SiteLockSettings`, `main.tsx`,
//      `SettingsPanel.tsx`, `index.css`): which fields appear for which
//      configuration, both-required flow, recovery, protected-route wrapping and
//      no credentials in browser storage,
//   4. live, read-only calls with NO session: a signed-out visitor is never asked
//      for a lock and can never verify, change or recover one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "./src/convex/_generated/api.js";
import {
  generateRecoveryCode,
  grantCoversSession,
  maskRecoveryEmail,
  pendingSiteFactors,
  staleSiteLockGrants,
  readableSiteLockError,
  requiredSiteFactors,
  sanitizeRecoveryCodeInput,
  sanitizeSitePinInput,
  siteLockEnabled,
  siteLockErrorMessage,
  siteLockoutFor,
  siteLockoutSeconds,
  sitePasswordProblem,
  sitePasswordsMatch,
  sitePinProblem,
  sitePinsMatch,
  siteRecoveryCodeProblem,
  SITE_LOCKOUT_AFTER,
  SITE_LOCKOUT_BASE_MS,
  SITE_LOCKOUT_MAX_MS,
  SITE_PASSWORD_MAX_LENGTH,
  SITE_PASSWORD_MIN_LENGTH,
  SITE_PIN_MAX_DIGITS,
  SITE_PIN_MIN_DIGITS,
  SITE_RECOVERY_CODE_DIGITS,
  SITE_RECOVERY_CODE_TTL_MS,
  SITE_RECOVERY_MAX_ATTEMPTS,
} from "./src/lib/site-lock.js";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e ?? ""}`); };
const is = (name, got, expected) => {
  if (got === expected) ok(name);
  else bad(name, `got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
};
const check = (name, condition, detail) => (condition ? ok(name) : bad(name, detail));
const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");
const count = (haystack, needle) => haystack.split(needle).length - 1;
/** The body of a declaration, up to its closing `});`. */
function handlerOf(source, declaration) {
  const start = source.indexOf(declaration);
  if (start < 0) return "";
  const end = source.indexOf("\n});", start);
  return source.slice(start, end < 0 ? undefined : end);
}

// ---------------------------------------------------------------------------
// 1a. PIN: 1–10 digits, leading zeros are significant
// ---------------------------------------------------------------------------
is("the documented PIN length is 1 to 10 digits", `${SITE_PIN_MIN_DIGITS}-${SITE_PIN_MAX_DIGITS}`, "1-10");
is("a single digit is a valid PIN", sitePinProblem("7"), null);
is("a single zero is a valid PIN", sitePinProblem("0"), null);
is("a leading-zero PIN is valid", sitePinProblem("0042"), null);
is("a ten digit PIN is valid", sitePinProblem("1234567890"), null);
is("an eleven digit PIN is refused", sitePinProblem("12345678901"), "A PIN can be at most 10 digits.");
is("letters are refused", sitePinProblem("12a45"), "A PIN can only contain digits 0–9.");
is("spaces are refused", sitePinProblem("12 45"), "A PIN can only contain digits 0–9.");
is("symbols are refused", sitePinProblem("12-45"), "A PIN can only contain digits 0–9.");
is("an empty PIN explains itself", sitePinProblem(""), "Enter your PIN.");
is("a non-string PIN is refused", sitePinProblem(1234), "Enter your PIN.");

is("leading zeros survive sanitising", sanitizeSitePinInput("00 12"), "0012");
is("a pasted PIN keeps every digit", sanitizeSitePinInput("0000123456789"), "0000123456");
is("letters never enter a PIN", sanitizeSitePinInput("a1b2c3"), "123");
is("the PIN is never parsed as a number", sanitizeSitePinInput("0042")[0], "0");
is("0042 and 42 are different PINs", sitePinsMatch("0042", "42"), false);
is("identical PINs match", sitePinsMatch("0042", "0042"), true);
is("different PINs do not match", sitePinsMatch("1234", "1235"), false);

// ---------------------------------------------------------------------------
// 1b. Extra password: reasonable length, letters/numbers/symbols all allowed
// ---------------------------------------------------------------------------
is("the documented minimum length is 8", SITE_PASSWORD_MIN_LENGTH, 8);
is("a short password is refused", sitePasswordProblem("Ab1!"), "Your password must be at least 8 characters long.");
is("eight characters with a letter and a number is enough", sitePasswordProblem("abcd1234"), null);
is("symbols, spaces and capitals are allowed", sitePasswordProblem("Corr3ct Horse!@#$%^&*()"), null);
is("a password of only letters is refused", sitePasswordProblem("abcdefgh"), "Your password must include at least one letter and one number.");
is("a password of only numbers is refused", sitePasswordProblem("12345678"), "Your password must include at least one letter and one number.");
is("an empty password explains itself", sitePasswordProblem(""), "Enter your password.");
is("an over-long password is refused", sitePasswordProblem("a1" + "x".repeat(SITE_PASSWORD_MAX_LENGTH)), "That password is too long.");
is("the password is never trimmed or normalised", sitePasswordProblem("  Abcd1234  "), null);
is("passwords must match", sitePasswordsMatch("Abcd1234!", "Abcd1234!"), true);
is("mismatched passwords are caught", sitePasswordsMatch("Abcd1234!", "Abcd1234?"), false);

// ---------------------------------------------------------------------------
// 1c. Both locks are independent, and all four configurations work
// ---------------------------------------------------------------------------
const CONFIGS = [
  { name: "neither lock", flags: { pinEnabled: false, passwordEnabled: false }, required: [] },
  { name: "PIN only", flags: { pinEnabled: true, passwordEnabled: false }, required: ["pin"] },
  { name: "password only", flags: { pinEnabled: false, passwordEnabled: true }, required: ["password"] },
  { name: "both locks", flags: { pinEnabled: true, passwordEnabled: true }, required: ["pin", "password"] },
];
for (const config of CONFIGS) {
  is(`${config.name}: the required credentials`, requiredSiteFactors(config.flags).join("+") || "(none)", config.required.join("+") || "(none)");
  is(`${config.name}: the feature is ${config.required.length ? "on" : "off"}`, siteLockEnabled(config.flags), config.required.length > 0);
  is(`${config.name}: a fresh session has to verify`, pendingSiteFactors(config.flags, {}).length, config.required.length);
  is(`${config.name}: with everything verified nothing is asked`, pendingSiteFactors(config.flags, { pin: true, password: true }).length, 0);
}
is("with both on, verifying only the PIN is not enough", pendingSiteFactors({ pinEnabled: true, passwordEnabled: true }, { pin: true }).join(","), "password");
is("with both on, verifying only the password is not enough", pendingSiteFactors({ pinEnabled: true, passwordEnabled: true }, { password: true }).join(","), "pin");
is("a PIN-only setup never asks for a password", pendingSiteFactors({ pinEnabled: true, passwordEnabled: false }, {}).join(","), "pin");
is("a password-only setup never asks for a PIN", pendingSiteFactors({ pinEnabled: false, passwordEnabled: true }, {}).join(","), "password");
is("a missing row (no locks at all) asks nothing", pendingSiteFactors({}, {}).length, 0);
is("an explicitly disabled PIN is off, not on", siteLockEnabled({ pinEnabled: false, passwordEnabled: false }), false);

// ---------------------------------------------------------------------------
// 1d. Progressive delay against repeated guessing
// ---------------------------------------------------------------------------
is("the first typos cost nothing", siteLockoutFor(1), 0);
is("the second typo still costs nothing", siteLockoutFor(SITE_LOCKOUT_AFTER - 1), 0);
is("the lockout starts after the third consecutive failure", siteLockoutFor(SITE_LOCKOUT_AFTER), SITE_LOCKOUT_BASE_MS);
is("the delay doubles each further failure", siteLockoutFor(SITE_LOCKOUT_AFTER + 1), SITE_LOCKOUT_BASE_MS * 2);
is("the delay keeps growing", siteLockoutFor(SITE_LOCKOUT_AFTER + 2), SITE_LOCKOUT_BASE_MS * 4);
is("the delay is capped", siteLockoutFor(60), SITE_LOCKOUT_MAX_MS);
{
  let monotonic = true;
  let previous = -1;
  for (let n = 0; n <= 40; n += 1) {
    const delay = siteLockoutFor(n);
    if (delay < previous) monotonic = false;
    previous = delay;
  }
  check("the delay never decreases as failures pile up", monotonic);
}
is("no lockout means no wait", siteLockoutSeconds(null, 1_000), 0);
is("an elapsed lockout is over", siteLockoutSeconds(1_000, 2_000), 0);
is("a lockout reports the seconds left", siteLockoutSeconds(6_000, 1_000), 5);
is("a wrong credential message is generic", siteLockErrorMessage(0), "That PIN or password is not correct.");
check("a wrong credential never says which part was wrong",
  !/pin (was|is) wrong|password (was|is) wrong|close|hint/i.test(siteLockErrorMessage(5_000)),
  siteLockErrorMessage(5_000));
check("the message tells the user how long to wait", siteLockErrorMessage(5_000).includes("5s"), siteLockErrorMessage(5_000));

// ---------------------------------------------------------------------------
// 1e. Recovery codes (single use, expiring, hashed server-side)
// ---------------------------------------------------------------------------
is("a recovery code is 6 digits", SITE_RECOVERY_CODE_DIGITS, 6);
is("recovery codes expire in 10 minutes", Math.round(SITE_RECOVERY_CODE_TTL_MS / 60_000), 10);
is("a recovery code allows a few tries", SITE_RECOVERY_MAX_ATTEMPTS >= 3, true);
is("a short code is refused", siteRecoveryCodeProblem("123"), "A recovery code is 6 digits.");
is("a non-numeric code is refused", siteRecoveryCodeProblem("12a456"), "That code should be digits only.");
is("a six digit code is accepted", siteRecoveryCodeProblem("000123"), null);
is("recovery input keeps leading zeros", sanitizeRecoveryCodeInput("0001239"), "000123");
is("a generated code is always 6 digits", generateRecoveryCode(() => 0.999).length, 6);
is("a generated code keeps leading zeros", generateRecoveryCode(() => 0).length, 6);
is("a zero-filled code is all zeros", generateRecoveryCode(() => 0), "000000");
check("generated codes vary with the source", generateRecoveryCode(() => 0.7) !== generateRecoveryCode(() => 0.1));
is("the emailed destination is masked", maskRecoveryEmail("ada@example.com"), "a••a@example.com");
check("the masked address hides the local part", !maskRecoveryEmail("ada@example.com").includes("ad"), maskRecoveryEmail("ada@example.com"));
is("a junk email is not echoed", maskRecoveryEmail("not-an-email"), "");

// ---------------------------------------------------------------------------
// 1f. Friendly errors
// ---------------------------------------------------------------------------
is("a KonvexError message is shown", readableSiteLockError({ data: "That PIN or password is not correct." }, "fallback"), "That PIN or password is not correct.");
is("a redacted server error falls back", readableSiteLockError(new Error("Server Error"), "Try again."), "Try again.");
is("an unknown failure falls back", readableSiteLockError(undefined, "Try again."), "Try again.");
check("only one short line is ever shown", readableSiteLockError({ data: "Line one\nLine two" }, "x") === "Line one");

// ---------------------------------------------------------------------------
// 1g. Verification is per DEVICE, so a second device can never re-lock this one
// ---------------------------------------------------------------------------
is("a session with no grant is not verified", grantCoversSession([], "s1", "pin"), false);
is("a session-less caller is never verified", grantCoversSession([{ sessionId: "s1", factor: "pin" }], null, "pin"), false);
is("a session's own grant verifies it", grantCoversSession([{ sessionId: "s1", factor: "pin" }], "s1", "pin"), true);
is("another device's grant does NOT verify this session", grantCoversSession([{ sessionId: "s2", factor: "pin" }], "s1", "pin"), false);
is("a PIN grant never satisfies the password lock", grantCoversSession([{ sessionId: "s1", factor: "pin" }], "s1", "password"), false);
is("several devices can each hold their own grant", grantCoversSession([
  { sessionId: "laptop", factor: "pin" },
  { sessionId: "phone", factor: "pin" },
], "phone", "pin"), true);
is("both factors can be held by one device", grantCoversSession([
  { sessionId: "laptop", factor: "pin" },
  { sessionId: "laptop", factor: "password" },
], "laptop", "password"), true);
{
  const grants = [
    { _id: "g1", sessionId: "laptop", factor: "pin" },
    { _id: "g2", sessionId: "phone", factor: "pin" },
    { _id: "g3", sessionId: "tablet", factor: "password" },
  ];
  check("grants for live sessions are kept", staleSiteLockGrants(grants, ["laptop", "phone", "tablet"]).length === 0, "a live grant was treated as stale");
  check("grants of expired/revoked sessions are dropped", staleSiteLockGrants(grants, ["laptop"]).map((g) => g._id).join(",") === "g2,g3", "a dead session's grant would linger forever");
  check("with no live sessions everything is stale", staleSiteLockGrants(grants, []).length === 3);
}

// ---------------------------------------------------------------------------
// 2a. Server: hashed storage, server-side verification, no plain-text anywhere
// ---------------------------------------------------------------------------
const server = read("src", "convex", "siteLock.ts");
const schema = read("src", "convex", "schema.ts");
const gate = read("src", "components", "SiteLockGate.tsx");
const settings = read("src", "components", "dashboard", "SiteLockSettings.tsx");
const main = read("src", "main.tsx");
const panel = read("src", "components", "dashboard", "SettingsPanel.tsx");

check("the PIN is hashed, never stored", server.includes("const pinHash = await new Scrypt().hash(pin);"), "the PIN is not hashed before storage");
check("the extra password is hashed, never stored", server.includes("const passwordHash = await new Scrypt().hash(newPassword)") || server.includes("const passwordHash = await new Scrypt().hash(password);"), "the password is not hashed before storage");
check("the recovery code is hashed too", server.includes("const codeHash = await new Scrypt().hash(code);"), "the recovery code is stored in the clear");
check("verification happens server-side with Scrypt", server.includes("await new Scrypt().verify(rec.pinHash!, pin)") && server.includes("await new Scrypt().verify(rec.passwordHash!, password)"), "verification is not server-side hashing");
check("the PIN is verified as a STRING (leading zeros preserved)", /Scrypt\(\)\.verify\(rec\.pinHash!, pin\)/.test(server) && !/Number\(pin\)/.test(server), "the PIN could be coerced to a number");
check("nothing logs a credential", !/console\.(log|debug|info|warn|error)/.test(server) && !/console\./.test(gate) && !/console\./.test(settings), "a credential could reach the logs");
{
  const siteLocks = handlerOf(schema, "siteLocks: defineTable({");
  check("the schema stores only hashes for the PIN", siteLocks.includes("pinHash") && !/\bpin:\s*v\./.test(siteLocks), "the schema has a plain-text PIN column");
  check("the schema stores only hashes for the extra password", siteLocks.includes("passwordHash") && !/\bpassword:\s*v\./.test(siteLocks), "the schema has a plain-text password column");
  check("the row is indexed by user", siteLocks.includes('.index("by_user", ["userId"])'), "the lock row has no user index");
  check("verification is stored per auth session", siteLocks.includes("verifiedPinSessionId") && siteLocks.includes("verifiedPasswordSessionId"), "verification is not session-scoped");
  check(
    "every device keeps its OWN grant row (unlocking one never locks another)",
    schema.includes("siteLockGrants: defineTable({") && siteLocks.includes("verifiedPinSessionId"),
    "verification is still a single account-wide value",
  );
  {
    const grantsTable = handlerOf(schema, "siteLockGrants: defineTable({");
    check("a grant names the session it belongs to", grantsTable.includes("sessionId: v.string()"), "a grant is not session-scoped");
    check("a grant names the factor it proves", grantsTable.includes('factor: v.union(v.literal("pin"), v.literal("password"))'), "a grant is not factor-scoped");
    check("grants are looked up per user + session + factor", grantsTable.includes('.index("by_user_session", ["userId", "sessionId", "factor"])'), "the per-session lookup is not indexed");
  }
  check("failure tracking is stored", siteLocks.includes("failedAttempts") && siteLocks.includes("lockedUntil"), "there is no failure/lockout state");
}

// The public surface must never hand a hash to a client.
{
  const status = handlerOf(server, "export const status = query({");
  check("the public status query exposes no hashes",
    status.length > 0 && !/(pinHash|passwordHash|recoveryCodeHash):/.test(status),
    "the status query returns a hash");
  check("it reports only whether a credential exists, not the credential",
    status.includes("hasPin: Boolean(row?.pinHash)") && status.includes("hasPassword: Boolean(row?.passwordHash)"),
    "the status query no longer reports lock presence safely");
  check("the status query is a query (reactive, cannot be cached into a bypass)", server.includes("export const status = query({"), "the gate's decision is no longer reactive");
  check("hashing only happens in actions, never in a query", !handlerOf(server, "export const status = query({").includes("Scrypt"), "crypto is running inside a query");
}
check("every public entry point requires the signed-in owner", count(server, 'throw new ConvexError("Please sign in to continue.")') >= 6, String(count(server, 'throw new ConvexError("Please sign in to continue.")')));
check("the lock row is read through the caller's own user id", server.includes('.withIndex("by_user", (q) => q.eq("userId", userId))'), "the lock row is not scoped to the caller");

// ---------------------------------------------------------------------------
// 2b. Server: independence, proof of identity, audit
// ---------------------------------------------------------------------------
{
  const clearPin = handlerOf(server, "export const clearPin = internalMutation({");
  const clearPassword = handlerOf(server, "export const clearPassword = internalMutation({");
  check("turning the PIN off never touches the password lock", clearPin.length > 0 && !/password/i.test(clearPin), "clearPin also clears the password");
  check("turning the password off never touches the PIN lock", clearPassword.length > 0 && !/pin/i.test(clearPassword.replace(/verifiedPinSessionId/g, "")), "clearPassword also clears the PIN");
}
check("changing a lock requires the current credential", server.includes('if (!currentPin) throw new ConvexError("Enter your current PIN.");') && server.includes('if (!currentPassword) throw new ConvexError("Enter your current password.");'), "a credential could be replaced with no proof");
check("turning a lock off requires proof of identity", count(server, "await proveIdentityOrThrow(") >= 2, "a lock could be turned off without proof");
check("the account password is an accepted proof", server.includes("identity confirmed with the account password"), "the account password is no longer accepted");
check("an account without a password credential can still get back in", server.includes("account has no password credential; identity confirmed by the signed-in session"), "such an account would be locked out");
check("a wrong account password is rate limited", server.includes("internal.siteLock.enforceLimit, { scope: \"disable\""), "the disable path is not rate limited");
for (const action of ["site_lock.pin.enable", "site_lock.pin.change", "site_lock.pin.disable", "site_lock.password.enable", "site_lock.password.change", "site_lock.password.disable", "site_lock.unlock", "site_lock.recovery.request", "site_lock.recovery.complete"]) {
  check(`the audit log records ${action}`, server.includes(`"${action}"`), "the audit trail is incomplete");
}
check("audit details never contain a credential", !/detail: [^\n]*\b(pin|password)\b[^\n]*\$\{/.test(server), "a credential could be written to the audit log");

// ---------------------------------------------------------------------------
// 2c. Server: rate limits, progressive delay, recovery safeguards
// ---------------------------------------------------------------------------
check("verification is rate limited", server.includes('scope: "verify", limit: 30, windowMs: 60_000'), "verify has no rate limit");
check("setting a PIN is rate limited", server.includes('scope: "setpin"'), "setPin has no rate limit");
check("setting a password is rate limited", server.includes('scope: "setpassword"'), "setPassword has no rate limit");
check("recovery emails are rate limited", server.includes('scope: "recovery", limit: 3'), "recovery has no rate limit");
check("guessing escalates through the shared ladder", server.includes("const delayMs = siteLockoutFor(failed);") && server.includes("siteLockoutSeconds(rec.lockedUntil, Date.now())"), "guessing is not slowed down");
check("a correct entry resets the failure streak", /if \(success\) \{[\s\S]*failedAttempts: 0/.test(server), "the streak is never reset");
check("a stale streak decays", server.includes("SITE_LOCKOUT_DECAY_MS"), "old failures never decay");
check("verification success is recorded for THIS session only", /markVerified = internalMutation\(\{[\s\S]*grantFactor\(ctx, userId, key, "pin", now\)/.test(server), "verification is not scoped to the session");
{
  const lockNow = handlerOf(server, "export const lockNow = mutation({");
  const markVerified = handlerOf(server, "export const markVerified = internalMutation({");
  check("verification reads the session's own grant", server.includes('sessionProved(sessionId, row?.verifiedPinSessionId, grants, "pin")'), "verification is not per session");
  check("a session-less caller is never verified", /function sessionProved\([\s\S]*if \(sessionId === null\) return false;/.test(server), "a session-less caller could be treated as verified");
  check("one device's unlock cannot lock another device", lockNow.length > 0 && lockNow.includes("grant.sessionId === key"), "locking now would revoke every device");
  check("the legacy single-session fields are only cleared for THIS session", lockNow.includes("row.verifiedPinSessionId === key") && lockNow.includes("row.verifiedPasswordSessionId === key"), "a legacy field could still lock another device");
  check("no account-wide verification reset exists anywhere", !/verifiedPinSessionId: undefined,\s*\n\s*verifiedPasswordSessionId: undefined,\s*\n\s*updatedAt/.test(lockNow), "locking still clears both fields for every session");
  check("marking verified writes a per-session grant", markVerified.includes("grantFactor(") && markVerified.includes("pruneDeadGrants("), "no grant is recorded, or dead grants are never pruned");
  check("a new or removed credential revokes every device's proof of it", count(server, "await revokeFactorGrants(ctx, userId,") >= 4, "an old proof could outlive the credential it proved");
  check("grants of dead sessions are pruned", server.includes("staleSiteLockGrants(grants, live)") && server.includes('withIndex("userId", (q) => q.eq("userId", userId))'), "dead grants would accumulate forever");
  check("a credential is never granted by a client on its own", server.includes("export const markVerified = internalMutation({") && !server.includes("export const markVerified = mutation({"), "markVerified is publicly callable");
}
check("a correct verification clears the failure state", /markVerified = internalMutation\(\{[\s\S]*failedAttempts: 0/.test(server), "the lockout would outlive a correct entry");
{
  const recover = handlerOf(server, "export const recoverWithCode = action({");
  check("a recovery code expires", recover.includes("recoveryCodeExpiresAt ?? 0) < Date.now()"), "an old code stays valid forever");
  check("a recovery code allows only a few attempts", recover.includes("SITE_RECOVERY_MAX_ATTEMPTS"), "a code can be brute forced");
  check("a recovery code is single use", recover.includes("internal.siteLock.clearRecoveryCode, {}"), "a code could be replayed");
  check("the new credential is validated before being stored", recover.includes("sitePinProblem(args.newPin)") && recover.includes("sitePasswordProblem(args.newPassword)"), "a recovery could store an unusable credential");
  check("recovery can also turn the lock off", recover.includes("args.disable"), "recovery cannot disable a lock");
  const request = handlerOf(server, "export const requestRecoveryCode = action({");
  check("the code is emailed to the account's own address", request.includes("internal.siteLock.accountEmail, { userId }") && request.includes("sendCodeEmail"), "the code is not sent to the account owner");
  check("recovery refuses when nothing is locked", request.includes("nothing to recover"), "recovery is offered with no lock");
  check("a failed send does not leave a usable code", request.includes("clearRecoveryCode") && request.includes("couldn't send the recovery email"), "a stale code could survive a failed delivery");
}
check("locking again is a safe, unauthenticated-direction action", /export const lockNow = mutation\(\{[\s\S]*verifiedPinSessionId: undefined[\s\S]*verifiedPasswordSessionId: undefined/.test(server), "the locks cannot be re-armed");

// ---------------------------------------------------------------------------
// 3a. The gate: which fields appear for which configuration
// ---------------------------------------------------------------------------
check("the gate reads the server's decision reactively", gate.includes("useQuery(api.siteLock.status, {})"), "the gate does not ask the server");
check("with no lock enabled the app renders unchanged", gate.includes("if (!status.enabled || status.unlocked) return <>{children}</>;"), "the site would be gated with no lock set");
check("a loading state exists (never a blank screen)", gate.includes("return <BrandSplash label="), "the gate can render nothing while loading");
check("the PIN field appears only when the PIN lock is on", gate.includes('const needsPin = status.pending.includes("pin");') && gate.includes("{needsPin && ("), "the PIN field is not conditional");
check("the password field appears only when the password lock is on", gate.includes('const needsPassword = status.pending.includes("password");') && gate.includes("{needsPassword && ("), "the password field is not conditional");
check("both credentials are submitted together when both are on", gate.includes("const both = needsPin && needsPassword;") && gate.includes("...(needsPin ? { pin } : {})") && gate.includes("...(needsPassword ? { password } : {})"), "both-required flow is broken");
check("verification runs in a server action", gate.includes("useAction(api.siteLock.verify)"), "verification is not a server action");
check("a failure shows a clear error", gate.includes('role="alert"') && gate.includes("readableSiteLockError("), "errors are not surfaced");
check("a submit is disabled while busy (and shows a spinner)", gate.includes("animate-spin") && gate.includes("disabled={!canSubmit}"), "there is no loading indicator");
check("the PIN rule is enforced before submitting", gate.includes("sitePinProblem(pin) === null"), "an unusable PIN could be submitted");
check("a Clear control exists", gate.includes("Clear") && gate.includes("onClick={clearFields}"), "there is no Clear control");
check("recovery is reachable from the lock screen", gate.includes("Forgot") && gate.includes("useAction(api.siteLock.requestRecoveryCode)"), "there is no recovery entry point");
check("recovery can set a new credential or turn the lock off", gate.includes("Turn this lock off instead") && gate.includes("recoverWithCode"), "recovery cannot fix a forgotten credential");
check("the account password is an alternative way back in", gate.includes("useAction(api.siteLock.disablePin)") && gate.includes("accountPassword"), "a forgotten credential without email would be a dead end");
check("the PIN input keeps leading zeros as the user types", gate.includes("sanitizeSitePinInput(e.target.value)"), "the PIN input can lose leading zeros");
check("the password input can be revealed", gate.includes("showPassword") && gate.includes("<Eye"), "there is no show/hide control");
check("the screen is responsive (mobile + desktop)", read("src", "index.css").includes("@media (max-width: 520px)"), "the lock screen has no small-screen rules");
check("nothing is written to browser storage", !/localStorage|sessionStorage|indexedDB/.test(gate + settings), "a credential could be cached in the browser");
check("no credential is hard-coded in the UI", !/\b(pin|password)\s*=\s*["'][^"']+["']/.test(gate.replace(/placeholder=[^\n]*/g, "")), "a credential literal is present in the UI");
check("the signed-in member can sign out from the lock screen", gate.includes("signOut()"), "a member on the wrong account is stuck");

// ---------------------------------------------------------------------------
// 3b. Protected routes cannot be reached around the gate
// ---------------------------------------------------------------------------
check("the dashboard route is wrapped by the gate", main.includes("import SiteLockGate from \"@/components/SiteLockGate\";") && count(main, "<SiteLockGate>") === 4, `SiteLockGate appears ${count(main, "<SiteLockGate>")} time(s)`);
{
  const onboardingRoute = main.slice(main.indexOf('path="/onboarding"'), main.indexOf('path="/dashboard"'));
  check("the onboarding route is gated too", onboardingRoute.includes("<RequireAuth") && onboardingRoute.includes("<SiteLockGate>"), "an authenticated route is reachable around the gate");
}
{
  const dashboardRoute = main.slice(main.indexOf('path="/dashboard"'), main.indexOf('path="/admin"'));
  check("the dashboard route is gated inside RequireAuth", dashboardRoute.includes("<RequireAuth") && dashboardRoute.includes("<SiteLockGate>") && dashboardRoute.includes("<Dashboard />"), "a deep link could bypass the gate");
  const adminRoute = main.slice(main.indexOf('path="/admin"'), main.indexOf('path="*"'));
  check("the Admin Panel route is gated too", adminRoute.includes("<RequireAuth") && adminRoute.includes("<SiteLockGate>"), "the admin route could bypass the gate");
}
check("the root gate also wraps the signed-in dashboard", main.includes("<SiteLockGate>\n            <Dashboard />"), "the root path renders the dashboard ungated");

// ---------------------------------------------------------------------------
// 3c. Settings → Account → Login & Security
// ---------------------------------------------------------------------------
check("the section is rendered in Settings → Account", panel.includes("import SiteLockSettings from \"./SiteLockSettings\";") && panel.includes("<SiteLockSettings />"), "the section is not mounted");
{
  const accountTab = panel.slice(panel.indexOf('{tab === "Account" && ('), panel.indexOf('{tab === "Privacy" && ('));
  check("it lives in the Account tab", accountTab.includes("<SiteLockSettings />"), "the section is in the wrong tab");
}
check("the section is titled Login & Security", settings.includes("Login &amp; Security"), "the section title is wrong");
check("PIN lock can be enabled and disabled independently", settings.includes("Enable PIN lock") && settings.includes("Turn PIN lock off"), "the PIN toggle is incomplete");
check("Password lock can be enabled and disabled independently", settings.includes("Enable Password lock") && settings.includes("Turn password lock off"), "the password toggle is incomplete");
check("creating a PIN requires confirmation", settings.includes("Confirm new PIN") && settings.includes("pin: pinNew") && settings.includes("confirmPin: pinConfirm"), "a PIN can be set without confirmation");
check("creating a password requires confirmation", settings.includes("Confirm new lock password") && settings.includes("confirmPassword: pwConfirm"), "a password can be set without confirmation");
check("changing a PIN asks for the current one", settings.includes("currentPin: pinCurrent"), "a PIN can be replaced without the old one");
check("changing the password asks for the current one", settings.includes("currentPassword: pwCurrent"), "the password can be replaced without the old one");
check("one lock being off never blocks the other", settings.includes("status.pinEnabled || status.passwordEnabled") && !/if \(!status\.pinEnabled\).*return/.test(settings), "the two locks are coupled");
check("the settings use the same PIN rules as the server", settings.includes("sitePinProblem(pinNew)") && settings.includes("sitePasswordProblem(pwNew)"), "the UI validates differently from the server");
check("the settings report real server errors", settings.includes("readableSiteLockError(") && settings.includes("toast.error"), "failures would be silent");
check("the member can lock Freecord immediately to test it", settings.includes("api.siteLock.lockNow"), "there is no way to test the lock");
check("recovery is explained where the locks are configured", settings.includes("Forgot PIN/password") && settings.includes("account password"), "recovery is undocumented");

// ---------------------------------------------------------------------------
// 4. Live: a signed-out visitor is never asked for a lock, and cannot verify one
// ---------------------------------------------------------------------------
const anonymous = new ConvexHttpClient(process.env.CONVEX_URL || "https://academic-porcupine-929.convex.cloud");
async function rejection(fn) {
  try {
    return { error: null, result: await fn() };
  } catch (error) {
    return { error: String(error?.data ?? error?.message ?? error) };
  }
}

const anonymousStatus = await rejection(() => anonymous.query(api.siteLock.status, {}));
check("the status query answers without a session", !anonymousStatus.error, anonymousStatus.error ?? "");
is("a signed-out visitor is never locked out", anonymousStatus.result?.enabled, false);
is("a signed-out visitor needs no verification", anonymousStatus.result?.requiresUnlock, false);
is("a signed-out visitor is never asked for a PIN", anonymousStatus.result?.pinEnabled, false);
is("a signed-out visitor is never asked for a password", anonymousStatus.result?.passwordEnabled, false);
is("the gate is a no-op for them", anonymousStatus.result?.unlocked, true);
is("no lock preference leaks to a stranger", anonymousStatus.result?.hasPin, false);

const anonymousVerify = await rejection(() => anonymous.action(api.siteLock.verify, { pin: "0042", password: "Abcd1234" }));
check("verification is refused without a session", Boolean(anonymousVerify.error) && /sign in/i.test(anonymousVerify.error), anonymousVerify.error ?? JSON.stringify(anonymousVerify.result));
const anonymousSetPin = await rejection(() => anonymous.action(api.siteLock.setPin, { pin: "0042", confirmPin: "0042" }));
check("a PIN cannot be created without a session", Boolean(anonymousSetPin.error) && /sign in/i.test(anonymousSetPin.error), anonymousSetPin.error ?? "");
const anonymousSetPassword = await rejection(() => anonymous.action(api.siteLock.setPassword, { password: "Abcd1234", confirmPassword: "Abcd1234" }));
check("a lock password cannot be created without a session", Boolean(anonymousSetPassword.error) && /sign in/i.test(anonymousSetPassword.error), anonymousSetPassword.error ?? "");
const anonymousDisable = await rejection(() => anonymous.action(api.siteLock.disablePin, { pin: "0042" }));
check("a lock cannot be turned off without a session", Boolean(anonymousDisable.error) && /sign in/i.test(anonymousDisable.error), anonymousDisable.error ?? "");
const anonymousRecovery = await rejection(() => anonymous.action(api.siteLock.requestRecoveryCode, {}));
check("no recovery code can be requested without a session", Boolean(anonymousRecovery.error) && /sign in/i.test(anonymousRecovery.error), anonymousRecovery.error ?? "");
const anonymousRecover = await rejection(() => anonymous.action(api.siteLock.recoverWithCode, { code: "000000", target: "pin", disable: true }));
check("no lock can be recovered without a session", Boolean(anonymousRecover.error) && /sign in/i.test(anonymousRecover.error), anonymousRecover.error ?? "");
const anonymousLockNow = await rejection(() => anonymous.mutation(api.siteLock.lockNow, {}));
check("locking is refused without a session", Boolean(anonymousLockNow.error), anonymousLockNow.error ?? "");
check("a signed-out caller can still reach the public app", anonymousStatus.result?.signedIn === false, JSON.stringify(anonymousStatus.result));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
