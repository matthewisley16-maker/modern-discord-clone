import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { audit, currentUserId, displayNameOf, hasPermission, requireMember } from "./lib";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

/** Hide a message for the current user only. Never touches the message itself. */
async function hideForMe(
  ctx: MutationCtx,
  userId: Id<"users">,
  messageId: string,
  target: { channelId?: Id<"channels">; conversationId?: Id<"dmConversations"> },
) {
  const existing = await ctx.db
    .query("messageVisibility")
    .withIndex("by_user_message", (q) => q.eq("userId", userId).eq("messageId", messageId))
    .unique();
  if (existing) return;
  await ctx.db.insert("messageVisibility", {
    userId,
    messageId,
    channelId: target.channelId,
    conversationId: target.conversationId,
    hiddenAt: Date.now(),
  });
}

// ---------------- Channel messages ----------------

/**
 * Delete a channel message for everyone.
 * The backend verifies: membership, channel access, ownership, and — for other
 * people's messages — the manageMessages/deleteMessages permission. A client
 * cannot bypass this by editing frontend code.
 */
export const deleteForEveryone = mutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const userId = await currentUserId(ctx);
    const message = await ctx.db.get(messageId);
    if (!message) throw new ConvexError("Message not found.");
    const channel = await ctx.db.get(message.channelId);
    if (!channel) throw new ConvexError("Channel not found.");
    // Membership + channel access is enforced before anything else.
    await requireMember(ctx, channel.serverId, userId);
    // Owner of the message, or a moderator with manageMessages/deleteMessages.
    const isAuthor = message.userId === userId;
    if (!isAuthor) {
      const manage = await hasPermission(ctx, channel.serverId, userId, "manageMessages");
      const del = await hasPermission(ctx, channel.serverId, userId, "deleteMessages");
      if (!manage && !del) {
        throw new ConvexError("You don't have permission to delete this message.");
      }
    }

    // Attachments tied only to this message are removed so no public link lingers.
    const files = await ctx.db.query("attachments").withIndex("by_message", (q) => q.eq("messageId", messageId)).collect();
    for (const f of files) {
      await ctx.storage.delete(f.storageId);
      await ctx.db.delete(f._id);
    }
    const reactions = await ctx.db.query("reactions").withIndex("by_message", (q) => q.eq("messageId", messageId)).collect();
    for (const r of reactions) await ctx.db.delete(r._id);

    await ctx.db.patch(messageId, {
      body: "",
      deletedForEveryone: true,
      deletedAt: Date.now(),
      deletedBy: userId,
      deletedByModerator: !isAuthor,
      pinned: false,
    });

    await audit(
      ctx,
      isAuthor ? "message.delete_own" : "message.delete_moderator",
      userId,
      `${isAuthor ? "Deleted own" : `Deleted ${await displayNameOf(ctx, message.userId)}'s`} message in #${channel.name}`,
      "message",
      messageId,
    );
  },
});

/** Hide a channel message for the current user only. */
export const deleteForMe = mutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const userId = await currentUserId(ctx);
    const msg = await ctx.db.get(messageId);
    if (!msg) throw new ConvexError("Message not found.");
    const channel = await ctx.db.get(msg.channelId);
    if (!channel) throw new ConvexError("Channel not found.");
    await requireMember(ctx, channel.serverId, userId);
    await hideForMe(ctx, userId, messageId, { channelId: msg.channelId });
  },
});

// ---------------- DM messages ----------------

export const deleteDmForEveryone = mutation({
  args: { messageId: v.id("dmMessages") },
  handler: async (ctx, { messageId }) => {
    const userId = await currentUserId(ctx);
    const message = await ctx.db.get(messageId);
    if (!message) throw new ConvexError("Message not found.");
    const member = await ctx.db
      .query("dmMembers")
      .withIndex("by_pair", (q) => q.eq("conversationId", message.conversationId).eq("userId", userId))
      .unique();
    if (!member) throw new ConvexError("You're not part of this conversation.");
    if (message.userId !== userId) {
      // DMs have no moderation roles — only the author can delete for everyone.
      throw new ConvexError("You can only delete your own messages in direct messages.");
    }
    const files = await ctx.db.query("attachments").withIndex("by_dm_message", (q) => q.eq("dmMessageId", messageId)).collect();
    for (const f of files) {
      await ctx.storage.delete(f.storageId);
      await ctx.db.delete(f._id);
    }
    const reactions = await ctx.db.query("dmReactions").withIndex("by_message", (q) => q.eq("messageId", messageId)).collect();
    for (const r of reactions) await ctx.db.delete(r._id);

    await ctx.db.patch(messageId, {
      body: "",
      deletedForEveryone: true,
      deletedAt: Date.now(),
      deletedBy: userId,
      pinned: false,
    });
    await audit(ctx, "dm.delete_own", userId, "Deleted own DM message", "dmMessage", messageId);
  },
});

export const deleteDmForMe = mutation({
  args: { messageId: v.id("dmMessages") },
  handler: async (ctx, { messageId }) => {
    const userId = await currentUserId(ctx);
    const msg = await ctx.db.get(messageId);
    if (!msg) throw new ConvexError("Message not found.");
    const member = await ctx.db
      .query("dmMembers")
      .withIndex("by_pair", (q) => q.eq("conversationId", msg.conversationId).eq("userId", userId))
      .unique();
    if (!member) throw new ConvexError("You're not part of this conversation.");
    await hideForMe(ctx, userId, messageId, { conversationId: msg.conversationId });
  },
});

/** Which messages the current user has hidden (for filtering). */
export const myHiddenIds = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db.query("messageVisibility").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    return rows.map((r) => r.messageId);
  },
});

/** Whether the current user may delete for everyone (used only to decide which menu items to show). */
export const canModerateHere = query({
  args: { channelId: v.id("channels") },
  handler: async (ctx, { channelId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return false;
    const channel = await ctx.db.get(channelId);
    if (!channel) return false;
    const manage = await hasPermission(ctx, channel.serverId, userId, "manageMessages");
    const del = await hasPermission(ctx, channel.serverId, userId, "deleteMessages");
    return manage || del;
  },
});