import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  auditAdmin,
  currentUserId,
  displayNameOf,
  isOwnerRole,
  isProtectedOwnerEmail,
  platformSettingsOf,
  PROTECTED_OWNER_EMAILS,
  rankOf,
  requirePanelAccess,
  ROLE_RANK,
} from "./lib";

/**
 * ---------------------------------------------------------------------------
 * FreeBuff Owner/Admin panel — SERVER-ENFORCED authorization.
 * ---------------------------------------------------------------------------
 * Every rule below (role hierarchy, protected owners, self-modification, audit
 * logging) is enforced here on the backend. The UI only *reflects* these rules;
 * it never decides them. All failures throw `ConvexError` so the message
 * reaches the client instead of being redacted.
 *
 * Role hierarchy (rank):  owner_admin (3) > admin (2) > moderator (1) > user/member (0)
 *   - Owner Admin is reserved for the three PROTECTED_OWNER_EMAILS accounts.
 *   - Admin can manage users + moderators; only Owner Admins manage admins.
 */

const roleArg = v.union(
  v.literal("owner_admin"),
  v.literal("owner"),
  v.literal("admin"),
  v.literal("moderator"),
  v.literal("user"),
);

/** Actor card used for audit entries (name is resolved fresh, never trusted). */
async function actorCard(ctx: Parameters<typeof displayNameOf>[0], userId: Id<"users">) {
  return { id: userId, name: await displayNameOf(ctx, userId) };
}

/**
 * Central authorization check for any action performed against a target
 * account. Enforces, on the server:
 *   - the target must exist
 *   - you cannot act on your own account
 *   - protected Owner Admin accounts can NEVER be modified by anyone
 *   - you cannot act on an account with an equal or higher role
 *   - only Owner Admins may manage administrators
 */
async function assertCanManage(
  ctx: MutationCtx,
  actorId: Id<"users">,
  targetId: Id<"users">,
) {
  const actor = await ctx.db.get(actorId);
  const target = await ctx.db.get(targetId);
  if (!actor) throw new ConvexError("Your account could not be found.");
  if (!target) throw new ConvexError("That account no longer exists.");

  const actorRole = actor.role ?? "user";
  const targetRole = target.role ?? "user";
  const actorRank = rankOf(actorRole);
  const targetRank = rankOf(targetRole);

  if (actorId === targetId) {
    throw new ConvexError("You cannot modify your own account from the Admin Panel.");
  }
  if (isProtectedOwnerEmail(target.email)) {
    throw new ConvexError("This is a protected Owner Admin account and cannot be modified.");
  }
  if (actorRank <= targetRank) {
    throw new ConvexError("You cannot act on an account with an equal or higher role.");
  }
  if (!isOwnerRole(actorRole) && targetRank >= ROLE_RANK.admin) {
    throw new ConvexError("Only Owner Admins can manage administrators.");
  }
  return { actor, actorRole, target, targetRole };
}

/** Immediately invalidate every session for a moderated account. */
async function killSessions(ctx: MutationCtx, userId: Id<"users">) {
  const sessions = await ctx.db
    .query("authSessions")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .collect();
  for (const s of sessions) {
    const tokens = await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionId", (q) => q.eq("sessionId", s._id))
      .collect();
    for (const t of tokens) await ctx.db.delete(t._id);
    await ctx.db.delete(s._id);
  }
}

// ---------------------------------------------------------------------------
// Access + overview
// ---------------------------------------------------------------------------

/** Lets the client decide whether to reveal the Admin Panel entry point. */
export const panelAccess = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return { canAccess: false, role: "user", isOwner: false, isProtectedOwner: false, userId: null as string | null };
    }
    const user = await ctx.db.get(userId);
    const role = user?.role ?? "user";
    return {
      canAccess: rankOf(role) >= ROLE_RANK.admin,
      role,
      isOwner: rankOf(role) >= ROLE_RANK.owner,
      isProtectedOwner: isProtectedOwnerEmail(user?.email),
      userId,
    };
  },
});

/** Backwards-compatible boolean for the signed-in user. */
export const amIAdmin = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return false;
    const user = await ctx.db.get(userId);
    return rankOf(user?.role) >= ROLE_RANK.admin;
  },
});

/** Platform statistics. Returns null for anyone without panel access. */
export const stats = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const me = await ctx.db.get(userId);
    if (rankOf(me?.role) < ROLE_RANK.admin) return null;

    const users = await ctx.db.query("users").take(2000);
    const servers = await ctx.db.query("servers").take(2000);
    const channels = await ctx.db.query("channels").take(2000);
    const messages = await ctx.db.query("messages").take(2000);
    const dms = await ctx.db.query("dmConversations").take(2000);
    const reports = await ctx.db.query("reports").take(2000);
    const bans = await ctx.db.query("bans").take(2000);
    const voice = await ctx.db.query("voiceSessions").take(2000);

    const now = Date.now();
    return {
      users: users.length,
      owners: users.filter((u) => isOwnerRole(u.role)).length,
      admins: users.filter((u) => u.role === "admin").length,
      moderators: users.filter((u) => u.role === "moderator").length,
      banned: users.filter((u) => u.banned).length,
      suspended: users.filter((u) => u.suspendedUntil && u.suspendedUntil > now).length,
      communities: servers.length,
      channels: channels.length,
      messages: messages.length,
      dmConversations: dms.length,
      openReports: reports.filter((r) => r.status === "open").length,
      bans: bans.length,
      activeVoice: voice.length,
    };
  },
});

// ---------------------------------------------------------------------------
// User management
// ---------------------------------------------------------------------------

export const listUsers = query({
  args: { q: v.optional(v.string()), role: v.optional(v.string()) },
  handler: async (ctx, { q, role }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const me = await ctx.db.get(userId);
    if (rankOf(me?.role) < ROLE_RANK.admin) return [];

    const term = q?.trim().toLowerCase() ?? "";
    // Scan broadly (the admin panel must be able to find any account, including
    // the newest ones, which sit at the end of the table).
    const all = await ctx.db.query("users").take(4000);
    // Resolve display names with ONE profiles read instead of a lookup per user.
    const profiles = await ctx.db.query("profiles").take(4000);
    const nameById = new Map(profiles.map((p) => [p.userId as string, p.displayName]));
    const rows = all.map((u) => {
      const name = nameById.get(u._id) || u.name || u.username || "Freebuff member";
      return {
        userId: u._id,
        username: u.username ?? "",
        name,
        email: u.email ?? null,
        role: u.role ?? "user",
        isProtectedOwner: isProtectedOwnerEmail(u.email),
        isSelf: u._id === userId,
        banned: u.banned ?? false,
        banReason: u.banReason ?? null,
        suspendedUntil: u.suspendedUntil ?? null,
        suspendReason: u.suspendReason ?? null,
        isAnonymous: u.isAnonymous ?? false,
        createdAt: u._creationTime,
        searchText: `${name} ${u.username ?? ""} ${u.email ?? ""}`.toLowerCase(),
      };
    });

    let filtered = rows;
    if (term) filtered = filtered.filter((r) => r.searchText.includes(term));
    if (role) filtered = filtered.filter((r) => (role === "owner" ? isOwnerRole(r.role) : r.role === role));
    return filtered
      .sort((a, b) => rankOf(b.role) - rankOf(a.role) || a.name.localeCompare(b.name))
      .slice(0, 200)
      .map(({ searchText: _searchText, ...r }) => r);
  },
});

/** Searches people by name/username/email for the promote/demote workflow. */
export const searchAccounts = query({
  args: { q: v.string() },
  handler: async (ctx, { q }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const me = await ctx.db.get(userId);
    if (rankOf(me?.role) < ROLE_RANK.admin) return [];
    const term = q.trim().toLowerCase();
    if (term.length < 1) return [];
    const all = await ctx.db.query("users").take(4000);
    const profiles = await ctx.db.query("profiles").take(4000);
    const nameById = new Map(profiles.map((p) => [p.userId as string, p.displayName]));
    const out = [];
    for (const u of all) {
      const hay = `${u.username ?? ""} ${u.name ?? ""} ${u.email ?? ""}`.toLowerCase();
      if (!hay.includes(term)) continue;
      out.push({
        userId: u._id,
        username: u.username ?? "",
        name: nameById.get(u._id) || u.name || u.username || "Freebuff member",
        email: u.email ?? null,
        role: u.role ?? "user",
        isProtectedOwner: isProtectedOwnerEmail(u.email),
      });
      if (out.length >= 25) break;
    }
    return out;
  },
});

/**
 * Change an account's role. Fully guarded server-side: no self-changes, no
 * touching protected owners, no managing equals/higher, and only Owner Admins
 * may grant or revoke administrator access. `owner` can never be assigned.
 */
export const setUserRole = mutation({
  args: { userId: v.id("users"), role: roleArg },
  handler: async (ctx, { userId, role }) => {
    const me = await currentUserId(ctx);
    await requirePanelAccess(ctx, me);
    const { actorRole, target, targetRole } = await assertCanManage(ctx, me, userId);

    if (isOwnerRole(role)) {
      throw new ConvexError("Owner Admin is reserved for the protected owner accounts.");
    }
    if (!isOwnerRole(actorRole) && rankOf(role) >= ROLE_RANK.admin) {
      throw new ConvexError("Only Owner Admins can grant administrator access.");
    }
    if (targetRole === role) {
      return { role };
    }
    await ctx.db.patch(userId, { role });
    const actor = await actorCard(ctx, me);
    await auditAdmin(ctx, {
      action: "account.role.update",
      actorId: me,
      actorName: actor.name,
      targetType: "user",
      targetId: userId,
      targetUserId: userId,
      targetName: await displayNameOf(ctx, userId),
      detail: `Changed ${target.username ?? target.email ?? userId} from ${targetRole} to ${role}`,
      previousRole: targetRole,
      newRole: role,
    });
    return { role };
  },
});

/** Permanently ban an account. Protected owners and higher roles are immune. */
export const banUser = mutation({
  args: { userId: v.id("users"), reason: v.optional(v.string()) },
  handler: async (ctx, { userId, reason }) => {
    const me = await currentUserId(ctx);
    await requirePanelAccess(ctx, me);
    const { target, targetRole } = await assertCanManage(ctx, me, userId);
    if (target.banned) throw new ConvexError("That account is already suspended.");

    await ctx.db.patch(userId, {
      banned: true,
      bannedAt: Date.now(),
      bannedBy: me,
      banReason: reason?.slice(0, 200) ?? undefined,
    });
    await killSessions(ctx, userId);
    const actor = await actorCard(ctx, me);
    await auditAdmin(ctx, {
      action: "account.ban",
      actorId: me,
      actorName: actor.name,
      targetType: "user",
      targetId: userId,
      targetUserId: userId,
      targetName: await displayNameOf(ctx, userId),
      detail: `Banned ${target.username ?? target.email ?? userId}${reason ? `: ${reason}` : ""}`,
      previousRole: targetRole,
      previousValue: "active",
      newValue: "banned",
    });
    return { banned: true };
  },
});

export const unbanUser = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const me = await currentUserId(ctx);
    await requirePanelAccess(ctx, me);
    const { target } = await assertCanManage(ctx, me, userId);
    await ctx.db.patch(userId, {
      banned: false,
      bannedAt: undefined,
      bannedBy: undefined,
      banReason: undefined,
    });
    const actor = await actorCard(ctx, me);
    await auditAdmin(ctx, {
      action: "account.unban",
      actorId: me,
      actorName: actor.name,
      targetType: "user",
      targetId: userId,
      targetUserId: userId,
      targetName: await displayNameOf(ctx, userId),
      detail: `Removed suspension from ${target.username ?? target.email ?? userId}`,
      previousValue: "banned",
      newValue: "active",
    });
    return { banned: false };
  },
});

/** Temporarily suspend an account for `durationMs`. */
export const suspendUser = mutation({
  args: { userId: v.id("users"), reason: v.optional(v.string()), durationMs: v.number() },
  handler: async (ctx, { userId, reason, durationMs }) => {
    const me = await currentUserId(ctx);
    await requirePanelAccess(ctx, me);
    const { target } = await assertCanManage(ctx, me, userId);
    if (durationMs <= 0 || durationMs > 1000 * 60 * 60 * 24 * 365) {
      throw new ConvexError("Choose a suspension length between 1 minute and 1 year.");
    }
    const until = Date.now() + durationMs;
    await ctx.db.patch(userId, {
      suspendedUntil: until,
      suspendedBy: me,
      suspendReason: reason?.slice(0, 200) ?? undefined,
    });
    await killSessions(ctx, userId);
    const actor = await actorCard(ctx, me);
    await auditAdmin(ctx, {
      action: "account.suspend",
      actorId: me,
      actorName: actor.name,
      targetType: "user",
      targetId: userId,
      targetUserId: userId,
      targetName: await displayNameOf(ctx, userId),
      detail: `Suspended ${target.username ?? target.email ?? userId} until ${new Date(until).toISOString()}${reason ? `: ${reason}` : ""}`,
      previousValue: "active",
      newValue: `suspended_until:${until}`,
    });
    return { suspendedUntil: until };
  },
});

export const unsuspendUser = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const me = await currentUserId(ctx);
    await requirePanelAccess(ctx, me);
    const { target } = await assertCanManage(ctx, me, userId);
    await ctx.db.patch(userId, {
      suspendedUntil: undefined,
      suspendedBy: undefined,
      suspendReason: undefined,
    });
    const actor = await actorCard(ctx, me);
    await auditAdmin(ctx, {
      action: "account.unsuspend",
      actorId: me,
      actorName: actor.name,
      targetType: "user",
      targetId: userId,
      targetUserId: userId,
      targetName: await displayNameOf(ctx, userId),
      detail: `Cleared suspension for ${target.username ?? target.email ?? userId}`,
    });
    return { suspendedUntil: null };
  },
});

/**
 * Delete an account and its data from the Admin Panel. Guarded exactly like
 * every other action: protected Owner Admins can never be deleted, and no one
 * can delete an equal/higher role or themselves.
 */
export const deleteUser = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const me = await currentUserId(ctx);
    await requirePanelAccess(ctx, me);
    const { target, targetRole } = await assertCanManage(ctx, me, userId);
    const actor = await actorCard(ctx, me);
    const targetName = await displayNameOf(ctx, userId);

    await purgeUserData(ctx, userId);

    await auditAdmin(ctx, {
      action: "account.delete",
      actorId: me,
      actorName: actor.name,
      targetType: "user",
      targetId: userId,
      targetName,
      detail: `Deleted account ${target.username ?? target.email ?? userId}`,
      previousRole: targetRole,
    });
    return { deleted: true };
  },
});

/**
 * Remove an account and everything it owns. Mirrors the self-service account
 * deletion so admin-initiated removal leaves no orphaned rows behind.
 */
async function purgeUserData(ctx: MutationCtx, userId: Id<"users">) {
  const ownedServers = (await ctx.db.query("servers").collect()).filter((s) => s.ownerId === userId);
  for (const server of ownedServers) {
    const channels = await ctx.db.query("channels").withIndex("by_server", (q) => q.eq("serverId", server._id)).collect();
    for (const channel of channels) {
      const messages = await ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("channelId", channel._id)).collect();
      for (const m of messages) {
        for (const r of await ctx.db.query("reactions").withIndex("by_message", (q) => q.eq("messageId", m._id)).collect()) await ctx.db.delete(r._id);
        for (const f of await ctx.db.query("attachments").withIndex("by_message", (q) => q.eq("messageId", m._id)).collect()) {
          await ctx.storage.delete(f.storageId);
          await ctx.db.delete(f._id);
        }
        await ctx.db.delete(m._id);
      }
      for (const vs of await ctx.db.query("voiceSessions").withIndex("by_channel", (q) => q.eq("channelId", channel._id)).collect()) await ctx.db.delete(vs._id);
      await ctx.db.delete(channel._id);
    }
    for (const cat of await ctx.db.query("channelCategories").withIndex("by_server", (q) => q.eq("serverId", server._id)).collect()) await ctx.db.delete(cat._id);
    for (const m of await ctx.db.query("memberships").withIndex("by_server", (q) => q.eq("serverId", server._id)).collect()) await ctx.db.delete(m._id);
    for (const r of await ctx.db.query("communityRoles").withIndex("by_server", (q) => q.eq("serverId", server._id)).collect()) await ctx.db.delete(r._id);
    for (const i of await ctx.db.query("invites").withIndex("by_server", (q) => q.eq("serverId", server._id)).collect()) await ctx.db.delete(i._id);
    for (const b of await ctx.db.query("bans").withIndex("by_server", (q) => q.eq("serverId", server._id)).collect()) await ctx.db.delete(b._id);
    await ctx.db.delete(server._id);
  }

  for (const m of await ctx.db.query("memberships").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) await ctx.db.delete(m._id);
  for (const dm of await ctx.db.query("dmMembers").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) await ctx.db.delete(dm._id);

  const presence = await ctx.db.query("presence").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
  if (presence) await ctx.db.delete(presence._id);
  const profile = await ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
  if (profile) {
    if (profile.avatarStorageId) await ctx.storage.delete(profile.avatarStorageId);
    if (profile.bannerStorageId) await ctx.storage.delete(profile.bannerStorageId);
    await ctx.db.delete(profile._id);
  }
  const settings = await ctx.db.query("userSettings").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
  if (settings) await ctx.db.delete(settings._id);

  for (const table of ["friendRequests", "follows", "blocks", "notifications"] as const) {
    const rows = await ctx.db.query(table).collect();
    for (const row of rows) {
      const r = row as unknown as {
        fromId?: string; toId?: string; followerId?: string; followingId?: string;
        blockerId?: string; blockedId?: string; userId?: string;
      };
      if ([r.fromId, r.toId, r.followerId, r.followingId, r.blockerId, r.blockedId, r.userId].includes(userId as string)) {
        await ctx.db.delete(row._id);
      }
    }
  }
  const friendships = (await ctx.db.query("friendships").collect()).filter((f) => f.userA === userId || f.userB === userId);
  for (const f of friendships) await ctx.db.delete(f._id);

  const accounts = await ctx.db.query("authAccounts").withIndex("userIdAndProvider", (q) => q.eq("userId", userId)).collect();
  for (const a of accounts) {
    const codes = await ctx.db.query("authVerificationCodes").withIndex("accountId", (q) => q.eq("accountId", a._id)).collect();
    for (const c of codes) await ctx.db.delete(c._id);
    await ctx.db.delete(a._id);
  }
  await killSessions(ctx, userId);
  await ctx.db.delete(userId);
}

// ---------------------------------------------------------------------------
// Reports + bans (existing moderation surface)
// ---------------------------------------------------------------------------

export const listReports = query({
  args: { status: v.optional(v.union(v.literal("open"), v.literal("resolved"), v.literal("dismissed"))) },
  handler: async (ctx, { status }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const me = await ctx.db.get(userId);
    if (rankOf(me?.role) < ROLE_RANK.admin) return [];
    const reports = status
      ? await ctx.db.query("reports").withIndex("by_status", (q) => q.eq("status", status)).take(200)
      : await ctx.db.query("reports").take(200);
    return Promise.all(
      reports.map(async (r) => ({
        ...r,
        reporter: await displayNameOf(ctx, r.reporterId),
      })),
    );
  },
});

export const listBans = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const me = await ctx.db.get(userId);
    if (rankOf(me?.role) < ROLE_RANK.admin) return [];
    const bans = await ctx.db.query("bans").take(200);
    return Promise.all(
      bans.map(async (b) => {
        const server = await ctx.db.get(b.serverId);
        return { ...b, userName: await displayNameOf(ctx, b.userId), communityName: server?.name ?? "" };
      }),
    );
  },
});

export const resolveReport = mutation({
  args: { reportId: v.id("reports"), status: v.union(v.literal("resolved"), v.literal("dismissed")) },
  handler: async (ctx, { reportId, status }) => {
    const userId = await currentUserId(ctx);
    await requirePanelAccess(ctx, userId);
    await ctx.db.patch(reportId, { status });
    const actor = await actorCard(ctx, userId);
    await auditAdmin(ctx, {
      action: `report.${status}`,
      actorId: userId,
      actorName: actor.name,
      targetType: "report",
      targetId: reportId,
      detail: `Report ${reportId} marked ${status}`,
    });
    return { status };
  },
});

// ---------------------------------------------------------------------------
// Communities
// ---------------------------------------------------------------------------

export const listCommunities = query({
  args: { q: v.optional(v.string()) },
  handler: async (ctx, { q }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const me = await ctx.db.get(userId);
    if (rankOf(me?.role) < ROLE_RANK.admin) return [];

    const term = q?.trim().toLowerCase() ?? "";
    const servers = await ctx.db.query("servers").take(2000);
    const rows = [];
    for (const server of servers) {
      if (term && !`${server.name} ${server.description}`.toLowerCase().includes(term)) continue;
      const members = await ctx.db
        .query("memberships")
        .withIndex("by_server", (x) => x.eq("serverId", server._id))
        .collect();
      rows.push({
        serverId: server._id,
        name: server.name,
        description: server.description,
        isPublic: server.isPublic ?? false,
        locked: server.locked ?? false,
        memberCount: members.length,
        ownerName: await displayNameOf(ctx, server.ownerId),
        ownerId: server.ownerId,
        createdAt: server._creationTime,
      });
    }
    return rows.sort((a, b) => b.memberCount - a.memberCount).slice(0, 200);
  },
});

export const updateCommunity = mutation({
  args: {
    serverId: v.id("servers"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    isPublic: v.optional(v.boolean()),
    locked: v.optional(v.boolean()),
  },
  handler: async (ctx, { serverId, ...patch }) => {
    const userId = await currentUserId(ctx);
    await requirePanelAccess(ctx, userId);
    const server = await ctx.db.get(serverId);
    if (!server) throw new ConvexError("Community not found.");

    const update: Record<string, unknown> = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name.length < 2 || name.length > 50) throw new ConvexError("Community name must be 2-50 characters.");
      update.name = name;
    }
    if (patch.description !== undefined) update.description = patch.description.trim().slice(0, 200);
    if (patch.isPublic !== undefined) update.isPublic = patch.isPublic;
    if (patch.locked !== undefined) update.locked = patch.locked;
    if (Object.keys(update).length === 0) return { updated: false };

    await ctx.db.patch(serverId, update);
    const actor = await actorCard(ctx, userId);
    await auditAdmin(ctx, {
      action: "community.update",
      actorId: userId,
      actorName: actor.name,
      targetType: "community",
      targetId: serverId,
      detail: `Updated community "${server.name}": ${Object.keys(update).join(", ")}`,
      previousValue: server.name,
      newValue: (update.name as string) ?? server.name,
    });
    return { updated: true };
  },
});

/** Deletes a community and all of its channels/messages. Owner Admins only. */
export const deleteCommunity = mutation({
  args: { serverId: v.id("servers") },
  handler: async (ctx, { serverId }) => {
    const userId = await currentUserId(ctx);
    const role = await requirePanelAccess(ctx, userId);
    if (!isOwnerRole(role)) throw new ConvexError("Only Owner Admins can delete communities.");
    const server = await ctx.db.get(serverId);
    if (!server) throw new ConvexError("Community not found.");

    const channels = await ctx.db.query("channels").withIndex("by_server", (q) => q.eq("serverId", serverId)).collect();
    for (const channel of channels) {
      const messages = await ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("channelId", channel._id)).collect();
      for (const m of messages) {
        for (const r of await ctx.db.query("reactions").withIndex("by_message", (q) => q.eq("messageId", m._id)).collect()) await ctx.db.delete(r._id);
        for (const f of await ctx.db.query("attachments").withIndex("by_message", (q) => q.eq("messageId", m._id)).collect()) {
          await ctx.storage.delete(f.storageId);
          await ctx.db.delete(f._id);
        }
        await ctx.db.delete(m._id);
      }
      for (const vs of await ctx.db.query("voiceSessions").withIndex("by_channel", (q) => q.eq("channelId", channel._id)).collect()) await ctx.db.delete(vs._id);
      await ctx.db.delete(channel._id);
    }
    for (const cat of await ctx.db.query("channelCategories").withIndex("by_server", (q) => q.eq("serverId", serverId)).collect()) await ctx.db.delete(cat._id);
    for (const m of await ctx.db.query("memberships").withIndex("by_server", (q) => q.eq("serverId", serverId)).collect()) await ctx.db.delete(m._id);
    for (const r of await ctx.db.query("communityRoles").withIndex("by_server", (q) => q.eq("serverId", serverId)).collect()) await ctx.db.delete(r._id);
    for (const i of await ctx.db.query("invites").withIndex("by_server", (q) => q.eq("serverId", serverId)).collect()) await ctx.db.delete(i._id);
    for (const b of await ctx.db.query("bans").withIndex("by_server", (q) => q.eq("serverId", serverId)).collect()) await ctx.db.delete(b._id);
    await ctx.db.delete(serverId);

    const actor = await actorCard(ctx, userId);
    await auditAdmin(ctx, {
      action: "community.delete",
      actorId: userId,
      actorName: actor.name,
      targetType: "community",
      targetId: serverId,
      detail: `Deleted community "${server.name}"`,
      previousValue: server.name,
    });
    return { deleted: true };
  },
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export const listAuditLogs = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const me = await ctx.db.get(userId);
    if (rankOf(me?.role) < ROLE_RANK.admin) return [];
    const take = Math.min(Math.max(limit ?? 150, 1), 300);
    const logs = await ctx.db.query("auditLogs").withIndex("by_at").order("desc").take(take);
    return logs.map((l) => ({
      id: l._id,
      action: l.action,
      actorId: l.actorId ?? null,
      actor: l.actorName ?? null,
      targetType: l.targetType ?? null,
      targetId: l.targetId ?? null,
      targetName: l.targetName ?? null,
      detail: l.detail,
      previousRole: l.previousRole ?? null,
      newRole: l.newRole ?? null,
      previousValue: l.previousValue ?? null,
      newValue: l.newValue ?? null,
      at: l.at,
    }));
  },
});

// ---------------------------------------------------------------------------
// Platform settings
// ---------------------------------------------------------------------------

const DEFAULT_PLATFORM_SETTINGS = {
  announcement: "",
  newCommunitiesEnabled: true,
  discoveryEnabled: true,
};

/** Public (signed-in) view of the operator announcement banner. */
export const platformBanner = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const row = await platformSettingsOf(ctx);
    const announcement = row?.announcement?.trim();
    return announcement ? { announcement } : null;
  },
});

export const getPlatformSettings = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const me = await ctx.db.get(userId);
    if (rankOf(me?.role) < ROLE_RANK.admin) return null;
    const row = await platformSettingsOf(ctx);
    return {
      announcement: row?.announcement ?? DEFAULT_PLATFORM_SETTINGS.announcement,
      newCommunitiesEnabled: row?.newCommunitiesEnabled ?? DEFAULT_PLATFORM_SETTINGS.newCommunitiesEnabled,
      discoveryEnabled: row?.discoveryEnabled ?? DEFAULT_PLATFORM_SETTINGS.discoveryEnabled,
      updatedAt: row?.updatedAt ?? null,
    };
  },
});

export const updatePlatformSettings = mutation({
  args: {
    announcement: v.optional(v.string()),
    newCommunitiesEnabled: v.optional(v.boolean()),
    discoveryEnabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await currentUserId(ctx);
    const role = await requirePanelAccess(ctx, userId);
    if (!isOwnerRole(role)) throw new ConvexError("Only Owner Admins can change platform-wide settings.");
    const row = await platformSettingsOf(ctx);
    const patch: Record<string, unknown> = { updatedAt: Date.now(), updatedBy: userId };
    if (args.announcement !== undefined) patch.announcement = args.announcement.trim().slice(0, 280);
    if (args.newCommunitiesEnabled !== undefined) patch.newCommunitiesEnabled = args.newCommunitiesEnabled;
    if (args.discoveryEnabled !== undefined) patch.discoveryEnabled = args.discoveryEnabled;

    if (row) await ctx.db.patch(row._id, patch);
    else await ctx.db.insert("platformSettings", { key: "global", ...patch });

    const actor = await actorCard(ctx, userId);
    await auditAdmin(ctx, {
      action: "platform.settings.update",
      actorId: userId,
      actorName: actor.name,
      targetType: "platform",
      targetId: "global",
      detail: `Updated platform settings: ${Object.keys(patch).filter((k) => k !== "updatedAt" && k !== "updatedBy").join(", ")}`,
    });
    return { updated: true };
  },
});

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/**
 * Communities created by the automated dev/test scripts. These are matched by
 * exact name patterns only, so real user communities (whatever they are
 * called) are never touched. Run once with:
 *   npx convex run admin:purgeTestCommunities
 */
const TEST_COMMUNITY_PATTERNS = [
  /^Private Guild( [a-z0-9]{6,})?$/i,
  /^Avatar Guild( [a-z0-9]{6,})?$/i,
  /^Presence( [a-z0-9]{6,})?$/i,
  /^Mention Guild( [a-z0-9]{6,})?$/i,
  /^DelTest( [a-z0-9]{6,})?$/i,
  /^Leave Test( [a-z0-9]{6,})?$/i,
  /^Fix Test( [a-z0-9]{6,})?$/i,
  /^Public Test( [a-z0-9]{6,})?$/i,
  /^My Public Community( [a-z0-9]{6,})?$/i,
  /^Secret Hideout [a-z0-9]{6,}$/i,
];

export const purgeTestCommunities = internalMutation({
  args: {},
  handler: async (ctx) => {
    const servers = await ctx.db.query("servers").collect();
    const removed: string[] = [];
    for (const server of servers) {
      if (!TEST_COMMUNITY_PATTERNS.some((re) => re.test(server.name))) continue;
      const channels = await ctx.db.query("channels").withIndex("by_server", (q) => q.eq("serverId", server._id)).collect();
      for (const channel of channels) {
        const messages = await ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("channelId", channel._id)).collect();
        for (const m of messages) {
          for (const a of await ctx.db.query("attachments").withIndex("by_message", (q) => q.eq("messageId", m._id)).collect()) await ctx.db.delete(a._id);
          for (const r of await ctx.db.query("reactions").withIndex("by_message", (q) => q.eq("messageId", m._id)).collect()) await ctx.db.delete(r._id);
          await ctx.db.delete(m._id);
        }
        for (const vs of await ctx.db.query("voiceSessions").withIndex("by_channel", (q) => q.eq("channelId", channel._id)).collect()) await ctx.db.delete(vs._id);
        await ctx.db.delete(channel._id);
      }
      for (const cat of await ctx.db.query("channelCategories").withIndex("by_server", (q) => q.eq("serverId", server._id)).collect()) await ctx.db.delete(cat._id);
      for (const m of await ctx.db.query("memberships").withIndex("by_server", (q) => q.eq("serverId", server._id)).collect()) await ctx.db.delete(m._id);
      for (const r of await ctx.db.query("communityRoles").withIndex("by_server", (q) => q.eq("serverId", server._id)).collect()) await ctx.db.delete(r._id);
      for (const i of await ctx.db.query("invites").withIndex("by_server", (q) => q.eq("serverId", server._id)).collect()) await ctx.db.delete(i._id);
      for (const b of await ctx.db.query("bans").withIndex("by_server", (q) => q.eq("serverId", server._id)).collect()) await ctx.db.delete(b._id);
      await ctx.db.delete(server._id);
      removed.push(server.name);
    }
    return { removed, count: removed.length };
  },
});

/**
 * One-shot reconciliation for the protected Owner Admin accounts.
 *
 * 1. Every protected email is looked up DIRECTLY through the email index, so an
 *    existing account is UPDATED in place (never duplicated) no matter where it
 *    sits in the users table. Exactly one account per email becomes Owner Admin.
 * 2. Any account still holding an owner role without a protected email is
 *    demoted back to `user`, so ownership can never be held by accident.
 *
 * Run with:  npx convex run admin:syncOwners
 */
export const syncOwners = internalMutation({
  args: {},
  handler: async (ctx) => {
    const results: Array<{ email: string; userId: string | null; action: string }> = [];
    let promoted = 0;
    let corrected = 0;

    for (const email of PROTECTED_OWNER_EMAILS) {
      const matches = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", email.trim().toLowerCase()))
        .collect();
      if (matches.length === 0) {
        results.push({ email, userId: null, action: "no_account" });
        continue;
      }
      // Deterministic choice: the oldest account for this email is the owner.
      const ordered = [...matches].sort((a, b) => a._creationTime - b._creationTime);
      const owner = ordered[0];
      if (owner.role !== "owner_admin") {
        await ctx.db.patch(owner._id, { role: "owner_admin" });
        promoted++;
      }
      for (const dup of ordered.slice(1)) {
        if (isOwnerRole(dup.role)) {
          await ctx.db.patch(dup._id, { role: "user" });
          corrected++;
        }
      }
      results.push({ email, userId: owner._id, action: owner.role === "owner_admin" ? "already_owner" : "promoted" });
    }

    // Nobody may hold an owner role without a protected email.
    const users = await ctx.db.query("users").collect();
    for (const u of users) {
      if (!isProtectedOwnerEmail(u.email) && isOwnerRole(u.role)) {
        await ctx.db.patch(u._id, { role: "user" });
        corrected++;
      }
    }

    return { promoted, corrected, results };
  },
});
