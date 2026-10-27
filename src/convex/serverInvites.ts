import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { enforceRateLimit } from "./authHelpers";
import { ensureDirect } from "./dms";
import {
  avatarUrlOf,
  currentUserId,
  displayNameOf,
  hasChannelPermission,
  hasPermission,
  isBlockedEitherWay,
  membershipOf,
  notify,
  requireMember,
  requirePermission,
} from "./lib";
import {
  inviteCardAccess,
  inviteRecipients,
  inviteViewStatus,
  INVITE_TTL_MS,
  MAX_INVITE_RECIPIENTS,
} from "../lib/server-invites";
import { truncateText } from "../lib/message-format";
import type { Doc, Id } from "./_generated/dataModel";

/**
 * Discord-style server invitations delivered through Freecord DMs or posted
 * into a community channel.
 *
 * Security model (all enforced HERE, never by hiding a button):
 *  - Sending requires membership of the community AND its `createInvites`
 *    permission — the same rule the shareable code uses. Posting one into a
 *    channel additionally requires the right to send messages in that channel.
 *  - A server can never be joined without the recipient accepting: `respond`
 *    is the only place a membership row is created. A DM invitation is only
 *    redeemable by the person it is addressed to; a posted (shared) invitation
 *    only by someone who can actually see the message it lives in.
 *  - Revoking requires being the inviter or holding `createInvites` there.
 *  - Previews expose PUBLIC metadata only (name, description, art, member count).
 *    No channel, message or member list is ever returned to a non-member.
 */

/** A stored invitation row. */
type InviteRow = Doc<"serverInviteCards">;

/**
 * A POSTED invitation (shared in a community channel) has no addressee, so
 * anybody who can see the message it lives in may accept it. An ADDRESSED one
 * belongs to exactly one person.
 */
function isOpenInvite(invite: InviteRow): boolean {
  return !invite.recipientId;
}

/** Secure, unguessable invitation identifier (never a sequential id). */
async function newInviteCode(ctx: QueryCtx | MutationCtx): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = crypto.randomUUID().replace(/-/g, "");
    const existing = await ctx.db
      .query("serverInviteCards")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();
    if (!existing) return code;
  }
  throw new ConvexError("Could not create an invitation. Please try again.");
}

/**
 * The public face of a community: exactly the information an invitation may show
 * to someone who is not a member yet. Private channels, messages and the member
 * list are deliberately absent.
 */
async function serverPreview(ctx: QueryCtx, serverId: Id<"servers">) {
  const server = await ctx.db.get(serverId);
  if (!server) return null;
  const members = await ctx.db
    .query("memberships")
    .withIndex("by_server", (q) => q.eq("serverId", serverId))
    .collect();
  return {
    serverId: server._id,
    name: server.name,
    description: server.description,
    iconUrl: server.iconStorageId ? await ctx.storage.getUrl(server.iconStorageId) : null,
    iconColor: server.iconColor ?? "violet",
    bannerUrl: server.bannerStorageId ? await ctx.storage.getUrl(server.bannerStorageId) : null,
    isPublic: Boolean(server.isPublic),
    tags: server.tags ?? [],
    memberCount: members.length,
  };
}

/**
 * Everything one viewer may know about one invitation: the public server
 * preview, the inviter's identity, and the status from THEIR point of view
 * (already a member ⇒ "Joined", past the 7-day window ⇒ "Expired", …).
 */
async function describeInvite(ctx: QueryCtx, invite: InviteRow, viewerId: Id<"users">) {
  const server = await serverPreview(ctx, invite.serverId);
  const member = await membershipOf(ctx, invite.serverId, viewerId);
  // One shared rule (also used by the message cards and the unit tests) decides
  // the status and what this viewer may do with the invitation.
  const access = inviteCardAccess(invite, viewerId, Boolean(member));
  const status = server ? access.status : "invalid";
  return {
    inviteId: invite._id,
    code: invite.code,
    status,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    alreadyMember: Boolean(member),
    isOpen: access.isOpen,
    joinCount: invite.joins ?? 0,
    isRecipient: isOpenInvite(invite) ? access.mayAccept : invite.recipientId === viewerId,
    canRespond: access.mayAccept,
    isInviter: invite.inviterId === viewerId,
    server,
    inviter: {
      userId: invite.inviterId,
      name: await displayNameOf(ctx, invite.inviterId),
      avatarUrl: await avatarUrlOf(ctx, invite.inviterId),
    },
  };
}

/** The message text stored alongside the card, so search/previews keep working. */
function inviteBody(inviterName: string, serverName: string): string {
  return truncateText(`${inviterName} invited you to join ${serverName}.`, 200);
}

/**
 * Create one invitation row + the DM message that carries it.
 *
 * `conversationId` is given when inviting from an existing conversation (the
 * message is posted there); otherwise a 1:1 DM per recipient is used/created —
 * one message each, so nobody ever learns who else was invited.
 */
async function deliverInvites(
  ctx: MutationCtx,
  args: {
    me: Id<"users">;
    server: Doc<"servers">;
    inviterName: string;
    conversationId?: Id<"dmConversations">;
    recipients: Id<"users">[];
  },
): Promise<{ sent: number; conversationIds: Id<"dmConversations">[] }> {
  const { me, server, inviterName, recipients } = args;
  const body = inviteBody(inviterName, server.name);
  const now = Date.now();
  const expiresAt = now + INVITE_TTL_MS;
  const conversationIds: Id<"dmConversations">[] = [];
  let sent = 0;

  /** Insert the message + its invitation rows for one conversation. */
  async function post(conversationId: Id<"dmConversations">, to: Id<"users">[]) {
    const messageId = await ctx.db.insert("dmMessages", {
      conversationId,
      userId: me,
      body,
    });
    const inviteIds: Id<"serverInviteCards">[] = [];
    for (const recipientId of to) {
      inviteIds.push(
        await ctx.db.insert("serverInviteCards", {
          serverId: server._id,
          inviterId: me,
          recipientId,
          code: await newInviteCode(ctx),
          conversationId,
          messageId,
          status: "pending",
          createdAt: now,
          expiresAt,
        }),
      );
    }
    // The array lives on the message so a page of history resolves its card in
    // one conditional read (no scan of the invitations table).
    await ctx.db.patch(messageId, { serverInviteIds: inviteIds });
    await ctx.db.patch(conversationId, { lastMessageAt: now });
    for (const recipientId of to) {
      await notify(
        ctx,
        recipientId,
        "invite",
        "Server invitation",
        `${inviterName} invited you to join ${truncateText(server.name, 80)}.`,
        `?dm=${conversationId}&message=${messageId}`,
        me,
      );
    }
    conversationIds.push(conversationId);
    sent += to.length;
  }

  if (args.conversationId) {
    if (recipients.length > 0) await post(args.conversationId, recipients);
  } else {
    for (const recipientId of recipients) {
      // Respect the recipient's DM privacy and blocks; a refused DM is skipped.
      const conversationId = await ensureDirect(ctx, me, recipientId);
      if (!conversationId) continue;
      await post(conversationId, [recipientId]);
    }
  }
  return { sent, conversationIds };
}

// ---------------- Sending ----------------

/**
 * Invite one or more people to a community through DMs.
 *
 * From a community: pass `recipientIds` (friends, or anyone found by search).
 * From a conversation: pass `conversationId` and leave `recipientIds` empty to
 * invite every other member of that chat.
 */
export const send = mutation({
  args: {
    serverId: v.id("servers"),
    recipientIds: v.optional(v.array(v.id("users"))),
    conversationId: v.optional(v.id("dmConversations")),
  },
  handler: async (ctx, { serverId, recipientIds, conversationId }) => {
    const me = await currentUserId(ctx);
    const server = await ctx.db.get(serverId);
    if (!server) throw new ConvexError("Community not found.");
    // Membership is required to invite, and `createInvites` decides whether the
    // member is allowed to — never the client.
    await requireMember(ctx, serverId, me);
    await requirePermission(ctx, serverId, me, "createInvites");
    if (server.locked) {
      throw new ConvexError("This community is locked, so invitations can't be sent right now.");
    }
    await enforceRateLimit(ctx, `serverinvite:${me}`, 10, 60_000);

    let targets: Id<"users">[];
    if (conversationId) {
      // Posting into an existing chat: the caller must be a member of it.
      const membership = await ctx.db
        .query("dmMembers")
        .withIndex("by_pair", (q) => q.eq("conversationId", conversationId).eq("userId", me))
        .unique();
      if (!membership) throw new ConvexError("You're not part of this conversation.");
      const members = await ctx.db
        .query("dmMembers")
        .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
        .collect();
      const requested = new Set(inviteRecipients(recipientIds ?? [], me));
      targets = members
        .filter((m) => m.userId !== me && (requested.size === 0 || requested.has(m.userId as string)))
        .map((m) => m.userId)
        .slice(0, MAX_INVITE_RECIPIENTS);
    } else {
      targets = inviteRecipients(recipientIds ?? [], me).map((id) => id as Id<"users">);
    }
    if (targets.length === 0) throw new ConvexError("Choose at least one person to invite.");

    // Only people who are not already members (and who haven't blocked either
    // way) receive an invitation — a member would only be confused by one.
    const recipients: Id<"users">[] = [];
    let alreadyMembers = 0;
    for (const id of targets) {
      // A hand-crafted request must not be able to leave an invitation pointing
      // at an account that doesn't exist.
      if (!(await ctx.db.get(id))) continue;
      if (await membershipOf(ctx, serverId, id)) {
        alreadyMembers += 1;
        continue;
      }
      if (await isBlockedEitherWay(ctx, me, id)) continue;
      recipients.push(id);
    }
    if (recipients.length === 0) {
      throw new ConvexError(
        alreadyMembers > 0
          ? "Everyone you picked is already a member of this community."
          : "Those people can't be messaged right now.",
      );
    }

    const inviterName = await displayNameOf(ctx, me);
    const result = await deliverInvites(ctx, { me, server, inviterName, conversationId, recipients });
    if (result.sent === 0) {
      throw new ConvexError("That person only accepts DMs from friends, so the invitation couldn't be sent.");
    }
    return {
      sent: result.sent,
      skipped: alreadyMembers + (recipients.length - result.sent),
      conversationIds: result.conversationIds,
    };
  },
});

// ---------------- Posting into a channel ----------------

/**
 * Post an invitation into a community channel instead of DMing it.
 *
 * The card becomes a real channel message carrying ONE shared invitation row
 * (no recipient), so everyone who can see the message can accept it and each
 * accept adds exactly one membership through `respond`. The caller needs the
 * `createInvites` permission in the TARGET community (the same rule as any
 * other invitation) plus the right to speak in the HOST channel.
 */
export const postToChannel = mutation({
  args: { serverId: v.id("servers"), channelId: v.id("channels") },
  handler: async (ctx, { serverId, channelId }) => {
    const me = await currentUserId(ctx);
    const server = await ctx.db.get(serverId);
    if (!server) throw new ConvexError("Community not found.");
    await requireMember(ctx, serverId, me);
    await requirePermission(ctx, serverId, me, "createInvites");
    if (server.locked) throw new ConvexError("This community is locked, so invitations can't be sent right now.");

    const channel = await ctx.db.get(channelId);
    if (!channel) throw new ConvexError("Channel not found.");
    if (channel.type && channel.type !== "text") {
      throw new ConvexError("Invitations can only be posted in a text channel.");
    }
    if (channel.locked) throw new ConvexError("This channel is locked.");
    await requireMember(ctx, channel.serverId, me);
    if (!(await hasChannelPermission(ctx, channelId, me, "sendMessages"))) {
      throw new ConvexError("You don't have permission to send messages in that channel.");
    }
    await enforceRateLimit(ctx, `serverinvite:${me}`, 10, 60_000);

    const now = Date.now();
    const messageId = await ctx.db.insert("messages", {
      channelId,
      userId: me,
      body: inviteBody(await displayNameOf(ctx, me), server.name),
    });
    const inviteId = await ctx.db.insert("serverInviteCards", {
      serverId,
      inviterId: me,
      code: await newInviteCode(ctx),
      channelId,
      channelMessageId: messageId,
      status: "pending",
      createdAt: now,
      expiresAt: now + INVITE_TTL_MS,
      joins: 0,
    });
    // The message points at its card, so a page of history resolves it in one read.
    await ctx.db.patch(messageId, { serverInviteIds: [inviteId] });
    return { posted: true, inviteId, messageId, channelId, serverId };
  },
});

// ---------------- Reading ----------------

/**
 * The channels this user may post an invitation into: only channels where they
 * are a member AND are allowed to send messages.
 */
export const postableChannels = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const out: {
      channelId: Id<"channels">;
      channelName: string;
      serverId: Id<"servers">;
      serverName: string;
      iconUrl: string | null;
      iconColor: string;
    }[] = [];
    for (const membership of memberships) {
      const server = await ctx.db.get(membership.serverId);
      if (!server || server.locked) continue;
      const channels = await ctx.db
        .query("channels")
        .withIndex("by_server", (q) => q.eq("serverId", server._id))
        .collect();
      for (const channel of channels) {
        if (channel.type && channel.type !== "text") continue;
        if (channel.locked) continue;
        if (!(await hasChannelPermission(ctx, channel._id, userId, "sendMessages"))) continue;
        out.push({
          channelId: channel._id,
          channelName: channel.name,
          serverId: server._id,
          serverName: server.name,
          iconUrl: server.iconStorageId ? await ctx.storage.getUrl(server.iconStorageId) : null,
          iconColor: server.iconColor ?? "violet",
        });
      }
    }
    return out.sort(
      (a, b) => a.serverName.localeCompare(b.serverName) || a.channelName.localeCompare(b.channelName),
    );
  },
});

/** The communities this user is allowed to invite people to. */
export const invitableServers = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const out = [];
    for (const membership of memberships) {
      const server = await ctx.db.get(membership.serverId);
      if (!server || server.locked) continue;
      if (!(await hasPermission(ctx, membership.serverId, userId, "createInvites"))) continue;
      out.push({
        serverId: server._id,
        name: server.name,
        iconUrl: server.iconStorageId ? await ctx.storage.getUrl(server.iconStorageId) : null,
        iconColor: server.iconColor ?? "violet",
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },
});

/**
 * Public preview for one invitation, identified by its secure code.
 *
 * Only the recipient, the inviter, or an existing member of that community may
 * read it — anyone else gets `null`, exactly as if the invitation didn't exist.
 */
export const preview = query({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const invite = await ctx.db
      .query("serverInviteCards")
      .withIndex("by_code", (q) => q.eq("code", code.trim()))
      .unique();
    if (!invite) return null;
    if (invite.recipientId !== userId && invite.inviterId !== userId) {
      const member = await membershipOf(ctx, invite.serverId, userId);
      if (!member) {
        // A posted invitation belongs to the channel it was shared in: anyone
        // who can see that message may read its public preview. Everyone else
        // is told exactly nothing, as if it didn't exist.
        const canSee = invite.channelId
          ? await hasChannelPermission(ctx, invite.channelId, userId, "viewChannels")
          : false;
        if (!canSee) return null;
      }
    }
    return await describeInvite(ctx, invite, userId);
  },
});

/**
 * Invitations this user sent for a community (for revocation). Permission-gated
 * by `createInvites`, and only the community's own rows are ever returned.
 */
export const listSent = query({
  args: { serverId: v.id("servers") },
  handler: async (ctx, { serverId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    if (!(await hasPermission(ctx, serverId, userId, "createInvites"))) return [];
    const rows = await ctx.db
      .query("serverInviteCards")
      .withIndex("by_server", (q) => q.eq("serverId", serverId))
      .order("desc")
      .take(60);
    const out = [];
    for (const row of rows) {
      // A posted invitation has no recipient — it is described by where it went.
      if (!row.recipientId) {
        const channel = row.channelId ? await ctx.db.get(row.channelId) : null;
        out.push({
          inviteId: row._id,
          recipientId: null,
          recipientName: channel ? `Posted in #${channel.name}` : "Posted in a channel",
          recipientAvatarUrl: null,
          joins: row.joins ?? 0,
          status: inviteViewStatus(row, Date.now(), false),
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          canRevoke: row.status === "pending" && row.expiresAt > Date.now(),
        });
        continue;
      }
      const member = await membershipOf(ctx, serverId, row.recipientId);
      out.push({
        inviteId: row._id,
        recipientId: row.recipientId,
        recipientName: await displayNameOf(ctx, row.recipientId),
        recipientAvatarUrl: await avatarUrlOf(ctx, row.recipientId),
        joins: 0,
        status: inviteViewStatus(row, Date.now(), Boolean(member)),
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        canRevoke: row.status === "pending" && row.expiresAt > Date.now(),
      });
    }
    return out;
  },
});

// ---------------- Responding ----------------

const CLOSED_STATUS_MESSAGE: Record<string, string> = {
  accepted: "You've already joined this community from this invitation.",
  declined: "You already declined this invitation.",
  revoked: "This invitation was revoked.",
};

/**
 * Accept or decline an invitation. The ONLY path that can add a membership from
 * an invitation: an addressed one may be redeemed only by the person it names,
 * and a posted (shared) one only by someone who can actually see the message it
 * lives in.
 */
export const respond = mutation({
  args: { inviteId: v.id("serverInviteCards"), accept: v.boolean() },
  handler: async (ctx, { inviteId, accept }) => {
    const me = await currentUserId(ctx);
    const invite = await ctx.db.get(inviteId);
    if (!invite) throw new ConvexError("This invitation no longer exists.");
    const open = isOpenInvite(invite);
    if (open) {
      // A posted invitation is redeemable only from the channel it was shared
      // in: membership there plus channel visibility, exactly like reading the
      // message. Anyone else is treated as if it didn't exist.
      if (invite.inviterId === me) {
        throw new ConvexError("You already have access to this community.");
      }
      const hostChannelId = invite.channelId;
      if (!hostChannelId) throw new ConvexError("The message this invitation was posted in no longer exists.");
      const host = await ctx.db.get(hostChannelId);
      if (!host) throw new ConvexError("The message this invitation was posted in no longer exists.");
      await requireMember(ctx, host.serverId, me);
      if (!(await hasChannelPermission(ctx, hostChannelId, me, "viewChannels"))) {
        throw new ConvexError("You don't have access to this invitation.");
      }
    } else if (invite.recipientId !== me) {
      throw new ConvexError("This invitation is addressed to someone else.");
    }
    const server = await ctx.db.get(invite.serverId);
    if (!server) throw new ConvexError("The community this invitation was for no longer exists.");

    if (invite.status !== "pending") {
      // Repeating an accept is not an error state for the caller if they are
      // already in: it just reports the existing membership.
      const member = await membershipOf(ctx, invite.serverId, me);
      if (invite.status === "accepted" && member) return { joined: false, serverId: server._id, alreadyMember: true };
      throw new ConvexError(CLOSED_STATUS_MESSAGE[invite.status] ?? "This invitation is no longer valid.");
    }
    if (invite.expiresAt <= Date.now()) {
      throw new ConvexError("This invitation has expired. Ask for a new one.");
    }

    if (!accept) {
      // A posted invitation is shared: declining it would close it for everyone
      // else who can see it, so it can only be accepted or ignored.
      if (open) {
        throw new ConvexError("This invitation was posted in a channel — you can just ignore it, or accept it.");
      }
      await ctx.db.patch(inviteId, { status: "declined", resolvedAt: Date.now() });
      await notify(
        ctx,
        invite.inviterId,
        "invite",
        "Invitation declined",
        `${await displayNameOf(ctx, me)} declined your invitation to ${truncateText(server.name, 80)}.`,
        undefined,
        me,
      );
      return { joined: false, serverId: server._id, alreadyMember: false };
    }

    // Accepting respects bans and restricted/locked communities exactly like any
    // other join — an invitation is never a way around them.
    const ban = await ctx.db
      .query("bans")
      .withIndex("by_server_user", (q) => q.eq("serverId", invite.serverId).eq("userId", me))
      .unique();
    if (ban) throw new ConvexError("You're banned from this community.");
    if (server.locked) throw new ConvexError("This community isn't accepting new members right now.");

    const existing = await membershipOf(ctx, invite.serverId, me);
    if (!existing) {
      // Exactly one membership row, ever: the check above plus the invitation's
      // own pending status make a duplicate join impossible.
      await ctx.db.insert("memberships", { serverId: invite.serverId, userId: me, role: "member" });
    }
    if (open) {
      // A posted invitation stays open for the rest of the channel; it only
      // counts who ACTUALLY joined through it, so the card stays honest.
      if (!existing) await ctx.db.patch(inviteId, { joins: (invite.joins ?? 0) + 1 });
    } else {
      await ctx.db.patch(inviteId, { status: "accepted", resolvedAt: Date.now() });
    }
    if (!existing) {
      await notify(
        ctx,
        invite.inviterId,
        "invite",
        "Invitation accepted",
        `${await displayNameOf(ctx, me)} joined ${truncateText(server.name, 80)} from your invitation.`,
        `?server=${server._id}`,
        me,
      );
    }
    return { joined: !existing, serverId: server._id, alreadyMember: Boolean(existing) };
  },
});

/** Revoke a pending invitation (the inviter, or anyone who can invite here). */
export const revoke = mutation({
  args: { inviteId: v.id("serverInviteCards") },
  handler: async (ctx, { inviteId }) => {
    const me = await currentUserId(ctx);
    const invite = await ctx.db.get(inviteId);
    if (!invite) return { revoked: false };
    const allowed =
      invite.inviterId === me ||
      (await hasPermission(ctx, invite.serverId, me, "createInvites"));
    if (!allowed) throw new ConvexError("You don't have permission to revoke this invitation.");
    if (invite.status !== "pending") return { revoked: false };
    await ctx.db.patch(inviteId, { status: "revoked", resolvedAt: Date.now() });
    return { revoked: true };
  },
});
