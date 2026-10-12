/**
 * Optional Admin PIN — the rules (pure, no Convex, no DOM).
 *
 * WHAT THIS IS
 * ------------
 * An ADMINISTRATOR may protect the Admin Panel with a short numeric PIN. It is
 * completely optional and per account:
 *
 *   - nobody is ever asked to create one (no forced setup, and no repeated
 *     prompts after choosing "Skip for now"),
 *   - with protection off, the panel opens on the existing account
 *     authentication + server-side administrator-role checks, exactly as before,
 *   - with protection on, the PIN is required before the protected admin pages
 *     open, until the administrator disables it or locks the panel.
 *
 * WHAT IT IS NOT
 * --------------
 * The PIN is NOT an authorization mechanism. It never grants admin access and it
 * never replaces the server-side role checks (`requirePanelAccess`): a signed-in
 * non-admin is refused with or without it, and disabling the PIN cannot weaken
 * those checks because they do not consult it. It is a local lock on top of a
 * session that was already authorized.
 *
 * PIN FORMAT
 * ----------
 * 1 to 10 NUMERIC digits, and leading zeros are significant: "007" is a valid
 * PIN and is different from "7". The PIN is therefore always handled as a
 * STRING — never parsed as a number, which would silently drop leading zeros —
 * and is only ever stored as a one-way Scrypt hash.
 */

/** Shortest accepted PIN (a single digit is allowed — it is the admin's choice). */
export const ADMIN_PIN_MIN_DIGITS = 1;
/** Longest accepted PIN. */
export const ADMIN_PIN_MAX_DIGITS = 10;
/**
 * How long one successful PIN entry keeps the panel open, per auth session.
 * After this the gate asks again — unless protection has been turned off.
 */
export const ADMIN_PIN_UNLOCK_MINUTES = 30;

const DIGITS_ONLY = new RegExp(`^\\d{${ADMIN_PIN_MIN_DIGITS},${ADMIN_PIN_MAX_DIGITS}}$`);

/**
 * Wrong-PIN delays.
 *
 * A few genuine typos cost nothing, but from the third consecutive failure the
 * wait DOUBLES each time (5s, 10s, 20s, 40s… ) up to a 15-minute ceiling, so
 * guessing gets progressively more expensive instead of being a constant-speed
 * grind. The count only resets when the correct PIN is entered, or after a long
 * quiet period (`ADMIN_PIN_LOCKOUT_DECAY_MS`), so an abandoned guessing run does
 * not penalise an honest administrator hours later.
 */
export const ADMIN_PIN_LOCKOUT_AFTER = 3;
export const ADMIN_PIN_LOCKOUT_BASE_MS = 5_000;
export const ADMIN_PIN_LOCKOUT_MAX_MS = 15 * 60 * 1000;
/** Quiet period after which the consecutive-failure count starts over. */
export const ADMIN_PIN_LOCKOUT_DECAY_MS = 60 * 60 * 1000;

/**
 * How long to wait after `failedAttempts` CONSECUTIVE failures (0 = no wait).
 * Monotonically non-decreasing, capped, and never longer than the ceiling.
 */
export function adminPinLockoutFor(failedAttempts: number): number {
  if (!Number.isFinite(failedAttempts) || failedAttempts < ADMIN_PIN_LOCKOUT_AFTER) return 0;
  const step = Math.floor(failedAttempts) - ADMIN_PIN_LOCKOUT_AFTER; // 0 → the first delay
  // Doubling on integers; Math.min keeps the ceiling exact even when 2 ** step
  // would overflow into Infinity for a huge attempt count.
  return Math.min(ADMIN_PIN_LOCKOUT_BASE_MS * 2 ** step, ADMIN_PIN_LOCKOUT_MAX_MS);
}

/** True when `pin` is a string of 1–10 digits (leading zeros kept). */
export function isAdminPinValid(pin: unknown): pin is string {
  return typeof pin === "string" && DIGITS_ONLY.test(pin);
}

/**
 * The reason a PIN is not usable, or `null` when it is. Returned as a message so
 * the UI and the server can refuse with identical wording.
 */
export function adminPinProblem(pin: unknown): string | null {
  if (typeof pin !== "string" || pin.length === 0) return "Enter your PIN.";
  if (!/^\d+$/.test(pin)) return "An Admin PIN can only contain digits 0–9.";
  if (pin.length > ADMIN_PIN_MAX_DIGITS) {
    return `An Admin PIN can be at most ${ADMIN_PIN_MAX_DIGITS} digits.`;
  }
  if (pin.length < ADMIN_PIN_MIN_DIGITS) {
    return `An Admin PIN must be at least ${ADMIN_PIN_MIN_DIGITS} digit.`;
  }
  return null;
}

/** True when the two entries of a new PIN match. */
export function adminPinsMatch(pin: string, confirmPin: string): boolean {
  return pin === confirmPin;
}

/**
 * What a numeric input should keep from raw keyboard/paste input: digits only,
 * capped at the maximum length, with leading zeros preserved. Used by the input
 * field so a 1–10 digit PIN with leading zeros survives untouched (e.g.
 * "00 12" → "0012"), and so a stray letter can never become part of a PIN.
 */
export function sanitizeAdminPinInput(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\D+/g, "").slice(0, ADMIN_PIN_MAX_DIGITS);
}

/** Seconds until the temporary lockout ends (0 when not locked out). */
export function adminPinLockoutSeconds(lockedUntil: number | null | undefined, now: number): number {
  if (typeof lockedUntil !== "number" || !Number.isFinite(lockedUntil)) return 0;
  return Math.max(0, Math.ceil((lockedUntil - now) / 1000));
}
