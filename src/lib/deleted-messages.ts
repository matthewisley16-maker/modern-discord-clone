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
 */

/** Longest message preview the Admin Panel shows for a retained message. */
export const DELETED_PREVIEW_MAX = 160;

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
 *   - something must actually still be retained to show or delete,
 *   - and, when `requireOwnSender` is set, I must also be the original sender.
 */
export function isRetainedHiddenMessage(candidate: RetainedHiddenMessage): boolean {
  if (!candidate.messageExists) return false;
  if (candidate.hiddenByUserId !== candidate.viewerId) return false;
  if (candidate.requireOwnSender && candidate.messageSenderId !== candidate.viewerId) return false;
  if (candidate.deletedForEveryone) return false;
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
