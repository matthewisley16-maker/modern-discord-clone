import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { avatarUrlOf, currentUserId, displayNameOf, isBlockedEitherWay, notify } from "./lib";
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
    // Respect existing block rules — blocked users cannot call each other.
    if (await isBlockedEitherWay(ctx, me, toId)) throw new Error("You can't call this user.");
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
      startedAt: Date.now(),
    });
    await notify(
      ctx,
      toId,
      "call",
      media === "video" ? "Incoming video call" : "Incoming voice call",
      `${await displayNameOf(ctx, me)} is calling you.`,
      conversationId ? `?dm=${conversationId}&call=${id}` : `?call=${id}`,
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
    if (invite.status !== "ringing") return;
    await ctx.db.patch(inviteId, { status: accept ? "accepted" : "declined", ...(accept ? { startedAt: Date.now() } : { endedAt: Date.now() }) });
    await notify(
      ctx,
      invite.fromId,
      "call",
      accept ? "Call accepted" : "Call declined",
      `${await displayNameOf(ctx, me)} ${accept ? "accepted" : "declined"} your call.`,
      invite.conversationId ? `?dm=${invite.conversationId}` : "/dashboard",
      me,
    );
  },
});

/** The caller gives up before the recipient answers. */
export const timeoutCall = mutation({
  args: { inviteId: v.id("callInvites") },
  handler: async (ctx, { inviteId }) => {
    const me = await currentUserId(ctx);
    const invite = await ctx.db.get(inviteId);
    if (!invite || invite.fromId !== me || invite.status !== "ringing") return;
    await ctx.db.patch(inviteId, { status: "missed", endedAt: Date.now() });
    const theirs = await ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", invite.toId)).collect();
    const pending = theirs
      .filter((n) => n.type === "call" && n.title.startsWith("Incoming"))
      .sort((a, b) => b._creationTime - a._creationTime)[0];
    if (pending) await ctx.db.patch(pending._id, { title: "Missed call", read: false });
  },
});

/** Either participant ends an accepted (or still ringing) call for good. */
export const endCall = mutation({
  args: { inviteId: v.id("callInvites"), reason: v.optional(v.string()) },
  handler: async (ctx, { inviteId }) => {
    const me = await currentUserId(ctx);
    const invite = await ctx.db.get(inviteId);
    if (!invite) return;
    if (invite.fromId !== me && invite.toId !== me) throw new Error("Call not found.");
    if (invite.status === "ended" || invite.status === "declined" || invite.status === "missed") return;
    // A call that is accepted and then ended is "ended"; one ended while still
    // ringing is treated as "missed" for the recipient.
    const finalStatus = invite.status === "accepted" ? "ended" : "missed";
    await ctx.db.patch(inviteId, { status: finalStatus, endedAt: Date.now() });
    const other = invite.fromId === me ? invite.toId : invite.fromId;
    await notify(ctx, other, "call", finalStatus === "ended" ? "Call ended" : "Missed call", `${await displayNameOf(ctx, me)} ${finalStatus === "ended" ? "ended the call" : "cancelled the call"}.`, invite.conversationId ? `?dm=${invite.conversationId}` : "/dashboard", me);
  },
});

export const cancelCall = mutation({
  args: { inviteId: v.id("callInvites") },
  handler: async (ctx, { inviteId }) => {
    const me = await currentUserId(ctx);
    const invite = await ctx.db.get(inviteId);
    if (!invite || invite.fromId !== me) return;
    await ctx.db.patch(inviteId, { status: "cancelled", endedAt: Date.now() });
    // Rewrite the recipient's "Incoming call" notification to a missed call so
    // they are never left with a stale, ringing notification.
    const theirs = await ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", invite.toId)).collect();
    const pending = theirs
      .filter((n) => n.type === "call" && n.title.startsWith("Incoming"))
      .sort((a, b) => b._creationTime - a._creationTime)[0];
    if (pending) await ctx.db.patch(pending._id, { title: "Missed call", read: false });
  },
});

// ---------------- DM call signaling (WebRTC for calls) ----------------

const signalKind = v.union(v.literal("offer"), v.literal("answer"), v.literal("candidate"));

/** Relay a WebRTC signal to the other member of a DM call. */
export const sendDmSignal = mutation({
  args: { conversationId: v.id("dmConversations"), toUserId: v.id("users"), kind: signalKind, payload: v.string() },
  handler: async (ctx, { conversationId, toUserId, kind, payload }) => {
    const me = await currentUserId(ctx);
    const member = await ctx.db
      .query("dmMembers")
      .withIndex("by_pair", (q) => q.eq("conversationId", conversationId).eq("userId", me))
      .unique();
    if (!member) throw new Error("You're not part of this conversation.");
    await ctx.db.insert("dmCallSignals", { conversationId, fromUserId: me, toUserId, kind, payload });
  },
});

/** Signals addressed to me for a given call. */
export const pollDmSignals = query({
  args: { conversationId: v.id("dmConversations") },
  handler: async (ctx, { conversationId }) => {
    const me = await getAuthUserId(ctx);
    if (!me) return [];
    const rows = await ctx.db.query("dmCallSignals").withIndex("by_to", (q) => q.eq("toUserId", me)).collect();
    return rows.filter((r) => r.conversationId === conversationId);
  },
});

export const clearDmSignal = mutation({
  args: { signalId: v.id("dmCallSignals") },
  handler: async (ctx, { signalId }) => {
    const me = await currentUserId(ctx);
    const signal = await ctx.db.get(signalId);
    if (!signal || signal.toUserId !== me) return;
    await ctx.db.delete(signalId);
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
    const fromUser = await ctx.db.get(invite.fromId);
    return {
      inviteId: invite._id,
      fromId: invite.fromId,
      fromName: await displayNameOf(ctx, invite.fromId),
      fromUsername: fromUser?.username ?? null,
      fromAvatarUrl: await avatarUrlOf(ctx, invite.fromId),
      media: invite.media,
      conversationId: invite.conversationId ?? null,
      createdAt: invite._creationTime,
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
    if (!recent) return null;
    // A ringing call expires 60s after it was placed; an accepted call stays
    // valid for the whole call; a finished call lingers briefly so the caller
    // can see "declined/ended" before it clears.
    const since = recent.endedAt ?? recent._creationTime;
    const ttl = recent.status === "ringing" ? 60_000 : recent.status === "accepted" ? 3_600_000 : 20_000;
    if (Date.now() - since > ttl) return null;
    const toUser = await ctx.db.get(recent.toId);
    return {
      inviteId: recent._id,
      toId: recent.toId,
      toName: await displayNameOf(ctx, recent.toId as Id<"users">),
      toUsername: toUser?.username ?? null,
      toAvatarUrl: await avatarUrlOf(ctx, recent.toId),
      media: recent.media,
      status: recent.status,
      conversationId: recent.conversationId ?? null,
      createdAt: recent._creationTime,
    };
  },
});
