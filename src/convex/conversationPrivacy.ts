import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { Scrypt } from "lucia";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { enforceRateLimit } from "./authHelpers";
import { avatarUrlOf, currentUserId, displayNameOf, presenceInfoOf, profileOf } from "./lib";
import { sendCodeEmail } from "./mailer";

/**
 * ---------------------------------------------------------------------------
 * Locked & Hidden Conversations (personal privacy, enforced server-side)
 * ---------------------------------------------------------------------------
 * A conversation can be protected with a PIN, in one of two modes:
 *
 *   🔒 Lock only      the chat stays in the normal Chats list (with a lock
 *                     icon) but its messages are withheld until the PIN is
 *                     entered.
 *   🔒 Hide & lock    the chat disappears from the normal list, search and
 *                     previews; it is reachable only from Secret Chats (again
 *                     only after the PIN).
 *
 * This is a PERSONAL privacy feature owned by the individual member. It is
 * completely separate from server roles, server moderators and the platform
 * Admin Panel — those never grant or bypass a conversation lock.
 *
 * Security model:
 *  - The PIN is only ever stored as a one-way Scrypt hash; it is never
 *    returned by any query, never logged and never echoed in an error.
 *  - Verification happens on the server (an action, so the CPU-heavy hash never
 *    blocks a query). Attempts are rate limited AND a temporary lockout kicks
 *    in after repeated failures.
 *  - Reading a locked conversation's messages requires a short-lived unlock
 *    grant stored server-side; the frontend cannot assert its way in.
 *  - PIN reset requires proving the account email, then a hashed, expiring,
 *    single-use email code; the PIN is temporarily set to "0000" and the user
 *    must choose a new one before Secret Chats unlocks.
 */

const PIN_PATTERN = /^\d{4,8}$/;
/** The documented temporary PIN used after a reset. Never user-choosable. */
export const TEMPORARY_PIN = "0000";
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
const RESET_TTL_MS = 15 * 60 * 1000;
const MAX_RESET_ATTEMPTS = 5;
const DEFAULT_AUTO_LOCK_MINUTES = 15;
const MAX_AUTO_LOCK_MINUTES = 240;

type Ctx = QueryCtx | MutationCtx;

function assertPinFormat(pin: string, label = "PIN") {
  if (!PIN_PATTERN.test(pin)) throw new ConvexError(`${label} must be 4–8 digits.`);
}

/** A PIN the user chooses for themselves must not be the reserved temp PIN. */
function assertChoosablePin(pin: string) {
  assertPinFormat(pin);
  if (pin === TEMPORARY_PIN) {
    throw new ConvexError("Please choose a PIN other than 0000 — that one is reserved for resets.");
  }
}

function autoLockMinutesOf(row: Doc<"conversationPins"> | null): number {
  const value = row?.autoLockMinutes;
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_AUTO_LOCK_MINUTES;
  return Math.min(Math.max(Math.round(value), 1), MAX_AUTO_LOCK_MINUTES);
}

/** Random 6-digit reset code (crypto-backed, never derived from user data). */
function generateResetCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const n = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return String(n % 1_000_000).padStart(6, "0");
}

// ---------------------------------------------------------------------------
// Shared helpers (also used by dms.ts so both layers agree on one rule set)
// ---------------------------------------------------------------------------

export type ConversationLock = { locked: boolean; hidden: boolean; unlocked: boolean };

/**
 * Is there a live unlock grant for this account (for one chat, or for all)?
 *
 * Grants are scoped to the auth session that entered the PIN and expire on
 * their own, so closing the app, signing out or signing in elsewhere locks the
 * protected conversations again.
 */
export async function hasUnlock(
  ctx: Ctx,
  userId: Id<"users">,
  conversationId?: Id<"dmConversations">,
): Promise<boolean> {
  const now = Date.now();
  const sessionId = await getAuthSessionId(ctx);
  const rows = await ctx.db
    .query("conversationUnlocks")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return rows.some(
    (r) =>
      r.expiresAt > now &&
      (r.sessionId ?? null) === (sessionId ?? null) &&
      (r.conversationId === undefined || (conversationId !== undefined && r.conversationId === conversationId)),
  );
}

/** Effective lock state of one conversation for one member. */
export async function lockStateOf(
  ctx: Ctx,
  userId: Id<"users">,
  membership: Doc<"dmMembers">,
): Promise<ConversationLock> {
  const locked = Boolean(membership.locked);
  if (!locked) return { locked: false, hidden: false, unlocked: true };
  const unlocked = await hasUnlock(ctx, userId, membership.conversationId);
  return { locked: true, hidden: Boolean(membership.hidden), unlocked };
}

// ---------------------------------------------------------------------------
// Internal building blocks
// ---------------------------------------------------------------------------

/**
 * The account's PIN record. `pinHash` is returned here ON PURPOSE — this is an
 * internal-only query that the client can never call.
 */
export const pinRecord = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const row = await ctx.db
      .query("conversationPins")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (!row) return null;
    return {
      hasPin: true,
      pinHash: row.pinHash,
      failedAttempts: row.failedAttempts,
      lockedUntil: row.lockedUntil ?? null,
      mustChangePin: Boolean(row.mustChangePin),
      defaultHidden: row.defaultHidden !== false,
      autoLockMinutes: autoLockMinutesOf(row),
    };
  },
});

/** The account's own email (used to verify a reset request). */
export const accountEmail = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    return { email: user?.email ?? null, emailVerified: Boolean(user?.emailVerificationTime) };
  },
});

/** The member row for a conversation (null when not a member). */
export const membershipOf = internalQuery({
  args: { userId: v.id("users"), conversationId: v.id("dmConversations") },
  handler: async (ctx, { userId, conversationId }) => {
    const row = await ctx.db
      .query("dmMembers")
      .withIndex("by_pair", (q) => q.eq("conversationId", conversationId).eq("userId", userId))
      .unique();
    if (!row) return null;
    return { locked: Boolean(row.locked), hidden: Boolean(row.hidden) };
  },
});

/** Count failed attempts, apply the temporary lockout, and clear it on success. */
export const registerPinAttempt = internalMutation({
  args: { userId: v.id("users"), success: v.boolean() },
  handler: async (ctx, { userId, success }) => {
    await enforceRateLimit(ctx, `pinattempt:${userId}`, 20, 60_000);
    const row = await ctx.db
      .query("conversationPins")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (!row) return;
    if (success) {
      await ctx.db.patch(row._id, { failedAttempts: 0, lockedUntil: undefined, updatedAt: Date.now() });
      return;
    }
    const failed = (row.failedAttempts ?? 0) + 1;
    await ctx.db.patch(row._id, {
      failedAttempts: failed >= MAX_ATTEMPTS ? 0 : failed,
      lockedUntil: failed >= MAX_ATTEMPTS ? Date.now() + LOCKOUT_MS : undefined,
      updatedAt: Date.now(),
    });
  },
});

/** Store (or replace) the hashed PIN. */
export const storePin = internalMutation({
  args: {
    userId: v.id("users"),
    pinHash: v.string(),
    mustChangePin: v.optional(v.boolean()),
    defaultHidden: v.optional(v.boolean()),
    autoLockMinutes: v.optional(v.number()),
  },
  handler: async (ctx, { userId, ...values }) => {
    const row = await ctx.db
      .query("conversationPins")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    const patch = {
      pinHash: values.pinHash,
      mustChangePin: values.mustChangePin ?? false,
      failedAttempts: 0,
      lockedUntil: undefined,
      updatedAt: Date.now(),
    };
    if (row) await ctx.db.patch(row._id, patch);
    else
      await ctx.db.insert("conversationPins", {
        userId,
        ...patch,
        defaultHidden: values.defaultHidden ?? true,
        autoLockMinutes: values.autoLockMinutes ?? DEFAULT_AUTO_LOCK_MINUTES,
      });
  },
});

/** Issue (or extend) an unlock grant for one conversation, or for all of them. */
export const grantUnlock = internalMutation({
  args: {
    userId: v.id("users"),
    conversationId: v.optional(v.id("dmConversations")),
    minutes: v.number(),
  },
  handler: async (ctx, { userId, conversationId, minutes }) => {
    const expiresAt = Date.now() + Math.min(Math.max(minutes, 1), MAX_AUTO_LOCK_MINUTES) * 60_000;
    // Read the session inside the mutation: this is the session that proved the
    // PIN, and only it may read the protected messages.
    const sessionId = (await getAuthSessionId(ctx)) ?? undefined;
    const rows = await ctx.db
      .query("conversationUnlocks")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const existing = rows.find(
      (r) =>
        (r.conversationId ?? null) === (conversationId ?? null) && (r.sessionId ?? null) === (sessionId ?? null),
    );
    if (existing) await ctx.db.patch(existing._id, { expiresAt });
    else await ctx.db.insert("conversationUnlocks", { userId, conversationId, expiresAt, sessionId });
  },
});

/** Revoke unlock grants (all of them, or just one conversation). */
export const revokeUnlocks = internalMutation({
  args: { userId: v.id("users"), conversationId: v.optional(v.id("dmConversations")) },
  handler: async (ctx, { userId, conversationId }) => {
    const rows = await ctx.db
      .query("conversationUnlocks")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const row of rows) {
      if (conversationId === undefined || row.conversationId === conversationId || row.conversationId === undefined) {
        await ctx.db.delete(row._id);
      }
    }
  },
});

/** Flip a conversation between visible / hidden and locked / unlocked. */
export const setMembershipLock = internalMutation({
  args: {
    userId: v.id("users"),
    conversationId: v.id("dmConversations"),
    locked: v.boolean(),
    hidden: v.boolean(),
  },
  handler: async (ctx, { userId, conversationId, locked, hidden }) => {
    const row = await ctx.db
      .query("dmMembers")
      .withIndex("by_pair", (q) => q.eq("conversationId", conversationId).eq("userId", userId))
      .unique();
    if (!row) throw new ConvexError("You're not part of this conversation.");
    await ctx.db.patch(row._id, { locked, hidden: locked ? hidden : false });
  },
});

/** Remove the PIN entirely: delete it, drop grants and release every lock. */
export const removePinEverywhere = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const pin = await ctx.db
      .query("conversationPins")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (pin) await ctx.db.delete(pin._id);
    for (const row of await ctx.db.query("conversationUnlocks").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) {
      await ctx.db.delete(row._id);
    }
    for (const row of await ctx.db.query("pinResets").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) {
      await ctx.db.delete(row._id);
    }
    for (const member of await ctx.db.query("dmMembers").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) {
      if (member.locked || member.hidden) await ctx.db.patch(member._id, { locked: false, hidden: false });
    }
  },
});

/** Rate limiting for the reset request/verify paths (mutations can write). */
export const enforceResetLimit = internalMutation({
  args: { userId: v.id("users"), scope: v.string(), limit: v.number(), windowMs: v.number() },
  handler: async (ctx, { userId, scope, limit, windowMs }) => {
    await enforceRateLimit(ctx, `${scope}:${userId}`, limit, windowMs);
  },
});

/** Store a fresh reset code, invalidating any previous one. */
export const storeReset = internalMutation({
  args: { userId: v.id("users"), email: v.string(), codeHash: v.string(), expiresAt: v.number() },
  handler: async (ctx, { userId, email, codeHash, expiresAt }) => {
    for (const row of await ctx.db.query("pinResets").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) {
      await ctx.db.delete(row._id);
    }
    await ctx.db.insert("pinResets", { userId, email, codeHash, expiresAt, attempts: 0 });
  },
});

/** The live reset code row for an account (internal: contains the hash). */
export const resetRecord = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const row = await ctx.db
      .query("pinResets")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (!row) return null;
    return { codeHash: row.codeHash, expiresAt: row.expiresAt, attempts: row.attempts, email: row.email };
  },
});

export const registerResetAttempt = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const row = await ctx.db
      .query("pinResets")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (row) await ctx.db.patch(row._id, { attempts: (row.attempts ?? 0) + 1 });
  },
});

export const clearReset = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    for (const row of await ctx.db.query("pinResets").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) {
      await ctx.db.delete(row._id);
    }
  },
});

// ---------------------------------------------------------------------------
// PIN verification (server-side only)
// ---------------------------------------------------------------------------

type PinRecord = {
  hasPin: boolean;
  pinHash: string;
  failedAttempts: number;
  lockedUntil: number | null;
  mustChangePin: boolean;
  defaultHidden: boolean;
  autoLockMinutes: number;
};

/**
 * Verify a PIN for the signed-in account. Throws a ConvexError on any failure
 * (never echoing the PIN) and records the attempt so the lockout is enforced.
 */
async function verifyPinForUser(
  ctx: ActionCtx,
  userId: Id<"users">,
  pin: string,
): Promise<PinRecord> {
  const rec = (await ctx.runQuery(internal.conversationPrivacy.pinRecord, { userId })) as PinRecord | null;
  if (!rec?.hasPin) throw new ConvexError("No PIN is set for this account yet.");
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) {
    const seconds = Math.ceil((rec.lockedUntil - Date.now()) / 1000);
    throw new ConvexError(`Too many incorrect attempts. Please try again in ${seconds}s.`);
  }
  assertPinFormat(pin);
  let valid = false;
  try {
    valid = await new Scrypt().verify(rec.pinHash, pin);
  } catch {
    valid = false;
  }
  await ctx.runMutation(internal.conversationPrivacy.registerPinAttempt, { userId, success: valid });
  if (!valid) throw new ConvexError("Incorrect PIN.");
  return rec;
}

async function requirePinSet(ctx: ActionCtx, userId: Id<"users">): Promise<PinRecord> {
  const rec = (await ctx.runQuery(internal.conversationPrivacy.pinRecord, { userId })) as PinRecord | null;
  if (!rec?.hasPin) throw new ConvexError("Set a PIN first.");
  return rec;
}

async function requireMembership(ctx: ActionCtx, userId: Id<"users">, conversationId: Id<"dmConversations">) {
  const member = await ctx.runQuery(internal.conversationPrivacy.membershipOf, { userId, conversationId });
  if (!member) throw new ConvexError("You're not part of this conversation.");
  return member;
}

// ---------------------------------------------------------------------------
// Queries (safe, client-callable)
// ---------------------------------------------------------------------------

/** Lock/PIN state for the signed-in account (never includes any hash). */
export const pinState = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return { hasPin: false, mustChangePin: false, defaultHidden: true, autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES, lockedUntil: null, failedAttempts: 0, lockedCount: 0, hiddenCount: 0 };
    }
    const row = await ctx.db
      .query("conversationPins")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    const memberships = await ctx.db
      .query("dmMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const locked = memberships.filter((m) => m.locked);
    return {
      hasPin: Boolean(row),
      mustChangePin: Boolean(row?.mustChangePin),
      defaultHidden: row?.defaultHidden !== false,
      autoLockMinutes: autoLockMinutesOf(row),
      lockedUntil: row?.lockedUntil ?? null,
      failedAttempts: row?.failedAttempts ?? 0,
      lockedCount: locked.length,
      hiddenCount: locked.filter((m) => m.hidden).length,
    };
  },
});

/**
 * Secret Chats. Requires a live "all conversations" unlock grant — finding the
 * screen (or calling this query) is not enough. While the PIN is still the
 * temporary "0000" the list stays empty and `mustChangePin` is set, so the user
 * has to choose a new PIN before anything is revealed.
 */
export const secretChats = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    const empty = { unlocked: false, mustChangePin: false, conversations: [] as never[] };
    if (!userId) return empty;
    const rec = await ctx.db
      .query("conversationPins")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    const mustChangePin = Boolean(rec?.mustChangePin);
    const unlocked = await hasUnlock(ctx, userId);
    if (!unlocked) return { unlocked: false, mustChangePin, conversations: [] as never[] };
    if (mustChangePin) return { unlocked: true, mustChangePin: true, conversations: [] as never[] };

    const memberships = await ctx.db
      .query("dmMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const conversations = [];
    for (const membership of memberships) {
      if (!membership.locked) continue;
      const convo = await ctx.db.get(membership.conversationId);
      if (!convo) continue;
      const members = await ctx.db
        .query("dmMembers")
        .withIndex("by_conversation", (q) => q.eq("conversationId", convo._id))
        .collect();
      const others = members.filter((m) => m.userId !== userId);
      const otherUser = others[0] ? await ctx.db.get(others[0].userId) : null;
      const otherProfile = others[0] ? await profileOf(ctx, others[0].userId) : null;
      const messages = await ctx.db
        .query("dmMessages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", convo._id))
        .collect();
      const lastRead = membership.lastReadAt ?? 0;
      const unread = messages.filter((m) => m.userId !== userId && m._creationTime > lastRead && !m.deleted).length;
      const sorted = messages.sort((a, b) => a._creationTime - b._creationTime);
      const last = sorted.length > 0 ? sorted[sorted.length - 1] : undefined;
      let presence = "offline";
      if (others[0]) presence = (await presenceInfoOf(ctx, others[0].userId, userId)).status;
      conversations.push({
        conversationId: convo._id,
        type: convo.type,
        name:
          convo.type === "group"
            ? convo.name ?? "Group"
            : otherProfile?.displayName ?? otherUser?.name ?? otherUser?.username ?? "Conversation",
        hidden: Boolean(membership.hidden),
        iconColor: convo.iconColor ?? "violet",
        avatarUrl: others[0] ? await avatarUrlOf(ctx, others[0].userId) : null,
        decorationId: otherProfile?.decorationId ?? null,
        memberCount: members.length,
        presence,
        unread,
        lastMessageAt: convo.lastMessageAt,
        lastMessage: last && !last.deleted ? last.body.slice(0, 90) : "",
      });
    }
    conversations.sort((a, b) => Number(b.hidden) - Number(a.hidden) || b.lastMessageAt - a.lastMessageAt);
    return { unlocked: true, mustChangePin, conversations };
  },
});

// ---------------------------------------------------------------------------
// PIN lifecycle actions (crypto happens here, never in a query)
// ---------------------------------------------------------------------------

/**
 * Create the PIN, or replace it. Replacing always requires the current PIN
 * (after a reset that is the temporary "0000", which the user has just typed).
 */
export const setPin = action({
  args: {
    pin: v.string(),
    confirmPin: v.string(),
    currentPin: v.optional(v.string()),
  },
  handler: async (ctx, { pin, confirmPin, currentPin }): Promise<{ ok: true }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Please sign in first.");
    assertChoosablePin(pin);
    if (pin !== confirmPin) throw new ConvexError("Those PINs don't match.");
    await ctx.runMutation(internal.conversationPrivacy.enforceResetLimit, {
      userId, scope: "pinchange", limit: 8, windowMs: 60_000,
    });

    const rec = (await ctx.runQuery(internal.conversationPrivacy.pinRecord, { userId })) as PinRecord | null;
    if (rec?.hasPin) {
      if (!currentPin) throw new ConvexError("Enter your current PIN.");
      await verifyPinForUser(ctx, userId, currentPin);
    }
    const pinHash = await new Scrypt().hash(pin);
    await ctx.runMutation(internal.conversationPrivacy.storePin, { userId, pinHash, mustChangePin: false });
    return { ok: true };
  },
});

/**
 * Unlock ONE conversation (the Lock Only prompt) for a limited time.
 *
 * While the PIN is still the temporary "0000" left by a reset, verification
 * succeeds but NO access is granted — the caller is told to change the PIN
 * first, so the temp PIN can never actually reveal messages.
 */
export const unlockConversation = action({
  args: { conversationId: v.id("dmConversations"), pin: v.string() },
  handler: async (ctx, { conversationId, pin }): Promise<{ ok: true; granted: boolean; mustChangePin: boolean }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Please sign in first.");
    await requireMembership(ctx, userId, conversationId);
    const rec = await verifyPinForUser(ctx, userId, pin);
    if (rec.mustChangePin) return { ok: true, granted: false, mustChangePin: true };
    await ctx.runMutation(internal.conversationPrivacy.grantUnlock, {
      userId, conversationId, minutes: rec.autoLockMinutes,
    });
    return { ok: true, granted: true, mustChangePin: false };
  },
});

/**
 * Unlock Secret Chats: verifies the PIN, then grants access to every lock.
 * Same temporary-PIN rule: nothing is revealed until a real PIN is chosen.
 */
export const unlockSecretChats = action({
  args: { pin: v.string() },
  handler: async (ctx, { pin }): Promise<{ ok: true; granted: boolean; mustChangePin: boolean }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Please sign in first.");
    const rec = await verifyPinForUser(ctx, userId, pin);
    if (rec.mustChangePin) return { ok: true, granted: false, mustChangePin: true };
    await ctx.runMutation(internal.conversationPrivacy.grantUnlock, {
      userId, minutes: rec.autoLockMinutes,
    });
    return { ok: true, granted: true, mustChangePin: false };
  },
});

/**
 * Replace the temporary PIN. Only the caller who proved the temp PIN can do
 * this, and it is the only route out of the `mustChangePin` state.
 */
export const finishPinReset = action({
  args: { currentPin: v.string(), pin: v.string(), confirmPin: v.string() },
  handler: async (ctx, { currentPin, pin, confirmPin }): Promise<{ ok: true; granted: boolean }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Please sign in first.");
    assertChoosablePin(pin);
    if (pin !== confirmPin) throw new ConvexError("Those PINs don't match.");
    await ctx.runMutation(internal.conversationPrivacy.enforceResetLimit, {
      userId, scope: "pinchange", limit: 8, windowMs: 60_000,
    });
    const rec = (await ctx.runQuery(internal.conversationPrivacy.pinRecord, { userId })) as PinRecord | null;
    if (!rec?.hasPin) throw new ConvexError("No PIN is set for this account yet.");
    if (!rec.mustChangePin) throw new ConvexError("Use Change PIN instead.");
    await verifyPinForUser(ctx, userId, currentPin);
    const pinHash = await new Scrypt().hash(pin);
    await ctx.runMutation(internal.conversationPrivacy.storePin, { userId, pinHash, mustChangePin: false });
    // The freshly chosen PIN also opens Secret Chats for this session.
    await ctx.runMutation(internal.conversationPrivacy.grantUnlock, {
      userId, minutes: rec.autoLockMinutes,
    });
    return { ok: true, granted: true };
  },
});

/**
 * Protect a conversation. Creates the PIN when there isn't one yet (with
 * confirmation), otherwise verifies the existing PIN first.
 */
export const protectConversation = action({
  args: {
    conversationId: v.id("dmConversations"),
    hidden: v.boolean(),
    pin: v.string(),
    confirmPin: v.optional(v.string()),
  },
  handler: async (ctx, { conversationId, hidden, pin, confirmPin }): Promise<{ ok: true; createdPin: boolean }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Please sign in first.");
    await requireMembership(ctx, userId, conversationId);
    const rec = (await ctx.runQuery(internal.conversationPrivacy.pinRecord, { userId })) as PinRecord | null;

    let createdPin = false;
    if (!rec?.hasPin) {
      assertChoosablePin(pin);
      if (pin !== (confirmPin ?? "")) throw new ConvexError("Those PINs don't match.");
      const pinHash = await new Scrypt().hash(pin);
      await ctx.runMutation(internal.conversationPrivacy.storePin, { userId, pinHash, mustChangePin: false });
      createdPin = true;
    } else {
      await verifyPinForUser(ctx, userId, pin);
    }

    await ctx.runMutation(internal.conversationPrivacy.setMembershipLock, {
      userId, conversationId, locked: true, hidden,
    });
    // The conversation locks immediately: drop any grant that covered it.
    await ctx.runMutation(internal.conversationPrivacy.revokeUnlocks, { userId, conversationId });
    return { ok: true, createdPin };
  },
});

/** Move a locked conversation between visible ("lock only") and hidden. */
export const setConversationHidden = action({
  args: { conversationId: v.id("dmConversations"), hidden: v.boolean(), pin: v.string() },
  handler: async (ctx, { conversationId, hidden, pin }): Promise<{ ok: true }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Please sign in first.");
    await requireMembership(ctx, userId, conversationId);
    await verifyPinForUser(ctx, userId, pin);
    await ctx.runMutation(internal.conversationPrivacy.setMembershipLock, {
      userId, conversationId, locked: true, hidden,
    });
    return { ok: true };
  },
});

/** Remove protection from a conversation (requires the PIN). */
export const unprotectConversation = action({
  args: { conversationId: v.id("dmConversations"), pin: v.string() },
  handler: async (ctx, { conversationId, pin }): Promise<{ ok: true }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Please sign in first.");
    await requireMembership(ctx, userId, conversationId);
    await verifyPinForUser(ctx, userId, pin);
    await ctx.runMutation(internal.conversationPrivacy.setMembershipLock, {
      userId, conversationId, locked: false, hidden: false,
    });
    await ctx.runMutation(internal.conversationPrivacy.revokeUnlocks, { userId, conversationId });
    return { ok: true };
  },
});

/** Remove the PIN completely and release every protected conversation. */
export const removePin = action({
  args: { pin: v.string() },
  handler: async (ctx, { pin }): Promise<{ ok: true }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Please sign in first.");
    await verifyPinForUser(ctx, userId, pin);
    await ctx.runMutation(internal.conversationPrivacy.removePinEverywhere, { userId });
    return { ok: true };
  },
});

/**
 * Non-sensitive preferences. Reachable only once a PIN exists; the UI surfaces
 * it inside the PIN-gated Secret Chats screen.
 */
export const updatePinSettings = mutation({
  args: { defaultHidden: v.optional(v.boolean()), autoLockMinutes: v.optional(v.number()) },
  handler: async (ctx, { defaultHidden, autoLockMinutes }) => {
    const userId = await currentUserId(ctx);
    if (autoLockMinutes !== undefined && (autoLockMinutes < 1 || autoLockMinutes > MAX_AUTO_LOCK_MINUTES)) {
      throw new ConvexError(`Auto-lock must be between 1 and ${MAX_AUTO_LOCK_MINUTES} minutes.`);
    }
    const row = await ctx.db
      .query("conversationPins")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (!row) throw new ConvexError("Set a PIN first.");
    await ctx.db.patch(row._id, {
      ...(defaultHidden === undefined ? {} : { defaultHidden }),
      ...(autoLockMinutes === undefined ? {} : { autoLockMinutes: Math.round(autoLockMinutes) }),
      updatedAt: Date.now(),
    });
    return { ok: true };
  },
});

/** Re-lock now (drops unlock grants). Safe direction, so no PIN is required. */
export const relock = mutation({
  args: { conversationId: v.optional(v.id("dmConversations")) },
  handler: async (ctx, { conversationId }) => {
    const userId = await currentUserId(ctx);
    const rows = await ctx.db
      .query("conversationUnlocks")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const row of rows) {
      if (conversationId === undefined || row.conversationId === conversationId || row.conversationId === undefined) {
        await ctx.db.delete(row._id);
      }
    }
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Forgot PIN: prove the account email, then a hashed expiring email code
// ---------------------------------------------------------------------------

/** Send a one-time PIN reset code to the account's own email address. */
export const requestPinReset = action({
  args: {},
  handler: async (ctx): Promise<{ sent: true; expiresInMinutes: number }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Please sign in first.");
    await ctx.runMutation(internal.conversationPrivacy.enforceResetLimit, {
      userId, scope: "pinreset", limit: 3, windowMs: 10 * 60_000,
    });
    const account = await ctx.runQuery(internal.conversationPrivacy.accountEmail, { userId });
    if (!account.email) {
      throw new ConvexError("This account has no email address, so it can't receive a reset code.");
    }
    const code = generateResetCode();
    const codeHash = await new Scrypt().hash(code);
    await ctx.runMutation(internal.conversationPrivacy.storeReset, {
      userId,
      email: account.email,
      codeHash,
      expiresAt: Date.now() + RESET_TTL_MS,
    });
    try {
      await sendCodeEmail({ to: account.email, code, subject: "Your FreeBuff Secret Chats PIN reset code" });
    } catch {
      await ctx.runMutation(internal.conversationPrivacy.clearReset, { userId });
      throw new ConvexError("We couldn't send the reset email. Please try again in a moment.");
    }
    return { sent: true, expiresInMinutes: Math.round(RESET_TTL_MS / 60_000) };
  },
});

/** Confirm the emailed code. On success the PIN becomes the temporary 0000. */
export const verifyPinResetCode = action({
  args: { code: v.string() },
  handler: async (ctx, { code }): Promise<{ ok: true; temporaryPin: boolean; mustChangePin: true }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Please sign in first.");
    await ctx.runMutation(internal.conversationPrivacy.enforceResetLimit, {
      userId, scope: "pinresetverify", limit: 10, windowMs: 10 * 60_000,
    });
    const record = await ctx.runQuery(internal.conversationPrivacy.resetRecord, { userId });
    if (!record) throw new ConvexError("Request a new reset code first.");
    if (record.expiresAt < Date.now()) {
      await ctx.runMutation(internal.conversationPrivacy.clearReset, { userId });
      throw new ConvexError("That reset code has expired. Please request a new one.");
    }
    if ((record.attempts ?? 0) >= MAX_RESET_ATTEMPTS) {
      await ctx.runMutation(internal.conversationPrivacy.clearReset, { userId });
      throw new ConvexError("Too many incorrect codes. Please request a new one.");
    }
    const entered = code.replace(/\D/g, "");
    let valid = false;
    try {
      valid = entered.length > 0 && (await new Scrypt().verify(record.codeHash, entered));
    } catch {
      valid = false;
    }
    if (!valid) {
      await ctx.runMutation(internal.conversationPrivacy.registerResetAttempt, { userId });
      throw new ConvexError("That reset code is incorrect.");
    }
    const tempHash = await new Scrypt().hash(TEMPORARY_PIN);
    await ctx.runMutation(internal.conversationPrivacy.storePin, { userId, pinHash: tempHash, mustChangePin: true });
    await ctx.runMutation(internal.conversationPrivacy.revokeUnlocks, { userId });
    await ctx.runMutation(internal.conversationPrivacy.clearReset, { userId });
    return { ok: true, temporaryPin: true, mustChangePin: true };
  },
});

/** Does the account have an email that a reset code could be sent to? */
export const resetAvailability = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { hasEmail: false, email: null as string | null, hasPin: false };
    const user = await ctx.db.get(userId);
    const pin = await ctx.db
      .query("conversationPins")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    return { hasEmail: Boolean(user?.email), email: user?.email ?? null, hasPin: Boolean(pin) };
  },
});

/** Display name for the Secret Chats header (kept tiny and leak-free). */
export const myCard = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    return { userId, displayName: await displayNameOf(ctx, userId) };
  },
});
