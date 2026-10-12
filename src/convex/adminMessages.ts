import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { auditAdmin, currentUserId, displayNameOf, requirePanelAccess } from "./lib";
import { deleteChannelMessage, deleteDmMessage } from "./storage";
import {
  deletedForMeExpiresAt,
  deletedMessagePreview,
  isRetainedHiddenMessage,
  matchesDeletedMessageSearch,
} from "../lib/deleted-messages";

/**
 * ---------------------------------------------------------------------------
 * Admin Panel — "My Deleted Messages" (delete-for-me retention + purge).
 * ---------------------------------------------------------------------------
 * FreeCord's "Delete for me" (`deletion.deleteForMe` / `deleteDmForMe`) inserts
 * a `messageVisibility` row and leaves the message itself completely untouched;
 * normal history queries just filter the id out. Nothing was ever able to look
 * those messages up again, so their content sat in storage forever.
 *
 * This module is that missing view, in two deliberately separate lists, both
 * reachable only by callers with panel access (`requirePanelAccess`, rank >=
 * admin):
 *   - `listMineDeletedMessages` — "My Deleted Messages": the caller's OWN
 *     messages they deleted for themselves;
 *   - `listMineHiddenMessages` — "Hidden Messages": the moderation list of any
 *     retained message the caller hid (an administrator may moderate another
 *     member's message without restoring it to their own history first). It
 *     never becomes a way to browse arbitrary private conversations: a row
 *     exists only because the caller already saw that message and hid it.
 *
 * HIDDEN vs DELETED
 * -----------------
 * "Hidden" is the delete-for-me marker: your own view only, nobody else's copy
 * is touched by hiding. "Deleted" means the message itself is removed — every
 * delete in this module PURGES the message for every participant (content, GIF,
 * attachment records and orphaned files, reactions, and all visibility markers),
 * leaving no "this message was deleted" placeholder behind. Whichever list an
 * administrator deletes from, the row disappears from everyone's history; the
 * only difference between the two tabs is which sender's messages the caller is
 * allowed to reach (own vs anyone they had hidden).
 *
 * Neither list ever shows a message deleted for everyone — its content is gone.
 *
 * Reads are indexed (`messageVisibility.by_user`, ordered newest-first) and
 * paginated, so the section never scans the whole message history and never
 * duplicates a subscription the dashboard already has.
 */

/** Hard cap on rows returned per page, whatever the client asks for. */
const MAX_PAGE_ITEMS = 50;
/**
 * Rows examined per request to fill one page. The filters below (search, other
 * people's hides, messages deleted for everyone, entries past the seven-day
 * retention window) can drop rows from the window, so the window is a few times
 * the requested page size — and it is a SINGLE paginated read, because Convex
 * allows exactly one `paginate` call per function execution ("This query or
 * mutation function ran multiple paginated queries").
 */
const SCAN_MULTIPLIER = 4;
/** Hard cap on rows examined by one request, whatever the client asks for. */
const MAX_SCAN_ROWS = 200;
/** Attachment previews returned per retained message. */
const MAX_ATTACHMENTS = 6;
/**
 * "Delete All Deleted Messages": entries permanently purged by ONE call. Each
 * purge removes a message plus its attachment/reaction/visibility rows, so the
 * batch stays small enough for a single well-bounded transaction; the admin can
 * run it again until nothing is left.
 */
const PURGE_ALL_BATCH = 10;
/** Newest markers examined by one bulk purge (indexed read). */
const PURGE_ALL_WINDOW = 60;

export type RetainedAttachment = {
  name: string;
  contentType: string;
  isImage: boolean;
  url: string | null;
};

export type RetainedDeletedMessage = {
  /** Identifies the row to purge — the message itself is identified by `messageId`. */
  visibilityId: Id<"messageVisibility">;
  messageId: string;
  kind: "channel" | "dm";
  conversationType: "channel" | "direct" | "group";
  conversationName: string;
  communityName: string | null;
  /** The retained message text ("" when the message only carried files). */
  body: string;
  preview: string;
  gifUrl: string | null;
  attachments: RetainedAttachment[];
  senderId: Id<"users">;
  senderName: string;
  /** When the message was originally sent. */
  sentAt: number;
  /** When the current user hid it with "Delete for me". */
  hiddenAt: number;
  /**
   * When this entry disappears from the panel on its own: exactly seven days
   * after `hiddenAt`. Enforced server-side (see `isDeletedForMeExpired`) and by
   * the scheduled sweep — never by the client.
   */
  expiresAt: number;
  /** True when the viewer wrote the message themselves. */
  senderIsMe: boolean;
};

/** Display-name lookups resolved once per request (never twice for one user). */
type NameCache = Map<string, string>;

async function nameOf(ctx: QueryCtx, cache: NameCache, userId: Id<"users">): Promise<string> {
  const key = userId as string;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const name = await displayNameOf(ctx, userId);
  cache.set(key, name);
  return name;
}

async function summarizeAttachment(ctx: QueryCtx, file: Doc<"attachments">): Promise<RetainedAttachment> {
  return {
    name: file.name,
    contentType: file.contentType,
    isImage: file.contentType.startsWith("image/"),
    url: await ctx.storage.getUrl(file.storageId),
  };
}

async function channelAttachments(ctx: QueryCtx, messageId: Id<"messages">): Promise<RetainedAttachment[]> {
  const files = await ctx.db
    .query("attachments")
    .withIndex("by_message", (q) => q.eq("messageId", messageId))
    .take(MAX_ATTACHMENTS);
  return Promise.all(files.map((f) => summarizeAttachment(ctx, f)));
}

async function dmAttachments(ctx: QueryCtx, messageId: Id<"dmMessages">): Promise<RetainedAttachment[]> {
  const files = await ctx.db
    .query("attachments")
    .withIndex("by_dm_message", (q) => q.eq("dmMessageId", messageId))
    .take(MAX_ATTACHMENTS);
  return Promise.all(files.map((f) => summarizeAttachment(ctx, f)));
}

/**
 * Turn one visibility row into a panel entry, or `null` when it is not
 * something the requested list may show (not hidden by me, message gone,
 * deleted for everyone, already filtered out by the search term).
 *
 * `ownSenderOnly` is the difference between the two admin lists:
 *   - "My Deleted Messages" — only messages I wrote and hid,
 *   - the moderation list — any message I hid (an administrator may moderate
 *     another member's message without first unhiding it).
 */
async function describeHiddenMessage(
  ctx: QueryCtx,
  viewerId: Id<"users">,
  vis: Doc<"messageVisibility">,
  term: string,
  names: NameCache,
  ownSenderOnly: boolean,
  now: number,
): Promise<RetainedDeletedMessage | null> {
  const channelMessageId = ctx.db.normalizeId("messages", vis.messageId);
  const dmMessageId = channelMessageId ? null : ctx.db.normalizeId("dmMessages", vis.messageId);
  if (!channelMessageId && !dmMessageId) return null;

  if (channelMessageId) {
    const message = await ctx.db.get(channelMessageId);
    if (!message) return null;
    const attachments = await channelAttachments(ctx, channelMessageId);
    if (
      !isRetainedHiddenMessage({
        viewerId,
        hiddenByUserId: vis.userId,
        messageExists: true,
        messageSenderId: message.userId,
        deletedForEveryone: message.deletedForEveryone,
        body: message.body,
        attachmentCount: attachments.length,
        hasGif: Boolean(message.gif),
        requireOwnSender: ownSenderOnly,
        hiddenAt: vis.hiddenAt,
        entryExpiredAt: vis.entryExpiredAt,
        now,
      })
    ) {
      return null;
    }
    const channel = await ctx.db.get(message.channelId);
    const server = channel ? await ctx.db.get(channel.serverId) : null;
    const conversationName = channel ? `#${channel.name}` : "Removed channel";
    if (
      !matchesDeletedMessageSearch(
        { body: message.body, conversationName, attachmentNames: attachments.map((a) => a.name) },
        term,
      )
    ) {
      return null;
    }
    return {
      visibilityId: vis._id,
      messageId: vis.messageId,
      kind: "channel",
      conversationType: "channel",
      conversationName,
      communityName: server?.name ?? null,
      body: message.body,
      preview: deletedMessagePreview({
        body: message.body,
        attachmentNames: attachments.map((a) => a.name),
        hasGif: Boolean(message.gif),
      }),
      gifUrl: message.gif?.url ?? null,
      attachments,
      senderId: message.userId,
      senderName: await nameOf(ctx, names, message.userId),
      sentAt: message._creationTime,
      hiddenAt: vis.hiddenAt,
      expiresAt: deletedForMeExpiresAt(vis.hiddenAt),
      senderIsMe: message.userId === viewerId,
    };
  }

  const message = await ctx.db.get(dmMessageId!);
  if (!message) return null;
  const attachments = await dmAttachments(ctx, dmMessageId!);
  if (
    !isRetainedHiddenMessage({
      viewerId,
      hiddenByUserId: vis.userId,
      messageExists: true,
      messageSenderId: message.userId,
      deletedForEveryone: message.deletedForEveryone,
      body: message.body,
      attachmentCount: attachments.length,
      hasGif: Boolean(message.gif),
      requireOwnSender: ownSenderOnly,
      hiddenAt: vis.hiddenAt,
      entryExpiredAt: vis.entryExpiredAt,
      now,
    })
  ) {
    return null;
  }
  const conversation = await ctx.db.get(message.conversationId);
  const isGroup = conversation?.type === "group";
  let conversationName = isGroup ? "Group chat" : "Direct message";
  if (conversation?.name?.trim()) {
    conversationName = conversation.name.trim();
  } else if (conversation && !isGroup) {
    // A 1:1 conversation has no name; show the other member's display name.
    const members = await ctx.db
      .query("dmMembers")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversation._id))
      .collect();
    const other = members.find((m) => m.userId !== viewerId);
    if (other) conversationName = await nameOf(ctx, names, other.userId);
  }
  if (
    !matchesDeletedMessageSearch(
      { body: message.body, conversationName, attachmentNames: attachments.map((a) => a.name) },
      term,
    )
  ) {
    return null;
  }
  return {
    visibilityId: vis._id,
    messageId: vis.messageId,
    kind: "dm",
    conversationType: isGroup ? "group" : "direct",
    conversationName,
    communityName: null,
    body: message.body,
    preview: deletedMessagePreview({
      body: message.body,
      attachmentNames: attachments.map((a) => a.name),
      hasGif: Boolean(message.gif),
    }),
    gifUrl: message.gif?.url ?? null,
    attachments,
    senderId: message.userId,
    senderName: await nameOf(ctx, names, message.userId),
    sentAt: message._creationTime,
    hiddenAt: vis.hiddenAt,
    expiresAt: deletedForMeExpiresAt(vis.hiddenAt),
    senderIsMe: message.userId === viewerId,
  };
}

/**
 * The shared indexed, paginated read behind both admin lists: newest local hide
 * first, filtered per row, bounded to one scan window so a search can never walk
 * the whole visibility table.
 *
 * CONVEX RULE: at most ONE paginated query may run per function execution. This
 * used to loop over several `paginate` calls (to keep filling a page while rows
 * were filtered out), which made the query throw
 * "This query or mutation function ran multiple paginated queries" — the whole
 * Admin Panel then failed, because the client rethrows a failed paginated query.
 * A single, slightly larger scan window gives the same bounded behaviour: rows
 * the filters reject are skipped, and `continueCursor` still points past
 * everything this call examined, so no row is ever skipped or duplicated.
 */
async function paginateHidden(
  ctx: QueryCtx,
  viewerId: Id<"users">,
  ownSenderOnly: boolean,
  paginationOpts: { numItems: number; cursor: string | null },
  search: string | undefined,
) {
  const term = search ?? "";
  const pageSize = Math.min(Math.max(paginationOpts.numItems, 1), MAX_PAGE_ITEMS);
  const scanSize = Math.min(pageSize * SCAN_MULTIPLIER, MAX_SCAN_ROWS);
  const names: NameCache = new Map();
  // ONE instant for the whole page, so every row's seven-day window is judged
  // against the same clock. Expiry is decided here, on the server, from each
  // marker's own `hiddenAt`: an entry disappears at exactly seven days even if
  // the maintenance sweep has not run yet, and re-opening the tab can never
  // extend or restart the window.
  const now = Date.now();

  const result = await ctx.db
    .query("messageVisibility")
    .withIndex("by_user", (q) => q.eq("userId", viewerId))
    .order("desc")
    .paginate({ cursor: paginationOpts.cursor, numItems: scanSize });

  const items: RetainedDeletedMessage[] = [];
  for (const vis of result.page) {
    const item = await describeHiddenMessage(ctx, viewerId, vis, term, names, ownSenderOnly, now);
    if (item) items.push(item);
  }

  return { page: items, continueCursor: result.continueCursor, isDone: result.isDone };
}

/**
 * My own messages that I deleted for myself and whose content is still
 * retained — newest local delete first. Requires Admin Panel access; throws for
 * everyone else (never returns another user's messages).
 */
export const listMineDeletedMessages = query({
  args: {
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
  },
  handler: async (ctx, { paginationOpts, search }) => {
    const viewerId = await currentUserId(ctx);
    await requirePanelAccess(ctx, viewerId);
    return await paginateHidden(ctx, viewerId, true, paginationOpts, search);
  },
});

/**
 * Every retained message I hid with "Delete for me", whatever its sender — the
 * moderation view. Admin-only, indexed and paginated exactly like the list
 * above, and read-only: nothing is deleted simply by looking at it.
 *
 * The global delete for one of these rows is `deletion.deleteHiddenForEveryone`,
 * which re-verifies the administrator role and this same visibility row on the
 * server.
 */
export const listMineHiddenMessages = query({
  args: {
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
  },
  handler: async (ctx, { paginationOpts, search }) => {
    const viewerId = await currentUserId(ctx);
    await requirePanelAccess(ctx, viewerId);
    return await paginateHidden(ctx, viewerId, false, paginationOpts, search);
  },
});

/**
 * Permanently remove ONE of my own retained messages COMPLETELY — the message
 * row itself, its attachment records and any file no other message still
 * references — so it is gone for every participant, not replaced by a
 * placeholder.
 *
 * Server-enforced: panel access, the visibility row must be mine, and the
 * message must actually be mine. A message that was deleted for everyone is
 * refused — its content is already gone, and removing the tombstone other
 * members still see would change their history for no reason.
 */
export const permanentlyDeleteMine = mutation({
  args: { visibilityId: v.id("messageVisibility") },
  handler: async (ctx, { visibilityId }) => {
    const viewerId = await currentUserId(ctx);
    await requirePanelAccess(ctx, viewerId);

    const vis = await ctx.db.get(visibilityId);
    if (!vis) throw new ConvexError("That deleted message is no longer listed.");
    if (vis.userId !== viewerId) {
      throw new ConvexError("You can only permanently delete messages you deleted for yourself.");
    }

    const channelMessageId = ctx.db.normalizeId("messages", vis.messageId);
    const dmMessageId = channelMessageId ? null : ctx.db.normalizeId("dmMessages", vis.messageId);
    if (!channelMessageId && !dmMessageId) {
      // Legacy marker pointing at a row that cannot exist any more: nothing to
      // purge, so only the stale marker is removed.
      await ctx.db.delete(vis._id);
      return { deleted: false, alreadyGone: true };
    }

    if (channelMessageId) {
      const message = await ctx.db.get(channelMessageId);
      if (!message) {
        await ctx.db.delete(vis._id);
        return { deleted: false, alreadyGone: true };
      }
      if (message.userId !== viewerId) {
        throw new ConvexError("You can only permanently delete your own messages.");
      }
      if (message.deletedForEveryone) {
        throw new ConvexError(
          "This message was already deleted for everyone — its content is gone, so there is nothing to remove.",
        );
      }
      const channel = await ctx.db.get(message.channelId);
      const label = channel ? `#${channel.name}` : "a removed channel";
      await deleteChannelMessage(ctx, message);
      await recordPermanentDelete(ctx, viewerId, vis, label, "message");
      return { deleted: true, alreadyGone: false };
    }

    const message = await ctx.db.get(dmMessageId!);
    if (!message) {
      await ctx.db.delete(vis._id);
      return { deleted: false, alreadyGone: true };
    }
    if (message.userId !== viewerId) {
      throw new ConvexError("You can only permanently delete your own messages.");
    }
    if (message.deletedForEveryone) {
      throw new ConvexError(
        "This message was already deleted for everyone — its content is gone, so there is nothing to remove.",
      );
    }
    const conversation = await ctx.db.get(message.conversationId);
    const label = conversation?.name?.trim() || (conversation?.type === "group" ? "a group chat" : "a direct message");
    await deleteDmMessage(ctx, message);
    await recordPermanentDelete(ctx, viewerId, vis, label, "dmMessage");
    return { deleted: true, alreadyGone: false };
  },
});

/**
 * The facts the shared eligibility rule needs about one of MY markers, read with
 * indexed point lookups only (no scans). Used by the bulk purges, which must
 * decide "is this still listed and may I remove it?" before touching a message —
 * the same rule the list itself uses, so the two can never disagree.
 *
 * `ownSenderOnly` is the difference between the two tabs, exactly as in the
 * lists: "My Deleted Messages" only purges messages I wrote, the moderation list
 * purges any retained message I hid.
 */
async function loadRetainedTarget(
  ctx: MutationCtx,
  viewerId: Id<"users">,
  vis: Doc<"messageVisibility">,
  now: number,
  ownSenderOnly: boolean,
): Promise<{ kind: "channel"; message: Doc<"messages"> } | { kind: "dm"; message: Doc<"dmMessages"> } | null> {
  const channelMessageId = ctx.db.normalizeId("messages", vis.messageId);
  const dmMessageId = channelMessageId ? null : ctx.db.normalizeId("dmMessages", vis.messageId);
  if (!channelMessageId && !dmMessageId) return null;

  if (channelMessageId) {
    const message = await ctx.db.get(channelMessageId);
    if (!message) return null;
    const attachment = await ctx.db
      .query("attachments")
      .withIndex("by_message", (q) => q.eq("messageId", channelMessageId))
      .take(1);
    const eligible = isRetainedHiddenMessage({
      viewerId,
      hiddenByUserId: vis.userId,
      messageExists: true,
      messageSenderId: message.userId,
      deletedForEveryone: message.deletedForEveryone,
      body: message.body,
      attachmentCount: attachment.length,
      hasGif: Boolean(message.gif),
      hiddenAt: vis.hiddenAt,
      entryExpiredAt: vis.entryExpiredAt,
      requireOwnSender: ownSenderOnly,
      now,
    });
    return eligible ? { kind: "channel", message } : null;
  }

  const message = await ctx.db.get(dmMessageId!);
  if (!message) return null;
  const attachment = await ctx.db
    .query("attachments")
    .withIndex("by_dm_message", (q) => q.eq("dmMessageId", dmMessageId!))
    .take(1);
  const eligible = isRetainedHiddenMessage({
    viewerId,
    hiddenByUserId: vis.userId,
    messageExists: true,
    messageSenderId: message.userId,
    deletedForEveryone: message.deletedForEveryone,
    body: message.body,
    attachmentCount: attachment.length,
    hasGif: Boolean(message.gif),
    hiddenAt: vis.hiddenAt,
    entryExpiredAt: vis.entryExpiredAt,
    requireOwnSender: ownSenderOnly,
    now,
  });
  return eligible ? { kind: "dm", message } : null;
}

/**
 * Permanently delete up to one bounded batch of the caller's retained entries,
 * newest first, newest marker window only.
 *
 * A COMPLETE delete: the message row goes with the purge — for every
 * participant — along with its attachment records (and any file no other message
 * still references), its reactions and every visibility marker pointing at it.
 * That is what "delete from the Admin Panel" means here: the message is removed,
 * not replaced with a "this message was deleted" placeholder.
 *
 * Bounded by design: it examines at most `PURGE_ALL_WINDOW` indexed markers and
 * removes at most `PURGE_ALL_BATCH` of them per call, reporting what is left so
 * the caller can run it again. Never an unbounded transaction.
 */
async function purgeRetainedBatch(
  ctx: MutationCtx,
  viewerId: Id<"users">,
  ownSenderOnly: boolean,
  audit: { action: string; detail: (deleted: number) => string },
): Promise<{ deleted: number; remaining: number; hasMore: boolean }> {
  const markers = await ctx.db
    .query("messageVisibility")
    .withIndex("by_user", (q) => q.eq("userId", viewerId))
    .order("desc")
    .take(PURGE_ALL_WINDOW);

  const now = Date.now();
  let deleted = 0;
  let remaining = 0;
  for (const vis of markers) {
    const target = await loadRetainedTarget(ctx, viewerId, vis, now, ownSenderOnly);
    if (!target) continue; // expired, already gone, deleted for everyone, or not listable here
    if (deleted >= PURGE_ALL_BATCH) {
      remaining++;
      continue;
    }
    if (target.kind === "channel") await deleteChannelMessage(ctx, target.message);
    else await deleteDmMessage(ctx, target.message);
    deleted++;
  }

  if (deleted > 0) {
    const name = await displayNameOf(ctx, viewerId);
    await auditAdmin(ctx, {
      action: audit.action,
      actorId: viewerId,
      actorName: name,
      targetType: "user",
      targetId: viewerId,
      targetName: name,
      detail: audit.detail(deleted),
    });
  }

  return {
    deleted,
    remaining,
    // The window was full, so there may be more entries beyond it.
    hasMore: markers.length === PURGE_ALL_WINDOW,
  };
}

/**
 * "Delete All Deleted Messages" — the immediate, manual cleanup of the list.
 *
 * Permanently removes up to `PURGE_ALL_BATCH` of MY OWN retained entries in one
 * bounded transaction (newest first), applies exactly the same eligibility rule
 * as the list, and never touches anyone else's markers or messages. When more
 * entries remain, the caller is told how many so the UI can offer it again.
 *
 * Entries whose seven-day window has closed are not part of the list any more
 * and are left alone here — they are handled by the scheduled sweep, which keeps
 * this action O(batch) whatever the size of the history.
 */
export const permanentlyDeleteAllMine = mutation({
  args: {},
  handler: async (ctx) => {
    const viewerId = await currentUserId(ctx);
    await requirePanelAccess(ctx, viewerId);
    return await purgeRetainedBatch(ctx, viewerId, true, {
      action: "message.delete_permanent_all",
      detail: (deleted) =>
        `Permanently deleted ${deleted} of their own retained "delete for me" message${deleted === 1 ? "" : "s"} (deleted completely, for everyone)`,
    });
  },
});

/**
 * The moderation list's bulk action: permanently delete every retained message
 * the administrator hid themselves, whoever wrote it.
 *
 * Same bounds, same eligibility rule and same complete deletion as
 * `permanentlyDeleteAllMine`; it only relaxes the own-sender requirement, which
 * is exactly what "Hidden Messages" lists. It can never reach a message the
 * caller had not already hidden (every row it reads is their own marker).
 */
export const permanentlyDeleteAllHidden = mutation({
  args: {},
  handler: async (ctx) => {
    const viewerId = await currentUserId(ctx);
    await requirePanelAccess(ctx, viewerId);
    return await purgeRetainedBatch(ctx, viewerId, false, {
      action: "message.delete_permanent_all_hidden",
      detail: (deleted) =>
        `Permanently deleted ${deleted} hidden message${deleted === 1 ? "" : "s"} they had hidden (deleted completely, for everyone)`,
    });
  },
});

/** Audit entry for a permanent purge (auditLogs + the legacy moderation feed). */
async function recordPermanentDelete(
  ctx: MutationCtx,
  viewerId: Id<"users">,
  vis: Doc<"messageVisibility">,
  label: string,
  targetType: "message" | "dmMessage",
) {
  await auditAdmin(ctx, {
    action: "message.delete_permanent",
    actorId: viewerId,
    actorName: await displayNameOf(ctx, viewerId),
    targetType,
    targetId: vis.messageId,
    targetName: label,
    detail: `Permanently deleted a message they had deleted for themselves in ${label}`,
  });
}
