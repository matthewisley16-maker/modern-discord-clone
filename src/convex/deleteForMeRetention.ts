import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { DELETED_FOR_ME_TTL_MS, isDeletedForMeExpired } from "./../lib/deleted-messages";

/**
 * ---------------------------------------------------------------------------
 * Seven-day expiry of "Delete for me" retention entries
 * ---------------------------------------------------------------------------
 * `deletion.deleteForMe` / `deleteDmForMe` insert ONE `messageVisibility` row per
 * user and leave the message itself alone. That marker does two jobs:
 *
 *   1. it keeps the message hidden from the user who deleted it (permanent), and
 *   2. it makes the message listable in Admin Panel → My Deleted Messages.
 *
 * Only (2) is temporary. Seven days after `hiddenAt` the entry is gone from the
 * panel; the hide stays, the message row, its body, its GIF and its attachments
 * stay, and every other participant keeps their copy untouched.
 *
 * TWO LAYERS, ON PURPOSE
 * ----------------------
 *   - The server QUERY already refuses to list an entry whose window has closed
 *     (`isDeletedForMeExpired`, applied inside `adminMessages`). That makes the
 *     behaviour exact — to the millisecond, with no dependence on this job ever
 *     running — and it is server-side, not front-end filtering.
 *   - This SWEEP records the expiry durably (`messageVisibility.entryExpiredAt`)
 *     and runs on a schedule, so entries are cleaned up by the backend itself,
 *     with no user action and no request-time cost.
 *
 * COST AND SAFETY
 *   - Indexed range read (`by_hidden_at`), oldest first, so it reads ONLY markers
 *     whose seven-day window has already closed. It never scans the visibility
 *     table and never looks at messages, attachments or storage.
 *   - Bounded: at most `MAX_SWEEP_BATCH` rows per run, one run per cron tick (see
 *     crons.ts — hours apart, deliberately not a poller).
 *   - Progressive: `retentionState.cursorHiddenAt` remembers how far the sweep has
 *     already expired, so every run moves forward over new rows instead of
 *     re-reading the same expired prefix forever.
 *   - Idempotent and retry-safe: an already-marked row is skipped, re-running a
 *     partial batch changes nothing, and both the read and the writes are
 *     transactional, so a retry can never double-apply.
 *   - Isolated: this job touches only `messageVisibility`/`retentionState`. It
 *     cannot break the Admin Panel, normal chat reads (which never look at
 *     `entryExpiredAt`) or other users' data.
 */

/** Progress of the sweep, so it never re-reads the rows it already expired. */
const STATE_KEY = "deleteForMeRetention";
/** Rows marked per scheduled run. */
const SWEEP_BATCH = 200;
/** Hard cap on rows per run, whatever a caller asks for. */
const MAX_SWEEP_BATCH = 400;

/**
 * Mark up to one bounded batch of closed retention windows as expired.
 *
 * Runs from `crons.ts` a few times a day. It is safe to run at any time: nothing
 * here deletes a message, a hide or an attachment, it only records that a
 * retention entry is over.
 */
export const expireRetainedEntries = internalMutation({
  args: {
    /** Rows to process this run (bounded). */
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const cutoff = now - DELETED_FOR_ME_TTL_MS;
    const limit = Math.min(MAX_SWEEP_BATCH, Math.max(1, Math.floor(args.batchSize ?? SWEEP_BATCH)));

    const state = await ctx.db
      .query("retentionState")
      .withIndex("by_key", (q) => q.eq("key", STATE_KEY))
      .unique();
    const cursor = state?.cursorHiddenAt ?? 0;

    // One indexed window, strictly bounded: `hiddenAt` greater than the cursor
    // (not processed yet) AND older than the cutoff (window already closed).
    const rows = await ctx.db
      .query("messageVisibility")
      .withIndex("by_hidden_at", (q) => q.gt("hiddenAt", cursor).lt("hiddenAt", cutoff))
      .order("asc")
      .take(limit);

    if (rows.length === 0) {
      return { examined: 0, expired: 0, hasMore: false, cursorHiddenAt: cursor };
    }

    let expired = 0;
    for (const row of rows) {
      if (row.entryExpiredAt !== undefined) continue; // already recorded
      // Defence in depth: the same predicate the list uses decides here too.
      if (!isDeletedForMeExpired(row.hiddenAt, now)) continue;
      await ctx.db.patch(row._id, { entryExpiredAt: now });
      expired++;
    }

    // Move the cursor past everything examined. Rows sharing this exact
    // millisecond may be skipped by the next run; that is harmless, because
    // `hiddenAt` — not this mark — is what removes an entry from the panel, so
    // those rows are already out of the list.
    const nextCursor = rows[rows.length - 1].hiddenAt;
    if (state) await ctx.db.patch(state._id, { cursorHiddenAt: nextCursor, updatedAt: now });
    else await ctx.db.insert("retentionState", { key: STATE_KEY, cursorHiddenAt: nextCursor, updatedAt: now });

    return {
      examined: rows.length,
      expired,
      // A full batch means there may be more closed windows behind it; the next
      // scheduled run continues from the cursor.
      hasMore: rows.length === limit,
      cursorHiddenAt: nextCursor,
    };
  },
});
