import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  audit,
  currentUserId,
  displayNameOf,
  hasPermission,
  rankOf,
  requireMember,
  roleOfUser,
  ROLE_RANK,
  type Ctx,
} from "./lib";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { isDeletedForMeExpired } from "../lib/deleted-messages";
import { deleteChannelMessage, deleteDmMessage } from "./storage";

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

/**
 * Global (platform) administrator check — the same authoritative role the Admin
 * Panel uses (`requirePanelAccess`). It is read from the users table on the
 * server, so no client-supplied flag, id or role can grant it.
 */
async function isPlatformAdmin(ctx: Ctx, userId: Id<"users">): Promise<boolean> {
  return rankOf(await roleOfUser(ctx, userId)) >= ROLE_RANK.admin;
}

/**
 * Remove a message's attachment rows, deleting a stored file only when no other
 * attachment row still references it (an object shared with another message is
 * kept, and re-deleting an already-removed file is not fatal).
 */
async function removeAttachmentsFor(
  ctx: MutationCtx,
  target: { messageId?: Id<"messages">; dmMessageId?: Id<"dmMessages"> },
) {
  const files = target.messageId
    ? await ctx.db.query("attachments").withIndex("by_message", (q) => q.eq("messageId", target.messageId)).collect()
    : await ctx.db.query("attachments").withIndex("by_dm_message", (q) => q.eq("dmMessageId", target.dmMessageId!)).collect();
  for (const file of files) {
    await ctx.db.delete(file._id);
    const stillReferenced = await ctx.db
      .query("attachments")
      .withIndex("by_storage", (q) => q.eq("storageId", file.storageId))
      .first();
    if (!stillReferenced) await ctx.storage.delete(file.storageId);
  }
}

/**
 * The ONE global-deletion mechanism: redact the message for everyone.
 * The body is emptied and `deletedForEveryone` is set, so every view, search,
 * preview and reply quote already treats it as gone; reactions and attachments
 * are cleaned up, and the tombstone row itself is kept so message relationships
 * (replies, counts) stay consistent.
 */
async function redactChannelMessage(
  ctx: MutationCtx,
  message: Doc<"messages">,
  actorId: Id<"users">,
  byModerator: boolean,
) {
  await removeAttachmentsFor(ctx, { messageId: message._id });
  for (const r of await ctx.db.query("reactions").withIndex("by_message", (q) => q.eq("messageId", message._id)).collect()) {
    await ctx.db.delete(r._id);
  }
  // A server invitation posted in this message is part of it: deleting the
  // message for everyone removes the invitation with it (nobody can accept a
  // card that no longer exists).
  for (const invite of await ctx.db.query("serverInviteCards").withIndex("by_channel_message", (q) => q.eq("channelMessageId", message._id)).collect()) {
    await ctx.db.delete(invite._id);
  }
  await ctx.db.patch(message._id, {
    body: "",
    deletedForEveryone: true,
    deletedAt: Date.now(),
    deletedBy: actorId,
    deletedByModerator: byModerator,
    pinned: false,
    serverInviteIds: undefined,
  });
}

async function redactDmMessage(ctx: MutationCtx, message: Doc<"dmMessages">, actorId: Id<"users">) {
  await removeAttachmentsFor(ctx, { dmMessageId: message._id });
  for (const r of await ctx.db.query("dmReactions").withIndex("by_message", (q) => q.eq("messageId", message._id)).collect()) {
    await ctx.db.delete(r._id);
  }
  await ctx.db.patch(message._id, {
    body: "",
    deletedForEveryone: true,
    deletedAt: Date.now(),
    deletedBy: actorId,
    pinned: false,
  });
}

// ---------------- Channel messages ----------------

/**
 * Delete a channel message for everyone.
 * The backend verifies: membership, channel access, ownership, and — for other
 * people's messages — either the manageMessages/deleteMessages permission or the
 * global platform-administrator role. A client cannot bypass this by editing
 * frontend code.
 *
 * Idempotent: deleting an already deleted message changes nothing and reports
 * `alreadyDeleted`, so a double click or a retry cannot corrupt the record.
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
    // Owner of the message, a community moderator, or a global administrator.
    const isAuthor = message.userId === userId;
    const isAdmin = isAuthor ? false : await isPlatformAdmin(ctx, userId);
    if (!isAuthor && !isAdmin) {
      const manage = await hasPermission(ctx, channel.serverId, userId, "manageMessages");
      const del = await hasPermission(ctx, channel.serverId, userId, "deleteMessages");
      if (!manage && !del) {
        throw new ConvexError("You don't have permission to delete this message.");
      }
    }

    if (message.deletedForEveryone) return { alreadyDeleted: true };

    await redactChannelMessage(ctx, message, userId, !isAuthor);

    // Audit entry: actor, action, message id, conversation reference, timestamp.
    // The message CONTENT is deliberately never copied into the log.
    await audit(
      ctx,
      isAuthor ? "message.delete_own" : isAdmin ? "message.delete_admin" : "message.delete_moderator",
      userId,
      `${isAuthor ? "Deleted own" : `Deleted ${await displayNameOf(ctx, message.userId)}'s`} message in #${channel.name}`,
      "message",
      messageId,
    );
    return { alreadyDeleted: false };
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

/**
 * Delete a DM (or group-DM) message for everyone.
 *
 * DMs have no community moderation roles, so this is the author OR a global
 * platform administrator. The caller must still be a participant: an
 * administrator cannot reach into a conversation they are not part of.
 */
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
    const isAuthor = message.userId === userId;
    if (!isAuthor && !(await isPlatformAdmin(ctx, userId))) {
      throw new ConvexError("You can only delete your own messages in direct messages.");
    }

    if (message.deletedForEveryone) return { alreadyDeleted: true };

    await redactDmMessage(ctx, message, userId);

    const conversation = await ctx.db.get(message.conversationId);
    const label = conversation?.name?.trim() || (conversation?.type === "group" ? "a group chat" : "a direct message");
    await audit(
      ctx,
      isAuthor ? "dm.delete_own" : "dm.delete_admin",
      userId,
      `${isAuthor ? "Deleted own" : `Deleted ${await displayNameOf(ctx, message.userId)}'s`} message in ${label}`,
      "dmMessage",
      messageId,
    );
    return { alreadyDeleted: false };
  },
});

/**
 * COMPLETELY delete a message the caller had ALREADY hidden with "Delete for
 * me" — the Admin Panel route for retained messages.
 *
 * "Delete from the Admin Panel" means the message is REMOVED, for everyone: the
 * row itself, its GIF, its attachment records (and any stored file no other
 * message still references), its reactions and every visibility marker pointing
 * at it. Nothing is left behind for other participants to see — no "this message
 * was deleted" placeholder — which is exactly what distinguishes deleting here
 * from hiding a message for yourself. (The in-conversation "Delete for everyone"
 * is unchanged: it redacts the row and keeps the placeholder, so a conversation's
 * history still reads coherently. Only this admin route removes it outright.)
 *
 * An administrator does not have to restore a hidden message to their normal
 * history first (the hide is left in place — the message stays out of their view)
 * and does not have to find it in the conversation again: their own
 * `messageVisibility` row is the proof they could see it, and platform-
 * administrator access is re-verified here on the server.
 *
 * If the content is already gone (deleted for everyone earlier, or swept by
 * retention) nothing is invented: the caller is told it is already deleted.
 */
export const deleteHiddenForEveryone = mutation({
  args: { visibilityId: v.id("messageVisibility") },
  handler: async (ctx, { visibilityId }) => {
    const userId = await currentUserId(ctx);
    if (!(await isPlatformAdmin(ctx, userId))) {
      throw new ConvexError("Administrator access required.");
    }
    const vis = await ctx.db.get(visibilityId);
    if (!vis) throw new ConvexError("That hidden message is no longer listed.");
    if (vis.userId !== userId) {
      throw new ConvexError("You can only moderate messages you hid yourself.");
    }
    // The seven-day window is enforced here too, not just in the list: a stale
    // page (or a hand-made request) must not be able to delete-for-everyone a
    // message whose retention entry has already expired. The message itself is
    // untouched by the expiry, so this only closes the panel's route, never
    // anyone's content.
    if (vis.entryExpiredAt != null || isDeletedForMeExpired(vis.hiddenAt, Date.now())) {
      throw new ConvexError(
        "The seven-day retention window for this entry has ended, so it can no longer be deleted for everyone from here.",
      );
    }

    const channelMessageId = ctx.db.normalizeId("messages", vis.messageId);
    const dmMessageId = channelMessageId ? null : ctx.db.normalizeId("dmMessages", vis.messageId);
    if (!channelMessageId && !dmMessageId) {
      throw new ConvexError("That message no longer exists — its content is already gone.");
    }

    if (channelMessageId) {
      const message = await ctx.db.get(channelMessageId);
      if (!message) throw new ConvexError("That message no longer exists — its content is already gone.");
      if (message.deletedForEveryone) return { alreadyDeleted: true };
      const isAuthor = message.userId === userId;
      const channel = await ctx.db.get(message.channelId);
      const label = channel ? `#${channel.name}` : "a removed channel";
      // Complete removal: the message, its attachments (and orphaned files),
      // reactions and every visibility marker go with it — for everyone, with no
      // placeholder left in anyone's history.
      await deleteChannelMessage(ctx, message);
      await audit(
        ctx,
        "message.delete_admin",
        userId,
        `Completely deleted ${isAuthor ? "own" : `${await displayNameOf(ctx, message.userId)}'s`} hidden message in ${label}`,  
        "message",
        message._id,
      );
      return { alreadyDeleted: false };
    }

    const message = await ctx.db.get(dmMessageId!);
    if (!message) throw new ConvexError("That message no longer exists — its content is already gone.");
    if (message.deletedForEveryone) return { alreadyDeleted: true };
    const isAuthor = message.userId === userId;
    const conversation = await ctx.db.get(message.conversationId);
    const label = conversation?.name?.trim() || (conversation?.type === "group" ? "a group chat" : "a direct message");
    await deleteDmMessage(ctx, message);
    await audit(
      ctx,
      "dm.delete_admin",
      userId,
      `Completely deleted ${isAuthor ? "own" : `${await displayNameOf(ctx, message.userId)}'s`} hidden message in ${label}`,
      "dmMessage",
      message._id,
    );
    return { alreadyDeleted: false };
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
    if (manage || del) return true;
    // Global administrators may moderate any message, anywhere. This only decides
    // whether the menu item is offered — `deleteForEveryone` re-checks the same
    // role server-side.
    return isPlatformAdmin(ctx, userId);
  },
});