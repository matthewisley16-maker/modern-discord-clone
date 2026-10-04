import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";

import type { Id } from "./_generated/dataModel";
import { gifValidator, requireGif } from "./gif";
import { authorCardOf, notify } from "./lib";
import { resolveMentions } from "./mentions";

async function signedIn(ctx: QueryCtx) {
  const id = await getAuthUserId(ctx);
  if (!id) throw new ConvexError("Please sign in first.");
  return id;
}
async function member(ctx: QueryCtx, serverId: Id<"servers">) {
  const id = await signedIn(ctx);
  const membership = await ctx.db.query("memberships").withIndex("by_server_user", q => q.eq("serverId", serverId).eq("userId", id)).unique();
  if (!membership) throw new ConvexError("You are not a member of this server.");
  return id;
}
async function nameOf(ctx: QueryCtx, id: Id<"users">) {
  const profile = await ctx.db.query("profiles").withIndex("by_user", q => q.eq("userId", id)).unique();
  const user = await ctx.db.get(id);
  return profile?.displayName || user?.name || "Freecord member";
}
function clean(value: string, max: number) {
  const text = value.trim();
  if (!text || text.length > max) throw new ConvexError(`Please enter between 1 and ${max} characters.`);
  return text;
}
export const workspace = query({ args: {}, handler: async ctx => {
  const userId = await signedIn(ctx);
  const memberships = await ctx.db.query("memberships").withIndex("by_user", q => q.eq("userId", userId)).collect();
  const servers = (await Promise.all(memberships.map(m => ctx.db.get(m.serverId)))).filter(s => s !== null);
  return { servers, displayName: await nameOf(ctx, userId), userId };
}});
export const serverDetails = query({ args: { serverId: v.id("servers") }, handler: async (ctx, { serverId }) => {
  await member(ctx, serverId);
  const server = await ctx.db.get(serverId);
  const channels = await ctx.db.query("channels").withIndex("by_server", q => q.eq("serverId", serverId)).collect();
  const memberships = await ctx.db.query("memberships").withIndex("by_server", q => q.eq("serverId", serverId)).collect();
  const members = await Promise.all(memberships.map(async m => ({ userId: m.userId, name: await nameOf(ctx, m.userId) })));
  return { server, channels, members };
}});
export const messages = query({ args: { channelId: v.id("channels") }, handler: async (ctx, { channelId }) => {
  const channel = await ctx.db.get(channelId);
  if (!channel) return [];
  await member(ctx, channel.serverId);
  // Per-user "delete for me": hidden ids are filtered out for this viewer only.
  const viewerId = await getAuthUserId(ctx);
  const hidden = new Set(
    viewerId
      ? (await ctx.db.query("messageVisibility").withIndex("by_user", q => q.eq("userId", viewerId)).collect()).map(h => h.messageId)
      : [],
  );
  const messages = await ctx.db.query("messages").withIndex("by_channel", q => q.eq("channelId", channelId)).order("desc").take(150);
  return Promise.all(messages
    // Messages deleted for everyone are removed from the conversation entirely,
    // and per-user hides are filtered for this viewer only.
    .filter(m => !m.deletedForEveryone && !hidden.has(m._id as string))
    .reverse().map(async message => {
    const files = await ctx.db.query("attachments").withIndex("by_message", q => q.eq("messageId", message._id)).collect();
    const attachments = await Promise.all(files.map(async f => ({
      _id: f._id, name: f.name, size: f.size, contentType: f.contentType,
      isImage: f.contentType.startsWith("image/"), url: await ctx.storage.getUrl(f.storageId),
    })));
    let reply = null;
    if (message.replyToId) {
      const parent = await ctx.db.get(message.replyToId);
      if (parent) {
        // Never expose the contents of a message deleted for everyone.
        reply = parent.deletedForEveryone
          ? { _id: parent._id, author: "", body: "Original message deleted", deleted: true }
          : { _id: parent._id, author: await nameOf(ctx, parent.userId), body: parent.body.slice(0, 140), deleted: false };
      }
    }
    return { ...message, ...(await authorCardOf(ctx, message.userId)), reactions: await ctx.db.query("reactions").withIndex("by_message", q => q.eq("messageId", message._id)).collect(), attachments, reply, mentionUsers: await resolveMentions(ctx, message.body, { serverId: channel.serverId }) };
  }));
}});
export const createServer = mutation({ args: { name: v.string(), description: v.string() }, handler: async (ctx, args) => {
  const userId = await signedIn(ctx);
  const name = clean(args.name, 50);
  if (args.description.length > 200) throw new ConvexError("Description is too long.");
  const serverId = await ctx.db.insert("servers", { name, description: args.description.trim(), ownerId: userId, inviteCode: crypto.randomUUID() });
  await ctx.db.insert("memberships", { serverId, userId });
  for (const channelName of ["general", "introductions", "off-topic"]) await ctx.db.insert("channels", { serverId, name: channelName, description: channelName === "general" ? "A little space for big conversations." : "Make yourself at home." });
  return serverId;
}});
export const joinServer = mutation({ args: { code: v.string() }, handler: async (ctx, { code }) => {
  const userId = await signedIn(ctx);
  const server = await ctx.db.query("servers").withIndex("by_invite", q => q.eq("inviteCode", code.trim())).unique();
  if (!server) throw new ConvexError("That invite code isn't valid.");
  const exists = await ctx.db.query("memberships").withIndex("by_server_user", q => q.eq("serverId", server._id).eq("userId", userId)).unique();
  if (!exists) await ctx.db.insert("memberships", { serverId: server._id, userId });
  return server._id;
}});
export const createChannel = mutation({ args: { serverId: v.id("servers"), name: v.string() }, handler: async (ctx, { serverId, name }) => {
  const userId = await member(ctx, serverId);
  const server = await ctx.db.get(serverId);
  if (server?.ownerId !== userId) throw new ConvexError("Only the server owner can create channels.");
  const normalized = clean(name, 40).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const channels = await ctx.db.query("channels").withIndex("by_server", q => q.eq("serverId", serverId)).collect();
  if (channels.some(c => c.name === normalized)) throw new ConvexError("A channel with that name already exists.");
  return ctx.db.insert("channels", { serverId, name: normalized, description: "A new conversation starts here." });
}});
export const sendMessage = mutation({ args: { channelId: v.id("channels"), body: v.string(), replyToId: v.optional(v.id("messages")), gif: v.optional(gifValidator) }, handler: async (ctx, { channelId, body, replyToId, gif }) => {
  const channel = await ctx.db.get(channelId);
  if (!channel) throw new ConvexError("Channel not found.");
  const userId = await member(ctx, channel.serverId);
  if (channel.locked) throw new ConvexError("This channel is locked.");
  // Validate the GIF server-side; never trust a client-provided media URL.
  const safeGif = gif ? requireGif(gif) : undefined;
  const raw = body.trim();
  if (raw.length > 4000) throw new ConvexError("Please enter between 1 and 4000 characters.");
  // A GIF can be sent on its own; a plain-text fallback keeps search/replies working.
  const text = safeGif ? raw || "Sent a GIF" : clean(body, 4000);
  const messageId = await ctx.db.insert("messages", { channelId, userId, body: text, replyToId, gif: safeGif });
  // Deep link so the recipient lands on this exact message.
  const link = `?server=${channel.serverId}&channel=${channelId}&message=${messageId}`;
  const already = new Set<string>([userId as string]);

  if (replyToId) {
    const parent = await ctx.db.get(replyToId);
    if (parent && parent.userId !== userId) {
      already.add(parent.userId as string);
      await notify(ctx, parent.userId, "reply", "New reply", `${await nameOf(ctx, userId)} replied to you in #${channel.name}`, link, userId);
    }
  }

  // @username mentions notify the mentioned member (never the author).
  const mentions = [...new Set((text.match(/@[a-z0-9._-]{2,24}/gi) ?? []).map((m) => m.slice(1).toLowerCase()))];
  if (mentions.length > 0) {
    const memberships = await ctx.db.query("memberships").withIndex("by_server", (q) => q.eq("serverId", channel.serverId)).collect();
    for (const memberRow of memberships) {
      if (already.has(memberRow.userId as string)) continue;
      const u = await ctx.db.get(memberRow.userId);
      if (!u?.username || !mentions.includes(u.username.toLowerCase())) continue;
      already.add(memberRow.userId as string);
      await notify(ctx, memberRow.userId, "mention", "You were mentioned", `${await nameOf(ctx, userId)} mentioned you in #${channel.name}`, link, userId);
    }
  }
  return messageId;
}});
export const deleteMessage = mutation({ args: { messageId: v.id("messages") }, handler: async (ctx, { messageId }) => {
  const message = await ctx.db.get(messageId);
  if (!message) return;
  const channel = await ctx.db.get(message.channelId);
  if (!channel) throw new ConvexError("Channel not found.");
  const userId = await member(ctx, channel.serverId);
  if (message.userId !== userId) throw new ConvexError("You can only delete your own messages.");
  for (const reaction of await ctx.db.query("reactions").withIndex("by_message", q => q.eq("messageId", messageId)).collect()) await ctx.db.delete(reaction._id);
  await ctx.db.delete(messageId);
}});
export const toggleReaction = mutation({ args: { messageId: v.id("messages"), emoji: v.string() }, handler: async (ctx, { messageId, emoji }) => {
  if (!["❤️", "🙌", "🔥", "👍"].includes(emoji)) throw new ConvexError("Unsupported reaction.");
  const message = await ctx.db.get(messageId);
  if (!message) throw new ConvexError("Message not found.");
  const channel = await ctx.db.get(message.channelId);
  if (!channel) throw new ConvexError("Channel not found.");
  const userId = await member(ctx, channel.serverId);
  const reactions = await ctx.db.query("reactions").withIndex("by_message", q => q.eq("messageId", messageId)).collect();
  const existing = reactions.find(r => r.userId === userId && r.emoji === emoji);
  if (existing) await ctx.db.delete(existing._id);
  else await ctx.db.insert("reactions", { messageId, userId, emoji });
}});
export const editMessage = mutation({ args: { messageId: v.id("messages"), body: v.string() }, handler: async (ctx, { messageId, body }) => {
  const message = await ctx.db.get(messageId);
  if (!message) throw new ConvexError("Message not found.");
  const channel = await ctx.db.get(message.channelId);
  if (!channel) throw new ConvexError("Channel not found.");
  const userId = await member(ctx, channel.serverId);
  if (message.userId !== userId) throw new ConvexError("You can only edit your own messages.");
  const text = body.trim();
  if (!text) throw new ConvexError("Message can't be empty.");
  await ctx.db.patch(messageId, { body: text.slice(0, 4000), editedAt: Date.now() });
}});
export const pinMessage = mutation({ args: { messageId: v.id("messages"), pinned: v.boolean() }, handler: async (ctx, { messageId, pinned }) => {
  const message = await ctx.db.get(messageId);
  if (!message) throw new ConvexError("Message not found.");
  const channel = await ctx.db.get(message.channelId);
  if (!channel) throw new ConvexError("Channel not found.");
  await member(ctx, channel.serverId);
  await ctx.db.patch(messageId, { pinned });
}});
export const updateProfile = mutation({ args: { name: v.string() }, handler: async (ctx, { name }) => {
  const userId = await signedIn(ctx);
  const displayName = clean(name, 40);
  const profile = await ctx.db.query("profiles").withIndex("by_user", q => q.eq("userId", userId)).unique();
  if (profile) await ctx.db.patch(profile._id, { displayName });
  else await ctx.db.insert("profiles", { userId, displayName });
}});
