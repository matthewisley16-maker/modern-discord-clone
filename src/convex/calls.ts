import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { areFriends, avatarUrlOf, currentUserId, displayNameOf, hasChannelPermission, isBlockedEitherWay, isTimedOut, membershipOf, notify, presenceInfoOf } from "./lib";
import type { Ctx } from "./lib";
import type { Id } from "./_generated/dataModel";

/**
 * Community call invitations.
 *
 * A "community call" is simply the set of `voiceSessions` rows for one voice/
 * video channel — there is no second, parallel call object. So an invitation
 * never creates a call: it is a validated pointer at a channel the inviter is
 * ALREADY inside, and accepting it joins that same channel via
 * `voice.joinVoiceChecked`. Everyone therefore shares one session, exactly like
 * joining the channel by hand.
 *
 * Everything is validated server-side; the client never supplies membership,
 * permissions, channel access or the participant list.
 */

/**
 * The single authority on "may this user be in this community call right now?".
 * Used when an invite is created (for the invitee) AND again when it is
 * accepted, so a permission/lock/ban change between the two is always honoured.
 */
async function assertCanJoinCommunityCall(ctx: Ctx, channelId: Id<"channels">, userId: Id<"users">) {
  const channel = await ctx.db.get(channelId);
  if (!channel) throw new ConvexError("That call is no longer available.");
  if (channel.type === "text") throw new ConvexError("That's a text channel.");
  const membership = await membershipOf(ctx, channel.serverId, userId);
  if (!membership) throw new ConvexError("You're not a member of this community.");
  if (isTimedOut(membership)) throw new ConvexError("You're currently timed out.");
  if (!(await hasChannelPermission(ctx, channelId, userId, "viewChannels"))) {
    throw new ConvexError("You don't have access to this channel.");
  }
  if (!(await hasChannelPermission(ctx, channelId, userId, "useVoice"))) {
    throw new ConvexError("You don't have permission to use voice in this channel.");
  }
  return channel;
}

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
    // A community invitation is re-validated at ACCEPT time: the community may
    // have changed the channel, revoked the role, locked it or banned the user
    // since the invite was sent (and an invitation must never outlive access).
    if (accept && invite.channelId) await assertCanJoinCommunityCall(ctx, invite.channelId, me);
    await ctx.db.patch(inviteId, { status: accept ? "accepted" : "declined", ...(accept ? { startedAt: Date.now() } : { endedAt: Date.now() }) });
    let link = invite.conversationId ? `?dm=${invite.conversationId}` : "/dashboard";
    if (invite.channelId) {
      const channel = await ctx.db.get(invite.channelId);
      link = channel ? `?server=${channel.serverId}&channel=${channel._id}&voice=1` : "/dashboard";
    }
    await notify(
      ctx,
      invite.fromId,
      "call",
      accept ? "Call accepted" : "Call declined",
      `${await displayNameOf(ctx, me)} ${accept ? "accepted" : "declined"} your ${invite.channelId ? "invitation" : "call"}.`,
      link,
      me,
    );
  },
});

/**
 * Invite someone into the community voice/video call I am currently in.
 * Server-validated: I must really be in the call, hold the channel-scoped
 * invite permission, and the invitee must be a community member who can
 * actually access and use that channel (locks, limits, timeouts and blocks all
 * apply). No new call is created — this points at the existing channel session.
 */
export const inviteToCommunityCall = mutation({
  args: {
    channelId: v.id("channels"),
    toUserId: v.id("users"),
    media: v.optional(v.union(v.literal("voice"), v.literal("video"))),
  },
  handler: async (ctx, { channelId, toUserId, media }) => {
    const me = await currentUserId(ctx);
    if (me === toUserId) throw new ConvexError("You can't invite yourself.");

    // I must actually be connected to this exact call right now.
    const mine = await ctx.db.query("voiceSessions").withIndex("by_user", (q) => q.eq("userId", me)).unique();
    if (!mine || mine.channelId !== channelId) {
      throw new ConvexError("Join the call before inviting people to it.");
    }
    const channel = await ctx.db.get(channelId);
    if (!channel) throw new ConvexError("Channel not found.");
    if (channel.type === "text") throw new ConvexError("That's a text channel.");
    // Inviting is a community permission — owner/admin/moderator by default,
    // and any role (or channel override) the community grants it to.
    if (!(await hasChannelPermission(ctx, channelId, me, "createInvites"))) {
      throw new ConvexError("You don't have permission to invite people here.");
    }
    if (await isBlockedEitherWay(ctx, me, toUserId)) throw new ConvexError("You can't invite this user.");
    // The invitee must be able to join — otherwise the invitation is refused
    // rather than silently granting access to a locked/private channel.
    await assertCanJoinCommunityCall(ctx, channelId, toUserId);

    // Already in this call? Never send a duplicate invitation.
    const target = await ctx.db.query("voiceSessions").withIndex("by_user", (q) => q.eq("userId", toUserId)).unique();
    if (target?.channelId === channelId) throw new ConvexError("They're already in this call.");

    // Re-sending to the same person for the same call reuses the live invite.
    const theirInvites = await ctx.db
      .query("callInvites")
      .withIndex("by_to", (q) => q.eq("toId", toUserId).eq("status", "ringing"))
      .collect();
    const duplicate = theirInvites.find((inv) => inv.fromId === me && inv.channelId === channelId);
    if (duplicate) return duplicate._id;
    // A previous still-ringing invite for a different call is superseded.
    for (const inv of theirInvites) {
      if (inv.fromId === me) await ctx.db.patch(inv._id, { status: "missed", endedAt: Date.now() });
    }

    // Channel capacity is enforced here so an invite can never overfill a room.
    const limit = channel.userLimit ?? 0;
    if (limit > 0) {
      const sessions = await ctx.db.query("voiceSessions").withIndex("by_channel", (q) => q.eq("channelId", channelId)).collect();
      if (sessions.length >= limit) throw new ConvexError("This voice channel is full.");
    }

    const kind = media ?? (mine.video ? "video" : "voice");
    const id = await ctx.db.insert("callInvites", {
      fromId: me,
      toId: toUserId,
      channelId,
      media: kind,
      status: "ringing",
      startedAt: Date.now(),
    });
    const server = await ctx.db.get(channel.serverId);
    await notify(
      ctx,
      toUserId,
      "call",
      kind === "video" ? "Invited to a video call" : "Invited to a voice call",
      `${await displayNameOf(ctx, me)} invited you to join #${channel.name} in ${server?.name ?? "a community"}.`,
      `?server=${channel.serverId}&channel=${channelId}&voice=1`,
      me,
    );
    return id;
  },
});

/**
 * Who can I invite to this community call? Members of this community who are
 * not already in the call and who could actually join it. Presence is the same
 * authoritative presence used everywhere else; online and friends rank first.
 */
export const communityInviteCandidates = query({
  args: { channelId: v.id("channels") },
  handler: async (ctx, { channelId }) => {
    const me = await getAuthUserId(ctx);
    if (!me) return null;
    const channel = await ctx.db.get(channelId);
    if (!channel || channel.type === "text") return null;
    if (!(await membershipOf(ctx, channel.serverId, me))) return null;
    if (!(await hasChannelPermission(ctx, channelId, me, "createInvites"))) return null;

    // Bounded on purpose: the picker is an explicit user action, so the scan is
    // capped so a very large community can never turn one open into a big read.
    const members = await ctx.db.query("memberships").withIndex("by_server", (q) => q.eq("serverId", channel.serverId)).take(200);
    const inCall = new Set(
      (await ctx.db.query("voiceSessions").withIndex("by_channel", (q) => q.eq("channelId", channelId)).collect()).map((s) => s.userId as string),
    );
    const rows: { userId: Id<"users">; name: string; username: string; avatarUrl: string | null; presence: string; role: string; friend: boolean; inCall: boolean }[] = [];
    for (const m of members) {
      if (rows.length >= 60) break;
      if (m.userId === me) continue;
      if (isTimedOut(m)) continue;
      if (await isBlockedEitherWay(ctx, me, m.userId)) continue;
      if (!(await hasChannelPermission(ctx, channelId, m.userId, "viewChannels"))) continue;
      if (!(await hasChannelPermission(ctx, channelId, m.userId, "useVoice"))) continue;
      const user = await ctx.db.get(m.userId);
      const { status } = await presenceInfoOf(ctx, m.userId, me);
      rows.push({
        userId: m.userId,
        name: await displayNameOf(ctx, m.userId),
        username: user?.username ?? "",
        avatarUrl: await avatarUrlOf(ctx, m.userId),
        presence: status,
        role: m.role ?? "member",
        friend: await areFriends(ctx, me, m.userId),
        // Already in the call — the UI shows "Already in call" instead of
        // offering a button that would create a duplicate invitation.
        inCall: inCall.has(m.userId),
      });
    }
    const rank = (p: string) => (p === "online" ? 0 : p === "idle" ? 1 : p === "dnd" ? 2 : 3);
    rows.sort((a, b) => Number(a.inCall) - Number(b.inCall) || rank(a.presence) - rank(b.presence) || Number(b.friend) - Number(a.friend) || a.name.localeCompare(b.name));
    return rows.slice(0, 60);
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

const signalKind = v.union(v.literal("offer"), v.literal("answer"), v.literal("candidate"), v.literal("screen"));

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
    if (payload.length > 60_000) throw new Error("Signal payload too large.");
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
    // Oldest first so offers/answers/candidates are applied in the order they
    // were produced — out-of-order application is what causes renegotiation.
    return rows
      .filter((r) => r.conversationId === conversationId)
      .sort((a, b) => a._creationTime - b._creationTime);
  },
});

/**
 * Live status of a single call, for both participants. Lets the callee notice
 * when the caller hangs up (and vice-versa) so no ghost call is left running.
 */
export const getCall = query({
  args: { inviteId: v.id("callInvites") },
  handler: async (ctx, { inviteId }) => {
    const me = await getAuthUserId(ctx);
    if (!me) return null;
    const invite = await ctx.db.get(inviteId);
    if (!invite || (invite.fromId !== me && invite.toId !== me)) return null;
    return {
      _id: invite._id,
      status: invite.status,
      media: invite.media,
      conversationId: invite.conversationId ?? null,
      channelId: invite.channelId ?? null,
      fromId: invite.fromId,
      toId: invite.toId,
    };
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

/**
 * Purge any lingering signaling rows for a conversation I'm part of. Called
 * when a call ends so the next call starts from a clean slate (no stale
 * offers/candidates that would trigger a renegotiation).
 */
export const clearConversationSignals = mutation({
  args: { conversationId: v.id("dmConversations") },
  handler: async (ctx, { conversationId }) => {
    const me = await currentUserId(ctx);
    const member = await ctx.db
      .query("dmMembers")
      .withIndex("by_pair", (q) => q.eq("conversationId", conversationId).eq("userId", me))
      .unique();
    if (!member) return;
    const rows = await ctx.db
      .query("dmCallSignals")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
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
    // A community invitation carries its community/channel context so the
    // recipient knows exactly where they are being asked to join.
    let community: { serverId: Id<"servers">; serverName: string; channelName: string } | null = null;
    if (invite.channelId) {
      const channel = await ctx.db.get(invite.channelId);
      if (channel) {
        const server = await ctx.db.get(channel.serverId);
        community = { serverId: channel.serverId, serverName: server?.name ?? "a community", channelName: channel.name };
      }
    }
    return {
      inviteId: invite._id,
      fromId: invite.fromId,
      fromName: await displayNameOf(ctx, invite.fromId),
      fromUsername: fromUser?.username ?? null,
      fromAvatarUrl: await avatarUrlOf(ctx, invite.fromId),
      media: invite.media,
      conversationId: invite.conversationId ?? null,
      channelId: invite.channelId ?? null,
      community,
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
