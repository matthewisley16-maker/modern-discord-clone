/**
 * Optional site locks (PIN and/or password) — the rules (pure, no Convex, no DOM).
 *
 * WHAT THIS IS
 * ------------
 * A signed-in member MAY put a short numeric PIN and/or an extra password in
 * front of Freecord itself. Both are COMPLETELY OPTIONAL and independent:
 *
 *   - nobody is ever asked to create either one,
 *   - with both off, Freecord opens exactly as it did before this feature
 *     existed (the normal account sign-in, nothing else),
 *   - PIN only, password only, both, or neither are all valid configurations,
 *   - turning both off restores the normal flow.
 *
 * WHAT IT IS NOT
 * --------------
 * Neither credential replaces account authentication. Signing in still goes
 * through the existing auth provider; these locks are verified on top of an
 * already signed-in session, and they grant no authority over anyone or
 * anything. Server-side verification, rate limits and a progressive lockout live
 * in `src/convex/siteLock.ts`; this module only holds the shared, testable rules
 * so the UI and the server refuse the same inputs with the same wording.
 *
 * PIN FORMAT
 * ----------
 * 1 to 10 NUMERIC digits, and leading zeros are SIGNIFICANT: "0042" is a valid
 * PIN and is a different credential from "42". The PIN is therefore always
 * handled, transported and hashed as a STRING — never parsed as a number, which
 * would silently drop the leading zeros.
 *
 * PASSWORD FORMAT
 * ---------------
 * At least 8 characters, with at least one letter and one number (the same rule
 * Freecord already applies to account passwords), and up to 200. Everything else
 * — symbols, spaces, upper case, unicode — is explicitly ALLOWED and stored
 * exactly as typed; nothing here strips or normalises a password.
 */

/** Shortest accepted PIN (one digit is allowed — it is the member's choice). */
export const SITE_PIN_MIN_DIGITS = 1;
/** Longest accepted PIN. */
export const SITE_PIN_MAX_DIGITS = 10;
/** Shortest accepted extra password. */
export const SITE_PASSWORD_MIN_LENGTH = 8;
/** Longest accepted extra password. */
export const SITE_PASSWORD_MAX_LENGTH = 200;
/** How many digits a recovery code sent by email has. */
export const SITE_RECOVERY_CODE_DIGITS = 6;
/** How long an emailed recovery code stays valid. */
export const SITE_RECOVERY_CODE_TTL_MS = 10 * 60 * 1000;
/** How many times a recovery code may be tried before it is dropped. */
export const SITE_RECOVERY_MAX_ATTEMPTS = 5;

/**
 * Wrong-credential delays — the SAME ladder the Admin PIN uses: a couple of
 * typos cost nothing, then from the third consecutive failure the wait doubles
 * each time (5s, 10s, 20s … capped at 15 minutes), so guessing slows down
 * instead of running at a constant rate. The count resets on a correct entry and
 * also decays after an hour of quiet.
 */
export const SITE_LOCKOUT_AFTER = 3;
export const SITE_LOCKOUT_BASE_MS = 5_000;
export const SITE_LOCKOUT_MAX_MS = 15 * 60 * 1000;
export const SITE_LOCKOUT_DECAY_MS = 60 * 60 * 1000;

/** The two independent locks, as a union used across the API and the UI. */
export type SiteLockFactor = "pin" | "password";

/** Which locks are switched on. */
export type SiteLockFlags = { pinEnabled?: boolean | null; passwordEnabled?: boolean | null };

/** True when at least one optional lock is on (otherwise: normal access). */
export function siteLockEnabled(flags: SiteLockFlags): boolean {
  return Boolean(flags.pinEnabled) || Boolean(flags.passwordEnabled);
}

/** The factors that must be verified to open the site, in a stable order. */
export function requiredSiteFactors(flags: SiteLockFlags): SiteLockFactor[] {
  const factors: SiteLockFactor[] = [];
  if (flags.pinEnabled) factors.push("pin");
  if (flags.passwordEnabled) factors.push("password");
  return factors;
}

/** The factors that are enabled but not verified yet for this session. */
export function pendingSiteFactors(flags: SiteLockFlags, verified: { pin?: boolean; password?: boolean }): SiteLockFactor[] {
  return requiredSiteFactors(flags).filter((factor) => (factor === "pin" ? !verified.pin : !verified.password));
}

/**
 * The reason a PIN is not usable, or `null` when it is. Returned as a message so
 * the UI and the server refuse with identical wording.
 */
export function sitePinProblem(pin: unknown): string | null {
  if (typeof pin !== "string" || pin.length === 0) return "Enter your PIN.";
  if (!/^\d+$/.test(pin)) return "A PIN can only contain digits 0–9.";
  if (pin.length > SITE_PIN_MAX_DIGITS) return `A PIN can be at most ${SITE_PIN_MAX_DIGITS} digits.`;
  if (pin.length < SITE_PIN_MIN_DIGITS) return `A PIN must be at least ${SITE_PIN_MIN_DIGITS} digit.`;
  return null;
}

/** True when the two entries of a new PIN match. */
export function sitePinsMatch(pin: string, confirmPin: string): boolean {
  return pin === confirmPin;
}

/**
 * What a PIN input should keep from raw keyboard/paste input: digits only, at
 * most the maximum length, with LEADING ZEROS PRESERVED. Used by the input field,
 * so "00 12" becomes "0012" and a stray letter can never become part of a PIN.
 */
export function sanitizeSitePinInput(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\D+/g, "").slice(0, SITE_PIN_MAX_DIGITS);
}

/**
 * The reason an extra password is not usable, or `null` when it is.
 *
 * Only the length and the letter+number requirement are enforced; symbols,
 * spaces and unicode are welcome and never stripped.
 */
export function sitePasswordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length === 0) return "Enter your password.";
  if (password.length < SITE_PASSWORD_MIN_LENGTH) {
    return `Your password must be at least ${SITE_PASSWORD_MIN_LENGTH} characters long.`;
  }
  if (password.length > SITE_PASSWORD_MAX_LENGTH) return "That password is too long.";
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return "Your password must include at least one letter and one number.";
  }
  return null;
}

/** True when the two entries of a new password match. */
export function sitePasswordsMatch(password: string, confirmPassword: string): boolean {
  return password === confirmPassword;
}

/**
 * How long to wait after `failedAttempts` CONSECUTIVE failures (0 = no wait).
 * Monotonically non-decreasing, capped at the ceiling.
 */
export function siteLockoutFor(failedAttempts: number): number {
  if (!Number.isFinite(failedAttempts) || failedAttempts < SITE_LOCKOUT_AFTER) return 0;
  const step = Math.floor(failedAttempts) - SITE_LOCKOUT_AFTER;
  return Math.min(SITE_LOCKOUT_BASE_MS * 2 ** step, SITE_LOCKOUT_MAX_MS);
}

/** Seconds until the temporary lockout ends (0 when not locked out). */
export function siteLockoutSeconds(lockedUntil: number | null | undefined, now: number): number {
  if (typeof lockedUntil !== "number" || !Number.isFinite(lockedUntil)) return 0;
  return Math.max(0, Math.ceil((lockedUntil - now) / 1000));
}

/** The message shown for a wrong credential, with the wait when one now applies. */
export function siteLockErrorMessage(delayMs: number): string {
  if (delayMs <= 0) return "That PIN or password is not correct.";
  return `That PIN or password is not correct. Please wait ${Math.ceil(delayMs / 1000)}s before trying again.`;
}

/** The reason an emailed recovery code is not usable, or `null` when it is. */
export function siteRecoveryCodeProblem(code: unknown): string | null {
  if (typeof code !== "string" || code.length === 0) return "Enter the code we emailed you.";
  if (!/^\d+$/.test(code)) return "That code should be digits only.";
  if (code.length !== SITE_RECOVERY_CODE_DIGITS) return `A recovery code is ${SITE_RECOVERY_CODE_DIGITS} digits.`;
  return null;
}

/** Digits-only, capped, for the recovery-code input (leading zeros kept). */
export function sanitizeRecoveryCodeInput(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\D+/g, "").slice(0, SITE_RECOVERY_CODE_DIGITS);
}

/**
 * A readable message for a failed lock action.
 *
 * Convex delivers user-safe messages (ConvexError) on `err.data`; a deployed
 * deployment redacts plain Errors to "Server Error", so a generic fallback is
 * used when there is nothing useful to show. Only ever displays our own wording —
 * never a credential — and always collapses to one short line.
 */
export function readableSiteLockError(error: unknown, fallback: string): string {
  const data = (error as { data?: unknown } | null)?.data;
  const fromData =
    typeof data === "string"
      ? data
      : data && typeof data === "object" && typeof (data as { message?: unknown }).message === "string"
        ? String((data as { message: string }).message)
        : null;
  const raw = fromData ?? (error instanceof Error ? error.message : typeof error === "string" ? error : "");
  const message = raw.split("\n")[0].replace(/^.*Error:\s*/, "").trim().slice(0, 200);
  if (!message || /^server error$/i.test(message)) return fallback;
  return message;
}

/**
 * A recovery code, as a string of exactly SITE_RECOVERY_CODE_DIGITS digits.
 * `random` is injectable so tests are deterministic; the default uses the
 * platform CSPRNG. Leading zeros are kept (it is never a number).
 */
export function generateRecoveryCode(random: () => number = Math.random): string {
  let code = "";
  for (let i = 0; i < SITE_RECOVERY_CODE_DIGITS; i += 1) {
    code += String(Math.floor(random() * 10) % 10);
  }
  return code;
}

/**
 * A recovery destination shown back to the member, with the local part masked:
 * "ada@example.com" → "a\u2022\u2022@example.com". The full address is never echoed
 * by the server; this only helps the member recognise which inbox to check.
 */
export function maskRecoveryEmail(email: unknown): string {
  if (typeof email !== "string") return "";
  const at = email.lastIndexOf("@");
  if (at <= 0) return "";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const head = local.slice(0, 1);
  const tail = local.length > 2 ? local.slice(-1) : "";
  return `${head}${tail ? "\u2022\u2022" : "\u2022"}${tail}${domain}`;
}
