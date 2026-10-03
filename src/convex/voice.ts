import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { audit, currentUserId, displayNameOf, hasPermission, isTimedOut, membershipOf, notify, requireMember, requirePermission } from "./lib";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

const channelTypeArg = v.union(v.literal("text"), v.literal("voice"), v.literal("video"));

/** Can the viewer see this channel? Private channels need an allowed role. */
async function canViewChannel(ctx: QueryCtx, channelId: Id<"channels">, userId: Id<"users">) {
  const channel = await ctx.db.get(channelId);
  if (!channel) return null;
  const membership = await membershipOf(ctx, channel.serverId, userId);
  if (!membership) return null;
  if (channel.isPrivate) {
    const allowed = channel.allowedRoleIds ?? [];
    const role = membership.role ?? "member";
    const customOk = membership.customRoleId ? allowed.includes(membership.customRoleId as string) : false;
    const server = await ctx.db.get(channel.serverId);
    const isOwnerOrAdmin = server?.ownerId === userId || role === "owner" || role === "admin";
    if (!isAdminLike(isOwnerOrAdmin) && !allowed.includes(role) && !customOk) return null;
  }
  return channel;
}

function isAdminLike(v: boolean) { return v; }

export const createChannelFull = mutation({
  args: {
    serverId: v.id("servers"),
    name: v.string(),
    type: channelTypeArg,
    categoryId: v.optional(v.id("channelCategories")),
    userLimit: v.optional(v.number()),
    isPrivate: v.optional(v.boolean()),
    allowedRoleIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await currentUserId(ctx);
    // The owner always passes this check; admins with the permission also do.
    await requirePermission(ctx, args.serverId, userId, "createChannels");

    const raw = args.name.trim();
    if (raw.length < 1 || raw.length > 40) throw new ConvexError("Channel names must be 1-40 characters.");
    const existing = await ctx.db.query("channels").withIndex("by_server", (q) => q.eq("serverId", args.serverId)).collect();
    // Voice channel names keep their formatting; text channels are slugified.
    const name = args.type === "text"
      ? raw.toLowerCase().replace(/[^a-z0-9- ]/g, "-").replace(/\s+/g, "-").slice(0, 40)
      : raw.slice(0, 40);
    if (existing.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      throw new ConvexError("A channel with that name already exists.");
    }
    const limit = args.userLimit === undefined ? 0 : Math.max(0, Math.min(100, Math.round(args.userLimit)));

    const id = await ctx.db.insert("channels", {
      serverId: args.serverId,
      name,
      description: args.type === "voice" ? "Hop in and talk." : "A new conversation starts here.",
      type: args.type,
      categoryId: args.categoryId,
      position: existing.length,
      userLimit: limit,
      isPrivate: args.isPrivate ?? false,
      allowedRoleIds: args.allowedRoleIds ?? [],
    });
    await audit(ctx, "channel.create", userId, `Created ${args.type} channel ${name}`, "channel", id);
    return id;
  },
});

export const updateChannelFull = mutation({
  args: {
    channelId: v.id("channels"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    userLimit: v.optional(v.number()),
    isPrivate: v.optional(v.boolean()),
    allowedRoleIds: v.optional(v.array(v.string())),
    categoryId: v.optional(v.id("channelCategories")),
    position: v.optional(v.number()),
    locked: v.optional(v.boolean()),
    slowModeSeconds: v.optional(v.number()),
  },
  handler: async (ctx, { channelId, ...patch }) => {
    const userId = await currentUserId(ctx);
    const channel = await ctx.db.get(channelId);
    if (!channel) throw new ConvexError("Channel not found.");
    await requirePermission(ctx, channel.serverId, userId, "manageChannels");

    const clean: Record<string, unknown> = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim().slice(0, 40);
      if (!name) throw new ConvexError("Channel name can't be empty.");
      clean.name = name;
    }
    if (patch.description !== undefined) clean.description = patch.description.trim().slice(0, 200);
    if (patch.userLimit !== undefined) clean.userLimit = Math.max(0, Math.min(100, Math.round(patch.userLimit)));
    if (patch.isPrivate !== undefined) clean.isPrivate = patch.isPrivate;
    if (patch.allowedRoleIds !== undefined) clean.allowedRoleIds = patch.allowedRoleIds.slice(0, 20);
    if (patch.categoryId !== undefined) clean.categoryId = patch.categoryId;
    if (patch.position !== undefined) clean.position = Math.max(0, Math.round(patch.position));
    if (patch.locked !== undefined) clean.locked = patch.locked;
    if (patch.slowModeSeconds !== undefined) clean.slowModeSeconds = Math.max(0, Math.min(300, patch.slowModeSeconds));

    await ctx.db.patch(channelId, clean);
    await audit(ctx, "channel.update", userId, `Updated channel ${clean.name ?? channel.name}`, "channel", channelId);
  },
});

export const reorderChannels = mutation({
  args: {
    serverId: v.id("servers"),
    order: v.array(v.object({ channelId: v.id("channels"), position: v.number(), categoryId: v.optional(v.id("channelCategories")) })),
  },
  handler: async (ctx, { serverId, order }) => {
    const userId = await currentUserId(ctx);
    await requirePermission(ctx, serverId, userId, "manageChannels");
    for (const item of order.slice(0, 200)) {
      const channel = await ctx.db.get(item.channelId);
      if (!channel || channel.serverId !== serverId) continue;
      await ctx.db.patch(item.channelId, { position: Math.max(0, Math.round(item.position)), categoryId: item.categoryId });
    }
    await audit(ctx, "channel.reorder", userId, "Reordered channels", "server", serverId);
  },
});

export const deleteChannelFull = mutation({
  args: { channelId: v.id("channels") },
  handler: async (ctx, { channelId }) => {
    const userId = await currentUserId(ctx);
    const channel = await ctx.db.get(channelId);
    if (!channel) return;
    await requirePermission(ctx, channel.serverId, userId, "manageChannels");

    // Disconnect anyone in the voice channel before removing it.
    const sessions = await ctx.db.query("voiceSessions").withIndex("by_channel", (q) => q.eq("channelId", channelId)).collect();
    for (const s of sessions) {
      await notify(ctx, s.userId, "announcement", "Voice channel closed", `#${channel.name} was deleted.`, "/dashboard");
      await ctx.db.delete(s._id);
    }
    const messages = await ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("channelId", channelId)).collect();
    for (const m of messages) {
      const reactions = await ctx.db.query("reactions").withIndex("by_message", (q) => q.eq("messageId", m._id)).collect();
      for (const r of reactions) await ctx.db.delete(r._id);
      const files = await ctx.db.query("attachments").withIndex("by_message", (q) => q.eq("messageId", m._id)).collect();
      for (const f of files) { await ctx.storage.delete(f.storageId); await ctx.db.delete(f._id); }
      await ctx.db.delete(m._id);
    }
    await ctx.db.delete(channelId);
    await audit(ctx, "channel.delete", userId, `Deleted ${channel.type} channel ${channel.name}`, "channel", channelId);
  },
});

/** Duplicate a voice channel's settings. */
export const duplicateChannel = mutation({
  args: { channelId: v.id("channels") },
  handler: async (ctx, { channelId }) => {
    const userId = await currentUserId(ctx);
    const channel = await ctx.db.get(channelId);
    if (!channel) throw new ConvexError("Channel not found.");
    await requirePermission(ctx, channel.serverId, userId, "manageChannels");
    const existing = await ctx.db.query("channels").withIndex("by_server", (q) => q.eq("serverId", channel.serverId)).collect();
    const id = await ctx.db.insert("channels", {
      serverId: channel.serverId,
      name: `${channel.name} copy`.slice(0, 40),
      description: channel.description,
      type: channel.type,
      categoryId: channel.categoryId,
      position: existing.length,
      userLimit: channel.userLimit,
      isPrivate: channel.isPrivate,
      allowedRoleIds: channel.allowedRoleIds,
    });
    await audit(ctx, "channel.duplicate", userId, `Duplicated channel ${channel.name}`, "channel", id);
    return id;
  },
});

// ---------------- Categories ----------------

export const createCategory = mutation({
  args: { serverId: v.id("servers"), name: v.string() },
  handler: async (ctx, { serverId, name }) => {
    const userId = await currentUserId(ctx);
    await requirePermission(ctx, serverId, userId, "manageChannels");
    const clean = name.trim().slice(0, 40);
    if (!clean) throw new ConvexError("Category name can't be empty.");
    const existing = await ctx.db.query("channelCategories").withIndex("by_server", (q) => q.eq("serverId", serverId)).collect();
    return ctx.db.insert("channelCategories", { serverId, name: clean, position: existing.length });
  },
});

export const updateCategory = mutation({
  args: { categoryId: v.id("channelCategories"), name: v.optional(v.string()), position: v.optional(v.number()) },
  handler: async (ctx, { categoryId, ...patch }) => {
    const userId = await currentUserId(ctx);
    const category = await ctx.db.get(categoryId);
    if (!category) throw new ConvexError("Category not found.");
    await requirePermission(ctx, category.serverId, userId, "manageChannels");
    const clean: Record<string, unknown> = {};
    if (patch.name !== undefined) clean.name = patch.name.trim().slice(0, 40);
    if (patch.position !== undefined) clean.position = Math.max(0, Math.round(patch.position));
    await ctx.db.patch(categoryId, clean);
  },
});

export const deleteCategory = mutation({
  args: { categoryId: v.id("channelCategories") },
  handler: async (ctx, { categoryId }) => {
    const userId = await currentUserId(ctx);
    const category = await ctx.db.get(categoryId);
    if (!category) return;
    await requirePermission(ctx, category.serverId, userId, "manageChannels");
    const channels = await ctx.db.query("channels").withIndex("by_server", (q) => q.eq("serverId", category.serverId)).collect();
    for (const c of channels) if (c.categoryId === categoryId) await ctx.db.patch(c._id, { categoryId: undefined });
    await ctx.db.delete(categoryId);
  },
});

/** Categories + ordered channels for the sidebar (private ones filtered out). */
export const channelTree = query({
  args: { serverId: v.id("servers") },
  handler: async (ctx, { serverId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    await requireMember(ctx, serverId, userId);
    const categories = await ctx.db.query("channelCategories").withIndex("by_server", (q) => q.eq("serverId", serverId)).collect();
    const channels = await ctx.db.query("channels").withIndex("by_server", (q) => q.eq("serverId", serverId)).collect();

    const visible: typeof channels = [];
    for (const c of channels) {
      const ok = await canViewChannel(ctx, c._id, userId);
      if (ok) visible.push(c);
    }
    visible.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    const sessions = await ctx.db.query("voiceSessions").collect();
    const byChannel: Record<string, { userId: string; name: string; muted: boolean; deafened: boolean; speaking: boolean; video: boolean; screen: boolean }[]> = {};
    for (const s of sessions) {
      const list = (byChannel[s.channelId as string] ??= []);
      list.push({
        userId: s.userId,
        name: await displayNameOf(ctx, s.userId),
        muted: s.muted,
        deafened: s.deafened,
        speaking: Boolean(s.speaking),
        video: s.video,
        screen: s.screen,
      });
    }

    return {
      categories: categories.sort((a, b) => a.position - b.position),
      uncategorized: visible.filter((c) => !c.categoryId),
      byCategory: categories.map((cat) => ({ category: cat, channels: visible.filter((c) => c.categoryId === cat._id) })),
      voiceParticipants: byChannel,
    };
  },
});

// ---------------- Joining / limits ----------------

export const joinVoiceChecked = mutation({
  args: { channelId: v.id("channels"), video: v.optional(v.boolean()) },
  handler: async (ctx, { channelId, video }) => {
    const userId = await currentUserId(ctx);
    const channel = await ctx.db.get(channelId);
    if (!channel) throw new ConvexError("Channel not found.");
    if (channel.type === "text") throw new ConvexError("That's a text channel.");

    const membership = await requireMember(ctx, channel.serverId, userId);
    if (isTimedOut(membership)) throw new ConvexError("You're currently timed out.");
    if (!(await hasPermission(ctx, channel.serverId, userId, "useVoice"))) {
      throw new ConvexError("You don't have permission to use voice here.");
    }
    // Private channel access.
    const viewable = await canViewChannel(ctx, channelId, userId);
    if (!viewable) throw new ConvexError("You don't have access to this voice channel.");

    // User limit (server-enforced so it can't be bypassed from the client).
    const sessions = await ctx.db.query("voiceSessions").withIndex("by_channel", (q) => q.eq("channelId", channelId)).collect();
    const limit = channel.userLimit ?? 0;
    const alreadyIn = sessions.some((s) => s.userId === userId);
    if (limit > 0 && !alreadyIn && sessions.length >= limit) {
      throw new ConvexError("Voice channel is full.");
    }

    // Leave any previous voice channel first.
    const mine = await ctx.db.query("voiceSessions").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    for (const s of mine) await ctx.db.delete(s._id);

    await ctx.db.insert("voiceSessions", {
      channelId,
      userId,
      joinedAt: Date.now(),
      muted: false,
      deafened: false,
      video: video ?? false,
      screen: false,
      speaking: false,
    });
  },
});

export const leaveVoiceSession = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await currentUserId(ctx);
    const sessions = await ctx.db.query("voiceSessions").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    for (const s of sessions) await ctx.db.delete(s._id);
  },
});

/**
 * Report real voice activity from the client's microphone analyser.
 * Stored on the session (not a message) and only used to render the speaking ring.
 */
export const setSpeaking = mutation({
  args: { speaking: v.boolean() },
  handler: async (ctx, { speaking }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return;
    const session = await ctx.db.query("voiceSessions").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    if (!session) return;
    if (session.speaking === speaking) return; // avoid needless writes
    await ctx.db.patch(session._id, { speaking, lastSpokeAt: speaking ? Date.now() : session.lastSpokeAt });
  },
});

export const setVoiceFlags = mutation({
  args: { muted: v.optional(v.boolean()), deafened: v.optional(v.boolean()), video: v.optional(v.boolean()), screen: v.optional(v.boolean()) },
  handler: async (ctx, patch) => {
    const userId = await currentUserId(ctx);
    const session = await ctx.db.query("voiceSessions").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    if (!session) throw new ConvexError("You're not in a voice channel.");
    const clean: Record<string, unknown> = {};
    if (patch.muted !== undefined) { clean.muted = patch.muted; if (patch.muted) clean.speaking = false; }
    if (patch.deafened !== undefined) clean.deafened = patch.deafened;
    if (patch.video !== undefined) clean.video = patch.video;
    if (patch.screen !== undefined) clean.screen = patch.screen;
    await ctx.db.patch(session._id, clean);
  },
});

// ---------------- Moderation ----------------

export const moderateUser = mutation({
  args: {
    action: v.union(v.literal("mute"), v.literal("deafen"), v.literal("disconnect"), v.literal("move")),
    userId: v.id("users"),
    targetChannelId: v.optional(v.id("channels")),
  },
  handler: async (ctx, { action, userId, targetChannelId }) => {
    const me = await currentUserId(ctx);
    const session = await ctx.db.query("voiceSessions").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    if (!session) throw new ConvexError("That user isn't in a voice channel.");
    const channel = await ctx.db.get(session.channelId);
    if (!channel) throw new ConvexError("Channel not found.");

    const permission = action === "move" ? "manageChannels" : "manageMembers";
    if (!(await hasPermission(ctx, channel.serverId, me, permission)) && !(await hasPermission(ctx, channel.serverId, me, "manageMembers"))) {
      throw new ConvexError("You don't have permission to moderate voice members.");
    }

    if (action === "mute") await ctx.db.patch(session._id, { muted: true, speaking: false });
    if (action === "deafen") await ctx.db.patch(session._id, { deafened: true, muted: true, speaking: false });
    if (action === "disconnect") {
      await ctx.db.delete(session._id);
      await notify(ctx, userId, "announcement", "Disconnected from voice", `You were disconnected from #${channel.name}.`, "/dashboard");
    }
    if (action === "move") {
      if (!targetChannelId) throw new ConvexError("Choose a channel to move them to.");
      const target = await ctx.db.get(targetChannelId);
      if (!target || target.serverId !== channel.serverId || target.type === "text") {
        throw new ConvexError("Invalid destination channel.");
      }
      const others = await ctx.db.query("voiceSessions").withIndex("by_channel", (q) => q.eq("channelId", targetChannelId)).collect();
      const limit = target.userLimit ?? 0;
      if (limit > 0 && others.length >= limit) throw new ConvexError("That channel is full.");
      await ctx.db.patch(session._id, { channelId: targetChannelId, speaking: false });
      await notify(ctx, userId, "announcement", "Moved to another voice channel", `You were moved to #${target.name}.`, "/dashboard");
    }
    await audit(ctx, `voice.${action}`, me, `${action} ${userId} in #${channel.name}`, "user", userId);
  },
});

export const voiceChannelDetails = query({
  args: { channelId: v.id("channels") },
  handler: async (ctx, { channelId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const channel = await ctx.db.get(channelId);
    if (!channel) return null;
    const viewable = await canViewChannel(ctx, channelId, userId);
    if (!viewable) return null;
    const sessions = await ctx.db.query("voiceSessions").withIndex("by_channel", (q) => q.eq("channelId", channelId)).collect();
    const participants = await Promise.all(
      sessions
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map(async (s) => ({
          userId: s.userId,
          name: await displayNameOf(ctx, s.userId),
          muted: s.muted,
          deafened: s.deafened,
          speaking: Boolean(s.speaking),
          video: s.video,
          screen: s.screen,
          joinedAt: s.joinedAt,
        })),
    );
    return { channel, participants, userLimit: channel.userLimit ?? 0 };
  },
});

void isAdminLike;