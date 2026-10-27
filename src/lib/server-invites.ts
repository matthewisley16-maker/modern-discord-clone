/**
 * Shared rules for server (community) invitations sent through Freecord DMs.
 *
 * Deliberately dependency-free: the SAME logic is imported by the Convex
 * backend (validation + status), by the DM message renderer and by the invite
 * dialog, so a card can never disagree with what the server enforces. It is
 * also what the unit tests exercise directly.
 */

/** How long an invitation stays valid after it is sent. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Upper bound on how many people a single invitation action may target. */
export const MAX_INVITE_RECIPIENTS = 20;

/** What is persisted on `serverInviteCards.status`. */
export type StoredInviteStatus = "pending" | "accepted" | "declined" | "revoked";

/** What a viewer is shown: a stored status, plus expiry and membership checks. */
export type InviteViewStatus =
  | "pending"
  | "joined"
  | "declined"
  | "revoked"
  | "expired"
  | "invalid";

/**
 * Resolve the status a viewer should see for one invitation.
 *
 * Precedence matters: real membership always wins (so an accepted invite for
 * someone who is already in the community reads "Joined"), then a revoked or
 * declined invitation is final, and only a still-`pending` invitation can
 * expire. A missing/invalid row reads "Invalid" rather than throwing.
 */
export function inviteViewStatus(
  invite: { status?: string | null; expiresAt?: number | null } | null | undefined,
  now: number = Date.now(),
  alreadyMember = false,
): InviteViewStatus {
  if (!invite) return "invalid";
  if (alreadyMember || invite.status === "accepted") return "joined";
  if (invite.status === "revoked") return "revoked";
  if (invite.status === "declined") return "declined";
  if (typeof invite.expiresAt !== "number" || !Number.isFinite(invite.expiresAt)) return "invalid";
  if (invite.expiresAt <= now) return "expired";
  return "pending";
}

/** Short badge text for a status. */
export const INVITE_STATUS_LABEL: Record<InviteViewStatus, string> = {
  pending: "Invite Pending",
  joined: "Joined",
  declined: "Declined",
  revoked: "Invite Revoked",
  expired: "Expired",
  invalid: "Invalid",
};

/** Only a pending invitation can be accepted or declined. */
export function canRespondToInvite(status: InviteViewStatus): boolean {
  return status === "pending";
}

/** Human countdown used on the card ("Expires in 6 days"). */
export function inviteExpiryLabel(expiresAt: number, now: number = Date.now()): string {
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return "";
  const ms = expiresAt - now;
  if (ms <= 0) return "Expired";
  const hours = Math.ceil(ms / 3_600_000);
  if (hours <= 1) return "Expires in under an hour";
  if (hours < 24) return `Expires in ${hours} hours`;
  const days = Math.ceil(hours / 24);
  return `Expires in ${days} day${days === 1 ? "" : "s"}`;
}

/**
 * Clean a recipient selection: strings only, no duplicates, never the sender,
 * and bounded so one action can never fan out to an unbounded number of DMs.
 */
export function inviteRecipients(
  ids: readonly string[] | null | undefined,
  me: string,
  cap: number = MAX_INVITE_RECIPIENTS,
): string[] {
  const safeCap = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : MAX_INVITE_RECIPIENTS;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== "string" || !id || id === me || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= safeCap) break;
  }
  return out;
}

/**
 * The ONE rule for "what may this viewer do with this invitation".
 *
 * Shared by the Convex backend (which enforces it), the card renderer (which
 * only reflects it) and the unit tests, so a button can never offer something
 * the server would reject, and a posted invitation can never be treated like an
 * addressed one:
 *
 *  - `recipientId` present  → an ADDRESSED invitation: only that person may act.
 *  - `recipientId` absent   → a POSTED invitation shared in a channel: anyone
 *    who can see it may accept (never the inviter, who is already a member), and
 *    there is nothing to decline — you accept it or ignore it.
 */
export function inviteCardAccess(
  invite: {
    recipientId?: string | null;
    inviterId: string;
    status?: string | null;
    expiresAt?: number | null;
  } | null | undefined,
  viewerId: string,
  alreadyMember: boolean,
  now: number = Date.now(),
): { status: InviteViewStatus; isOpen: boolean; mayAccept: boolean; mayDecline: boolean } {
  if (!invite) return { status: "invalid", isOpen: false, mayAccept: false, mayDecline: false };
  const isOpen = !invite.recipientId;
  // "Joined" describes the person the card belongs to; for a posted card that is
  // whoever is looking at it and is already in the community.
  const joined = isOpen ? alreadyMember : invite.recipientId === viewerId && alreadyMember;
  const status = inviteViewStatus(invite, now, joined);
  const actionable = canRespondToInvite(status);
  const mayAccept =
    actionable &&
    (isOpen ? invite.inviterId !== viewerId && !alreadyMember : invite.recipientId === viewerId);
  return { status, isOpen, mayAccept, mayDecline: mayAccept && !isOpen };
}

/** Button label for the recipient picker. */
export function inviteSendLabel(count: number): string {
  const n = Math.max(0, Math.trunc(count));
  if (n === 0) return "Send invitation";
  return n === 1 ? "Send invitation" : `Send ${n} invitations`;
}
