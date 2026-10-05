import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { enforceRateLimit } from "./authHelpers";
import {
  audit,
  avatarUrlOf,
  currentUserId,
  displayNameOf,
  presenceInfoOf,
  effectivePermissions,
  hasPermission,
  isBlockedEitherWay,
  isTimedOut,
  membershipOf,
  notify,
  platformSettingsOf,
  profileOf,
  rankOf,
  requireMember,
  requirePermission,
} from "./lib";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

const permissionArg = v.union(
  v.literal("sendMessages"), v.literal("deleteMessages"), v.literal("manageMessages"),
  v.literal("createChannels"), v.literal("manageChannels"), v.literal("kickMembers"),
  v.literal("banMembers"), v.literal("manageRoles"), v.literal("manageCommunity"),
  v.literal("createInvites"), v.literal("useVoice"), v.literal("manageMembers"),
);

function inviteCode() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

async function memberCard(ctx: QueryCtx, userId: Id<"users">, role?: string, timeoutUntil?: number, viewerId?: Id<"users">) {
  const profile = await profileOf(ctx, userId);
  const user = await ctx.db.get(userId);
  const { status, lastSeen } = await presenceInfoOf(ctx, userId, viewerId);
  return {
    userId,
    username: user?.username ?? "",
    displayName: profile?.displayName ?? user?.name ?? "Freecord member",
    avatarColor: profile?.avatarColor ?? "violet",
    avatarUrl: await avatarUrlOf(ctx, userId),
    decorationId: profile?.decorationId ?? null,
    presence: status,
    lastSeen,
    role: role ?? "member",
    timedOutUntil: timeoutUntil && timeoutUntil > Date.now() ? timeoutUntil : null,
  };
}

// ---------------- Communities ----------------

export const create = mutation({
  args: { name: v.string(), description: v.string(), isPublic: v.optional(v.boolean()), tags: v.optional(v.array(v.string())), category: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await currentUserId(ctx);
    await enforceRateLimit(ctx, `community:${userId}`, 5, 60_000);
    // Platform-wide switch (managed from the Admin Panel). Admins can always
    // create; when disabled, regular members cannot start new communities.
    const settings = await platformSettingsOf(ctx);
    if (settings?.newCommunitiesEnabled === false) {
      const me = await ctx.db.get(userId);
      if (rankOf(me?.role) < rankOf("admin")) {
        throw new Error("Creating new communities is temporarily disabled.");
      }
    }
    const name = args.name.trim();
    if (name.length < 2 || name.length > 50) throw new Error("Community name must be 2-50 characters.");
    const serverId = await ctx.db.insert("servers", {
      name,
      description: args.description.trim().slice(0, 200),
      ownerId: userId,
      inviteCode: inviteCode(),
      isPublic: args.isPublic ?? false,
      tags: (args.tags ?? []).slice(0, 6).map((t) => t.trim().slice(0, 20)).filter(Boolean),
      category: args.category?.slice(0, 30),
      iconColor: "violet",
    });
    await ctx.db.insert("memberships", { serverId, userId, role: "owner" });
    // A real, editable "General" section the owner can rename, reorder or delete.
    const generalCategoryId = await ctx.db.insert("channelCategories", { serverId, name: "General", position: 0 });
    const defaults = [["general", "text"], ["introductions", "text"], ["off-topic", "text"], ["General Voice", "voice"]] as const;
    for (let i = 0; i < defaults.length; i++) {
      const [channelName, type] = defaults[i];
      await ctx.db.insert("channels", {
        serverId,
        name: channelName,
        description: channelName === "general" ? "A little space for big conversations." : type === "voice" ? "Hop in and talk." : "Make yourself at home.",
        type,
        categoryId: generalCategoryId,
        position: i,
      });
    }
    await audit(ctx, "community.create", userId, `Created community "${name}"`, "community", serverId);
    return serverId;
  },
});

export const joinByCode = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const userId = await currentUserId(ctx);
    await enforceRateLimit(ctx, `join:${userId}`, 20, 60_000);
    const trimmed = code.trim();

    const invite = await ctx.db.query("invites").withIndex("by_code", (q) => q.eq("code", trimmed)).unique();
    let server = invite ? await ctx.db.get(invite.serverId) : null;
    if (!server) {
      server = await ctx.db.query("servers").withIndex("by_invite", (q) => q.eq("inviteCode", trimmed)).unique();
    }
    if (!server) throw new Error("That invite code isn't valid.");

    const ban = await ctx.db.query("bans").withIndex("by_server_user", (q) => q.eq("serverId", server!._id).eq("userId", userId)).unique();
    if (ban) throw new Error("You're banned from this community.");

    const existing = await ctx.db.query("memberships").withIndex("by_server_user", (q) => q.eq("serverId", server!._id).eq("userId", userId)).unique();
    if (!existing) {
      await ctx.db.insert("memberships", { serverId: server._id, userId, role: "member" });
      if (invite) await ctx.db.patch(invite._id, { uses: invite.uses + 1 });
    }
    return server._id;
  },
});

export const join = mutation({
  args: { serverId: v.id("servers") },
  handler: async (ctx, { serverId }) => {
    const userId = await currentUserId(ctx);
    await enforceRateLimit(ctx, `join:${userId}`, 20, 60_000);
    const server = await ctx.db.get(serverId);
    if (!server) throw new Error("Community not found.");
    if (!server.isPublic) throw new Error("This community is private. Use an invite.");
    const ban = await ctx.db.query("bans").withIndex("by_server_user", (q) => q.eq("serverId", serverId).eq("userId", userId)).unique();
    if (ban) throw new Error("You're banned from this community.");
    const existing = await ctx.db.query("memberships").withIndex("by_server_user", (q) => q.eq("serverId", serverId).eq("userId", userId)).unique();
    if (!existing) await ctx.db.insert("memberships", { serverId, userId, role: "member" });
    return serverId;
  },
});

export const leave = mutation({
  args: { serverId: v.id("servers") },
  handler: async (ctx, { serverId }) => {
    const userId = await currentUserId(ctx);
    const server = await ctx.db.get(serverId);
    if (!server) return;
    if (server.ownerId === userId) throw new Error("Owners can't leave. Transfer or delete the community instead.");
    const membership = await membershipOf(ctx, serverId, userId);
    if (membership) await ctx.db.delete(membership._id);
    const voice = await ctx.db.query("voiceSessions").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    for (const s of voice) if (s.channelId) await ctx.db.delete(s._id);
  },
});

export const deleteCommunity = mutation({
  args: { serverId: v.id("servers") },
  handler: async (ctx, { serverId }) => {
    const userId = await currentUserId(ctx);
    const server = await ctx.db.get(serverId);
    if (!server || server.ownerId !== userId) throw new Error("Only the owner can delete this community.");
    const channels = await ctx.db.query("channels").withIndex("by_server", (q) => q.eq("serverId", serverId)).collect();
    for (const channel of channels) {
      const messages = await ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("channelId", channel._id)).collect();
      for (const m of messages) {
        const reacts = await ctx.db.query("reactions").withIndex("by_message", (q) => q.eq("messageId", m._id)).collect();
        for (const r of reacts) await ctx.db.delete(r._id);
        await ctx.db.delete(m._id);
      }
      const voice = await ctx.db.query("voiceSessions").withIndex("by_channel", (q) => q.eq("channelId", channel._id)).collect();
      for (const vs of voice) await ctx.db.delete(vs._id);
      await ctx.db.delete(channel._id);
    }
    const members = await ctx.db.query("memberships").withIndex("by_server", (q) => q.eq("serverId", serverId)).collect();
    for (const m of members) await ctx.db.delete(m._id);
    const roles = await ctx.db.query("communityRoles").withIndex("by_server", (q) => q.eq("serverId", serverId)).collect();
    for (const r of roles) await ctx.db.delete(r._id);
    const invites = await ctx.db.query("invites").withIndex("by_server", (q) => q.eq("serverId", serverId)).collect();
    for (const i of invites) await ctx.db.delete(i._id);
    const bans = await ctx.db.query("bans").withIndex("by_server", (q) => q.eq("serverId", serverId)).collect();
    for (const b of bans) await ctx.db.delete(b._id);
    await ctx.db.delete(serverId);
    await audit(ctx, "community.delete", userId, `Deleted community "${server.name}"`, "community", serverId);
  },
});

export const updateSettings = mutation({
  args: {
    serverId: v.id("servers"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    isPublic: v.optional(v.boolean()),
    bannerColor: v.optional(v.string()),
    iconColor: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    category: v.optional(v.string()),
    slowModeSeconds: v.optional(v.number()),
    iconStorageId: v.optional(v.id("_storage")),
    bannerStorageId: v.optional(v.id("_storage")),
    clearIcon: v.optional(v.boolean()),
  },
  handler: async (ctx, { serverId, ...patch }) => {
    const userId = await currentUserId(ctx);
    await requirePermission(ctx, serverId, userId, "manageCommunity");
    const clean: Record<string, unknown> = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name.length < 2 || name.length > 50) throw new Error("Community name must be 2-50 characters.");
      clean.name = name;
    }
    if (patch.description !== undefined) clean.description = patch.description.trim().slice(0, 200);
    if (patch.isPublic !== undefined) clean.isPublic = patch.isPublic;
    if (patch.bannerColor !== undefined) clean.bannerColor = patch.bannerColor;
    if (patch.iconColor !== undefined) clean.iconColor = patch.iconColor;
    if (patch.tags !== undefined) clean.tags = patch.tags.slice(0, 6);
    if (patch.category !== undefined) clean.category = patch.category;
    if (patch.slowModeSeconds !== undefined) clean.slowModeSeconds = Math.max(0, Math.min(300, patch.slowModeSeconds));
    if (patch.iconStorageId !== undefined) clean.iconStorageId = patch.iconStorageId;
    if (patch.bannerStorageId !== undefined) clean.bannerStorageId = patch.bannerStorageId;
    if (patch.clearIcon) clean.iconStorageId = undefined;
    await ctx.db.patch(serverId, clean);
    await audit(ctx, "community.update", userId, `Updated community settings`, "community", serverId);
  },
});

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const memberships = await ctx.db.query("memberships").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    const servers = await Promise.all(memberships.map((m) => ctx.db.get(m.serverId)));
    return Promise.all(
      servers.filter((s) => s !== null).map(async (s) => ({
        ...s,
        iconUrl: s.iconStorageId ? await ctx.storage.getUrl(s.iconStorageId) : null,
      })),
    );
  },
});

export const details = query({
  args: { serverId: v.id("servers") },
  handler: async (ctx, { serverId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    await requireMember(ctx, serverId, userId);
    const server = await ctx.db.get(serverId);
    if (!server) return null;
    const channels = await ctx.db.query("channels").withIndex("by_server", (q) => q.eq("serverId", serverId)).collect();
    const memberships = await ctx.db.query("memberships").withIndex("by_server", (q) => q.eq("serverId", serverId)).collect();
    const members = await Promise.all(
      memberships.map((m) => memberCard(ctx, m.userId, m.role, m.timeoutUntil, userId)),
    );
    const roles = await ctx.db.query("communityRoles").withIndex("by_server", (q) => q.eq("serverId", serverId)).collect();
    const permissions = await effectivePermissions(ctx, serverId, userId);
    const myMembership = memberships.find((m) => m.userId === userId);
    return {
      server: {
        ...server,
        iconUrl: server.iconStorageId ? await ctx.storage.getUrl(server.iconStorageId) : null,
        bannerUrl: server.bannerStorageId ? await ctx.storage.getUrl(server.bannerStorageId) : null,
      },
      channels,
      members,
      roles,
      permissions,
      myRole: myMembership?.role ?? "member",
      isOwner: server.ownerId === userId,
      timedOut: isTimedOut(myMembership ?? null),
      inviteCode: server.inviteCode,
    };
  },
});

// ---------------- Discovery ----------------

export const discover = query({
  args: { q: v.optional(v.string()), category: v.optional(v.string()) },
  handler: async (ctx, { q, category }) => {
    // Platform-wide switch (managed from the Admin Panel).
    const settings = await platformSettingsOf(ctx);
    if (settings?.discoveryEnabled === false) return [];
    const all = await ctx.db.query("servers").withIndex("by_public", (q2) => q2.eq("isPublic", true)).take(100);
    const term = q?.trim().toLowerCase();
    const out = [];
    for (const server of all) {
      // Communities without an explicit category belong to "General".
      if (category && (server.category ?? "General") !== category) continue;
      if (term && !`${server.name} ${server.description} ${(server.tags ?? []).join(" ")}`.toLowerCase().includes(term)) continue;
      const members = await ctx.db.query("memberships").withIndex("by_server", (x) => x.eq("serverId", server._id)).collect();
      out.push({
        serverId: server._id,
        name: server.name,
        description: server.description,
        iconColor: server.iconColor ?? "violet",
        bannerColor: server.bannerColor ?? "violet",
        iconUrl: server.iconStorageId ? await ctx.storage.getUrl(server.iconStorageId) : null,
        memberCount: members.length,
        tags: server.tags ?? [],
        category: server.category ?? "General",
      });
    }
    return out.sort((a, b) => b.memberCount - a.memberCount).slice(0, 40);
  },
});

export const categories = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("servers").withIndex("by_public", (q) => q.eq("isPublic", true)).take(200);
    const set = new Set(all.map((s) => s.category ?? "General"));
    return [...set].sort();
  },
});

// ---------------- Channels ----------------

export const createChannel = mutation({
  args: { serverId: v.id("servers"), name: v.string(), type: v.optional(v.union(v.literal("text"), v.literal("voice"), v.literal("video"))) },
  handler: async (ctx, { serverId, name, type }) => {
    const userId = await currentUserId(ctx);
    await requirePermission(ctx, serverId, userId, "createChannels");
    const normalized = name.trim().toLowerCase().replace(/[^a-z0-9- ]/g, "-").replace(/\s+/g, "-").slice(0, 40);
    if (!normalized) throw new Error("Please enter a channel name.");
    const channels = await ctx.db.query("channels").withIndex("by_server", (q) => q.eq("serverId", serverId)).collect();
    if (channels.some((c) => c.name.toLowerCase() === normalized)) throw new Error("A channel with that name already exists.");
    const id = await ctx.db.insert("channels", {
      serverId,
      name: type === "text" || !type ? normalized : name.trim().slice(0, 40),
      description: "A new conversation starts here.",
      type: type ?? "text",
    });
    await audit(ctx, "channel.create", userId, `Created channel ${normalized}`, "channel", id);
    return id;
  },
});

export const updateChannel = mutation({
  args: { channelId: v.id("channels"), name: v.optional(v.string()), description: v.optional(v.string()), locked: v.optional(v.boolean()), slowModeSeconds: v.optional(v.number()) },
  handler: async (ctx, { channelId, ...patch }) => {
    const userId = await currentUserId(ctx);
    const channel = await ctx.db.get(channelId);
    if (!channel) throw new Error("Channel not found.");
    await requirePermission(ctx, channel.serverId, userId, "manageChannels");
    const clean: Record<string, unknown> = {};
    if (patch.name !== undefined) clean.name = patch.name.trim().slice(0, 40);
    if (patch.description !== undefined) clean.description = patch.description.trim().slice(0, 200);
    if (patch.locked !== undefined) clean.locked = patch.locked;
    if (patch.slowModeSeconds !== undefined) clean.slowModeSeconds = Math.max(0, Math.min(300, patch.slowModeSeconds));
    await ctx.db.patch(channelId, clean);
  },
});

export const deleteChannel = mutation({
  args: { channelId: v.id("channels") },
  handler: async (ctx, { channelId }) => {
    const userId = await currentUserId(ctx);
    const channel = await ctx.db.get(channelId);
    if (!channel) return;
    await requirePermission(ctx, channel.serverId, userId, "manageChannels");
    const messages = await ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("channelId", channelId)).collect();
    for (const m of messages) {
      const reacts = await ctx.db.query("reactions").withIndex("by_message", (q) => q.eq("messageId", m._id)).collect();
      for (const r of reacts) await ctx.db.delete(r._id);
      await ctx.db.delete(m._id);
    }
    await ctx.db.delete(channelId);
    await audit(ctx, "channel.delete", userId, `Deleted channel ${channel.name}`, "channel", channelId);
  },
});

// ---------------- Roles ----------------

export const createRole = mutation({
  args: { serverId: v.id("servers"), name: v.string(), color: v.optional(v.string()), permissions: v.array(permissionArg) },
  handler: async (ctx, { serverId, name, color, permissions }) => {
    const userId = await currentUserId(ctx);
    await requirePermission(ctx, serverId, userId, "manageRoles");
    const clean = name.trim().slice(0, 30);
    if (!clean) throw new Error("Please enter a role name.");
    const existing = await ctx.db.query("communityRoles").withIndex("by_server", (q) => q.eq("serverId", serverId)).collect();
    const id = await ctx.db.insert("communityRoles", { serverId, name: clean, color, permissions, position: existing.length });
    await audit(ctx, "role.create", userId, `Created role ${clean}`, "role", id);
    return id;
  },
});

export const updateRole = mutation({
  args: { roleId: v.id("communityRoles"), name: v.optional(v.string()), color: v.optional(v.string()), permissions: v.optional(v.array(permissionArg)) },
  handler: async (ctx, { roleId, ...patch }) => {
    const userId = await currentUserId(ctx);
    const role = await ctx.db.get(roleId);
    if (!role) throw new Error("Role not found.");
    await requirePermission(ctx, role.serverId, userId, "manageRoles");
    const clean: Record<string, unknown> = {};
    if (patch.name !== undefined) clean.name = patch.name.trim().slice(0, 30);
    if (patch.color !== undefined) clean.color = patch.color;
    if (patch.permissions !== undefined) clean.permissions = patch.permissions;
    await ctx.db.patch(roleId, clean);
  },
});

export const deleteRole = mutation({
  args: { roleId: v.id("communityRoles") },
  handler: async (ctx, { roleId }) => {
    const userId = await currentUserId(ctx);
    const role = await ctx.db.get(roleId);
    if (!role) return;
    await requirePermission(ctx, role.serverId, userId, "manageRoles");
    const members = await ctx.db.query("memberships").withIndex("by_server", (q) => q.eq("serverId", role.serverId)).collect();
    for (const m of members) if (m.customRoleId === roleId) await ctx.db.patch(m._id, { customRoleId: undefined });
    await ctx.db.delete(roleId);
  },
});

export const assignRole = mutation({
  args: { serverId: v.id("servers"), userId: v.id("users"), role: v.optional(v.union(v.literal("owner"), v.literal("admin"), v.literal("moderator"), v.literal("member"))), customRoleId: v.optional(v.id("communityRoles")) },
  handler: async (ctx, { serverId, userId, role, customRoleId }) => {
    const me = await currentUserId(ctx);
    await requirePermission(ctx, serverId, me, "manageRoles");
    const target = await membershipOf(ctx, serverId, userId);
    if (!target) throw new Error("That user isn't a member.");
    if (role) {
      const server = await ctx.db.get(serverId);
      if (server?.ownerId === userId && role !== "owner") throw new Error("The owner's role can't be changed.");
      await ctx.db.patch(target._id, { role });
    }
    if (customRoleId !== undefined) await ctx.db.patch(target._id, { customRoleId });
    await audit(ctx, "role.assign", me, `Assigned role to ${userId}`, "user", userId);
  },
});

// ---------------- Invites ----------------

export const createInvite = mutation({
  args: { serverId: v.id("servers"), expiresInHours: v.optional(v.number()), maxUses: v.optional(v.number()) },
  handler: async (ctx, { serverId, expiresInHours, maxUses }) => {
    const userId = await currentUserId(ctx);
    await requirePermission(ctx, serverId, userId, "createInvites");
    const code = inviteCode();
    const id = await ctx.db.insert("invites", {
      serverId,
      code,
      createdBy: userId,
      expiresAt: expiresInHours ? Date.now() + expiresInHours * 3_600_000 : undefined,
      maxUses,
      uses: 0,
    });
    return { id, code };
  },
});

export const listInvites = query({
  args: { serverId: v.id("servers") },
  handler: async (ctx, { serverId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    await requireMember(ctx, serverId, userId);
    const invites = await ctx.db.query("invites").withIndex("by_server", (q) => q.eq("serverId", serverId)).collect();
    return invites.map((i) => ({ ...i, expired: Boolean(i.expiresAt && i.expiresAt < Date.now()) }));
  },
});

export const revokeInvite = mutation({
  args: { inviteId: v.id("invites") },
  handler: async (ctx, { inviteId }) => {
    const userId = await currentUserId(ctx);
    const invite = await ctx.db.get(inviteId);
    if (!invite) return;
    await requirePermission(ctx, invite.serverId, userId, "createInvites");
    await ctx.db.delete(inviteId);
  },
});

// ---------------- Moderation ----------------

export const kickMember = mutation({
  args: { serverId: v.id("servers"), userId: v.id("users") },
  handler: async (ctx, { serverId, userId }) => {
    const me = await currentUserId(ctx);
    await requirePermission(ctx, serverId, me, "kickMembers");
    const server = await ctx.db.get(serverId);
    if (server?.ownerId === userId) throw new Error("You can't kick the owner.");
    const target = await membershipOf(ctx, serverId, userId);
    if (!target) throw new Error("That user isn't a member.");
    await ctx.db.delete(target._id);
    await audit(ctx, "member.kick", me, `Kicked ${userId}`, "user", userId);
    await notify(ctx, userId, "announcement", "Removed from a community", `You were removed from ${server?.name ?? "a community"}.`, `?discover=1`);
  },
});

export const banMember = mutation({
  args: { serverId: v.id("servers"), userId: v.id("users"), reason: v.optional(v.string()) },
  handler: async (ctx, { serverId, userId, reason }) => {
    const me = await currentUserId(ctx);
    await requirePermission(ctx, serverId, me, "banMembers");
    const server = await ctx.db.get(serverId);
    if (server?.ownerId === userId) throw new Error("You can't ban the owner.");
    const existing = await ctx.db.query("bans").withIndex("by_server_user", (q) => q.eq("serverId", serverId).eq("userId", userId)).unique();
    if (!existing) await ctx.db.insert("bans", { serverId, userId, reason: reason?.slice(0, 200), byId: me });
    const target = await membershipOf(ctx, serverId, userId);
    if (target) await ctx.db.delete(target._id);
    await audit(ctx, "member.ban", me, `Banned ${userId}${reason ? `: ${reason}` : ""}`, "user", userId);
  },
});

export const unbanMember = mutation({
  args: { serverId: v.id("servers"), userId: v.id("users") },
  handler: async (ctx, { serverId, userId }) => {
    const me = await currentUserId(ctx);
    await requirePermission(ctx, serverId, me, "banMembers");
    const ban = await ctx.db.query("bans").withIndex("by_server_user", (q) => q.eq("serverId", serverId).eq("userId", userId)).unique();
    if (ban) await ctx.db.delete(ban._id);
    await audit(ctx, "member.unban", me, `Unbanned ${userId}`, "user", userId);
  },
});

export const listBans = query({
  args: { serverId: v.id("servers") },
  handler: async (ctx, { serverId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    if (!(await hasPermission(ctx, serverId, userId, "banMembers"))) return [];
    const bans = await ctx.db.query("bans").withIndex("by_server", (q) => q.eq("serverId", serverId)).collect();
    return Promise.all(bans.map(async (b) => ({ userId: b.userId, reason: b.reason ?? "", name: await displayNameOf(ctx, b.userId) })));
  },
});

export const timeoutMember = mutation({
  args: { serverId: v.id("servers"), userId: v.id("users"), minutes: v.number() },
  handler: async (ctx, { serverId, userId, minutes }) => {
    const me = await currentUserId(ctx);
    await requirePermission(ctx, serverId, me, "manageMembers");
    const target = await membershipOf(ctx, serverId, userId);
    if (!target) throw new Error("That user isn't a member.");
    const clamped = Math.max(0, Math.min(1440, Math.round(minutes)));
    await ctx.db.patch(target._id, { timeoutUntil: clamped === 0 ? undefined : Date.now() + clamped * 60_000 });
    await audit(ctx, clamped === 0 ? "member.untimeout" : "member.timeout", me, `${clamped === 0 ? "Cleared timeout for" : `Timed out`} ${userId} (${clamped}m)`, "user", userId);
  },
});

export const auditLog = query({
  args: { serverId: v.id("servers") },
  handler: async (ctx, { serverId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    if (!(await hasPermission(ctx, serverId, userId, "manageCommunity"))) return [];
    const members = await ctx.db.query("memberships").withIndex("by_server", (q) => q.eq("serverId", serverId)).collect();
    const memberIds = new Set(members.map((m) => m.userId as string));
    const logs = await ctx.db.query("moderationLogs").order("desc").take(200);
    const relevant = logs.filter((l) => l.actorId && memberIds.has(l.actorId as string));
    return Promise.all(relevant.slice(0, 60).map(async (l) => ({ ...l, actor: l.actorId ? await displayNameOf(ctx, l.actorId) : "system" })));
  },
});

// ---------------- Voice / video sessions ----------------

export const joinVoice = mutation({
  args: { channelId: v.id("channels"), video: v.optional(v.boolean()) },
  handler: async (ctx, { channelId, video }) => {
    const userId = await currentUserId(ctx);
    const channel = await ctx.db.get(channelId);
    if (!channel) throw new Error("Channel not found.");
    const membership = await requireMember(ctx, channel.serverId, userId);
    if (isTimedOut(membership)) throw new Error("You're currently timed out.");
    if (!(await hasPermission(ctx, channel.serverId, userId, "useVoice"))) throw new Error("You don't have permission to use voice here.");
    const existing = await ctx.db.query("voiceSessions").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    for (const s of existing) await ctx.db.delete(s._id);
    await ctx.db.insert("voiceSessions", { channelId, userId, joinedAt: Date.now(), muted: false, deafened: false, video: video ?? false, screen: false });
  },
});

export const leaveVoice = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await currentUserId(ctx);
    const sessions = await ctx.db.query("voiceSessions").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    for (const s of sessions) await ctx.db.delete(s._id);
  },
});

export const setVoiceState = mutation({
  args: { muted: v.optional(v.boolean()), deafened: v.optional(v.boolean()), video: v.optional(v.boolean()), screen: v.optional(v.boolean()) },
  handler: async (ctx, patch) => {
    const userId = await currentUserId(ctx);
    const session = await ctx.db.query("voiceSessions").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    if (!session) throw new Error("You're not in a voice channel.");
    const clean: Record<string, unknown> = {};
    if (patch.muted !== undefined) clean.muted = patch.muted;
    if (patch.deafened !== undefined) clean.deafened = patch.deafened;
    if (patch.video !== undefined) clean.video = patch.video;
    if (patch.screen !== undefined) clean.screen = patch.screen;
    await ctx.db.patch(session._id, clean);
  },
});

export const voiceParticipants = query({
  args: { channelId: v.id("channels") },
  handler: async (ctx, { channelId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const sessions = await ctx.db.query("voiceSessions").withIndex("by_channel", (q) => q.eq("channelId", channelId)).collect();
    return Promise.all(
      sessions.map(async (s) => ({
        userId: s.userId,
        name: await displayNameOf(ctx, s.userId),
        muted: s.muted,
        deafened: s.deafened,
        video: s.video,
        screen: s.screen,
        joinedAt: s.joinedAt,
      })),
    );
  },
});

/** Active voice sessions across the communities the user belongs to. */
export const myVoiceSession = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const session = await ctx.db.query("voiceSessions").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    if (!session) return null;
    const channel = await ctx.db.get(session.channelId);
    return { ...session, channelName: channel?.name ?? "" };
  },
});

// WebRTC signaling: offer/answer/candidate relayed through the database.
export const sendSignal = mutation({
  args: {
    channelId: v.id("channels"),
    toUserId: v.id("users"),
    kind: v.union(v.literal("offer"), v.literal("answer"), v.literal("candidate"), v.literal("screen")),
    payload: v.string(),
  },
  handler: async (ctx, { channelId, toUserId, kind, payload }) => {
    const userId = await currentUserId(ctx);
    const channel = await ctx.db.get(channelId);
    if (!channel) throw new Error("Channel not found.");
    await requireMember(ctx, channel.serverId, userId);
    if (payload.length > 60_000) throw new Error("Signal payload too large.");
    await ctx.db.insert("voiceSignals", { channelId, fromUserId: userId, toUserId, kind, payload });
  },
});

export const pollSignals = query({
  args: { channelId: v.id("channels") },
  handler: async (ctx, { channelId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db.query("voiceSignals").withIndex("by_to", (q) => q.eq("toUserId", userId)).collect();
    return rows.filter((r) => r.channelId === channelId).slice(0, 40).map((r) => ({ _id: r._id, fromUserId: r.fromUserId, kind: r.kind, payload: r.payload }));
  },
});

export const clearSignal = mutation({
  args: { signalId: v.id("voiceSignals") },
  handler: async (ctx, { signalId }) => {
    const userId = await currentUserId(ctx);
    const row = await ctx.db.get(signalId);
    if (!row || row.toUserId !== userId) return;
    await ctx.db.delete(signalId);
  },
});

// ---------------- Channel typing ----------------

export const setTyping = mutation({
  args: { channelId: v.id("channels") },
  handler: async (ctx, { channelId }) => {
    const userId = await currentUserId(ctx);
    const channel = await ctx.db.get(channelId);
    if (!channel) return;
    await requireMember(ctx, channel.serverId, userId);
    const scope = `channel:${channelId}`;
    const rows = await ctx.db.query("typing").withIndex("by_scope", (q) => q.eq("scope", scope)).collect();
    const mine = rows.find((t) => t.userId === userId);
    if (mine) await ctx.db.patch(mine._id, { at: Date.now() });
    else await ctx.db.insert("typing", { scope, userId, at: Date.now() });
  },
});

export const typingIn = query({
  args: { channelId: v.id("channels") },
  handler: async (ctx, { channelId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db.query("typing").withIndex("by_scope", (q) => q.eq("scope", `channel:${channelId}`)).collect();
    const cutoff = Date.now() - 6000;
    return Promise.all(rows.filter((t) => t.userId !== userId && t.at > cutoff).map((t) => displayNameOf(ctx, t.userId)));
  },
});

export const isBlockedCheck = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const me = await getAuthUserId(ctx);
    if (!me) return false;
    return isBlockedEitherWay(ctx, me, userId);
  },
});
