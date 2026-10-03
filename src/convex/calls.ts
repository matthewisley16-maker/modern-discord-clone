import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { currentUserId, displayNameOf, notify } from "./lib";
import type { Id } from "./_generated/dataModel";

/** Invite someone to a DM voice/video call. */
export const inviteCall = mutation({
  args: {
    toId: v.id("users"),
    conversationId: v.optional(v.id("dmConversations")),
    media: v.union(v.literal("voice"), v.literal("video")),
  },
  handler: async (ctx, { toId, conversationId, media }) => {
    const me = await currentUserId(ctx);
    if (me === toId) throw new Error("You can't call yourself.");
    // Only one ringing invite per caller/recipient pair.
    const existing = await ctx.db
      .query("callInvites")
      .withIndex("by_to", (q) => q.eq("toId", toId).eq("status", "ringing"))
      .collect();
    for (const invite of existing) {
      if (invite.fromId === me) await ctx.db.patch(invite._id, { status: "missed" });
    }
    const id = await ctx.db.insert("callInvites", {
      fromId: me,
      toId,
      conversationId,
      media,
      status: "ringing",
    });
    await notify(
      ctx,
      toId,
      "call",
      media === "video" ? "Incoming video call" : "Incoming voice call",
      `${await displayNameOf(ctx, me)} is calling you.`,
      "/dashboard",
      me,
    );
    return id;
  },
});

export const respondCall = mutation({
  args: { inviteId: v.id("callInvites"), accept: v.boolean() },
  handler: async (ctx, { inviteId, accept }) => {
    const me = await currentUserId(ctx);
    const invite = await ctx.db.get(inviteId);
    if (!invite || invite.toId !== me) throw new Error("Call not found.");
    await ctx.db.patch(inviteId, { status: accept ? "accepted" : "declined" });
    await notify(
      ctx,
      invite.fromId,
      "call",
      accept ? "Call accepted" : "Call declined",
      `${await displayNameOf(ctx, me)} ${accept ? "accepted" : "declined"} your call.`,
      "/dashboard",
      me,
    );
  },
});

export const cancelCall = mutation({
  args: { inviteId: v.id("callInvites") },
  handler: async (ctx, { inviteId }) => {
    const me = await currentUserId(ctx);
    const invite = await ctx.db.get(inviteId);
    if (!invite || invite.fromId !== me) return;
    await ctx.db.patch(inviteId, { status: "missed" });
  },
});

/** The ringing call currently addressed to me, if any. */
export const incomingCall = query({
  args: {},
  handler: async (ctx) => {
    const me = await getAuthUserId(ctx);
    if (!me) return null;
    const ringing = await ctx.db
      .query("callInvites")
      .withIndex("by_to", (q) => q.eq("toId", me).eq("status", "ringing"))
      .collect();
    const invite = ringing.sort((a, b) => b._creationTime - a._creationTime)[0];
    if (!invite) return null;
    return {
      inviteId: invite._id,
      fromId: invite.fromId,
      fromName: await displayNameOf(ctx, invite.fromId),
      media: invite.media,
      conversationId: invite.conversationId ?? null,
    };
  },
});

/** Status of calls I started, so the caller can show "ringing/accepted/declined". */
export const outgoingCall = query({
  args: {},
  handler: async (ctx) => {
    const me = await getAuthUserId(ctx);
    if (!me) return null;
    const mine = await ctx.db.query("callInvites").collect();
    const recent = mine
      .filter((c) => c.fromId === me)
      .sort((a, b) => b._creationTime - a._creationTime)[0];
    if (!recent || Date.now() - recent._creationTime > 120_000) return null;
    return {
      inviteId: recent._id,
      toId: recent.toId,
      toName: await displayNameOf(ctx, recent.toId as Id<"users">),
      media: recent.media,
      status: recent.status,
    };
  },
});
