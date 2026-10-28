import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { Scrypt } from "lucia";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { audit, currentUserId, displayNameOf } from "./lib";
import { enforceRateLimit } from "./authHelpers";
import { sendCodeEmail } from "./mailer";
import {
  generateRecoveryCode,
  grantCoversSession,
  maskRecoveryEmail,
  pendingSiteFactors,
  staleSiteLockGrants,
  siteAutoLockExpiredAt,
  siteAutoLockExpiresAt,
  siteAutoLockLabel,
  siteAutoLockMinutes,
  siteAutoLockMode,
  siteAutoLockProblem,
  SITE_AUTO_LOCK_DEFAULT_MINUTES,
  SITE_AUTO_LOCK_NEVER,
  SITE_AUTO_LOCK_STALE_PROOF_MS,
  SITE_AUTO_LOCK_TOUCH_MS,
  SITE_LOCKOUT_DECAY_MS,
  SITE_PASSWORD_MIN_LENGTH,
  SITE_PIN_MAX_DIGITS,
  SITE_RECOVERY_CODE_TTL_MS,
  SITE_RECOVERY_MAX_ATTEMPTS,
  siteLockErrorMessage,
  siteLockEnabled,
  siteLockoutFor,
  siteLockoutSeconds,
  sitePasswordProblem,
  sitePasswordsMatch,
  sitePinProblem,
  sitePinsMatch,
  siteRecoveryCodeProblem,
  type SiteAutoLockMode,
  type SiteLockFactor,
} from "../lib/site-lock";

/**
 * ---------------------------------------------------------------------------
 * OPTIONAL site locks — PIN and/or password in front of Freecord (`siteLocks`)
 * ---------------------------------------------------------------------------
 * A member MAY lock Freecord itself with a short numeric PIN and/or an extra
 * password. Both are opt-in, independent and entirely optional:
 *
 *   - NO ROW, or both flags false, means "no lock". That is the state of every
 *     account by default: nobody is ever asked to set either credential, and the
 *     site opens on the EXISTING account authentication alone — exactly as it did
 *     before this feature existed.
 *   - PIN only, password only, both, or neither are all supported. Enabling one
 *     never touches the other, and disabling one never affects the other.
 *   - The locks are verified ON TOP of an already signed-in session. They are not
 *     a second login, they grant no authority, and they can never expose another
 *     member's data: every read/write in the app still goes through its own
 *     server-side authorization.
 *
 * Verification is remembered per AUTH SESSION, and for that session it lasts
 * only as long as the device is being used: a credential is asked for once when a
 * session starts and is not asked again while the member is active — so
 * refreshing, navigating between routes or reconnecting a socket never re-asks —
 * but a device left alone asks again after the member's own auto-lock window
 * (`autoLockMinutes`; 0 keeps the old "until I sign out" behaviour), and signing
 * out or expiring that session locks it again immediately. A page refresh cannot
 * bypass anything either, since the gate's decision comes from this table and a
 * proof whose window has closed stops counting here, on the server.
 *
 * Each session keeps its OWN row in `siteLockGrants`, so devices are completely
 * independent: signing in — and unlocking — on a second device never re-locks a
 * device that is already open, and "Lock now" only locks the device it was
 * pressed on. (The two legacy `verified*SessionId` fields can only ever name one
 * session, so they are read as a fallback for a session that was verified before
 * that table existed, and never written again.)
 *
 * Security: credentials are only ever stored as one-way Scrypt hashes with a
 * random per-credential salt, are never returned to a client, never logged and
 * never echoed in an error. Crypto runs in actions (never in a query), every
 * attempt is rate limited server-side, and wrong entries escalate through the
 * same progressive delay ladder the Admin PIN uses. Changing or turning off a
 * credential requires proof of identity (the current credential, the account
 * password, or a single-use emailed code) — and, for accounts that have no
 * password credential at all (email-code sign-in), the signed-in session itself,
 * which is the account's existing authentication. Every change is audited.
 *
 * Changing one credential never signs anybody out: nothing here touches auth
 * sessions, so unrelated account settings keep working normally, as before.
 */

type Ctx = QueryCtx | MutationCtx;

type LockRecord = {
  pinEnabled: boolean;
  passwordEnabled: boolean;
  enabled: boolean;
  hasPin: boolean;
  hasPassword: boolean;
  /** Internal only — never returned by a public function. */
  pinHash: string | null;
  passwordHash: string | null;
  pinVerified: boolean;
  passwordVerified: boolean;
  pending: SiteLockFactor[];
  failedAttempts: number;
  lockedUntil: number | null;
  recoveryCodeHash: string | null;
  recoveryCodeExpiresAt: number | null;
  recoveryAttempts: number;
  accountHasPassword: boolean;
  email: string | null;
  emailVerified: boolean;
  name: string;
};

async function lockRow(ctx: Ctx, userId: Id<"users">): Promise<Doc<"siteLocks"> | null> {
  return await ctx.db
    .query("siteLocks")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

/** Every per-session proof this account holds (one or two rows per device). */
async function grantsOf(ctx: Ctx, userId: Id<"users">) {
  return await ctx.db
    .query("siteLockGrants")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
}

/**
 * Is `factor` already proved for THIS auth session?
 *
 * `remembered` is the legacy single-session field: honouring it keeps a session
 * that was verified before `siteLockGrants` existed from ever being asked again
 * mid-session, without ever scoping verification to one device again.
 */
function sessionProved(
  sessionId: string | null,
  remembered: string | undefined,
  grants: readonly { sessionId: string; factor: SiteLockFactor }[],
  factor: SiteLockFactor,
): boolean {
  if (sessionId === null) return false;
  if (remembered === sessionId) return true;
  return grantCoversSession(grants, sessionId, factor);
}

/**
 * The proofs that still count for THIS caller, under the member's chosen mode:
 *
 *   - "visit" (the default): only a proof claimed by the SAME page load — a
 *     refresh has a new id, so the credential is asked for again,
 *   - "idle": only a proof still inside its inactivity window,
 *   - "never": any proof of this session, until the session itself ends.
 *
 * The gate's status query and the actions' lock record both read this same
 * filtered list, so the auto-lock is a server decision and not a countdown kept
 * by the browser.
 *
 * A caller that cannot say which page load it is (no page id at all — a stale
 * cached bundle, a script) falls back to the session-level proof rather than being
 * locked out of its own account forever.
 */
function liveProofs(
  grants: readonly Doc<"siteLockGrants">[],
  mode: SiteAutoLockMode,
  autoLockMinutes: number,
  pageId: string | null,
  now: number,
): Doc<"siteLockGrants">[] {
  return grants.filter((grant) => {
    if (mode === "never") return true;
    if (mode === "visit") return pageId === null || grant.pageId === pageId;
    return !siteAutoLockExpiredAt(grant.verifiedAt, autoLockMinutes, now);
  });
}

/**
 * The legacy single-session marker, honoured only when the proof does not have to
 * be page-scoped: in "every page load" mode it would otherwise keep a session
 * unlocked across reloads, which is exactly what that mode forbids.
 */
function legacyProof(mode: SiteAutoLockMode, remembered: string | undefined): string | undefined {
  return mode === "visit" ? undefined : remembered;
}

/**
 * When THIS session's proofs stop counting — the earliest deadline among the
 * factors it has proved (with both locks on, the first one to lapse asks for
 * both again), or `null` when nothing is proved or no countdown is configured.
 */
function relocksAtOf(
  grants: readonly { sessionId: string; factor: SiteLockFactor; verifiedAt: number }[],
  sessionId: string | null,
  flags: { pin: boolean; password: boolean },
  autoLockMinutes: number,
): number | null {
  if (sessionId === null || siteAutoLockMode(autoLockMinutes) !== "idle") return null;
  const mine = grants.filter(
    (grant) => grant.sessionId === sessionId && (grant.factor === "pin" ? flags.pin : flags.password),
  );
  if (mine.length === 0) return null;
  return Math.min(
    ...mine.map(
      (grant) => siteAutoLockExpiresAt(grant.verifiedAt, autoLockMinutes) ?? Number.POSITIVE_INFINITY,
    ),
  );
}

// ---------------------------------------------------------------------------
// Internal reads
// ---------------------------------------------------------------------------

/**
 * Everything the gate, the settings screen and the actions need about the caller's
 * locks. `pinHash`/`passwordHash` are returned ON PURPOSE (internal only, called
 * exclusively from actions that verify them server-side); no public function ever
 * exposes them.
 */
export const lockRecord = internalQuery({
  /** The page load asking, so an "every page load" proof is not reused. */
  args: { pageId: v.optional(v.string()) },
  handler: async (ctx, { pageId }): Promise<LockRecord | null> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const row = await lockRow(ctx, userId);
    const sessionId = await getAuthSessionId(ctx);
    const user = await ctx.db.get(userId);
    const account = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", userId).eq("provider", "password"))
      .unique();

    const autoLockMinutes = siteAutoLockMinutes(row?.autoLockMinutes);
    const now = Date.now();
    // Proofs past their idle window are ignored here too, so an expired session
    // is asked for the credential again on the next action.
    const mode = siteAutoLockMode(autoLockMinutes);
    const grants = liveProofs(await grantsOf(ctx, userId), mode, autoLockMinutes, pageId ?? null, now);
    const pinEnabled = Boolean(row?.pinEnabled && row.pinHash);
    const passwordEnabled = Boolean(row?.passwordEnabled && row.passwordHash);
    const pinVerified =
      pinEnabled && sessionProved(sessionId, legacyProof(mode, row?.verifiedPinSessionId), grants, "pin");
    const passwordVerified =
      passwordEnabled &&
      sessionProved(sessionId, legacyProof(mode, row?.verifiedPasswordSessionId), grants, "password");

    return {
      pinEnabled,
      passwordEnabled,
      enabled: siteLockEnabled({ pinEnabled, passwordEnabled }),
      hasPin: Boolean(row?.pinHash),
      hasPassword: Boolean(row?.passwordHash),
      pinHash: row?.pinHash ?? null,
      passwordHash: row?.passwordHash ?? null,
      pinVerified,
      passwordVerified,
      pending: pendingSiteFactors({ pinEnabled, passwordEnabled }, { pin: pinVerified, password: passwordVerified }),
      failedAttempts: row?.failedAttempts ?? 0,
      lockedUntil: row?.lockedUntil ?? null,
      recoveryCodeHash: row?.recoveryCodeHash ?? null,
      recoveryCodeExpiresAt: row?.recoveryCodeExpiresAt ?? null,
      recoveryAttempts: row?.recoveryAttempts ?? 0,
      accountHasPassword: Boolean(account?.secret),
      email: user?.email ?? null,
      emailVerified: Boolean(user?.emailVerificationTime),
      name: await displayNameOf(ctx, userId),
    };
  },
});

/**
 * The account's own password credential (the EXISTING Freecord sign-in secret),
 * used as one of the identity proofs for changing or turning off a lock. Internal
 * only: the hash never leaves the server.
 */
export const accountCredential = internalQuery({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { hasPassword: false, secret: null };
    const account = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", userId).eq("provider", "password"))
      .unique();
    const secret = account?.secret ?? null;
    return { hasPassword: Boolean(secret), secret };
  },
});

/** The account's recovery email (only ever used to send a code to its owner). */
export const accountEmail = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    return { email: user?.email ?? null, emailVerified: Boolean(user?.emailVerificationTime) };
  },
});

// ---------------------------------------------------------------------------
// Internal writes
// ---------------------------------------------------------------------------

/** Backend-authoritative rate limit (abuse protection cannot be bypassed). */
export const enforceLimit = internalMutation({
  args: { scope: v.string(), limit: v.number(), windowMs: v.number() },
  handler: async (ctx, { scope, limit, windowMs }) => {
    const userId = await currentUserId(ctx);
    await enforceRateLimit(ctx, `sitelock:${scope}:${userId}`, limit, windowMs);
  },
});

/**
 * Count a credential attempt and apply the PROGRESSIVE delay after repeated
 * failures (5s → 10s → 20s … capped at 15 minutes), so guessing slows down
 * instead of running at a constant rate. The streak resets on a correct entry and
 * also decays after an hour of quiet, so an honest typo is never punished later.
 * Returns the delay that now applies so the caller can say exactly how long to
 * wait. The credential itself is never recorded — only the count and the time.
 */
export const registerAttempt = internalMutation({
  args: { success: v.boolean() },
  handler: async (ctx, { success }): Promise<{ delayMs: number; failedAttempts: number }> => {
    const userId = await currentUserId(ctx);
    await enforceRateLimit(ctx, `sitelock:attempt:${userId}`, 30, 60_000);
    const row = await lockRow(ctx, userId);
    if (!row) return { delayMs: 0, failedAttempts: 0 };
    const now = Date.now();
    if (success) {
      await ctx.db.patch(row._id, {
        failedAttempts: 0,
        lockedUntil: undefined,
        lastFailedAt: undefined,
        updatedAt: now,
      });
      return { delayMs: 0, failedAttempts: 0 };
    }
    const stale = row.lastFailedAt !== undefined && now - row.lastFailedAt > SITE_LOCKOUT_DECAY_MS;
    const failed = (stale ? 0 : row.failedAttempts ?? 0) + 1;
    const delayMs = siteLockoutFor(failed);
    await ctx.db.patch(row._id, {
      failedAttempts: failed,
      lockedUntil: delayMs > 0 ? now + delayMs : undefined,
      lastFailedAt: now,
      updatedAt: now,
    });
    return { delayMs, failedAttempts: failed };
  },
});

/**
 * Remember one factor as proved for ONE auth session and (in the default mode)
 * ONE page load. Idempotent for that pair: entering the PIN twice on the same page
 * refreshes its own row instead of adding another.
 *
 * One row per PAGE LOAD, not per session: two tabs share an auth session, so a
 * single row would let the second tab's unlock evict the first tab's proof and
 * bounce it back to the lock screen. Each page keeps its own row instead, and old
 * rows are dropped by age in `pruneDeadGrants`.
 */
async function grantFactor(
  ctx: MutationCtx,
  userId: Id<"users">,
  sessionId: string,
  factor: SiteLockFactor,
  now: number,
  pageId: string | undefined,
) {
  const rows = await ctx.db
    .query("siteLockGrants")
    .withIndex("by_user_session", (q) =>
      q.eq("userId", userId).eq("sessionId", sessionId).eq("factor", factor),
    )
    .collect();
  const existing = rows.find((row) => row.pageId === pageId);
  if (existing) await ctx.db.patch(existing._id, { verifiedAt: now });
  else await ctx.db.insert("siteLockGrants", { userId, sessionId, factor, verifiedAt: now, pageId });
}

/**
 * Forget every proof of ONE factor, for every device.
 *
 * Used when a credential is created, replaced or turned off: the old proof no
 * longer means anything, so no session may keep relying on it. (The session that
 * just performed the change re-grants itself immediately afterwards through
 * `markVerified`.)
 */
async function revokeFactorGrants(ctx: MutationCtx, userId: Id<"users">, factor: SiteLockFactor) {
  for (const grant of await grantsOf(ctx, userId)) {
    if (grant.factor === factor) await ctx.db.delete(grant._id);
  }
}

/**
 * Drop proofs whose auth session is gone or expired: they can never be used
 * again, so they must not accumulate. Bounded by the account's own devices.
 */
async function pruneDeadGrants(
  ctx: MutationCtx,
  userId: Id<"users">,
  now: number,
  mode: SiteAutoLockMode,
) {
  const grants = await grantsOf(ctx, userId);
  if (grants.length === 0) return;
  const sessions = await ctx.db
    .query("authSessions")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .collect();
  const live = sessions.filter((s) => s.expirationTime > now).map((s) => s._id as string);
  const deadSessions = new Set(staleSiteLockGrants(grants, live).map((grant) => grant._id));
  // In "never" mode a proof legitimately lasts the whole session, so age alone is
  // never a reason to drop it; every other mode re-asks long before a day passes.
  const maxAge = mode === "never" ? Number.POSITIVE_INFINITY : SITE_AUTO_LOCK_STALE_PROOF_MS;
  for (const grant of grants) {
    // The proof of a session that is gone, or one nobody could still be using.
    if (deadSessions.has(grant._id) || now - grant.verifiedAt > maxAge) {
      await ctx.db.delete(grant._id);
    }
  }
}

/**
 * Mark the CURRENT auth session as verified for the given factors. Called only
 * after a credential was checked (or just created by its owner), so it can never
 * be granted by a client on its own.
 *
 * Only THIS session is recorded, which is exactly what keeps a second device from
 * disturbing an already-unlocked one.
 */
export const markVerified = internalMutation({
  args: { pin: v.boolean(), password: v.boolean(), pageId: v.optional(v.string()) },
  handler: async (ctx, { pin, password, pageId }) => {
    const userId = await currentUserId(ctx);
    const row = await lockRow(ctx, userId);
    if (!row) return;
    const sessionId = await getAuthSessionId(ctx);
    const now = Date.now();
    await ctx.db.patch(row._id, {
      failedAttempts: 0,
      lockedUntil: undefined,
      lastFailedAt: undefined,
      updatedAt: now,
    });
    if (!sessionId) return;
    const key = sessionId as string;
    if (pin) await grantFactor(ctx, userId, key, "pin", now, pageId);
    if (password) await grantFactor(ctx, userId, key, "password", now, pageId);
    await pruneDeadGrants(ctx, userId, now, siteAutoLockMode(row.autoLockMinutes));
  },
});

/** Store (or replace) the hashed PIN, turning the PIN lock on. */
export const storePin = internalMutation({
  args: { pinHash: v.string(), changing: v.boolean() },
  handler: async (ctx, { pinHash, changing }) => {
    const userId = await currentUserId(ctx);
    const name = await displayNameOf(ctx, userId);
    const row = await lockRow(ctx, userId);
    const patch = {
      pinHash,
      pinEnabled: true,
      failedAttempts: 0,
      lockedUntil: undefined,
      updatedAt: Date.now(),
    };
    if (row) await ctx.db.patch(row._id, patch);
    else await ctx.db.insert("siteLocks", { userId, passwordEnabled: false, ...patch });
    // A new PIN invalidates every device's proof of the OLD one.
    await revokeFactorGrants(ctx, userId, "pin");
    await audit(
      ctx,
      changing ? "site_lock.pin.change" : "site_lock.pin.enable",
      userId,
      `${name} ${changing ? "changed" : "enabled"} optional PIN lock for Freecord`,
      "user",
      userId,
    );
  },
});

/** Turn the PIN lock off and forget the PIN (never touches auth or other locks). */
export const clearPin = internalMutation({
  args: { reason: v.string() },
  handler: async (ctx, { reason }) => {
    const userId = await currentUserId(ctx);
    const name = await displayNameOf(ctx, userId);
    const row = await lockRow(ctx, userId);
    if (row) {
      await ctx.db.patch(row._id, {
        pinEnabled: false,
        pinHash: undefined,
        verifiedPinSessionId: undefined,
        failedAttempts: 0,
        lockedUntil: undefined,
        updatedAt: Date.now(),
      });
    }
    // No PIN means no proof of one is worth keeping, on any device.
    await revokeFactorGrants(ctx, userId, "pin");
    await audit(
      ctx,
      "site_lock.pin.disable",
      userId,
      `${name} turned OFF optional PIN lock (${reason}) — Freecord opens with the account's normal sign-in alone`,
      "user",
      userId,
    );
  },
});

/** Store (or replace) the hashed extra password, turning the password lock on. */
export const storePassword = internalMutation({
  args: { passwordHash: v.string(), changing: v.boolean() },
  handler: async (ctx, { passwordHash, changing }) => {
    const userId = await currentUserId(ctx);
    const name = await displayNameOf(ctx, userId);
    const row = await lockRow(ctx, userId);
    const patch = {
      passwordHash,
      passwordEnabled: true,
      failedAttempts: 0,
      lockedUntil: undefined,
      updatedAt: Date.now(),
    };
    if (row) await ctx.db.patch(row._id, patch);
    else await ctx.db.insert("siteLocks", { userId, pinEnabled: false, ...patch });
    // A new password invalidates every device's proof of the OLD one.
    await revokeFactorGrants(ctx, userId, "password");
    await audit(
      ctx,
      changing ? "site_lock.password.change" : "site_lock.password.enable",
      userId,
      `${name} ${changing ? "changed" : "enabled"} optional password lock for Freecord`,
      "user",
      userId,
    );
  },
});

/** Turn the password lock off and forget the password (auth untouched). */
export const clearPassword = internalMutation({
  args: { reason: v.string() },
  handler: async (ctx, { reason }) => {
    const userId = await currentUserId(ctx);
    const name = await displayNameOf(ctx, userId);
    const row = await lockRow(ctx, userId);
    if (row) {
      await ctx.db.patch(row._id, {
        passwordEnabled: false,
        passwordHash: undefined,
        verifiedPasswordSessionId: undefined,
        failedAttempts: 0,
        lockedUntil: undefined,
        updatedAt: Date.now(),
      });
    }
    // The lock is off: its proofs are meaningless now.
    await revokeFactorGrants(ctx, userId, "password");
    await audit(
      ctx,
      "site_lock.password.disable",
      userId,
      `${name} turned OFF optional password lock (${reason}) — Freecord opens with the account's normal sign-in alone`,
      "user",
      userId,
    );
  },
});

/** Store a fresh single-use recovery code (hashed) for the caller. */
export const storeRecoveryCode = internalMutation({
  args: { codeHash: v.string(), expiresAt: v.number() },
  handler: async (ctx, { codeHash, expiresAt }) => {
    const userId = await currentUserId(ctx);
    const row = await lockRow(ctx, userId);
    if (!row) return;
    await ctx.db.patch(row._id, {
      recoveryCodeHash: codeHash,
      recoveryCodeExpiresAt: expiresAt,
      recoveryAttempts: 0,
      updatedAt: Date.now(),
    });
  },
});

/** Drop a recovery code (used, expired, exhausted, or delivery failed). */
export const clearRecoveryCode = internalMutation({
  args: {},
  handler: async (ctx) => {
    const userId = await currentUserId(ctx);
    const row = await lockRow(ctx, userId);
    if (!row) return;
    await ctx.db.patch(row._id, {
      recoveryCodeHash: undefined,
      recoveryCodeExpiresAt: undefined,
      recoveryAttempts: undefined,
      updatedAt: Date.now(),
    });
  },
});

/** Count one wrong recovery-code entry. */
export const registerRecoveryAttempt = internalMutation({
  args: {},
  handler: async (ctx) => {
    const userId = await currentUserId(ctx);
    const row = await lockRow(ctx, userId);
    if (!row) return;
    await ctx.db.patch(row._id, { recoveryAttempts: (row.recoveryAttempts ?? 0) + 1, updatedAt: Date.now() });
  },
});

/** Record the outcome of a lock change (never the credential itself). */
export const recordAudit = internalMutation({
  args: { action: v.string(), detail: v.string() },
  handler: async (ctx, { action, detail }) => {
    const userId = await currentUserId(ctx);
    await audit(ctx, action, userId, detail, "user", userId);
  },
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The state the lock screen and Settings → Account → Login & Security need.
 *
 * A signed-out caller — or any account with both locks off, which is every
 * account by default — gets `enabled: false, unlocked: true`: nothing to ask for,
 * nothing to remember, the normal site. Only the member themself can read this
 * row; there is no way to query another account's locks.
 */
export const status = query({
  /** The page load asking (see `src/lib/page-session.ts`). */
  args: { pageId: v.optional(v.string()) },
  handler: async (ctx, { pageId }) => {
    const base = {
      signedIn: false,
      enabled: false,
      pinEnabled: false,
      passwordEnabled: false,
      unlocked: true,
      requiresUnlock: false,
      pinVerified: false,
      passwordVerified: false,
      pending: [] as SiteLockFactor[],
      hasPin: false,
      hasPassword: false,
      accountHasPassword: false,
      hasEmail: false,
      emailVerified: false,
      hasPendingRecoveryCode: false,
      lockedUntil: null as number | null,
      lockoutSeconds: 0,
      failedAttempts: 0,
      maxDigits: SITE_PIN_MAX_DIGITS,
      minPasswordLength: SITE_PASSWORD_MIN_LENGTH,
      /** The member's chosen idle window (0 = never until sign-out). */
      autoLockMinutes: SITE_AUTO_LOCK_DEFAULT_MINUTES,
      /** When this device's proofs lapse, so the screen can count down honestly. */
      autoLockExpiresAt: null as number | null,
      displayName: "",
    };

    const userId = await getAuthUserId(ctx);
    if (!userId) return base;

    const row = await lockRow(ctx, userId);
    const sessionId = await getAuthSessionId(ctx);
    const user = await ctx.db.get(userId);
    const account = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", userId).eq("provider", "password"))
      .unique();

    const autoLockMinutes = siteAutoLockMinutes(row?.autoLockMinutes);
    const mode = siteAutoLockMode(autoLockMinutes);
    const now = Date.now();
    // A proof that does not qualify is not a proof: dropping it here is what makes
    // the auto-lock a server decision rather than a browser countdown.
    const grants = liveProofs(await grantsOf(ctx, userId), mode, autoLockMinutes, pageId ?? null, now);
    const pinEnabled = Boolean(row?.pinEnabled && row.pinHash);
    const passwordEnabled = Boolean(row?.passwordEnabled && row.passwordHash);
    const enabled = siteLockEnabled({ pinEnabled, passwordEnabled });
    const pinVerified =
      pinEnabled && sessionProved(sessionId, legacyProof(mode, row?.verifiedPinSessionId), grants, "pin");
    const passwordVerified =
      passwordEnabled &&
      sessionProved(sessionId, legacyProof(mode, row?.verifiedPasswordSessionId), grants, "password");
    const pending = pendingSiteFactors({ pinEnabled, passwordEnabled }, { pin: pinVerified, password: passwordVerified });

    return {
      signedIn: true,
      enabled,
      pinEnabled,
      passwordEnabled,
      unlocked: pending.length === 0,
      requiresUnlock: pending.length > 0,
      pinVerified,
      passwordVerified,
      pending,
      hasPin: Boolean(row?.pinHash),
      hasPassword: Boolean(row?.passwordHash),
      accountHasPassword: Boolean(account?.secret),
      hasEmail: Boolean(user?.email),
      emailVerified: Boolean(user?.emailVerificationTime),
      hasPendingRecoveryCode: Boolean(row?.recoveryCodeHash),
      lockedUntil: row?.lockedUntil ?? null,
      lockoutSeconds: siteLockoutSeconds(row?.lockedUntil, now),
      failedAttempts: row?.failedAttempts ?? 0,
      maxDigits: SITE_PIN_MAX_DIGITS,
      minPasswordLength: SITE_PASSWORD_MIN_LENGTH,
      autoLockMinutes,
      autoLockExpiresAt: relocksAtOf(
        grants,
        sessionId,
        { pin: pinEnabled, password: passwordEnabled },
        autoLockMinutes,
      ),
      displayName: await displayNameOf(ctx, userId),
    };
  },
});

/**
 * Check one stored credential, throwing the generic error (and counting the
 * failure) when it does not match. Never reveals which part was wrong, whether a
 * credential exists, or how close the guess was.
 */
async function verifyFactorOrThrow(
  ctx: ActionCtx,
  rec: LockRecord,
  factor: SiteLockFactor,
  value: string,
): Promise<void> {
  const wait = siteLockoutSeconds(rec.lockedUntil, Date.now());
  if (wait > 0) {
    throw new ConvexError(`Too many incorrect attempts. Please try again in ${wait}s.`);
  }
  const hash = factor === "pin" ? rec.pinHash : rec.passwordHash;
  const problem = factor === "pin" ? sitePinProblem(value) : sitePasswordProblem(value);
  if (!hash || problem !== null) {
    const recorded = (await ctx.runMutation(internal.siteLock.registerAttempt, { success: false })) as {
      delayMs: number;
    } | null;
    throw new ConvexError(siteLockErrorMessage(recorded?.delayMs ?? 0));
  }
  const ok = await new Scrypt().verify(hash, value);
  const recorded = (await ctx.runMutation(internal.siteLock.registerAttempt, { success: ok })) as {
    delayMs: number;
  } | null;
  if (!ok) throw new ConvexError(siteLockErrorMessage(recorded?.delayMs ?? 0));
}

/**
 * Verify the credentials the caller has enabled, for THIS session.
 *
 * Only the factors that are enabled AND not yet verified for this session are
 * checked, so the flow works for all four configurations: with both locks off
 * this is a no-op, with one lock on that credential is checked, and with both on
 * both are required before the site opens. A correct entry is remembered for the
 * session (refreshing the page never re-asks), a wrong one is rate limited and
 * escalates through the progressive delay.
 */
export const verify = action({
  args: {
    pin: v.optional(v.string()),
    password: v.optional(v.string()),
    /** Which page load is unlocking; an "every page load" proof is scoped to it. */
    pageId: v.optional(v.string()),
  },
  handler: async (ctx, { pin, password, pageId }): Promise<{ ok: true; enabled: boolean; unlocked: boolean }> => {
    const rec = (await ctx.runQuery(internal.siteLock.lockRecord, { pageId })) as LockRecord | null;
    if (!rec) throw new ConvexError("Please sign in to continue.");
    if (!rec.enabled) return { ok: true, enabled: false, unlocked: true };

    const wait = siteLockoutSeconds(rec.lockedUntil, Date.now());
    if (wait > 0) {
      throw new ConvexError(`Too many incorrect attempts. Please try again in ${wait}s.`);
    }
    await ctx.runMutation(internal.siteLock.enforceLimit, { scope: "verify", limit: 30, windowMs: 60_000 });

    const checks: boolean[] = [];
    if (rec.pinEnabled && !rec.pinVerified) {
      checks.push(
        Boolean(rec.pinHash) &&
          typeof pin === "string" &&
          sitePinProblem(pin) === null &&
          (await new Scrypt().verify(rec.pinHash!, pin)),
      );
    }
    if (rec.passwordEnabled && !rec.passwordVerified) {
      checks.push(
        Boolean(rec.passwordHash) &&
          typeof password === "string" &&
          sitePasswordProblem(password) === null &&
          (await new Scrypt().verify(rec.passwordHash!, password)),
      );
    }

    // Nothing pending (already verified moments ago): the site is open, and
    // re-sending a credential that was already accepted must not count as a
    // failure.
    if (checks.length === 0) return { ok: true, enabled: true, unlocked: true };

    const passed = checks.every(Boolean);
    const recorded = (await ctx.runMutation(internal.siteLock.registerAttempt, { success: passed })) as {
      delayMs: number;
    } | null;
    if (!passed) throw new ConvexError(siteLockErrorMessage(recorded?.delayMs ?? 0));

    await ctx.runMutation(internal.siteLock.markVerified, {
      pin: rec.pinEnabled && !rec.pinVerified,
      password: rec.passwordEnabled && !rec.passwordVerified,
      pageId,
    });
    await ctx.runMutation(internal.siteLock.recordAudit, {
      action: "site_lock.unlock",
      detail: `${rec.name} opened Freecord with their optional site lock credentials`,
    });
    return { ok: true, enabled: true, unlocked: true };
  },
});

/**
 * Create the PIN lock, or change the PIN. Changing requires the current PIN;
 * setting one up for the first time does not (there is nothing to prove yet, and
 * the caller is already the signed-in owner). The new PIN is stored only as a
 * Scrypt hash and this session is marked verified, since the owner just typed it.
 */
export const setPin = action({
  args: {
    pin: v.string(),
    confirmPin: v.string(),
    currentPin: v.optional(v.string()),
    pageId: v.optional(v.string()),
  },
  handler: async (ctx, { pin, confirmPin, currentPin, pageId }): Promise<{ ok: true; changing: boolean }> => {
    const rec = (await ctx.runQuery(internal.siteLock.lockRecord, { pageId })) as LockRecord | null;
    if (!rec) throw new ConvexError("Please sign in to continue.");
    const problem = sitePinProblem(pin);
    if (problem) throw new ConvexError(problem);
    if (!sitePinsMatch(pin, confirmPin)) throw new ConvexError("Those PINs don't match.");
    await ctx.runMutation(internal.siteLock.enforceLimit, { scope: "setpin", limit: 8, windowMs: 60_000 });

    const changing = rec.pinEnabled && rec.hasPin;
    if (changing) {
      if (!currentPin) throw new ConvexError("Enter your current PIN.");
      await verifyFactorOrThrow(ctx, rec, "pin", currentPin);
    }

    const pinHash = await new Scrypt().hash(pin);
    await ctx.runMutation(internal.siteLock.storePin, { pinHash, changing });
    await ctx.runMutation(internal.siteLock.markVerified, { pin: true, password: false, pageId });
    return { ok: true, changing };
  },
});

/**
 * Create the extra password, or change it. Changing requires the current extra
 * password; the first setup does not. Symbols, spaces, upper case and unicode are
 * all accepted and stored exactly as typed (only the length and the letter+number
 * rule apply, matching account passwords).
 */
export const setPassword = action({
  args: {
    password: v.string(),
    confirmPassword: v.string(),
    currentPassword: v.optional(v.string()),
    pageId: v.optional(v.string()),
  },
  handler: async (ctx, { password, confirmPassword, currentPassword, pageId }): Promise<{ ok: true; changing: boolean }> => {
    const rec = (await ctx.runQuery(internal.siteLock.lockRecord, { pageId })) as LockRecord | null;
    if (!rec) throw new ConvexError("Please sign in to continue.");
    const problem = sitePasswordProblem(password);
    if (problem) throw new ConvexError(problem);
    if (!sitePasswordsMatch(password, confirmPassword)) throw new ConvexError("Those passwords don't match.");
    await ctx.runMutation(internal.siteLock.enforceLimit, { scope: "setpassword", limit: 8, windowMs: 60_000 });

    const changing = rec.passwordEnabled && rec.hasPassword;
    if (changing) {
      if (!currentPassword) throw new ConvexError("Enter your current password.");
      await verifyFactorOrThrow(ctx, rec, "password", currentPassword);
    }

    const passwordHash = await new Scrypt().hash(password);
    await ctx.runMutation(internal.siteLock.storePassword, { passwordHash, changing });
    await ctx.runMutation(internal.siteLock.markVerified, { pin: false, password: true, pageId });
    return { ok: true, changing };
  },
});

/**
 * The identity proof shared by "turn this lock off" and "which proof may I use?":
 * the lock's own credential, or the account's password (the existing Freecord
 * sign-in secret, verified against its stored Scrypt hash). An account with NO
 * password credential (email-code sign-in) can prove identity with the signed-in
 * session itself — the same reasoning the Admin PIN uses: the lock never granted
 * authority, and the session *is* that account's authentication.
 */
async function proveIdentityOrThrow(
  ctx: ActionCtx,
  rec: LockRecord,
  factor: SiteLockFactor,
  own: string | undefined,
  accountPassword: string | undefined,
): Promise<string> {
  const credential = (await ctx.runQuery(internal.siteLock.accountCredential, {})) as {
    hasPassword: boolean;
    secret: string | null;
  };

  if (own) {
    await verifyFactorOrThrow(ctx, rec, factor, own);
    return "identity confirmed with the current credential";
  }
  if (accountPassword && credential.secret) {
    await ctx.runMutation(internal.siteLock.enforceLimit, { scope: "disable", limit: 8, windowMs: 60_000 });
    const ok = await new Scrypt().verify(credential.secret, accountPassword);
    if (ok) return "identity confirmed with the account password";
  }
  if (!credential.hasPassword) {
    return "account has no password credential; identity confirmed by the signed-in session";
  }
  throw new ConvexError(
    factor === "pin"
      ? "Enter your current PIN or your account password to turn PIN lock off."
      : "Enter your current password or your account password to turn password lock off.",
  );
}

/** Turn the PIN lock off (the password lock, if any, is untouched). */
export const disablePin = action({
  args: { pin: v.optional(v.string()), accountPassword: v.optional(v.string()) },
  handler: async (ctx, { pin, accountPassword }): Promise<{ ok: true; alreadyDisabled: boolean }> => {
    const rec = (await ctx.runQuery(internal.siteLock.lockRecord, {})) as LockRecord | null;
    if (!rec) throw new ConvexError("Please sign in to continue.");
    if (!rec.hasPin) return { ok: true, alreadyDisabled: true };
    const reason = await proveIdentityOrThrow(ctx, rec, "pin", pin, accountPassword);
    await ctx.runMutation(internal.siteLock.clearPin, { reason });
    return { ok: true, alreadyDisabled: false };
  },
});

/** Turn the extra-password lock off (the PIN lock, if any, is untouched). */
export const disablePassword = action({
  args: { password: v.optional(v.string()), accountPassword: v.optional(v.string()) },
  handler: async (ctx, { password, accountPassword }): Promise<{ ok: true; alreadyDisabled: boolean }> => {
    const rec = (await ctx.runQuery(internal.siteLock.lockRecord, {})) as LockRecord | null;
    if (!rec) throw new ConvexError("Please sign in to continue.");
    if (!rec.hasPassword) return { ok: true, alreadyDisabled: true };
    const reason = await proveIdentityOrThrow(ctx, rec, "password", password, accountPassword);
    await ctx.runMutation(internal.siteLock.clearPassword, { reason });
    return { ok: true, alreadyDisabled: false };
  },
});

/**
 * Email a single-use recovery code to the account's own address, so a forgotten
 * PIN or password is never a lockout. Requires a signed-in owner (the code goes
 * to their address, and the action is scoped to their own row), refuses while
 * neither lock is on, is rate limited, and stores only the hash.
 */
export const requestRecoveryCode = action({
  args: {},
  handler: async (ctx): Promise<{ ok: true; email: string; expiresInMinutes: number }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Please sign in to continue.");
    const rec = (await ctx.runQuery(internal.siteLock.lockRecord, {})) as LockRecord | null;
    if (!rec?.enabled) throw new ConvexError("Neither lock is on, so there is nothing to recover.");
    await ctx.runMutation(internal.siteLock.enforceLimit, { scope: "recovery", limit: 3, windowMs: 10 * 60_000 });

    const account = (await ctx.runQuery(internal.siteLock.accountEmail, { userId })) as {
      email: string | null;
    };
    if (!account.email) {
      throw new ConvexError(
        "Your account has no email address, so a recovery code can't be sent. Add one in Settings → Account, or use your account password instead.",
      );
    }

    const code = generateRecoveryCode();
    const codeHash = await new Scrypt().hash(code);
    await ctx.runMutation(internal.siteLock.storeRecoveryCode, {
      codeHash,
      expiresAt: Date.now() + SITE_RECOVERY_CODE_TTL_MS,
    });
    try {
      await sendCodeEmail({ to: account.email, code, subject: "your Freecord recovery code" });
    } catch {
      await ctx.runMutation(internal.siteLock.clearRecoveryCode, {});
      throw new ConvexError("We couldn't send the recovery email. Please try again in a moment.");
    }
    await ctx.runMutation(internal.siteLock.recordAudit, {
      action: "site_lock.recovery.request",
      detail: `${rec.name} requested a recovery code for their optional site locks`,
    });
    return {
      ok: true,
      email: maskRecoveryEmail(account.email),
      expiresInMinutes: Math.round(SITE_RECOVERY_CODE_TTL_MS / 60_000),
    };
  },
});

/**
 * Finish a recovery with the emailed code: set a NEW PIN / password, or turn that
 * lock off. The code is single use, expires, and allows only a few wrong guesses
 * before it is dropped. The recovered credential is written as a fresh Scrypt
 * hash, and what could not be recovered on the lock screen is always possible from
 * Settings with the account password — so a forgotten credential never locks a
 * member out of their own account.
 */
export const recoverWithCode = action({
  args: {
    code: v.string(),
    target: v.union(v.literal("pin"), v.literal("password")),
    disable: v.boolean(),
    newPin: v.optional(v.string()),
    confirmPin: v.optional(v.string()),
    newPassword: v.optional(v.string()),
    confirmPassword: v.optional(v.string()),
    pageId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ ok: true; disabled: boolean }> => {
    const rec = (await ctx.runQuery(internal.siteLock.lockRecord, {})) as LockRecord | null;
    if (!rec) throw new ConvexError("Please sign in to continue.");
    if (!rec.enabled) throw new ConvexError("Neither lock is on, so there is nothing to recover.");
    await ctx.runMutation(internal.siteLock.enforceLimit, { scope: "recoveryverify", limit: 10, windowMs: 10 * 60_000 });

    if (!rec.recoveryCodeHash) throw new ConvexError("Request a new recovery code first.");
    if ((rec.recoveryCodeExpiresAt ?? 0) < Date.now()) {
      await ctx.runMutation(internal.siteLock.clearRecoveryCode, {});
      throw new ConvexError("That recovery code has expired. Please request a new one.");
    }
    if ((rec.recoveryAttempts ?? 0) >= SITE_RECOVERY_MAX_ATTEMPTS) {
      await ctx.runMutation(internal.siteLock.clearRecoveryCode, {});
      throw new ConvexError("Too many incorrect codes. Please request a new one.");
    }

    const problem = siteRecoveryCodeProblem(args.code);
    let valid = false;
    if (problem === null) {
      try {
        valid = await new Scrypt().verify(rec.recoveryCodeHash, args.code);
      } catch {
        valid = false;
      }
    }
    if (!valid) {
      await ctx.runMutation(internal.siteLock.registerRecoveryAttempt, {});
      throw new ConvexError("That recovery code is not correct.");
    }

    // Validate the replacement credential BEFORE burning the code, so a typo in
    // the new PIN or password never costs the member another email round trip.
    if (args.target === "pin" && !args.disable) {
      const pinProblem = sitePinProblem(args.newPin);
      if (pinProblem) throw new ConvexError(pinProblem);
      if (!sitePinsMatch(args.newPin!, args.confirmPin ?? "")) throw new ConvexError("Those PINs don't match.");
    }
    if (args.target === "password" && !args.disable) {
      const pwProblem = sitePasswordProblem(args.newPassword);
      if (pwProblem) throw new ConvexError(pwProblem);
      if (!sitePasswordsMatch(args.newPassword!, args.confirmPassword ?? "")) {
        throw new ConvexError("Those passwords don't match.");
      }
    }

    // The code proved identity; burn it before writing anything.
    await ctx.runMutation(internal.siteLock.clearRecoveryCode, {});

    if (args.target === "pin") {
      if (args.disable) {
        await ctx.runMutation(internal.siteLock.clearPin, { reason: "recovered with an emailed code" });
      } else {
        const pinHash = await new Scrypt().hash(args.newPin!);
        await ctx.runMutation(internal.siteLock.storePin, { pinHash, changing: rec.hasPin });
        await ctx.runMutation(internal.siteLock.markVerified, { pin: true, password: false, pageId: args.pageId });
      }
    } else if (args.disable) {
      await ctx.runMutation(internal.siteLock.clearPassword, { reason: "recovered with an emailed code" });
    } else {
      const passwordHash = await new Scrypt().hash(args.newPassword!);
      await ctx.runMutation(internal.siteLock.storePassword, { passwordHash, changing: rec.hasPassword });
      await ctx.runMutation(internal.siteLock.markVerified, { pin: false, password: true, pageId: args.pageId });
    }

    await ctx.runMutation(internal.siteLock.recordAudit, {
      action: "site_lock.recovery.complete",
      detail: `${rec.name} recovered their optional ${args.target} lock with an emailed code (${
        args.disable ? "lock turned off" : "new credential set"
      })`,
    });
    return { ok: true, disabled: args.disable };
  },
});

/**
 * Lock Freecord again right now: revoke THIS device's verification so the gate
 * asks for the enabled credentials on the next render. Safe direction, so no
 * credential is required — unlike turning a lock off, which always needs one.
 *
 * Only the caller's own session is revoked: locking your laptop must never lock
 * the phone you are also signed in on. The legacy single-session fields are
 * cleared only when they describe THIS session, for the same reason.
 */
export const lockNow = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await currentUserId(ctx);
    const sessionId = await getAuthSessionId(ctx);
    const key = sessionId ? (sessionId as string) : null;
    const now = Date.now();
    if (key) {
      for (const grant of await grantsOf(ctx, userId)) {
        if (grant.sessionId === key) await ctx.db.delete(grant._id);
      }
    }
    const row = await lockRow(ctx, userId);
    if (row) {
      await ctx.db.patch(row._id, {
        ...(key && row.verifiedPinSessionId === key ? { verifiedPinSessionId: undefined } : {}),
        ...(key && row.verifiedPasswordSessionId === key ? { verifiedPasswordSessionId: undefined } : {}),
        updatedAt: now,
      });
    }
    return { locked: true };
  },
});

/**
 * How long a device may sit UNUSED before the enabled credentials are asked for
 * again — the delay the member picks in Settings → Account → Login & Security
 * (`0` = never, satisfied until sign-out).
 *
 * SAFE DIRECTION ONLY: this can never turn a lock off, never verify a credential
 * and never grant access. It only decides when a device that already unlocked
 * itself asks again, which is why no credential is required to change it — like
 * `lockNow`, it is a preference of the signed-in member, not a proof of anything.
 *
 * The caller's OWN device has its proofs re-stamped, so a shorter window never
 * locks the settings screen out from under the hand that just changed it; other
 * devices keep their own timestamps and simply follow the new window from their
 * next activity (a device already idle for longer than the new window asks for
 * the credential at its next interaction, which is the point of shortening it).
 */
export const setAutoLock = mutation({
  args: { minutes: v.number() },
  handler: async (ctx, { minutes }) => {
    const userId = await currentUserId(ctx);
    const problem = siteAutoLockProblem(minutes);
    if (problem) throw new ConvexError(problem);
    const row = await lockRow(ctx, userId);
    if (!row || !siteLockEnabled({ pinEnabled: row.pinEnabled, passwordEnabled: row.passwordEnabled })) {
      throw new ConvexError("Turn on a PIN or password lock first.");
    }
    await enforceRateLimit(ctx, `sitelock:autolock:${userId}`, 30, 60_000);
    const value = siteAutoLockMinutes(minutes);
    const now = Date.now();
    await ctx.db.patch(row._id, { autoLockMinutes: value, updatedAt: now });
    const sessionId = await getAuthSessionId(ctx);
    if (sessionId) {
      const key = sessionId as string;
      for (const grant of await grantsOf(ctx, userId)) {
        if (grant.sessionId === key) await ctx.db.patch(grant._id, { verifiedAt: now });
      }
    }
    const name = await displayNameOf(ctx, userId);
    await audit(
      ctx,
      "site_lock.autolock.change",
      userId,
      `${name} set the optional Freecord auto-lock to ${
        value === SITE_AUTO_LOCK_NEVER ? "never (unlocked until sign-out)" : siteAutoLockLabel(value).toLowerCase()
      }`,
      "user",
      userId,
    );
    return { autoLockMinutes: value };
  },
});

/**
 * "I am still here": push THIS device's proof deadline forward while it is being
 * used, which is what makes the window an inactivity timer rather than a hard
 * session limit.
 *
 * Deliberately powerless: it never verifies a credential (no `grantFactor` here),
 * never creates a proof that does not already exist, and never revives one whose
 * window has already closed — so a lapsed session cannot talk its way back open,
 * and a device can only ever extend its own rows. Callers report at most once per
 * `siteAutoLockReportIntervalMs`, so an hour of activity is a few small writes, not
 * thousands; a report that is rate limited changes nothing at all.
 */
export const refreshAutoLock = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await currentUserId(ctx);
    const row = await lockRow(ctx, userId);
    const sessionId = await getAuthSessionId(ctx);
    if (!row || !sessionId || !siteLockEnabled({ pinEnabled: row.pinEnabled, passwordEnabled: row.passwordEnabled })) {
      return { extended: false, autoLockExpiresAt: null as number | null };
    }
    const autoLockMinutes = siteAutoLockMinutes(row.autoLockMinutes);
    // Only the timer mode has a deadline to extend: "every page load" needs no
    // reporting at all (a proof cannot outlive its page), and "never" has none.
    if (siteAutoLockMode(autoLockMinutes) !== "idle") return { extended: false, autoLockExpiresAt: null };
    await enforceRateLimit(ctx, `sitelock:touch:${userId}`, 20, 60_000);
    const key = sessionId as string;
    const now = Date.now();
    let extended = false;
    for (const grant of await grantsOf(ctx, userId)) {
      if (grant.sessionId !== key) continue;
      // Already lapsed, or still fresh enough that a write would be noise.
      if (siteAutoLockExpiredAt(grant.verifiedAt, autoLockMinutes, now)) continue;
      if (now - grant.verifiedAt < SITE_AUTO_LOCK_TOUCH_MS) continue;
      await ctx.db.patch(grant._id, { verifiedAt: now });
      extended = true;
    }
    return { extended, autoLockExpiresAt: now + autoLockMinutes * 60_000 };
  },
});
