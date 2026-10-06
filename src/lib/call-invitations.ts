/**
 * Pure rules for "join an EXISTING call" invitations.
 *
 * These live outside the Convex functions on purpose: the invitation state
 * machine (pending / accepted / declined / expired / cancelled) is the part of
 * this feature with no DOM and no database behind it, so it is the only part we
 * can cover with a real unit test. `src/convex/calls.ts` imports these rules,
 * so the suite in `call-invitations-test.mjs` exercises production logic, not a
 * copy of it.
 *
 * Invariants the rest of the app relies on:
 *  - An invitation is only ever acceptable while `pending` AND inside its TTL.
 *  - It always points at an already-running call (channel or conversation) —
 *    it never creates one.
 *  - Two live invitations from the same person to the same call are a bug
 *    (both duplicate guards call `isLiveInvitationFor`).
 */

/** How long an invitation stays acceptable before it expires. */
export const INVITATION_TTL_MS = 15 * 60_000;

/** Mirrors the `callInvitations.status` union in `src/convex/schema.ts`. */
export type InvitationStatus = "pending" | "accepted" | "declined" | "expired" | "cancelled";

/** The subset of a `callInvitations` row these rules need. */
export type InvitationLike = {
  status: InvitationStatus;
  expiresAt: number;
  fromId?: string;
  channelId?: string | null;
  conversationId?: string | null;
};

/**
 * Is this invitation still acceptable right now? A row that was accepted,
 * declined, cancelled, expired — or whose TTL has elapsed — can never be used
 * to join a call, whatever the client claims.
 */
export function isAcceptable(row: Pick<InvitationLike, "status" | "expiresAt">, now: number): boolean {
  return row.status === "pending" && row.expiresAt > now;
}

/**
 * Is `row` a live invitation from `fromId` aimed at THIS call?
 *
 * Exactly one of `channelId` / `conversationId` selects which call is meant.
 * Used both to suppress duplicate sends and to render "Invitation already
 * pending" instead of a second Invite button.
 */
export function isLiveInvitationFor(
  row: InvitationLike,
  opts: { fromId: string; channelId?: string | null; conversationId?: string | null; now: number },
): boolean {
  if (!isAcceptable(row, opts.now)) return false;
  if (row.fromId !== opts.fromId) return false;
  if (opts.channelId) return row.channelId === opts.channelId;
  if (opts.conversationId) return row.conversationId === opts.conversationId;
  // Neither call target given — we cannot say this belongs to the call in
  // question, so treat it as "not this call" rather than a false duplicate.
  return false;
}
