/**
 * Recipient rules for "someone posted in a community channel".
 *
 * This is the server-notification counterpart of the DM path
 * (`dms.sendMessage`, which notifies a conversation's other members): a channel
 * message notifies the rest of the community, but only the people who should
 * actually hear about it.
 *
 * The rules live here — dependency-free — for the same reason the invitation
 * rules do: `src/convex/chat.ts` calls this module, so a plain unit test
 * (`server-notifications-test.mjs`) exercises the real production logic instead
 * of a copy of it.
 *
 * Invariants the rest of the app relies on:
 *  - The sender never gets a notification for their own message.
 *  - Someone already notified for this message (mention/reply) is never
 *    notified twice.
 *  - A muted community, a muted channel, a timeout, a block or no access to the
 *    channel all suppress it.
 *  - The expensive lookups (block + channel permission) only run for the
 *    candidates that survived every cheap check, so a large community does not
 *    pay for members the message will never reach.
 */

/** A member of the community the message was posted in. */
export type ChannelNotifyCandidate = {
  userId: string;
  /** The member muted this whole community. */
  mutedCommunity?: boolean;
  /** The member is currently timed out. */
  timedOut?: boolean;
};

export type ChannelNotifyInput = {
  /** The member who posted the message. */
  senderId: string;
  /** The community's members (bounded by the caller). */
  candidates: readonly ChannelNotifyCandidate[];
  /** Members who already got a mention/reply notification for this message. */
  alreadyNotified: ReadonlySet<string>;
  /** Users who muted THIS channel (read once for the whole channel). */
  mutedChannelUserIds: ReadonlySet<string>;
  /** True when either side blocked the other. */
  isBlocked: (userId: string) => Promise<boolean>;
  /** True when the member can see this channel (`viewChannels`). */
  canViewChannel: (userId: string) => Promise<boolean>;
};

/**
 * The user ids that should receive a "new message in #channel" notification,
 * in the order the members were supplied.
 */
export async function collectChannelNotifyTargets(input: ChannelNotifyInput): Promise<string[]> {
  const targets: string[] = [];
  for (const candidate of input.candidates) {
    if (candidate.userId === input.senderId) continue; // never the author
    if (input.alreadyNotified.has(candidate.userId)) continue; // mention/reply already sent
    if (candidate.mutedCommunity) continue; // muted community
    if (input.mutedChannelUserIds.has(candidate.userId)) continue; // muted channel
    if (candidate.timedOut) continue; // timed out members are not pinged
    if (await input.isBlocked(candidate.userId)) continue; // blocked either way
    if (!(await input.canViewChannel(candidate.userId))) continue; // private/locked to them
    targets.push(candidate.userId);
  }
  return targets;
}
