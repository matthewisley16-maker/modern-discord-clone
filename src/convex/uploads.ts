import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { enforceRateLimit } from "./authHelpers";
import { currentUserId, requireMember } from "./lib";

/** File size + type limits enforced server-side (client MIME is never trusted). */
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"];
const FILE_TYPES = [
  ...IMAGE_TYPES,
  "application/pdf", "text/plain", "text/csv", "application/json", "application/zip",
  "audio/mpeg", "audio/ogg", "audio/wav", "video/mp4", "video/webm",
];
/** Extensions we refuse regardless of the declared type. */
const BLOCKED_EXT = /\.(exe|dll|bat|cmd|sh|js|mjs|cjs|html|htm|svg|php|py|jar|msi|scr|vbs|ps1)$/i;

export function isAllowedType(contentType: string, name: string) {
  if (BLOCKED_EXT.test(name)) return false;
  return FILE_TYPES.includes(contentType);
}

/** A short-lived URL the client PUTs the file to. */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await currentUserId(ctx);
    await enforceRateLimit(ctx, `upload:${userId}`, 30, 60_000);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Record an uploaded file against a channel message or a DM message.
 * Validates size, type and (server-side) that the caller may post there.
 */
export const attach = mutation({
  args: {
    storageId: v.id("_storage"),
    name: v.string(),
    size: v.number(),
    contentType: v.string(),
    messageId: v.optional(v.id("messages")),
    dmMessageId: v.optional(v.id("dmMessages")),
  },
  handler: async (ctx, args) => {
    const userId = await currentUserId(ctx);
    if (!args.messageId && !args.dmMessageId) throw new Error("No message to attach to.");
    if (args.size > MAX_BYTES) throw new Error("Files must be 10 MB or smaller.");
    if (!isAllowedType(args.contentType, args.name)) throw new Error("That file type isn't supported.");

    if (args.messageId) {
      const message = await ctx.db.get(args.messageId);
      if (!message) throw new Error("Message not found.");
      const channel = await ctx.db.get(message.channelId);
      if (!channel) throw new Error("Channel not found.");
      await requireMember(ctx, channel.serverId, userId);
    } else if (args.dmMessageId) {
      const message = await ctx.db.get(args.dmMessageId);
      if (!message) throw new Error("Message not found.");
      const member = await ctx.db
        .query("dmMembers")
        .withIndex("by_pair", (q) => q.eq("conversationId", message.conversationId).eq("userId", userId))
        .unique();
      if (!member) throw new Error("You're not part of this conversation.");
    }

    return ctx.db.insert("attachments", {
      storageId: args.storageId,
      uploaderId: userId,
      name: args.name.slice(0, 120),
      size: args.size,
      contentType: args.contentType,
      messageId: args.messageId,
      dmMessageId: args.dmMessageId,
    });
  },
});

export const listForMessage = query({
  args: { messageId: v.id("messages") },
  handler: async (ctx, { messageId }) => {
    const files = await ctx.db.query("attachments").withIndex("by_message", (q) => q.eq("messageId", messageId)).collect();
    return Promise.all(
      files.map(async (f) => ({
        _id: f._id,
        name: f.name,
        size: f.size,
        contentType: f.contentType,
        isImage: IMAGE_TYPES.includes(f.contentType),
        url: await ctx.storage.getUrl(f.storageId),
      })),
    );
  },
});

export const storageUrl = query({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    return await ctx.storage.getUrl(storageId);
  },
});
