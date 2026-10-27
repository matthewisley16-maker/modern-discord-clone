import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { membershipOf, memoizeAuthorCards } from "./lib";
import { inviteCardAccess } from "../lib/server-invites";

/**
 * Resolve the invitation card a message carries, from one viewer's point of view.
 *
 * Shared by BOTH message queries (`dms.messages` and `chat.messages`) so a card
 * renders identically wherever it was delivered, and can never disagree with the
 * rules `serverInvites.respond` enforces:
 *
 *  - A DM invitation is one row per recipient, so a group member sees THEIR row
 *    (pending for them even when somebody else already joined).
 *  - A channel invitation is ONE shared row with no recipient: every member who
 *    can see the message may accept it, and its status counts the people who
 *    joined through it.
 *
 * Only PUBLIC server metadata is returned — a card is rendered for non-members,
 * so nothing about channels, messages or the member list may leak here.
 */
export async function inviteCardFor(
  ctx: QueryCtx,
  ids: Id<"serverInviteCards">[] | undefined,
  viewerId: Id<"users">,
  now: number,
  authorCardFor: ReturnType<typeof memoizeAuthorCards>,
) {
  if (!ids || ids.length === 0) return null;
  const rows = (await Promise.all(ids.map((id) => ctx.db.get(id)))).filter(
    (row): row is NonNullable<typeof row> => Boolean(row),
  );
  if (rows.length === 0) return null;
  // The viewer's own invitation when there is one, else the inviter's view.
  const invite = rows.find((row) => row.recipientId === viewerId) ?? rows[0];
  const server = await ctx.db.get(invite.serverId);
  const inviter = await authorCardFor(invite.inviterId);
  const member = await membershipOf(ctx, invite.serverId, viewerId);
  // One shared rule decides the status and what the viewer may do; the card only
  // reflects it. A posted invitation is open to anyone who can see the message
  // carrying it, which the calling query has already permission-checked.
  const access = inviteCardAccess(invite, viewerId, Boolean(member), now);
  const status = server ? access.status : "invalid";
  return {
    inviteId: invite._id,
    code: invite.code,
    serverId: invite.serverId,
    serverName: server?.name ?? "",
    serverDescription: server?.description ?? "",
    serverIconUrl: server?.iconStorageId ? await ctx.storage.getUrl(server.iconStorageId) : null,
    serverIconColor: server?.iconColor ?? "violet",
    serverIsPublic: Boolean(server?.isPublic),
    inviterName: inviter.author,
    inviterAvatarUrl: inviter.authorAvatarUrl,
    expiresAt: invite.expiresAt,
    status,
    /** True for a card posted into a channel: a shared, not an addressed, invite. */
    isOpen: access.isOpen,
    /** How many people have joined through this shared card. */
    joinCount: invite.joins ?? 0,
    isRecipient: access.mayAccept || invite.recipientId === viewerId,
    canRespond: access.mayAccept,
  };
}
