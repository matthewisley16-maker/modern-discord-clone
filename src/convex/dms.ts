import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { enforceRateLimit } from "./authHelpers";
import { areFriends, avatarUrlOf, currentUserId, displayNameOf, isBlockedEitherWay, notify, profileOf, settingsOf } from "./lib";
import type { Id } from "./_generated/dataModel";

async function requireMember(ctx: Parameters<typeof displayNameOf>[0], conversationId: Id<"dmConversations">, userId: Id<"users">) {
  const member = await ctx.db
    .query("dmMembers")
    .withIndex("by_pair", (q) => q.eq("conversationId", conversationId).eq("userId", userId))
    .unique();
  if (!member) throw new Error("You're not part of this conversation.");
  return member;
}

async function card(ctx: Parameters<typeof displayNameOf>[0], userId: Id<"users">) {
  const profile = await profileOf(ctx, userId);
  const user = await ctx.db.get(userId);
  const presence = await ctx.db.query("presence").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
  return {
    userId,
    username: user?.username ?? "",
    displayName: profile?.displayName ?? user?.name ?? "Freecord member",
    avatarColor: profile?.avatarColor ?? "violet",
    avatarUrl: await avatarUrlOf(ctx, userId),
    presence: presence?.status ?? "offline",
  };
}

/** Sidebar: all conversations the user is in, most recent first, with unread counts. */
export const listConversations = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const mine = await ctx.db.query("dmMembers").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    const out = [];
    for (const membership of mine) {
      const convo = await ctx.db.get(membership.conversationId);
      if (!convo) continue;
      const members = await ctx.db.query("dmMembers").withIndex("by_conversation", (q) => q.eq("conversationId", convo._id)).collect();
      const others = members.filter((m) => m.userId !== userId);
      const otherCards = await Promise.all(others.map((m) => card(ctx, m.userId)));

      const messages = await ctx.db.query("dmMessages").withIndex("by_conversation", (q) => q.eq("conversationId", convo._id)).collect();
      const lastRead = membership.lastReadAt ?? 0;
      const unread = messages.filter((m) => m.userId !== userId && m._creationTime > lastRead && !m.deleted).length;
      const sorted = messages.sort((a, b) => a._creationTime - b._creationTime);
      const last = sorted.length > 0 ? sorted[sorted.length - 1] : undefined;

      out.push({
        conversationId: convo._id,
        type: convo.type,
        name: convo.type === "group" ? convo.name ?? "Group" : otherCards[0]?.displayName ?? "Conversation",
        iconColor: convo.iconColor ?? "violet",
        members: otherCards,
        memberCount: members.length,
        pinned: membership.pinned ?? false,
        muted: membership.muted ?? false,
        unread,
        lastMessageAt: convo.lastMessageAt,
        lastMessage: last && !last.deleted ? last.body.slice(0, 90) : "",
      });
    }
    return out.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastMessageAt - a.lastMessageAt);
  },
});

/** Total unread DMs (for badges). */
export const unreadTotal = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return 0;
    const mine = await ctx.db.query("dmMembers").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    let total = 0;
    for (const membership of mine) {
      const messages = await ctx.db.query("dmMessages").withIndex("by_conversation", (q) => q.eq("conversationId", membership.conversationId)).collect();
      const lastRead = membership.lastReadAt ?? 0;
      total += messages.filter((m) => m.userId !== userId && m._creationTime > lastRead && !m.deleted).length;
    }
    return total;
  },
});

/** Start (or reuse) a 1:1 DM. Respects the recipient's DM privacy + blocks. */
export const startDirect = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const me = await currentUserId(ctx);
    if (me === userId) throw new Error("You can't DM yourself.");
    await enforceRateLimit(ctx, `dm:${me}`, 30, 60_000);
    if (await isBlockedEitherWay(ctx, me, userId)) throw new Error("You can't message this user.");

    const settings = await settingsOf(ctx, userId);
    if (settings?.dmPrivacy === "none") throw new Error("This user isn't accepting direct messages.");
    if (settings?.dmPrivacy === "friends" && !(await areFriends(ctx, me, userId))) {
      throw new Error("This user only accepts DMs from friends.");
    }

    // Reuse an existing direct conversation.
    const myConvos = await ctx.db.query("dmMembers").withIndex("by_user", (q) => q.eq("userId", me)).collect();
    for (const m of myConvos) {
      const convo = await ctx.db.get(m.conversationId);
      if (!convo || convo.type !== "direct") continue;
      const members = await ctx.db.query("dmMembers").withIndex("by_conversation", (q) => q.eq("conversationId", convo._id)).collect();
      if (members.length === 2 && members.some((x) => x.userId === userId)) return convo._id;
    }

    const now = Date.now();
    const conversationId = await ctx.db.insert("dmConversations", { type: "direct", ownerId: me, lastMessageAt: now });
    await ctx.db.insert("dmMembers", { conversationId, userId: me, lastReadAt: now });
    await ctx.db.insert("dmMembers", { conversationId, userId, lastReadAt: 0 });
    return conversationId;
  },
});

export const createGroup = mutation({
  args: { name: v.string(), memberIds: v.array(v.id("users")) },
  handler: async (ctx, { name, memberIds }) => {
    const me = await currentUserId(ctx);
    const clean = name.trim().slice(0, 50) || "Group";
    const unique = [...new Set(memberIds.filter((id) => id !== me))].slice(0, 24);
    if (unique.length === 0) throw new Error("Add at least one friend to the group.");
    for (const id of unique) {
      if (await isBlockedEitherWay(ctx, me, id)) throw new Error("One of those users is unavailable.");
    }
    const now = Date.now();
    const conversationId = await ctx.db.insert("dmConversations", { type: "group", name: clean, ownerId: me, lastMessageAt: now });
    await ctx.db.insert("dmMembers", { conversationId, userId: me, lastReadAt: now });
    for (const id of unique) await ctx.db.insert("dmMembers", { conversationId, userId: id, lastReadAt: 0 });
    return conversationId;
  },
});

export const renameGroup = mutation({
  args: { conversationId: v.id("dmConversations"), name: v.string() },
  handler: async (ctx, { conversationId, name }) => {
    const me = await currentUserId(ctx);
    await requireMember(ctx, conversationId, me);
    const convo = await ctx.db.get(conversationId);
    if (!convo) throw new Error("Conversation not found.");
    if (convo.type !== "group") throw new Error("Only group DMs can be renamed.");
    const clean = name.trim().slice(0, 50);
    if (!clean) throw new Error("Group name can't be empty.");
    await ctx.db.patch(conversationId, { name: clean });
  },
});

export const setGroupIcon = mutation({
  args: { conversationId: v.id("dmConversations"), iconColor: v.string() },
  handler: async (ctx, { conversationId, iconColor }) => {
    const me = await currentUserId(ctx);
    await requireMember(ctx, conversationId, me);
    await ctx.db.patch(conversationId, { iconColor });
  },
});

export const addGroupMembers = mutation({
  args: { conversationId: v.id("dmConversations"), memberIds: v.array(v.id("users")) },
  handler: async (ctx, { conversationId, memberIds }) => {
    const me = await currentUserId(ctx);
    await requireMember(ctx, conversationId, me);
    const convo = await ctx.db.get(conversationId);
    if (!convo || convo.type !== "group") throw new Error("Only group DMs can add members.");
    const existing = await ctx.db.query("dmMembers").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect();
    const existingIds = new Set(existing.map((m) => m.userId as string));
    for (const id of [...new Set(memberIds)]) {
      if (existingIds.has(id as string)) continue;
      if (await isBlockedEitherWay(ctx, me, id)) continue;
      await ctx.db.insert("dmMembers", { conversationId, userId: id, lastReadAt: 0 });
      await notify(ctx, id, "invite", "Added to a group DM", `${await displayNameOf(ctx, me)} added you to "${convo.name ?? "a group"}".`, "/dashboard");
    }
  },
});

export const removeGroupMember = mutation({
  args: { conversationId: v.id("dmConversations"), userId: v.id("users") },
  handler: async (ctx, { conversationId, userId }) => {
    const me = await currentUserId(ctx);
    await requireMember(ctx, conversationId, me);
    const convo = await ctx.db.get(conversationId);
    if (!convo || convo.type !== "group") throw new Error("Only group DMs have members.");
    // Owner or self can remove.
    if (convo.ownerId !== me && userId !== me) throw new Error("Only the group owner can remove members.");
    const member = await ctx.db.query("dmMembers").withIndex("by_pair", (q) => q.eq("conversationId", conversationId).eq("userId", userId)).unique();
    if (member) await ctx.db.delete(member._id);
  },
});

export const leaveGroup = mutation({
  args: { conversationId: v.id("dmConversations") },
  handler: async (ctx, { conversationId }) => {
    const me = await currentUserId(ctx);
    const member = await requireMember(ctx, conversationId, me);
    await ctx.db.delete(member._id);
    const remaining = await ctx.db.query("dmMembers").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect();
    if (remaining.length === 0) {
      const messages = await ctx.db.query("dmMessages").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect();
      for (const m of messages) await ctx.db.delete(m._id);
      await ctx.db.delete(conversationId);
    }
  },
});

export const setPinned = mutation({
  args: { conversationId: v.id("dmConversations"), pinned: v.boolean() },
  handler: async (ctx, { conversationId, pinned }) => {
    const me = await currentUserId(ctx);
    const member = await requireMember(ctx, conversationId, me);
    await ctx.db.patch(member._id, { pinned });
  },
});

export const setMuted = mutation({
  args: { conversationId: v.id("dmConversations"), muted: v.boolean() },
  handler: async (ctx, { conversationId, muted }) => {
    const me = await currentUserId(ctx);
    const member = await requireMember(ctx, conversationId, me);
    await ctx.db.patch(member._id, { muted });
  },
});

export const markRead = mutation({
  args: { conversationId: v.id("dmConversations") },
  handler: async (ctx, { conversationId }) => {
    const me = await currentUserId(ctx);
    const member = await ctx.db
      .query("dmMembers")
      .withIndex("by_pair", (q) => q.eq("conversationId", conversationId).eq("userId", me))
      .unique();
    if (member) await ctx.db.patch(member._id, { lastReadAt: Date.now() });
  },
});

/** Messages in a conversation, with reactions, attachments, replies and read state. */
export const messages = query({
  args: { conversationId: v.id("dmConversations"), search: v.optional(v.string()) },
  handler: async (ctx, { conversationId, search }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    await requireMember(ctx, conversationId, userId);
    // "Delete for me" is per-user and never affects other members.
    const hidden = new Set(
      (await ctx.db.query("messageVisibility").withIndex("by_user", (q) => q.eq("userId", userId)).collect()).map((h) => h.messageId),
    );
    const rows = await ctx.db
      .query("dmMessages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .order("desc")
      .take(150);
    // Deleted-for-everyone messages are removed entirely; hides apply per user.
    const ordered = rows
      .filter((r) => !r.deletedForEveryone && !hidden.has(r._id as string))
      .reverse();
    const term = search?.trim().toLowerCase();

    const result = [];
    for (const m of ordered) {
      if (term && !m.body.toLowerCase().includes(term)) continue;
      const reactions = await ctx.db.query("dmReactions").withIndex("by_message", (q) => q.eq("messageId", m._id)).collect();
      const files = await ctx.db.query("attachments").withIndex("by_dm_message", (q) => q.eq("dmMessageId", m._id)).collect();
      const attachments = await Promise.all(
        files.map(async (f) => ({ _id: f._id, name: f.name, size: f.size, contentType: f.contentType, url: await ctx.storage.getUrl(f.storageId) })),
      );
      let reply = null;
      if (m.replyToId) {
        const parent = await ctx.db.get(m.replyToId);
        if (parent) {
          reply = parent.deletedForEveryone
            ? { _id: parent._id, author: "", body: "Original message deleted", deleted: true }
            : { _id: parent._id, author: await displayNameOf(ctx, parent.userId), body: parent.body.slice(0, 140), deleted: false };
        }
      }
      result.push({
        ...m,
        author: await displayNameOf(ctx, m.userId),
        authorAvatarUrl: await avatarUrlOf(ctx, m.userId),
        reactions,
        // Attachments are removed on delete-for-everyone, so this stays empty.
        attachments,
        reply,
      });
    }

    // Read receipts: other members' lastReadAt.
    const members = await ctx.db.query("dmMembers").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect();
    const others = members.filter((m) => m.userId !== userId);
    const receiptsAllowed = (await Promise.all(others.map((o) => settingsOf(ctx, o.userId)))).every((s) => s?.readReceipts !== false);
    const lastMessage = result.length > 0 ? result[result.length - 1] : undefined;
    const readByOthers = receiptsAllowed && lastMessage
      ? others.filter((o) => (o.lastReadAt ?? 0) >= lastMessage._creationTime).length
      : 0;
    return Object.assign(result, { readByOthers, memberCount: members.length });
  },
});

export const sendMessage = mutation({
  args: { conversationId: v.id("dmConversations"), body: v.string(), replyToId: v.optional(v.id("dmMessages")) },
  handler: async (ctx, { conversationId, body, replyToId }) => {
    const me = await currentUserId(ctx);
    await requireMember(ctx, conversationId, me);
    await enforceRateLimit(ctx, `dmsg:${me}`, 60, 60_000);
    const text = body.trim();
    if (!text) throw new Error("Message can't be empty.");
    if (text.length > 4000) throw new Error("Message is too long (4000 characters max).");
    const messageId = await ctx.db.insert("dmMessages", { conversationId, userId: me, body: text, replyToId });
    await ctx.db.patch(conversationId, { lastMessageAt: Date.now() });

    // Notify other members (muted conversations are skipped).
    const members = await ctx.db.query("dmMembers").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect();
    const convo = await ctx.db.get(conversationId);
    for (const m of members) {
      if (m.userId === me || m.muted) continue;
      await notify(
        ctx,
        m.userId,
        replyToId ? "reply" : "dm",
        replyToId ? "New reply" : "New direct message",
        `${await displayNameOf(ctx, me)}${convo?.type === "group" ? ` in ${convo.name ?? "a group"}` : ""}: ${text.slice(0, 80)}`,
        "/dashboard",
        me,
      );
    }
    return messageId;
  },
});

export const editMessage = mutation({
  args: { messageId: v.id("dmMessages"), body: v.string() },
  handler: async (ctx, { messageId, body }) => {
    const me = await currentUserId(ctx);
    const message = await ctx.db.get(messageId);
    if (!message) throw new Error("Message not found.");
    await requireMember(ctx, message.conversationId, me);
    if (message.userId !== me) throw new Error("You can only edit your own messages.");
    const text = body.trim();
    if (!text) throw new Error("Message can't be empty.");
    await ctx.db.patch(messageId, { body: text.slice(0, 4000), editedAt: Date.now() });
  },
});

export const deleteMessage = mutation({
  args: { messageId: v.id("dmMessages") },
  handler: async (ctx, { messageId }) => {
    const me = await currentUserId(ctx);
    const message = await ctx.db.get(messageId);
    if (!message) return;
    await requireMember(ctx, message.conversationId, me);
    if (message.userId !== me) throw new Error("You can only delete your own messages.");
    const reactions = await ctx.db.query("dmReactions").withIndex("by_message", (q) => q.eq("messageId", messageId)).collect();
    for (const r of reactions) await ctx.db.delete(r._id);
    const files = await ctx.db.query("attachments").withIndex("by_dm_message", (q) => q.eq("dmMessageId", messageId)).collect();
    for (const f of files) { await ctx.storage.delete(f.storageId); await ctx.db.delete(f._id); }
    await ctx.db.delete(messageId);
  },
});

export const toggleReaction = mutation({
  args: { messageId: v.id("dmMessages"), emoji: v.string() },
  handler: async (ctx, { messageId, emoji }) => {
    const me = await currentUserId(ctx);
    const message = await ctx.db.get(messageId);
    if (!message) throw new Error("Message not found.");
    await requireMember(ctx, message.conversationId, me);
    const existing = await ctx.db
      .query("dmReactions")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .collect();
    const mine = existing.find((r) => r.userId === me && r.emoji === emoji);
    if (mine) await ctx.db.delete(mine._id);
    else await ctx.db.insert("dmReactions", { messageId, userId: me, emoji: emoji.slice(0, 8) });
  },
});

export const setPinnedMessage = mutation({
  args: { messageId: v.id("dmMessages"), pinned: v.boolean() },
  handler: async (ctx, { messageId, pinned }) => {
    const me = await currentUserId(ctx);
    const message = await ctx.db.get(messageId);
    if (!message) throw new Error("Message not found.");
    await requireMember(ctx, message.conversationId, me);
    await ctx.db.patch(messageId, { pinned });
  },
});

// ---------------- Typing indicators ----------------

export const setTyping = mutation({
  args: { conversationId: v.id("dmConversations") },
  handler: async (ctx, { conversationId }) => {
    const me = await currentUserId(ctx);
    await requireMember(ctx, conversationId, me);
    const scope = `dm:${conversationId}`;
    const existing = await ctx.db.query("typing").withIndex("by_scope", (q) => q.eq("scope", scope)).collect();
    const mine = existing.find((t) => t.userId === me);
    if (mine) await ctx.db.patch(mine._id, { at: Date.now() });
    else await ctx.db.insert("typing", { scope, userId: me, at: Date.now() });
  },
});

/** Clear my typing state for a DM (called on send, empty draft, or leaving). */
export const stopTyping = mutation({
  args: { conversationId: v.optional(v.id("dmConversations")), channelId: v.optional(v.id("channels")) },
  handler: async (ctx, { conversationId, channelId }) => {
    const me = await currentUserId(ctx);
    const scope = channelId ? `channel:${channelId}` : conversationId ? `dm:${conversationId}` : null;
    if (!scope) return;
    const rows = await ctx.db.query("typing").withIndex("by_scope", (q) => q.eq("scope", scope)).collect();
    for (const row of rows) if (row.userId === me) await ctx.db.delete(row._id);
  },
});

/** Who is currently typing (entries older than 6s are ignored). */
export const typingIn = query({
  args: { conversationId: v.id("dmConversations") },
  handler: async (ctx, { conversationId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db
      .query("typing")
      .withIndex("by_scope", (q) => q.eq("scope", `dm:${conversationId}`))
      .collect();
    const cutoff = Date.now() - 6000;
    return Promise.all(
      rows.filter((t) => t.userId !== userId && t.at > cutoff).map((t) => displayNameOf(ctx, t.userId)),
    );
  },
});
