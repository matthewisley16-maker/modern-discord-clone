/**
 * "Deleted for me" retention helpers — Admin Panel → My Deleted Messages.
 *
 * HOW A LOCAL DELETE IS STORED
 * ----------------------------
 * `deletion.deleteForMe` (channels) and `deletion.deleteDmForMe` (DMs) never
 * touch the message row. They insert ONE row in `messageVisibility`
 * (`userId`, `messageId`, `channelId` | `conversationId`, `hiddenAt`) and the
 * normal history queries (`chat.messages`, `dms.messages`, `search`) simply
 * filter those ids out. The body, the GIF and the attachment records therefore
 * stay in storage — which is exactly what makes the Admin Panel section
 * possible, and why nothing here "restores" a message into normal history.
 *
 * The rules below are pure (no Convex, no DOM) so they can be unit tested and
 * are the SINGLE definition used by the server query — the UI never decides
 * eligibility on its own.
 *
 * SEVEN-DAY EXPIRY
 * ----------------
 * A local delete is a TEMPORARY recovery window for the platform, not a
 * permanent archive: `DELETED_FOR_ME_TTL_MS` after the user deleted it, the
 * entry disappears from the Admin Panel on its own. The expiry is decided from
 * `messageVisibility.hiddenAt` (a server timestamp written when the message was
 * hidden) — never from when the tab was opened — so refreshing, re-subscribing
 * or clicking around cannot extend it. The scheduled sweep in
 * `convex/deleteForMeRetention.ts` records the expiry durably, and this module
 * is what decides both the list contents and whether a retained message may
 * still be permanently purged.
 *
 * Expiring an entry removes the panel entry and nothing else: the hidden
 * message stays hidden for the user who deleted it, the message row, its body
 * and its attachment records are untouched, and every other participant keeps
 * seeing their own copy. Nothing here ever expires for another user either —
 * each row's window is judged against its own `hiddenAt` and `userId`.
 */

/** Longest message preview the Admin Panel shows for a retained message. */
export const DELETED_PREVIEW_MAX = 160;

/**
 * How long ONE user's "Delete for me" entry stays available in the Admin Panel.
 *
 * The clock starts when the user deletes the message for themselves
 * (`messageVisibility.hiddenAt`, written server-side by `deletion.hideForMe`) and
 * is never restarted afterwards: opening the tab, refreshing, re-hiding, or any
 * later read leaves it untouched. Seven days after that instant the entry is
 * gone from the panel — see `isDeletedForMeExpired` (authoritative, server-side)
 * and the bounded sweep in `convex/deleteForMeRetention.ts` (durable).
 *
 * Expiring an entry never touches the message itself: other participants keep
 * their copy, its body, its GIF and its attachments.
 */
export const DELETED_FOR_ME_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The instant one entry's retention window closes. */
export function deletedForMeExpiresAt(hiddenAt: number): number {
  return hiddenAt + DELETED_FOR_ME_TTL_MS;
}

/**
 * Has the retention window for this local delete closed? `now` is injected so
 * the rule can be tested with fixed clocks and so every row of one request is
 * judged against the same instant.
 *
 * A marker without a usable timestamp fails CLOSED (reported as expired): a
 * row that cannot prove when it was created must not keep content listable.
 */
export function isDeletedForMeExpired(hiddenAt: number, now: number): boolean {
  if (!Number.isFinite(hiddenAt)) return true;
  return now - hiddenAt >= DELETED_FOR_ME_TTL_MS;
}

/** Milliseconds left in the window (0 once it has closed). */
export function deletedForMeRemainingMs(hiddenAt: number, now: number): number {
  if (!Number.isFinite(hiddenAt)) return 0;
  return Math.max(0, deletedForMeExpiresAt(hiddenAt) - now);
}

/** Compact "how long is left" label for the panel, e.g. "6d 23h" / "42 min". */
export function deletedForMeRemainingLabel(hiddenAt: number, now: number): string {
  const remaining = deletedForMeRemainingMs(hiddenAt, now);
  if (remaining <= 0) return "expired";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days}d ${restHours}h` : `${days}d`;
}

/** The structural facts the eligibility rules need about one candidate. */
export type RetainedHiddenMessage = {
  /** The administrator viewing the panel. */
  viewerId: string;
  /** `messageVisibility.userId` — who hid the message. */
  hiddenByUserId: string;
  /** Whether the message row still exists in storage at all. */
  messageExists: boolean;
  /** `messages.userId` / `dmMessages.userId` — the original sender. */
  messageSenderId?: string | null;
  /** Set by "Delete for everyone", which clears the retained body. */
  deletedForEveryone?: boolean;
  /**
   * `messageVisibility.hiddenAt` — when the VIEWER deleted the message for
   * themselves. Starts this user's seven-day retention window.
   */
  hiddenAt: number;
  /** Server "now" (ms), injected so the window is judged against one instant. */
  now: number;
  /**
   * Set by the retention sweep once the window has closed. Optional because
   * `hiddenAt` alone already proves expiry; the mark makes the cleanup durable.
   */
  entryExpiredAt?: number | null;
  body?: string | null;
  attachmentCount?: number;
  hasGif?: boolean;
  /**
   * Only messages the viewer wrote qualify (the "My Deleted Messages" list).
   * The administrator moderation list leaves this unset, because a global
   * administrator may also moderate another member's message they had hidden.
   */
  requireOwnSender?: boolean;
};

/** Kept as the strict, own-message-only shape. */
export type RetainedOwnDeletion = Omit<RetainedHiddenMessage, "requireOwnSender">;

/** True when a message still has content worth showing/deleting. */
export function hasRetainedContent(content: {
  body?: string | null;
  attachmentCount?: number;
  hasGif?: boolean;
}): boolean {
  if ((content.body ?? "").trim().length > 0) return true;
  if ((content.attachmentCount ?? 0) > 0) return true;
  return Boolean(content.hasGif);
}

/**
 * The shared eligibility rule for retained "delete for me" records:
 *   - the visibility row must be MY OWN local delete,
 *   - the message itself must still exist (a removed row cannot be recovered),
 *   - it must NOT have been deleted for everyone (its content is already gone,
 *     and pretending it is recoverable would be a lie),
 *   - the seven-day retention window must still be OPEN for this user's delete
 *     (`hiddenAt` + TTL) and the entry must not already be marked expired,
 *   - something must actually still be retained to show or delete,
 *   - and, when `requireOwnSender` is set, I must also be the original sender.
 *
 * The window is per marker, so one user's expiry can never affect another
 * user's hidden message, their retention entry, or the message row itself.
 */
export function isRetainedHiddenMessage(candidate: RetainedHiddenMessage): boolean {
  if (!candidate.messageExists) return false;
  if (candidate.hiddenByUserId !== candidate.viewerId) return false;
  if (candidate.requireOwnSender && candidate.messageSenderId !== candidate.viewerId) return false;
  if (candidate.deletedForEveryone) return false;
  if (candidate.entryExpiredAt != null) return false;
  if (isDeletedForMeExpired(candidate.hiddenAt, candidate.now)) return false;
  return hasRetainedContent(candidate);
}

/**
 * The rule for **My Deleted Messages**: my own messages that I hid myself.
 * A message another member wrote is never part of this list, even though a
 * platform administrator may moderate it through the moderation list.
 */
export function isRetainedOwnDeletion(candidate: RetainedOwnDeletion): boolean {
  return isRetainedHiddenMessage({ ...candidate, requireOwnSender: true });
}

/** One-line preview: the message text when there is any, otherwise its files. */
export function deletedMessagePreview(input: {
  body?: string | null;
  attachmentNames?: readonly string[];
  hasGif?: boolean;
}): string {
  const body = (input.body ?? "").replace(/\s+/g, " ").trim();
  if (body) {
    return body.length > DELETED_PREVIEW_MAX ? `${body.slice(0, DELETED_PREVIEW_MAX - 1)}…` : body;
  }
  const names = input.attachmentNames ?? [];
  if (names.length === 1) return `Attachment: ${names[0]}`;
  if (names.length > 1) return `${names.length} attachments`;
  if (input.hasGif) return "GIF";
  return "(no text content)";
}

/**
 * Search across the fields an administrator can actually see. An empty term
 * matches everything; matching is case-insensitive and never throws.
 */
export function matchesDeletedMessageSearch(
  fields: {
    body?: string | null;
    conversationName?: string | null;
    attachmentNames?: readonly string[];
  },
  term: string,
): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [fields.body ?? "", fields.conversationName ?? "", ...(fields.attachmentNames ?? [])]
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle);
}
