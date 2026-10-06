import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

/**
 * Synthetic / test-data cleanup.
 *
 * The Freecord `.mjs` test suites create accounts through the normal password
 * sign-up path with generated usernames of the form `<label>_<stamp>` (see
 * `stamp = Date.now().toString(36)` in the suites). Because dev and production
 * share one Convex deployment, those accounts leaked into the production user
 * table and appear in the Admin Panel.
 *
 * This module identifies those accounts by PROVENANCE — not by display name:
 *   - the username matches the generator's `<label>_<stamp>` shape, AND
 *   - the account has a password credential (every generated account has one), AND
 *   - the account has no email, or only a clearly-test email domain.
 *
 * Real accounts with unusual names (e.g. `deli`, `kameeyah16`) do NOT match the
 * shape, and any account with a real email domain is never touched. Nothing is
 * deleted automatically: `purgeSyntheticUsers` must be invoked explicitly and is
 * bounded, so it can never run away or exceed a transaction limit.
 */

const SYNTHETIC_USERNAME = /^[a-z0-9]+(_[a-z0-9]+)*_[a-z0-9]{6,10}$/;
const TEST_EMAIL_SUFFIXES = ["@example.com", "@example.invalid", "@example.org", "@test.local", "@test.example"];

type UserRow = { _id: Id<"users">; username?: string | null; email?: string | null; _creationTime: number };

function isSynthetic(user: UserRow, userIdsWithPassword: Set<string>) {
  const username = user.username ?? "";
  if (!SYNTHETIC_USERNAME.test(username)) return false;
  // Generated accounts always authenticate with a password credential.
  if (!userIdsWithPassword.has(user._id as string)) return false;
  const email = user.email ?? "";
  if (email && !TEST_EMAIL_SUFFIXES.some((suffix) => email.endsWith(suffix))) return false;
  return true;
}

async function collectSynthetic(ctx: QueryCtx | MutationCtx) {
  const users = (await ctx.db.query("users").collect()) as UserRow[];
  const accounts = await ctx.db.query("authAccounts").collect();
  const withPassword = new Set<string>();
  for (const account of accounts) {
    if (account.provider === "password") withPassword.add(account.userId as string);
  }
  return users.filter((u) => isSynthetic(u, withPassword));
}

/** Read-only: how many synthetic users exist, and a safe sample (no secrets). */
export const syntheticUserSample = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const synthetic = await collectSynthetic(ctx);
    const take = Math.max(1, Math.min(limit ?? 25, 200));
    return {
      totalUsers: (await ctx.db.query("users").collect()).length,
      syntheticCount: synthetic.length,
      sample: synthetic
        .sort((a, b) => b._creationTime - a._creationTime)
        .slice(0, take)
        .map((u) => ({ userId: u._id as string, username: u.username ?? "" })),
    };
  },
});

/**
 * Admin-only diagnostic surfaced in the Admin Panel: counts synthetic records
 * that have leaked into production. It NEVER deletes anything.
 */
export const syntheticAudit = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const me = await ctx.db.get(userId);
    if (me?.role !== "owner_admin" && me?.role !== "owner" && me?.role !== "admin") return null;
    const synthetic = await collectSynthetic(ctx);
    const orphans = await collectOrphans(ctx);
    return {
      totalUsers: (await ctx.db.query("users").collect()).length,
      syntheticCount: synthetic.length,
      sample: synthetic.slice(0, 10).map((u) => u.username ?? ""),
      orphanCount: countOrphans(orphans),
    };
  },
});

/**
 * Delete a stored file, tolerating objects that are already gone.
 *
 * Some synthetic accounts were created by test suites that uploaded then
 * removed files, leaving attachment rows pointing at a storage object that no
 * longer exists. `ctx.storage.delete` throws "storage id ... not found" for
 * those, which would abort the whole transaction and stall the purge. A missing
 * object is exactly the state we want, so it must not be fatal.
 */
async function deleteStoredFile(ctx: MutationCtx, storageId: Id<"_storage">) {
  try {
    await ctx.storage.delete(storageId);
  } catch {
    // Already deleted (or never persisted) — nothing left to clean up.
  }
}

/** Immediately invalidate every session for a purged account. */
async function killSessions(ctx: MutationCtx, userId: Id<"users">) {
  const sessions = await ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", userId)).collect();
  for (const session of sessions) {
    const tokens = await ctx.db.query("authRefreshTokens").withIndex("sessionId", (q) => q.eq("sessionId", session._id)).collect();
    for (const token of tokens) await ctx.db.delete(token._id);
    await ctx.db.delete(session._id);
  }
}

/** Delete everything a single synthetic account owns/participates in. */
async function purgeOne(ctx: MutationCtx, userId: Id<"users">) {
  // Owned communities (test communities) and all of their content.
  const ownedServers = (await ctx.db.query("servers").collect()).filter((s) => s.ownerId === userId);
  for (const server of ownedServers) {
    for (const channel of await ctx.db.query("channels").withIndex("by_server", (q) => q.eq("serverId", server._id)).collect()) {
      for (const message of await ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("channelId", channel._id)).collect()) {
        for (const reaction of await ctx.db.query("reactions").withIndex("by_message", (q) => q.eq("messageId", message._id)).collect()) await ctx.db.delete(reaction._id);
        for (const file of await ctx.db.query("attachments").withIndex("by_message", (q) => q.eq("messageId", message._id)).collect()) {
          await deleteStoredFile(ctx, file.storageId);
          await ctx.db.delete(file._id);
        }
        await ctx.db.delete(message._id);
      }
      for (const session of await ctx.db.query("voiceSessions").withIndex("by_channel", (q) => q.eq("channelId", channel._id)).collect()) await ctx.db.delete(session._id);
      await ctx.db.delete(channel._id);
    }
    for (const category of await ctx.db.query("channelCategories").withIndex("by_server", (q) => q.eq("serverId", server._id)).collect()) await ctx.db.delete(category._id);
    for (const membership of await ctx.db.query("memberships").withIndex("by_server", (q) => q.eq("serverId", server._id)).collect()) await ctx.db.delete(membership._id);
    for (const role of await ctx.db.query("communityRoles").withIndex("by_server", (q) => q.eq("serverId", server._id)).collect()) await ctx.db.delete(role._id);
    for (const invite of await ctx.db.query("invites").withIndex("by_server", (q) => q.eq("serverId", server._id)).collect()) await ctx.db.delete(invite._id);
    for (const ban of await ctx.db.query("bans").withIndex("by_server", (q) => q.eq("serverId", server._id)).collect()) await ctx.db.delete(ban._id);
    await ctx.db.delete(server._id);
  }

  // The conversations this account belonged to — so we can drop empty ones.
  const memberships = await ctx.db.query("dmMembers").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
  const conversationIds = [...new Set(memberships.map((m) => m.conversationId))];
  for (const membership of memberships) await ctx.db.delete(membership._id);
  for (const conversationId of conversationIds) {
    const remaining = await ctx.db.query("dmMembers").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect();
    if (remaining.length > 0) continue; // a real participant still uses it — keep it
    for (const message of await ctx.db.query("dmMessages").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect()) {
      for (const reaction of await ctx.db.query("dmReactions").withIndex("by_message", (q) => q.eq("messageId", message._id)).collect()) await ctx.db.delete(reaction._id);
      for (const file of await ctx.db.query("attachments").withIndex("by_dm_message", (q) => q.eq("dmMessageId", message._id)).collect()) {
        await deleteStoredFile(ctx, file.storageId);
        await ctx.db.delete(file._id);
      }
      await ctx.db.delete(message._id);
    }
    for (const signal of await ctx.db.query("dmCallSignals").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect()) await ctx.db.delete(signal._id);
    await ctx.db.delete(conversationId);
  }

  // Indexed per-user rows across the app.
  for (const membership of await ctx.db.query("memberships").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) await ctx.db.delete(membership._id);
  for (const profile of await ctx.db.query("memberProfiles").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) await ctx.db.delete(profile._id);
  for (const pin of await ctx.db.query("conversationPins").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) await ctx.db.delete(pin._id);
  for (const unlock of await ctx.db.query("conversationUnlocks").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) await ctx.db.delete(unlock._id);
  for (const reset of await ctx.db.query("pinResets").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) await ctx.db.delete(reset._id);
  for (const typing of await ctx.db.query("typing").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) await ctx.db.delete(typing._id);
  for (const visibility of await ctx.db.query("messageVisibility").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) await ctx.db.delete(visibility._id);
  for (const session of await ctx.db.query("voiceSessions").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) await ctx.db.delete(session._id);
  for (const org of await ctx.db.query("serverOrganization").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) await ctx.db.delete(org._id);

  const presence = await ctx.db.query("presence").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
  if (presence) await ctx.db.delete(presence._id);
  const profile = await ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
  if (profile) {
    if (profile.avatarStorageId) await deleteStoredFile(ctx, profile.avatarStorageId);
    if (profile.bannerStorageId) await deleteStoredFile(ctx, profile.bannerStorageId);
    await ctx.db.delete(profile._id);
  }
  const appearance = await ctx.db.query("appearance").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
  if (appearance) await ctx.db.delete(appearance._id);
  const settings = await ctx.db.query("userSettings").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
  if (settings) await ctx.db.delete(settings._id);

  for (const request of await ctx.db.query("friendRequests").withIndex("by_from", (q) => q.eq("fromId", userId)).collect()) await ctx.db.delete(request._id);
  for (const request of await ctx.db.query("friendRequests").withIndex("by_to", (q) => q.eq("toId", userId)).collect()) await ctx.db.delete(request._id);
  for (const friendship of await ctx.db.query("friendships").withIndex("by_a", (q) => q.eq("userA", userId)).collect()) await ctx.db.delete(friendship._id);
  for (const friendship of await ctx.db.query("friendships").withIndex("by_b", (q) => q.eq("userB", userId)).collect()) await ctx.db.delete(friendship._id);
  for (const follow of await ctx.db.query("follows").withIndex("by_follower", (q) => q.eq("followerId", userId)).collect()) await ctx.db.delete(follow._id);
  for (const follow of await ctx.db.query("follows").withIndex("by_following", (q) => q.eq("followingId", userId)).collect()) await ctx.db.delete(follow._id);
  for (const block of await ctx.db.query("blocks").withIndex("by_blocker", (q) => q.eq("blockerId", userId)).collect()) await ctx.db.delete(block._id);
  for (const block of await ctx.db.query("blocks").withIndex("by_blocked", (q) => q.eq("blockedId", userId)).collect()) await ctx.db.delete(block._id);
  for (const notification of await ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) await ctx.db.delete(notification._id);
  for (const invite of await ctx.db.query("callInvites").withIndex("by_from", (q) => q.eq("fromId", userId)).collect()) await ctx.db.delete(invite._id);
  for (const invite of await ctx.db.query("callInvites").withIndex("by_to", (q) => q.eq("toId", userId)).collect()) await ctx.db.delete(invite._id);

  // Authentication identities + verification codes + sessions.
  const accounts = await ctx.db.query("authAccounts").withIndex("userIdAndProvider", (q) => q.eq("userId", userId)).collect();
  for (const account of accounts) {
    for (const code of await ctx.db.query("authVerificationCodes").withIndex("accountId", (q) => q.eq("accountId", account._id)).collect()) await ctx.db.delete(code._id);
    await ctx.db.delete(account._id);
  }
  await killSessions(ctx, userId);
  await ctx.db.delete(userId);
}

/**
 * Bounded purge. Deletes at most `limit` positively-identified synthetic users
 * per invocation (default 20). `dryRun` returns what WOULD be deleted without
 * deleting. Returns `remainingSynthetic` so a caller can loop until zero.
 */
export const purgeSyntheticUsers = internalMutation({
  args: { limit: v.optional(v.number()), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { limit, dryRun }) => {
    const synthetic = await collectSynthetic(ctx);
    const take = Math.max(1, Math.min(limit ?? 20, 50));
    const batch = synthetic.slice(0, take).map((u) => ({ userId: u._id, username: u.username ?? "" }));

    if (dryRun) {
      return { dryRun: true, pending: batch, deletedCount: 0, remainingSynthetic: synthetic.length };
    }

    for (const { userId } of batch) await purgeOne(ctx, userId);
    return {
      dryRun: false,
      deleted: batch.map((b) => b.username),
      deletedCount: batch.length,
      remainingSynthetic: synthetic.length - batch.length,
    };
  },
});

/**
 * Rows that reference a parent which no longer exists — leftover test-data
 * debris from earlier runs that could not be reached by any real user.
 *
 * Only three kinds of parent are considered "gone": a user, a community, or a
 * conversation. A row whose parent still resolves is never collected, so real
 * data cannot be selected here.
 */
async function collectOrphans(ctx: QueryCtx | MutationCtx) {
  const userIds = new Set((await ctx.db.query("users").collect()).map((u) => u._id as string));
  const serverIds = new Set((await ctx.db.query("servers").collect()).map((s) => s._id as string));
  const channelIds = new Set((await ctx.db.query("channels").collect()).map((c) => c._id as string));

  const conversations = await ctx.db.query("dmConversations").collect();
  const conversationIds = new Set(conversations.map((c) => c._id as string));
  const dmMembers = await ctx.db.query("dmMembers").collect();
  const memberCount = new Map<string, number>();
  for (const member of dmMembers) {
    const key = member.conversationId as string;
    memberCount.set(key, (memberCount.get(key) ?? 0) + 1);
  }
  // A conversation with no members is unreachable by everyone.
  const emptyConversations = conversations.filter((c) => (memberCount.get(c._id as string) ?? 0) === 0);
  const emptyConversationIds = new Set(emptyConversations.map((c) => c._id as string));

  const orphanCategories = (await ctx.db.query("channelCategories").collect()).filter(
    (c) => !serverIds.has(c.serverId as string),
  );
  const orphanChannels = (await ctx.db.query("channels").collect()).filter(
    (c) => !serverIds.has(c.serverId as string),
  );

  const messages = await ctx.db.query("messages").collect();
  const messageIds = new Set(messages.map((m) => m._id as string));
  const orphanMessages = messages.filter(
    (m) => !channelIds.has(m.channelId as string) || !userIds.has(m.userId as string),
  );
  const orphanMessageIds = new Set(orphanMessages.map((m) => m._id as string));

  const dmMessages = await ctx.db.query("dmMessages").collect();
  const dmMessageIds = new Set(dmMessages.map((m) => m._id as string));
  const orphanDmMessages = dmMessages.filter(
    (m) =>
      !conversationIds.has(m.conversationId as string) ||
      emptyConversationIds.has(m.conversationId as string) ||
      !userIds.has(m.userId as string),
  );
  const orphanDmMessageIds = new Set(orphanDmMessages.map((m) => m._id as string));

  const orphanAttachments = (await ctx.db.query("attachments").collect()).filter((a) => {
    const messageGone = a.messageId ? !messageIds.has(a.messageId as string) || orphanMessageIds.has(a.messageId as string) : true;
    const dmMessageGone = a.dmMessageId ? !dmMessageIds.has(a.dmMessageId as string) || orphanDmMessageIds.has(a.dmMessageId as string) : true;
    return messageGone && dmMessageGone;
  });

  const orphanReactions = (await ctx.db.query("reactions").collect()).filter(
    (r) => !messageIds.has(r.messageId as string) || orphanMessageIds.has(r.messageId as string),
  );
  const orphanDmReactions = (await ctx.db.query("dmReactions").collect()).filter(
    (r) => !dmMessageIds.has(r.messageId as string) || orphanDmMessageIds.has(r.messageId as string),
  );
  const orphanDmCallSignals = (await ctx.db.query("dmCallSignals").collect()).filter(
    (s) => !conversationIds.has(s.conversationId as string) || emptyConversationIds.has(s.conversationId as string),
  );
  const orphanDmMembers = dmMembers.filter(
    (m) => !conversationIds.has(m.conversationId as string) || !userIds.has(m.userId as string),
  );

  // "Delete for me" markers whose message no longer exists (or is about to go).
  const goingMessageIds = new Set<string>([...orphanMessageIds, ...orphanDmMessageIds]);
  const orphanVisibility = (await ctx.db.query("messageVisibility").collect()).filter(
    (row) =>
      goingMessageIds.has(row.messageId) ||
      (!messageIds.has(row.messageId) && !dmMessageIds.has(row.messageId)),
  );

  return {
    orphanCategories,
    orphanChannels,
    orphanMessages,
    orphanDmMessages,
    orphanAttachments,
    orphanReactions,
    orphanDmReactions,
    orphanDmCallSignals,
    orphanDmMembers,
    orphanVisibility,
    emptyConversations,
  };
}

type Orphans = Awaited<ReturnType<typeof collectOrphans>>;

function countOrphans(o: Orphans) {
  return (
    o.orphanCategories.length +
    o.orphanChannels.length +
    o.orphanMessages.length +
    o.orphanDmMessages.length +
    o.orphanAttachments.length +
    o.orphanReactions.length +
    o.orphanDmReactions.length +
    o.orphanDmCallSignals.length +
    o.orphanDmMembers.length +
    o.orphanVisibility.length +
    o.emptyConversations.length
  );
}

/**
 * One-off safety sweep for the invitation model.
 *
 * Community invitations were previously stored as RINGING `callInvites` rows,
 * which made an invitation behave like an incoming call (it rang, and it opened
 * the incoming-call UI). Invitations now live in `callInvitations` and never
 * ring, so any leftover ringing channel invite is cancelled here. Rows are
 * cancelled, never deleted, and real — non-channel — direct calls are untouched.
 */
export const cancelLegacyChannelCallInvites = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("callInvites").collect();
    let cancelled = 0;
    for (const row of rows) {
      if (row.channelId && (row.status === "ringing" || row.status === "accepted")) {
        await ctx.db.patch(row._id, { status: "cancelled", endedAt: Date.now() });
        cancelled += 1;
      }
    }
    return { cancelled };
  },
});

/**
 * Removes ONLY rows whose parent no longer exists (see `collectOrphans`). This
 * never targets a row that still resolves to a live user, community, channel or
 * conversation, so legitimate data is never affected. `dryRun` reports what
 * would be removed without removing it.
 */
export const purgeOrphanedData = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { dryRun }) => {
    const o = await collectOrphans(ctx);
    const summary = {
      categories: o.orphanCategories.length,
      channels: o.orphanChannels.length,
      messages: o.orphanMessages.length,
      emptyConversations: o.emptyConversations.length,
      dmMessages: o.orphanDmMessages.length,
      dmMembers: o.orphanDmMembers.length,
      dmCallSignals: o.orphanDmCallSignals.length,
      attachments: o.orphanAttachments.length,
      reactions: o.orphanReactions.length,
      dmReactions: o.orphanDmReactions.length,
      visibility: o.orphanVisibility.length,
    };

    if (dryRun) return { dryRun: true, ...summary, remaining: countOrphans(o) };

    // Children before parents, so nothing is left transiently orphaned.
    for (const row of o.orphanAttachments) {
      await deleteStoredFile(ctx, row.storageId);
      await ctx.db.delete(row._id);
    }
    for (const row of o.orphanReactions) await ctx.db.delete(row._id);
    for (const row of o.orphanDmReactions) await ctx.db.delete(row._id);
    for (const row of o.orphanVisibility) await ctx.db.delete(row._id);
    for (const row of o.orphanMessages) await ctx.db.delete(row._id);
    for (const row of o.orphanDmMessages) await ctx.db.delete(row._id);
    for (const row of o.orphanDmCallSignals) await ctx.db.delete(row._id);
    for (const row of o.orphanDmMembers) await ctx.db.delete(row._id);
    for (const row of o.orphanChannels) await ctx.db.delete(row._id);
    for (const row of o.orphanCategories) await ctx.db.delete(row._id);
    for (const row of o.emptyConversations) await ctx.db.delete(row._id);

    const after = await collectOrphans(ctx);
    return { dryRun: false, ...summary, remaining: countOrphans(after) };
  },
});
