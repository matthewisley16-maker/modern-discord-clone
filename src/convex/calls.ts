import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { areFriends, avatarUrlOf, currentUserId, displayNameOf, hasChannelPermission, isBlockedEitherWay, isTimedOut, membershipOf, notify, presenceInfoOf } from "./lib";
import type { Ctx } from "./lib";
import type { Id } from "./_generated/dataModel";
// Shared with the client and with the unit tests: the invitation state-machine
// rules are pure, so they live in one place instead of being re-inlined per
// mutation (and they are the only part of this feature that can be covered by
// a runnable test).
import { INVITATION_TTL_MS, isAcceptable, isLiveInvitationFor } from "../lib/call-invitations";

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
/** How long an invitation stays acceptable before it expires (`INVITATION_TTL_MS` in `src/lib/call-invitations`). */

/**
 * The call currently running in a DM conversation, if any. Used only to prove
 * that an invitation points at a call that actually exists — the invitation
 * never starts one.
 */
async function activeDmCallForConversation(ctx: Ctx, conversationId: Id<"dmConversations">) {
  // Indexed lookup: this runs from a reactive query (`dmInviteCandidates`), so
  // a whole-table scan of every call ever placed would be unacceptable.
  const rows = await ctx.db
    .query("callInvites")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
    .collect();
  // An answered call always wins over a stray newer ringing row: an invitation
  // must point at the call that is actually live, not at an unanswered one.
  return rows.find((c) => c.status === "accepted") ?? rows.find((c) => c.status === "ringing") ?? null;
}

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

    // Duplicate protection: an identical, still-valid pending invitation is
    // reused rather than creating a second one for the same person + call.
    const theirPending = await ctx.db
      .query("callInvitations")
      .withIndex("by_to", (q) => q.eq("toId", toUserId).eq("status", "pending"))
      .collect();
    const duplicate = theirPending.find((inv) => isLiveInvitationFor(inv, { fromId: me, channelId, now: Date.now() }));
    if (duplicate) return duplicate._id;

    // Channel capacity is enforced here so an invite can never overfill a room.
    const limit = channel.userLimit ?? 0;
    if (limit > 0) {
      const sessions = await ctx.db.query("voiceSessions").withIndex("by_channel", (q) => q.eq("channelId", channelId)).collect();
      if (sessions.length >= limit) throw new ConvexError("This voice channel is full.");
    }

    const kind = media ?? (mine.video ? "video" : "voice");
    const now = Date.now();
    const id = await ctx.db.insert("callInvitations", {
      fromId: me,
      toId: toUserId,
      channelId,
      media: kind,
      status: "pending",
      createdAt: now,
      expiresAt: now + INVITATION_TTL_MS,
    });
    const server = await ctx.db.get(channel.serverId);
    // NOTIFICATION ONLY. This is a `callInvitations` row, never a `callInvites`
    // one, so it cannot ring, cannot appear as an incoming call, and never
    // touches the recipient's camera, microphone or WebRTC.
    await notify(
      ctx,
      toUserId,
      "call",
      kind === "video" ? "🎥 Community Video Call Invite" : "🔊 Community Voice Call Invite",
      `${await displayNameOf(ctx, me)} invited you to join the ${kind} call in ${server?.name ?? "a community"} / #${channel.name}.`,
      `?invite=${id}`,
      me,
    );
    return id;
  },
});

/**
 * Invite a conversation member into the call that is ALREADY running in a DM.
 * Notification only — no ringing, no auto-connect, no media. Validated against
 * the live call so an invitation can never point at a call that is not there.
 */
export const inviteToDmCall = mutation({
  args: {
    conversationId: v.id("dmConversations"),
    toUserId: v.id("users"),
    media: v.union(v.literal("voice"), v.literal("video")),
  },
  handler: async (ctx, { conversationId, toUserId, media }) => {
    const me = await currentUserId(ctx);
    if (me === toUserId) throw new ConvexError("You can't invite yourself.");
    const mine = await ctx.db
      .query("dmMembers")
      .withIndex("by_pair", (q) => q.eq("conversationId", conversationId).eq("userId", me))
      .unique();
    if (!mine) throw new ConvexError("You're not part of this conversation.");
    const theirs = await ctx.db
      .query("dmMembers")
      .withIndex("by_pair", (q) => q.eq("conversationId", conversationId).eq("userId", toUserId))
      .unique();
    if (!theirs) throw new ConvexError("You can only invite members of this conversation.");
    if (await isBlockedEitherWay(ctx, me, toUserId)) throw new ConvexError("You can't invite this user.");
    const active = await activeDmCallForConversation(ctx, conversationId);
    if (!active) {
      throw new ConvexError("There's no active call in this conversation to invite them to.");
    }
    // Only someone actually IN this call may hand out invitations to it — the
    // same rule the community path enforces with a voice-session lookup. A
    // third conversation member must never be able to point an invitation at
    // a call they have no part in.
    if (active.fromId !== me && active.toId !== me) {
      throw new ConvexError("Join the call before inviting people to it.");
    }
    // An unanswered (ringing) call is not yet joinable — wait for it to be
    // picked up, exactly like the two people already in it did.
    if (active.status !== "accepted") {
      throw new ConvexError("The call hasn't been answered yet.");
    }
    // Server-side duplicate protection: never invite someone who is already a
    // participant of the running call (the client also hides the button).
    if (active.fromId === toUserId || active.toId === toUserId) {
      throw new ConvexError("They're already in this call.");
    }
    const pending = await ctx.db
      .query("callInvitations")
      .withIndex("by_to", (q) => q.eq("toId", toUserId).eq("status", "pending"))
      .collect();
    const duplicate = pending.find((inv) => isLiveInvitationFor(inv, { fromId: me, conversationId, now: Date.now() }));
    if (duplicate) return duplicate._id;
    const now = Date.now();
    const id = await ctx.db.insert("callInvitations", {
      fromId: me,
      toId: toUserId,
      conversationId,
      media,
      status: "pending",
      createdAt: now,
      expiresAt: now + INVITATION_TTL_MS,
    });
    await notify(
      ctx,
      toUserId,
      "call",
      media === "video" ? "🎥 Video Call Invite" : "🔊 Voice Call Invite",
      `${await displayNameOf(ctx, me)} invited you to join a ${media} call.`,
      `?invite=${id}`,
      me,
    );
    return id;
  },
});

/**
 * Invitations waiting on me. ONE indexed subscription drives the whole UI —
 * expired rows are simply not offered, so there is no polling and no sweeper.
 */
export const pendingInvitations = query({
  args: {},
  handler: async (ctx) => {
    const me = await getAuthUserId(ctx);
    if (!me) return [];
    const rows = await ctx.db
      .query("callInvitations")
      .withIndex("by_to", (q) => q.eq("toId", me).eq("status", "pending"))
      .collect();
    const now = Date.now();
    const out = [];
    for (const inv of rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, 8)) {
      if (!isAcceptable(inv, now)) continue; // expired / already resolved — never offered
      const channel = inv.channelId ? await ctx.db.get(inv.channelId) : null;
      // A community invitation whose channel is gone is dead: skip it.
      if (inv.channelId && !channel) continue;
      const server = channel ? await ctx.db.get(channel.serverId) : null;
      const fromUser = await ctx.db.get(inv.fromId);
      out.push({
        invitationId: inv._id,
        fromId: inv.fromId,
        fromName: await displayNameOf(ctx, inv.fromId),
        fromUsername: fromUser?.username ?? null,
        fromAvatarUrl: await avatarUrlOf(ctx, inv.fromId),
        media: inv.media,
        channelId: channel?._id ?? null,
        channelName: channel?.name ?? null,
        serverId: server?._id ?? null,
        serverName: server?.name ?? null,
        conversationId: inv.conversationId ?? null,
        createdAt: inv.createdAt,
        expiresAt: inv.expiresAt,
      });
    }
    return out;
  },
});

/**
 * Accept or decline an invitation.
 *
 * Accepting NEVER starts a call — it validates that the referenced call is
 * still there and that the user may still join, marks the invitation accepted,
 * and hands the client the target so it can join the EXISTING call. Declining
 * touches nothing at all (no media, no WebRTC, no call UI).
 */
export const respondInvitation = mutation({
  args: { invitationId: v.id("callInvitations"), accept: v.boolean() },
  handler: async (ctx, { invitationId, accept }) => {
    const me = await currentUserId(ctx);
    const invite = await ctx.db.get(invitationId);
    if (!invite || invite.toId !== me) throw new ConvexError("This call invitation is no longer available.");
    if (!isAcceptable(invite, Date.now())) {
      // Only a genuinely pending-but-stale row changes state; a row that was
      // already resolved is reported without a pointless write.
      if (invite.status === "pending") {
        await ctx.db.patch(invitationId, { status: "expired", resolvedAt: Date.now() });
      }
      throw new ConvexError("This call invitation is no longer available.");
    }

    if (!accept) {
      await ctx.db.patch(invitationId, { status: "declined", resolvedAt: Date.now() });
      return { joined: false as const, target: null };
    }

    if (invite.channelId) {
      // Re-validated at accept time: permissions, locks, bans and the channel's
      // very existence can all have changed since the invitation was sent.
      const channel = await assertCanJoinCommunityCall(ctx, invite.channelId, me);
      await ctx.db.patch(invitationId, { status: "accepted", resolvedAt: Date.now() });
      const server = await ctx.db.get(channel.serverId);
      return {
        joined: true as const,
        target: {
          kind: "community" as const,
          channelId: channel._id,
          channelName: channel.name,
          serverId: channel.serverId,
          serverName: server?.name ?? "a community",
        },
      };
    }

    if (invite.conversationId) {
      const member = await ctx.db
        .query("dmMembers")
        .withIndex("by_pair", (q) => q.eq("conversationId", invite.conversationId!).eq("userId", me))
        .unique();
      if (!member) throw new ConvexError("This call invitation is no longer available.");
      // The invitation must still point at a RUNNING call. Nothing is created
      // here: the returned `callId` is the existing session the user attaches to.
      const active = await activeDmCallForConversation(ctx, invite.conversationId);
      if (!active) {
        await ctx.db.patch(invitationId, { status: "expired", resolvedAt: Date.now() });
        throw new ConvexError("This call invitation is no longer available.");
      }
      await ctx.db.patch(invitationId, { status: "accepted", resolvedAt: Date.now() });
      const fromUser = await ctx.db.get(invite.fromId);
      return {
        joined: true as const,
        target: {
          kind: "dm" as const,
          conversationId: invite.conversationId,
          media: invite.media,
          callId: active._id,
          peerId: invite.fromId,
          peerName: await displayNameOf(ctx, invite.fromId),
          peerUsername: fromUser?.username ?? null,
          peerAvatarUrl: await avatarUrlOf(ctx, invite.fromId),
        },
      };
    }

    throw new ConvexError("This call invitation is no longer available.");
  },
});

/** Dismiss / withdraw an invitation. Either side may resolve it. */
export const cancelInvitation = mutation({
  args: { invitationId: v.id("callInvitations") },
  handler: async (ctx, { invitationId }) => {
    const me = await currentUserId(ctx);
    const invite = await ctx.db.get(invitationId);
    if (!invite) return;
    if (invite.fromId !== me && invite.toId !== me) throw new ConvexError("Invitation not found.");
    if (invite.status !== "pending") return; // only a real state change is written
    await ctx.db.patch(invitationId, { status: "cancelled", resolvedAt: Date.now() });
  },
});

/**
 * Who can I invite into the DM / group-DM call that is ALREADY running in this
 * conversation? Only members of the conversation, never someone outside it, and
 * never someone already in the call or already holding a pending invitation
 * from me for it. Read-only, indexed and bounded: the picker is an explicit
 * user action, so it never polls and never scans the whole users table.
 */
export const dmInviteCandidates = query({
  args: { conversationId: v.id("dmConversations") },
  handler: async (ctx, { conversationId }) => {
    const me = await getAuthUserId(ctx);
    if (!me) return null;
    const mine = await ctx.db
      .query("dmMembers")
      .withIndex("by_pair", (q) => q.eq("conversationId", conversationId).eq("userId", me))
      .unique();
    if (!mine) return null;
    // No active call in this conversation means there is nothing to invite to.
    const active = await activeDmCallForConversation(ctx, conversationId);
    if (!active) return null;
    const inCall = new Set<string>(
      active.status === "accepted" ? [active.fromId as string, active.toId as string] : [active.fromId as string],
    );
    const now = Date.now();
    const invitedIds = new Set<string>(
      (await ctx.db.query("callInvitations").withIndex("by_from", (q) => q.eq("fromId", me)).collect())
        .filter((i) => isLiveInvitationFor(i, { fromId: me, conversationId, now }))
        .map((i) => i.toId as string),
    );
    const members = await ctx.db
      .query("dmMembers")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .take(200);
    const rows: { userId: Id<"users">; name: string; username: string; avatarUrl: string | null; presence: string; friend: boolean; inCall: boolean; invited: boolean }[] = [];
    for (const m of members) {
      if (rows.length >= 60) break;
      if (m.userId === me) continue;
      if (await isBlockedEitherWay(ctx, me, m.userId)) continue;
      const user = await ctx.db.get(m.userId);
      if (!user) continue;
      const { status } = await presenceInfoOf(ctx, m.userId, me);
      rows.push({
        userId: m.userId,
        name: await displayNameOf(ctx, m.userId),
        username: user.username ?? "",
        avatarUrl: await avatarUrlOf(ctx, m.userId),
        presence: status,
        friend: await areFriends(ctx, me, m.userId),
        inCall: inCall.has(m.userId),
        invited: invitedIds.has(m.userId),
      });
    }
    const rank = (p: string) => (p === "online" ? 0 : p === "idle" ? 1 : p === "dnd" ? 2 : 3);
    rows.sort((a, b) => Number(a.inCall) - Number(b.inCall) || rank(a.presence) - rank(b.presence) || Number(b.friend) - Number(a.friend) || a.name.localeCompare(b.name));
    return rows;
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
    // People I already invited to THIS call show "Invitation already pending"
    // instead of offering another invite button.
    const now = Date.now();
    const invitedIds = new Set(
      (await ctx.db.query("callInvitations").withIndex("by_from", (q) => q.eq("fromId", me)).collect())
        .filter((i) => isLiveInvitationFor(i, { fromId: me, channelId, now }))
        .map((i) => i.toId as string),
    );
    const rows: { userId: Id<"users">; name: string; username: string; avatarUrl: string | null; presence: string; role: string; friend: boolean; inCall: boolean; invited: boolean }[] = [];
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
        invited: invitedIds.has(m.userId),
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
    // Ending the call kills any invitations pointing at it, so a pending
    // invitation can never be accepted into a finished call.
    if (invite.conversationId) {
      const pending = await ctx.db
        .query("callInvitations")
        .withIndex("by_conversation", (q) => q.eq("conversationId", invite.conversationId))
        .collect();
      for (const invitation of pending) {
        if (invitation.status === "pending") {
          await ctx.db.patch(invitation._id, { status: "cancelled", resolvedAt: Date.now() });
        }
      }
    }
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
    if (!invite) return null;
    if (invite.fromId !== me && invite.toId !== me) {
      // A guest who accepted an invitation is attached to the SAME call but is
      // not a party to the ringing row. They may still observe its status
      // read-only — otherwise their panel would never notice the owner hanging
      // up and would keep the microphone live in a ghost call. `endCall` stays
      // restricted to the original pair, so a guest can never end it.
      const conversationId = invite.conversationId;
      if (!conversationId) return null;
      const member = await ctx.db
        .query("dmMembers")
        .withIndex("by_pair", (q) => q.eq("conversationId", conversationId).eq("userId", me))
        .unique();
      if (!member) return null;
    }
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
/**
 * Clear only MY signaling rows for a conversation.
 *
 * A guest who joined an existing call by accepting an invitation must NOT call
 * `clearConversationSignals` on leave: that deletes the owner's in-flight ICE
 * for the call they are still running. This scoped variant keeps a guest's
 * departure purely local — it drops only rows I sent and rows addressed to me,
 * so a leftover offer of mine cannot be replayed against the next call started
 * in the same conversation, while the participants' signaling stays untouched.
 */
export const clearMyConversationSignals = mutation({
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
    for (const r of rows) {
      if (r.toUserId === me || r.fromUserId === me) await ctx.db.delete(r._id);
    }
  },
});

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
    // Indexed by caller: this is a reactive query, so it must not scan every
    // call ever placed just to find the latest one I started.
    const mine = await ctx.db.query("callInvites").withIndex("by_from", (q) => q.eq("fromId", me)).collect();
    const recent = [...mine].sort((a, b) => b._creationTime - a._creationTime)[0];
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
