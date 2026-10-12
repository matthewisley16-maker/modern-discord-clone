import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { Scrypt } from "lucia";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { auditAdmin, currentUserId, displayNameOf, rankOf, requirePanelAccess, roleOfUser, ROLE_RANK } from "./lib";
import { enforceRateLimit } from "./authHelpers";
import {
  ADMIN_PIN_LOCKOUT_DECAY_MS,
  ADMIN_PIN_MAX_DIGITS,
  ADMIN_PIN_UNLOCK_MINUTES,
  adminPinLockoutFor,
  adminPinLockoutSeconds,
  adminPinProblem,
  adminPinsMatch,
} from "../lib/admin-pin";

/**
 * ---------------------------------------------------------------------------
 * OPTIONAL Admin PIN (`adminPinSettings`)
 * ---------------------------------------------------------------------------
 * An administrator MAY put a 1–10 digit PIN in front of the Admin Panel's
 * protected pages. The feature is opt-in per account and is deliberately built so
 * it can never become a requirement or a lockout:
 *
 *   - No row, or `enabled: false`, means "no PIN protection". That is the state
 *     of every account by default — nothing here forces a PIN to be created, and
 *     "Skip for now" records the administrator's choice (`skippedAt`) so the UI
 *     never nags them again.
 *   - With protection off, the panel opens on the EXISTING account
 *     authentication plus the server-side administrator-role checks
 *     (`requirePanelAccess`), exactly as before this feature existed.
 *   - With protection on, a correct PIN is required before those pages open. The
 *     grant is short-lived and scoped to the auth session that entered it, so
 *     signing out or using another device asks again; "Lock panel now" revokes it
 *     immediately.
 *
 * Security boundaries (deliberate, and the reason this file is separate from
 * `auth.ts` — sign-in is untouched):
 *   - A PIN NEVER grants authority. Every public function here first calls
 *     `panelAccess`, which re-checks the signed-in account's role on the server;
 *     a non-admin is refused with or without a PIN.
 *   - Turning protection off can never weaken those role checks, because they
 *     never consult this table. Disabling requires the administrator to prove
 *     identity with the current PIN, or with the account's password through the
 *     existing auth credential; auditing records every change.
 *   - The PIN is only ever stored as a one-way Scrypt hash, never returned by a
 *     query, never logged, and never echoed in an error. Crypto runs in actions
 *     (never in a query), failures are rate limited and followed by a temporary
 *     lockout, and every failure message is generic.
 *   - Ordinary members have no access to any of this: it lives only in the Admin
 *     Panel, and the panel itself is closed to them by role.
 */

type Ctx = QueryCtx | MutationCtx;

type PinRecord = {
  enabled: boolean;
  hasPin: boolean;
  pinHash: string | null;
  failedAttempts: number;
  lockedUntil: number | null;
  unlocked: boolean;
  unlockedUntil: number | null;
  skippedAt: number | null;
};

/** Is there a live elevation for THIS auth session? */
function sessionUnlocked(row: Doc<"adminPinSettings"> | null, sessionId: string | null): boolean {
  if (!row || row.unlockedUntil === undefined) return false;
  if (row.unlockedUntil <= Date.now()) return false;
  return (row.unlockedSessionId ?? null) === (sessionId ?? null);
}

async function settingsRow(ctx: Ctx, userId: Id<"users">): Promise<Doc<"adminPinSettings"> | null> {
  return await ctx.db
    .query("adminPinSettings")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

// ---------------------------------------------------------------------------
// Internal reads
// ---------------------------------------------------------------------------

/**
 * The authorization gate every public entry point calls first: the caller must
 * be signed in (and not banned/suspended) AND hold an administrator role. The
 * role is read from the users table on the server — a PIN, a client flag or a
 * stored preference can never stand in for it.
 *
 * Auth identity is propagated to nested calls, so this also works when invoked
 * from the PIN actions via `ctx.runQuery`.
 */
export const panelAccess = internalQuery({
  args: {},
  handler: async (ctx) => {
    const userId = await currentUserId(ctx);
    const role = await requirePanelAccess(ctx, userId);
    return { userId, role, name: await displayNameOf(ctx, userId) };
  },
});

/** The caller's PIN record — `pinHash` is returned ON PURPOSE (internal only). */
export const pinRecord = internalQuery({
  args: {},
  handler: async (ctx): Promise<PinRecord | null> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const row = await settingsRow(ctx, userId);
    if (!row) return null;
    const sessionId = await getAuthSessionId(ctx);
    return {
      enabled: Boolean(row.enabled && row.pinHash),
      hasPin: Boolean(row.pinHash),
      pinHash: row.pinHash ?? null,
      failedAttempts: row.failedAttempts,
      lockedUntil: row.lockedUntil ?? null,
      unlocked: sessionUnlocked(row, sessionId),
      unlockedUntil: row.unlockedUntil ?? null,
      skippedAt: row.skippedAt ?? null,
    };
  },
});

/**
 * Does the caller's account have a PASSWORD credential (the existing Freecord
 * sign-in secret)? Used as the identity proof for turning PIN protection off
 * after a forgotten PIN. Internal only: the hash is never exposed to a client.
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

// ---------------------------------------------------------------------------
// Internal writes
// ---------------------------------------------------------------------------

/** Backend-authoritative rate limit (abuse protection cannot be bypassed). */
export const enforceLimit = internalMutation({
  args: { scope: v.string(), limit: v.number(), windowMs: v.number() },
  handler: async (ctx, { scope, limit, windowMs }) => {
    const userId = await currentUserId(ctx);
    await enforceRateLimit(ctx, `adminpin:${scope}:${userId}`, limit, windowMs);
  },
});

/**
 * Count a PIN attempt and apply the PROGRESSIVE delay after repeated failures.
 *
 * The first couple of typos cost nothing; from the third consecutive failure the
 * wait doubles each time (5s → 10s → 20s … capped at 15 minutes) and keeps
 * growing while the guessing continues, so a wrong-PIN loop slows down instead of
 * running at a constant rate. The count is cleared by a correct PIN, and it also
 * starts over after `ADMIN_PIN_LOCKOUT_DECAY_MS` of quiet, so an honest
 * administrator is never punished hours later for an old mistype.
 *
 * Returns the delay that now applies (ms, 0 when none) so the caller can tell the
 * user exactly how long to wait.
 */
export const registerAttempt = internalMutation({
  args: { success: v.boolean() },
  handler: async (ctx, { success }): Promise<{ delayMs: number; failedAttempts: number }> => {
    const userId = await currentUserId(ctx);
    await enforceRateLimit(ctx, `adminpin:attempt:${userId}`, 20, 60_000);
    const row = await settingsRow(ctx, userId);
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
    // A stale run of failures does not carry over: the streak restarts after an
    // hour of quiet.
    const stale = row.lastFailedAt !== undefined && now - row.lastFailedAt > ADMIN_PIN_LOCKOUT_DECAY_MS;
    const failed = (stale ? 0 : row.failedAttempts ?? 0) + 1;
    const delayMs = adminPinLockoutFor(failed);
    await ctx.db.patch(row._id, {
      failedAttempts: failed,
      lockedUntil: delayMs > 0 ? now + delayMs : undefined,
      lastFailedAt: now,
      updatedAt: now,
    });
    return { delayMs, failedAttempts: failed };
  },
});

/** Store (or replace) the hashed PIN and turn protection on. */
export const storePin = internalMutation({
  args: { pinHash: v.string(), actorId: v.id("users"), actorName: v.string(), changing: v.boolean() },
  handler: async (ctx, { pinHash, actorId, actorName, changing }) => {
    const row = await settingsRow(ctx, actorId);
    const patch = {
      pinHash,
      enabled: true,
      failedAttempts: 0,
      lockedUntil: undefined,
      skippedAt: undefined,
      updatedAt: Date.now(),
    };
    if (row) await ctx.db.patch(row._id, patch);
    else await ctx.db.insert("adminPinSettings", { userId: actorId, ...patch });
    await auditAdmin(ctx, {
      action: changing ? "admin_pin.change" : "admin_pin.enable",
      actorId,
      actorName,
      targetType: "user",
      targetId: actorId,
      targetUserId: actorId,
      targetName: actorName,
      detail: changing
        ? "Changed their Admin PIN (Admin Panel protection stays on)"
        : "Enabled optional Admin PIN protection for the Admin Panel",
    });
  },
});

/** Turn protection off and forget the PIN (never touches roles or auth). */
export const clearPin = internalMutation({
  args: { actorId: v.id("users"), actorName: v.string(), reason: v.string() },
  handler: async (ctx, { actorId, actorName, reason }) => {
    const row = await settingsRow(ctx, actorId);
    if (row) {
      await ctx.db.patch(row._id, {
        enabled: false,
        pinHash: undefined,
        failedAttempts: 0,
        lockedUntil: undefined,
        unlockedUntil: undefined,
        unlockedSessionId: undefined,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("adminPinSettings", {
        userId: actorId,
        enabled: false,
        failedAttempts: 0,
        updatedAt: Date.now(),
      });
    }
    await auditAdmin(ctx, {
      action: "admin_pin.disable",
      actorId,
      actorName,
      targetType: "user",
      targetId: actorId,
      targetUserId: actorId,
      targetName: actorName,
      detail: `Turned OFF Admin PIN protection (${reason}) — the Admin Panel now opens with the account's administrator-role check alone`,
    });
  },
});

/** Record "Skip for now" so a deliberate choice is never prompted again. */
export const recordSkip = internalMutation({
  args: { actorId: v.id("users") },
  handler: async (ctx, { actorId }) => {
    const row = await settingsRow(ctx, actorId);
    if (row) await ctx.db.patch(row._id, { skippedAt: Date.now(), updatedAt: Date.now() });
    else
      await ctx.db.insert("adminPinSettings", {
        userId: actorId,
        enabled: false,
        failedAttempts: 0,
        skippedAt: Date.now(),
        updatedAt: Date.now(),
      });
  },
});

/** Grant a short-lived elevation to the CURRENT auth session. */
export const grantUnlock = internalMutation({
  args: { minutes: v.number() },
  handler: async (ctx, { minutes }) => {
    const userId = await currentUserId(ctx);
    const row = await settingsRow(ctx, userId);
    if (!row) return;
    const sessionId = await getAuthSessionId(ctx);
    const until = Date.now() + Math.min(Math.max(minutes, 1), 240) * 60_000;
    await ctx.db.patch(row._id, {
      unlockedUntil: until,
      unlockedSessionId: sessionId ?? undefined,
      failedAttempts: 0,
      lockedUntil: undefined,
      updatedAt: Date.now(),
    });
  },
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The state the Admin Panel needs: is protection on, and is THIS session open?
 *
 * Returns harmless defaults (`enabled: false, unlocked: true`) for a signed-out
 * caller or an account without panel access: an ordinary member is never
 * PIN-gated — they are kept out of the panel by the role check, not by a
 * preference — and asking for a PIN from someone who cannot use the panel would
 * be misleading.
 */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const base = {
      enabled: false,
      hasPin: false,
      unlocked: true,
      unlockedUntil: null as number | null,
      lockedUntil: null as number | null,
      failedAttempts: 0,
      accountHasPassword: false,
      skipped: false,
      unlockMinutes: ADMIN_PIN_UNLOCK_MINUTES,
      maxDigits: ADMIN_PIN_MAX_DIGITS,
    };
    const userId = await getAuthUserId(ctx);
    if (!userId) return base;
    if (rankOf(await roleOfUser(ctx, userId)) < ROLE_RANK.admin) return base;

    const row = await settingsRow(ctx, userId);
    const enabled = Boolean(row?.enabled && row.pinHash);
    const sessionId = await getAuthSessionId(ctx);
    const account = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", userId).eq("provider", "password"))
      .unique();

    return {
      enabled,
      hasPin: Boolean(row?.pinHash),
      unlocked: !enabled || sessionUnlocked(row, sessionId),
      unlockedUntil: row?.unlockedUntil ?? null,
      lockedUntil: row?.lockedUntil ?? null,
      failedAttempts: row?.failedAttempts ?? 0,
      accountHasPassword: Boolean(account?.secret),
      skipped: Boolean(row?.skippedAt),
      unlockMinutes: ADMIN_PIN_UNLOCK_MINUTES,
      maxDigits: ADMIN_PIN_MAX_DIGITS,
    };
  },
});

/**
 * Verify the PIN on `pin` for the signed-in administrator, throwing a generic
 * error when it is wrong. Lockout and rate limiting apply; the count resets on
 * success. Never reveals whether a PIN exists or how close it was.
 */
async function verifyPinOrThrow(ctx: ActionCtx, rec: PinRecord, pin: string): Promise<void> {
  const lockout = adminPinLockoutSeconds(rec.lockedUntil, Date.now());
  if (lockout > 0) {
    throw new ConvexError(`Too many incorrect attempts. Please try again in ${lockout}s.`);
  }
  if (!rec.pinHash || adminPinProblem(pin) !== null) {
    const recorded = (await ctx.runMutation(internal.adminPin.registerAttempt, { success: false })) as {
      delayMs: number;
    } | null;
    throw new ConvexError(incorrectPinMessage(recorded?.delayMs ?? 0));
  }
  const ok = await new Scrypt().verify(rec.pinHash, pin);
  const recorded = (await ctx.runMutation(internal.adminPin.registerAttempt, { success: ok })) as {
    delayMs: number;
  } | null;
  if (!ok) throw new ConvexError(incorrectPinMessage(recorded?.delayMs ?? 0));
}

/** The generic wrong-PIN error, plus the progressive wait when one now applies. */
function incorrectPinMessage(delayMs: number): string {
  if (delayMs <= 0) return "That PIN is not correct.";
  return `That PIN is not correct. Please wait ${Math.ceil(delayMs / 1000)}s before trying again.`;
}

/**
 * Create the PIN, or change it. Changing always requires the current PIN; the
 * very first setup does not (there is nothing to prove yet). Enabling protection
 * also opens the panel for this session, since the admin just typed the PIN.
 */
export const setPin = action({
  args: { pin: v.string(), confirmPin: v.string(), currentPin: v.optional(v.string()) },
  handler: async (ctx, { pin, confirmPin, currentPin }): Promise<{ ok: true }> => {
    const me = await ctx.runQuery(internal.adminPin.panelAccess, {});
    const problem = adminPinProblem(pin);
    if (problem) throw new ConvexError(problem);
    if (!adminPinsMatch(pin, confirmPin)) throw new ConvexError("Those PINs don't match.");
    await ctx.runMutation(internal.adminPin.enforceLimit, { scope: "setpin", limit: 8, windowMs: 60_000 });

    const rec = (await ctx.runQuery(internal.adminPin.pinRecord, {})) as PinRecord | null;
    const changing = Boolean(rec?.enabled && rec.pinHash);
    if (changing) {
      if (!currentPin) throw new ConvexError("Enter your current Admin PIN.");
      await verifyPinOrThrow(ctx, rec!, currentPin);
    }

    const pinHash = await new Scrypt().hash(pin);
    await ctx.runMutation(internal.adminPin.storePin, {
      pinHash,
      actorId: me.userId,
      actorName: me.name,
      changing,
    });
    await ctx.runMutation(internal.adminPin.grantUnlock, { minutes: ADMIN_PIN_UNLOCK_MINUTES });
    return { ok: true };
  },
});

/**
 * Open the protected admin pages for this session. When protection is off this
 * is a no-op (`enabled: false`) — nothing is required, and nothing is recorded.
 */
export const unlock = action({
  args: { pin: v.string() },
  handler: async (ctx, { pin }): Promise<{ ok: true; enabled: boolean }> => {
    await ctx.runQuery(internal.adminPin.panelAccess, {});
    const rec = (await ctx.runQuery(internal.adminPin.pinRecord, {})) as PinRecord | null;
    if (!rec?.enabled || !rec.pinHash) return { ok: true, enabled: false };
    await verifyPinOrThrow(ctx, rec, pin);
    await ctx.runMutation(internal.adminPin.grantUnlock, { minutes: ADMIN_PIN_UNLOCK_MINUTES });
    return { ok: true, enabled: true };
  },
});

/**
 * Turn PIN protection off. Requires the caller to be a signed-in administrator
 * (checked on the server) and to prove identity EITHER with the current PIN or
 * with the account's password (the existing Freecord credential, verified here
 * against its stored Scrypt hash) — so a forgotten PIN is not a lockout.
 *
 * The one case with no stronger proof available is an administrator whose
 * account has NO password credential (an email-code or guest sign-in): there the
 * signed-in administrator session IS the existing authentication, and since the
 * PIN never granted authority in the first place, protection can be turned off
 * on that basis. The action is audited either way, and the role checks that
 * actually guard the panel are untouched by it.
 */
export const disable = action({
  args: { pin: v.optional(v.string()), password: v.optional(v.string()) },
  handler: async (ctx, { pin, password }): Promise<{ ok: true; alreadyDisabled: boolean }> => {
    const me = await ctx.runQuery(internal.adminPin.panelAccess, {});
    const rec = (await ctx.runQuery(internal.adminPin.pinRecord, {})) as PinRecord | null;
    if (!rec?.hasPin) return { ok: true, alreadyDisabled: true };

    const credential = (await ctx.runQuery(internal.adminPin.accountCredential, {})) as {
      hasPassword: boolean;
      secret: string | null;
    };

    let proved = false;
    let reason = "identity confirmed with the Admin PIN";
    if (pin) {
      await verifyPinOrThrow(ctx, rec, pin);
      proved = true;
    } else if (password && credential.secret) {
      await ctx.runMutation(internal.adminPin.enforceLimit, { scope: "disable", limit: 8, windowMs: 60_000 });
      proved = await new Scrypt().verify(credential.secret, password);
      reason = "identity confirmed with the account password";
      // A wrong account password is rate limited like a wrong PIN: it is the
      // other proof of identity for this account.
    } else if (!credential.hasPassword) {
      proved = true;
      reason = "account has no password credential; identity confirmed by the signed-in administrator session";
    }

    if (!proved) {
      throw new ConvexError(
        credential.hasPassword
          ? "Enter your current Admin PIN, or your account password, to turn off PIN protection."
          : "Enter your current Admin PIN to turn off PIN protection.",
      );
    }

    await ctx.runMutation(internal.adminPin.clearPin, { actorId: me.userId, actorName: me.name, reason });
    return { ok: true, alreadyDisabled: false };
  },
});

/**
 * "Skip for now": remember that this administrator deliberately chose not to use
 * a PIN, so the panel never asks again. Refused while protection is on (turning
 * it off is `disable`, which requires proof of identity).
 */
export const skip = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await currentUserId(ctx);
    await requirePanelAccess(ctx, userId);
    const row = await settingsRow(ctx, userId);
    if (row?.enabled && row.pinHash) {
      throw new ConvexError("PIN protection is on. Turn it off in Admin Settings instead of skipping.");
    }
    await ctx.runMutation(internal.adminPin.recordSkip, { actorId: userId });
    return { skipped: true };
  },
});

/** Lock the panel immediately: revoke this session's elevation. */
export const lock = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await currentUserId(ctx);
    await requirePanelAccess(ctx, userId);
    const row = await settingsRow(ctx, userId);
    if (row && (row.unlockedUntil !== undefined || row.unlockedSessionId !== undefined)) {
      await ctx.db.patch(row._id, {
        unlockedUntil: undefined,
        unlockedSessionId: undefined,
        updatedAt: Date.now(),
      });
    }
    return { locked: true };
  },
});
