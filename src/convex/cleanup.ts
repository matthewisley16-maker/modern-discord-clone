import { ConvexError, v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  auditAdmin,
  currentUserId,
  displayNameOf,
  isOwnerRole,
  rankOf,
  requirePanelAccess,
  ROLE_RANK,
} from "./lib";
import { deleteChannelMessage, deleteDmMessage } from "./storage";
import {
  CLEANUP_BATCHES_PER_RUN,
  CLEANUP_BATCH_SIZE,
  CLEANUP_HISTORY_LIMIT,
  CLEANUP_SCAN_CAP,
  GENERAL_CATEGORIES,
  ORPHAN_FILE_GRACE_MS,
  PREVIEW_SCAN_LIMIT,
  PREVIEW_TARGET_LIMIT,
  RATE_LIMIT_GRACE_MS,
  STALE_EPHEMERAL_MS,
  TERMINAL_CALL_GRACE_MS,
  categoryById,
  isSiteWide,
  jobResultLabel,
  localTimeZone,
  phraseMatches,
  rangeCovers,
  rangeLabel,
  rangeProblem,
  requiredPhrase,
  sanitizeCategoryIds,
  scopeLabel,
  scopeProblem,
  timeZoneLabel,
  type CleanupScope,
  type CleanupScopeKind,
  type MessageRange,
  type RangeRequest,
} from "../lib/cleanup";

/**
 * ---------------------------------------------------------------------------
 * Admin Panel → Cleanup & Maintenance
 * ---------------------------------------------------------------------------
 * Two administrator-only tools, integrated with the rest of Freecord:
 *
 *   1. Message Cleanup — delete messages by WHEN they were sent
 *      (`_creationTime`, the real send time), optionally limited to one
 *      community, channel or direct conversation.
 *   2. General System Cleanup — remove data the application regenerates or that
 *      nothing references any more, in the fixed categories defined in
 *      `src/lib/cleanup.ts` and implemented at the bottom of this file.
 *
 * HOW IT STAYS SAFE
 * -----------------
 *  - **Authorization on every call, and again on every batch.** Every public
 *    function starts with `requireActor`, which resolves the signed-in account
 *    and requires an administrator role through `requirePanelAccess` — the same
 *    server gate the rest of the panel uses. A running job re-checks its actor
 *    before each batch, so revoking an administrator stops their cleanup.
 *  - **Site-wide deletion needs Owner Admin** *and* a typed confirmation phrase
 *    (`DELETE ALL MESSAGES`), verified server-side — a client cannot skip it.
 *  - **Previews never write.** The previews are read-only queries behind
 *    actions; the server re-validates the scope and range it was given.
 *  - **Attachments follow their message.** Deletion goes through the app's own
 *    `deleteChannelMessage` / `deleteDmMessage`, which remove a stored file ONLY
 *    when no other attachment row still references it, and also clear reactions
 *    and "delete for me" markers.
 *  - **Batched and resumable.** A job works in bounded batches, re-schedules
 *    itself, records progress (which the panel subscribes to), and can be
 *    cancelled between batches. A time window in the middle of a long history is
 *    reached through an INDEXED range scan, so nothing is read just to skip it.
 *  - **One job at a time.** A second cleanup refuses to start while one runs; a
 *    job that stopped reporting progress is recovered as failed.
 *  - **Audited.** Start, completion, cancellation and failure are written to the
 *    audit log with the scope, the range *including the time zone*, the counts
 *    and the outcome. No credential is ever read by this module, so none can
 *    reach a log.
 *
 * WHAT IT DELIBERATELY NEVER DOES
 * -------------------------------
 * No category can delete a user account, a community, a channel, a membership, a
 * role, a profile, a group, a live session, an attachment a message still
 * references, or an audit record. Audit history — including these jobs — is out
 * of scope and survives the messages it removed.
 */

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

type Actor = { userId: Id<"users">; name: string; role: string; isOwner: boolean };

/** The signed-in administrator, resolved server-side (never trusted from a client). */
async function requireActor(ctx: QueryCtx | MutationCtx): Promise<Actor> {
  const userId = await currentUserId(ctx);
  const role = await requirePanelAccess(ctx, userId);
  return { userId, name: await displayNameOf(ctx, userId), role, isOwner: isOwnerRole(role) };
}

/** Internal: the same check, for the actions that cannot read the database directly. */
export const actor = internalQuery({
  args: {},
  handler: async (ctx): Promise<Actor> => await requireActor(ctx),
});

/** Internal: is this account still an administrator? (re-checked on every batch) */
export const authz = internalQuery({
  args: { actorId: v.id("users") },
  handler: async (ctx, { actorId }) => {
    const user = await ctx.db.get(actorId);
    const role = user?.role ?? "user";
    return { role, isAdmin: rankOf(role) >= ROLE_RANK.admin, isOwner: isOwnerRole(role) };
  },
});

function categoryAllowedFor(actor: Actor, categoryId: string): boolean {
  const category = categoryById(categoryId);
  if (!category) return false;
  return category.minRole === "owner" ? actor.isOwner : rankOf(actor.role) >= ROLE_RANK.admin;
}

// ---------------------------------------------------------------------------
// Scope resolution — labels always come from the database, never from a request
// ---------------------------------------------------------------------------

type Targets = { channels: Array<Id<"channels">>; conversations: Array<Id<"dmConversations">> };

async function channelIdsOfServer(ctx: QueryCtx | MutationCtx, serverId: Id<"servers">): Promise<Array<Id<"channels">>> {
  const channels = await ctx.db
    .query("channels")
    .withIndex("by_server", (q) => q.eq("serverId", serverId))
    .take(PREVIEW_TARGET_LIMIT);
  return channels.map((channel) => channel._id);
}

/**
 * The channels and conversations a job must walk, minus the ones it has already
 * finished. Enumeration always comes from the database, and `doneScopes` is what
 * lets a big job resume across batches without ever skipping a target.
 */
async function scopeTargets(
  ctx: QueryCtx | MutationCtx,
  scopeKind: CleanupScopeKind,
  scopeId: string | undefined,
  done: readonly string[],
): Promise<Targets & { truncated: boolean }> {
  const doneSet = new Set(done);

  if (scopeKind === "channel" && scopeId) {
    return { channels: [scopeId as Id<"channels">], conversations: [], truncated: false };
  }
  if (scopeKind === "conversation" && scopeId) {
    return { channels: [], conversations: [scopeId as Id<"dmConversations">], truncated: false };
  }

  let truncated = false;
  const channelIds: Array<Id<"channels">> = [];
  if (scopeKind === "community" && scopeId) {
    channelIds.push(...(await channelIdsOfServer(ctx, scopeId as Id<"servers">)));
  } else {
    const servers = await ctx.db.query("servers").take(PREVIEW_TARGET_LIMIT);
    if (servers.length === PREVIEW_TARGET_LIMIT) truncated = true;
    for (const server of servers) channelIds.push(...(await channelIdsOfServer(ctx, server._id)));
  }

  const conversations = await ctx.db.query("dmConversations").take(PREVIEW_TARGET_LIMIT);
  if (conversations.length === PREVIEW_TARGET_LIMIT) truncated = true;

  return {
    channels: channelIds.filter((id) => !doneSet.has(id as string)),
    conversations: conversations.map((c) => c._id).filter((id) => !doneSet.has(id as string)),
    truncated,
  };
}

/** The human label for a scope, read from the real row it points at. */
async function resolveScope(
  ctx: QueryCtx | MutationCtx,
  request: { kind: CleanupScopeKind; id?: string },
): Promise<CleanupScope> {
  const problem = scopeProblem(request);
  if (problem) throw new ConvexError(problem);
  if (request.kind === "all") return { kind: "all" };
  const id = request.id!;

  if (request.kind === "community") {
    const server = await ctx.db.get(id as Id<"servers">);
    if (!server) throw new ConvexError("That community no longer exists. Refresh the list and try again.");
    return { kind: "community", id, label: server.name };
  }
  if (request.kind === "channel") {
    const channel = await ctx.db.get(id as Id<"channels">);
    if (!channel) throw new ConvexError("That channel no longer exists. Refresh the list and try again.");
    const server = await ctx.db.get(channel.serverId);
    return { kind: "channel", id, label: `${server?.name ?? "Community"} · #${channel.name}` };
  }

  const conversation = await ctx.db.get(id as Id<"dmConversations">);
  if (!conversation) throw new ConvexError("That conversation no longer exists. Refresh the list and try again.");
  if (conversation.name) return { kind: "conversation", id, label: conversation.name };
  // A direct conversation is named after its participants — never by email.
  const members = await ctx.db
    .query("dmMembers")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversation._id))
    .take(3);
  const names: string[] = [];
  for (const member of members) {
    const user = await ctx.db.get(member.userId);
    if (user) names.push(user.name || (user.username ? `@${user.username}` : "Member"));
  }
  return { kind: "conversation", id, label: names.join(" ↔ ") || "Direct conversation" };
}

/** The stored range: exactly what was confirmed, rebuilt from the job row only. */
function storedRangeOf(job: Doc<"cleanupJobs">): MessageRange {
  if (job.kind !== "messages") return { kind: "all" };
  if (job.to === undefined) return { kind: "all" };
  if (job.from === undefined) return { kind: "before", before: job.to };
  return { kind: "between", from: job.from, to: job.to };
}

/**
 * A request's date/time selection → the validated range it describes.
 *
 * The wire shape deliberately differs from the validated one (`rangeKind` vs
 * `kind`) so a client cannot smuggle a scope object in where a range belongs: the
 * range is rebuilt from its three own fields, and every value is checked here
 * before anything is counted or deleted.
 */
function buildRange(request: {
  rangeKind: string;
  before?: number;
  from?: number;
  to?: number;
}): MessageRange {
  const raw: RangeRequest =
    request.rangeKind === "before"
      ? { kind: "before", before: request.before as number }
      : request.rangeKind === "between"
        ? { kind: "between", from: request.from as number, to: request.to as number }
        : { kind: "all" };
  const problem = rangeProblem(raw);
  if (problem) throw new ConvexError(problem);
  return raw;
}

// ---------------------------------------------------------------------------
// Message selection — indexed, time-bounded, exact
// ---------------------------------------------------------------------------

/**
 * One bounded page of a channel's messages inside the range, in SEND-TIME order.
 *
 * Every index implicitly ends with `_creationTime`, so `by_channel` yields one
 * channel's messages oldest-first and the database applies the range bounds: a
 * window in the middle of a long history is reached directly instead of reading
 * (and skipping) everything before it. `exhausted` means the page came back
 * short — nothing else is in range.
 */
async function pageChannelMessages(
  ctx: QueryCtx | MutationCtx,
  channelId: Id<"channels">,
  range: MessageRange,
  scan: number,
  after?: number,
): Promise<{ rows: Array<Doc<"messages">>; exhausted: boolean }> {
  // One branch per range kind: each builds a single, fully-typed index range so
  // the bound is applied by the DATABASE rather than by filtering rows in JS.
  const rows =
    range.kind === "before"
      ? await ctx.db
          .query("messages")
          .withIndex("by_channel", (q) => q.eq("channelId", channelId).lt("_creationTime", range.before))
          .take(scan)
      : range.kind === "between"
        ? await ctx.db
            .query("messages")
            .withIndex("by_channel", (q) =>
              q.eq("channelId", channelId).gte("_creationTime", range.from).lte("_creationTime", range.to),
            )
            .take(scan)
        : await ctx.db
            .query("messages")
            .withIndex("by_channel", (q) => q.eq("channelId", channelId))
            .take(scan);
  // `after` only walks a READ-ONLY page sequence (a preview); a deletion sweep
  // never needs it, because the rows it deletes leave the index behind them.
  const visible = after === undefined ? rows : rows.filter((row) => row._creationTime > after);
  return { rows: visible, exhausted: rows.length < scan };
}

/** One bounded page of a conversation's direct messages inside the range. */
async function pageDmMessages(
  ctx: QueryCtx | MutationCtx,
  conversationId: Id<"dmConversations">,
  range: MessageRange,
  scan: number,
  after?: number,
): Promise<{ rows: Array<Doc<"dmMessages">>; exhausted: boolean }> {
  const rows =
    range.kind === "before"
      ? await ctx.db
          .query("dmMessages")
          .withIndex("by_conversation", (q) =>
            q.eq("conversationId", conversationId).lt("_creationTime", range.before),
          )
          .take(scan)
      : range.kind === "between"
        ? await ctx.db
            .query("dmMessages")
            .withIndex("by_conversation", (q) =>
              q.eq("conversationId", conversationId).gte("_creationTime", range.from).lte("_creationTime", range.to),
            )
            .take(scan)
        : await ctx.db
            .query("dmMessages")
            .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
            .take(scan);
  const visible = after === undefined ? rows : rows.filter((row) => row._creationTime > after);
  return { rows: visible, exhausted: rows.length < scan };
}

type MessageCounts = {
  channelMessages: number;
  dmMessages: number;
  total: number;
  scanned: number;
  approximate: boolean;
  oldest: number | null;
  newest: number | null;
  targets: number;
};

/**
 * The exact shape a Message Cleanup preview returns. Declared explicitly, and
 * annotated on both the internal query and the action that exposes it, because a
 * handler that reads `internal.cleanup.*` while its own type is still being
 * inferred would otherwise be circular (`api.d.ts` types this module by
 * `typeof import("../cleanup")`).
 */
type MessagePreview = MessageCounts & {
  scopeKind: CleanupScopeKind;
  scopeId: string | null;
  scopeLabel: string;
  rangeLabel: string;
  timeZone: string;
  timeZoneLabel: string;
  siteWide: boolean;
};

/** Per-category figures read by the General Cleanup preview (read-only). */
type CategoryCount = { id: string; records: number; bytes: number; more: boolean; note?: string };

/** The exact shape a General System Cleanup preview returns (see above). */
type GeneralPreview = {
  categories: Array<{
    id: string;
    label: string;
    description: string;
    includes: string[];
    safety: string;
    minRole: string;
    measurable: boolean;
    records: number;
    bytes: number;
    /** True when the bounded scan stopped at a cap, so the figure is a lower bound. */
    atLeast: boolean;
    note: string | null;
  }>;
  alreadyRunning: boolean;
};

/**
 * Count messages in a scope/range WITHOUT changing anything.
 *
 * Read-only, so it pages forward with a time cursor. Bounded by
 * `PREVIEW_SCAN_LIMIT` rows and `PREVIEW_TARGET_LIMIT` targets: when a cap is
 * reached the result is reported as a LOWER BOUND (`approximate: true`) rather
 * than pretending to be exact.
 */
async function countMessages(ctx: QueryCtx, scope: CleanupScope, range: MessageRange): Promise<MessageCounts> {
  const targets = await scopeTargets(ctx, scope.kind, scope.kind === "all" ? undefined : scope.id, []);
  let scanned = 0;
  let channelMessages = 0;
  let dmMessages = 0;
  let oldest: number | null = null;
  let newest: number | null = null;
  let approximate = targets.truncated;
  let targetCount = 0;

  const note = (time: number) => {
    oldest = oldest === null ? time : Math.min(oldest, time);
    newest = newest === null ? time : Math.max(newest, time);
  };

  for (const channelId of targets.channels) {
    if (scanned >= PREVIEW_SCAN_LIMIT) {
      approximate = true;
      break;
    }
    targetCount += 1;
    const seen = new Set<string>();
    let cursor: number | undefined;
    for (;;) {
      const { rows, exhausted } = await pageChannelMessages(ctx, channelId, range, CLEANUP_SCAN_CAP, cursor);
      scanned += rows.length;
      for (const row of rows) {
        if (seen.has(row._id)) continue;
        seen.add(row._id);
        if (!rangeCovers(range, row._creationTime)) continue;
        channelMessages += 1;
        note(row._creationTime);
      }
      if (exhausted || rows.length === 0 || scanned >= PREVIEW_SCAN_LIMIT) break;
      cursor = rows[rows.length - 1]._creationTime;
    }
  }

  for (const conversationId of targets.conversations) {
    if (scanned >= PREVIEW_SCAN_LIMIT) {
      approximate = true;
      break;
    }
    targetCount += 1;
    const seen = new Set<string>();
    let cursor: number | undefined;
    for (;;) {
      const { rows, exhausted } = await pageDmMessages(ctx, conversationId, range, CLEANUP_SCAN_CAP, cursor);
      scanned += rows.length;
      for (const row of rows) {
        if (seen.has(row._id)) continue;
        seen.add(row._id);
        if (!rangeCovers(range, row._creationTime)) continue;
        dmMessages += 1;
        note(row._creationTime);
      }
      if (exhausted || rows.length === 0 || scanned >= PREVIEW_SCAN_LIMIT) break;
      cursor = rows[rows.length - 1]._creationTime;
    }
  }

  if (scanned >= PREVIEW_SCAN_LIMIT) approximate = true;
  return {
    channelMessages,
    dmMessages,
    total: channelMessages + dmMessages,
    scanned,
    approximate,
    oldest,
    newest,
    targets: targetCount,
  };
}

type SweepResult = {
  channelMessages: number;
  dmMessages: number;
  attachments: number;
  bytes: number;
  finished: string[];
  examined: number;
};

/**
 * Delete up to `budget` messages in this job's scope, in indexed time-bounded
 * pages. Every candidate is re-read and re-checked against the range before it
 * is removed, so a message retention already deleted is skipped instead of
 * failing, and nothing outside the range can go.
 */
async function sweepMessages(
  ctx: MutationCtx,
  job: Doc<"cleanupJobs">,
  range: MessageRange,
  budget: number,
): Promise<SweepResult> {
  const targets = await scopeTargets(ctx, job.scopeKind, job.scopeId, job.doneScopes ?? []);
  const result: SweepResult = {
    channelMessages: 0,
    dmMessages: 0,
    attachments: 0,
    bytes: 0,
    finished: [],
    examined: 0,
  };
  let remaining = budget;

  for (const channelId of targets.channels) {
    if (remaining <= 0) break;
    const { rows, exhausted } = await pageChannelMessages(ctx, channelId, range, CLEANUP_SCAN_CAP);
    result.examined += rows.length;
    let drained = exhausted;
    for (const row of rows) {
      if (remaining <= 0) {
        drained = false;
        break;
      }
      const fresh = await ctx.db.get(row._id);
      if (!fresh) continue; // retention removed it first — nothing to do
      if (!rangeCovers(range, fresh._creationTime)) continue;
      const removed = await deleteChannelMessage(ctx, fresh);
      result.channelMessages += 1;
      result.attachments += removed.attachments;
      result.bytes += removed.bytes;
      remaining -= 1;
    }
    if (drained) result.finished.push(channelId as string);
  }

  for (const conversationId of targets.conversations) {
    if (remaining <= 0) break;
    const { rows, exhausted } = await pageDmMessages(ctx, conversationId, range, CLEANUP_SCAN_CAP);
    result.examined += rows.length;
    let drained = exhausted;
    for (const row of rows) {
      if (remaining <= 0) {
        drained = false;
        break;
      }
      const fresh = await ctx.db.get(row._id);
      if (!fresh) continue;
      if (!rangeCovers(range, fresh._creationTime)) continue;
      const removed = await deleteDmMessage(ctx, fresh);
      result.dmMessages += 1;
      result.attachments += removed.attachments;
      result.bytes += removed.bytes;
      remaining -= 1;
    }
    if (drained) result.finished.push(conversationId as string);
  }

  return result;
}

// ---------------------------------------------------------------------------
// General System Cleanup — shared eligibility + the actual removals
// ---------------------------------------------------------------------------

/** Storage ids that a message, profile, group or community still points at. */
async function referencedStorageIds(ctx: QueryCtx | MutationCtx): Promise<Set<string>> {
  const referenced = new Set<string>();
  // The image columns are read in full on purpose: eligibility for deleting a
  // FILE must be exact, so a cap here could orphan a live picture. These four
  // tables are small next to message history (and the orphan sweep already reads
  // whole tables the same way). Message attachments are checked per candidate
  // through the `by_storage` index instead, which is exact and cheap.
  for (const table of ["profiles", "memberProfiles", "dmConversations", "servers"] as const) {
    for (const row of await ctx.db.query(table).collect()) {
      const record = row as unknown as Record<string, unknown>;
      for (const key of ["avatarStorageId", "bannerStorageId", "iconStorageId"]) {
        const value = record[key];
        if (typeof value === "string") referenced.add(value);
      }
    }
  }
  return referenced;
}

type CategoryOutcome = { records: number; bytes: number; more: boolean };

/**
 * Run ONE category, deleting what is eligible. `budget` bounds the rows examined
 * so a big cleanup makes bounded progress per batch.
 *
 * The read-only counterpart used by the preview is `countCategory` below; the
 * two are deliberately kept side by side and the test suite asserts that every
 * category id is handled by BOTH, so a preview can never promise something the
 * run would not do (or the other way round).
 */
async function runCategory(ctx: MutationCtx, categoryId: string, budget: number): Promise<CategoryOutcome> {
  const now = Date.now();
  let records = 0;
  let bytes = 0;
  let more = false;

  switch (categoryId) {
    // 1. Rows whose parent community/channel/conversation/account no longer exists.
    case "orphaned-records": {
      const report = (await ctx.runQuery(internal.maintenance.orphanAudit, {})) as { records: number; bytes: number };
      const summary = (await ctx.runMutation(internal.maintenance.purgeOrphanedData, { dryRun: false })) as {
        bytes?: number;
      };
      records = report.records;
      bytes = summary.bytes ?? report.bytes;
      more = records > budget;
      break;
    }

    // 2. Uploaded files nothing references any more.
    case "unreferenced-files": {
      const referenced = await referencedStorageIds(ctx);
      const objects = await ctx.db.system.query("_storage").take(CLEANUP_SCAN_CAP);
      for (const object of objects) {
        if (records >= budget) {
          more = true;
          break;
        }
        if (referenced.has(object._id as string)) continue;
        const attachment = await ctx.db
          .query("attachments")
          .withIndex("by_storage", (q) => q.eq("storageId", object._id))
          .first();
        if (attachment) continue; // still referenced by a message
        if (now - object._creationTime < ORPHAN_FILE_GRACE_MS) continue; // may be in flight
        records += 1;
        bytes += object.size ?? 0;
        try {
          await ctx.storage.delete(object._id);
        } catch {
          // Already gone — exactly the state we want, so it is not an error.
        }
      }
      break;
    }

    // 3. Sessions and one-time codes that have already expired.
    case "expired-sessions": {
      for (const session of await ctx.db.query("authSessions").take(CLEANUP_SCAN_CAP)) {
        if (records >= budget) {
          more = true;
          break;
        }
        if (session.expirationTime >= now) continue;
        records += 1;
        for (const token of await ctx.db
          .query("authRefreshTokens")
          .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
          .collect()) {
          await ctx.db.delete(token._id);
        }
        await ctx.db.delete(session._id);
      }
      for (const code of await ctx.db.query("authVerificationCodes").take(CLEANUP_SCAN_CAP)) {
        if (records >= budget) {
          more = true;
          break;
        }
        if (code.expirationTime >= now) continue;
        records += 1;
        await ctx.db.delete(code._id);
      }
      break;
    }

    // 4. Stale real-time rows, and presence left by accounts that are gone.
    case "ephemeral-rows": {
      for (const row of await ctx.db.query("typing").take(CLEANUP_SCAN_CAP)) {
        if (records >= budget) {
          more = true;
          break;
        }
        if (now - row.at <= STALE_EPHEMERAL_MS) continue;
        records += 1;
        await ctx.db.delete(row._id);
      }
      for (const table of ["voiceSignals", "dmCallSignals"] as const) {
        for (const row of await ctx.db.query(table).take(CLEANUP_SCAN_CAP)) {
          if (records >= budget) {
            more = true;
            break;
          }
          if (now - row._creationTime <= STALE_EPHEMERAL_MS) continue;
          records += 1;
          await ctx.db.delete(row._id);
        }
      }
      for (const row of await ctx.db.query("presence").take(CLEANUP_SCAN_CAP)) {
        if (records >= budget) {
          more = true;
          break;
        }
        if (await ctx.db.get(row.userId)) continue;
        records += 1;
        await ctx.db.delete(row._id);
      }
      break;
    }

    // 5. Calls that finished more than a week ago.
    case "finished-calls": {
      const terminal = new Set(["declined", "missed", "cancelled", "ended", "failed"]);
      for (const invite of await ctx.db.query("callInvites").take(CLEANUP_SCAN_CAP)) {
        if (records >= budget) {
          more = true;
          break;
        }
        if (!terminal.has(invite.status)) continue; // still ringing or in progress
        const at = invite.endedAt ?? invite.startedAt ?? invite._creationTime;
        if (now - at < TERMINAL_CALL_GRACE_MS) continue;
        records += 1;
        await ctx.db.delete(invite._id);
      }
      for (const invitation of await ctx.db.query("callInvitations").take(CLEANUP_SCAN_CAP)) {
        if (records >= budget) {
          more = true;
          break;
        }
        const final =
          invitation.status === "expired" || invitation.status === "declined" || invitation.status === "cancelled";
        if (!final) continue;
        const at = invitation.resolvedAt ?? invitation.expiresAt;
        if (now - at < TERMINAL_CALL_GRACE_MS) continue;
        records += 1;
        await ctx.db.delete(invitation._id);
      }
      break;
    }

    // 6. Invite links that expired or ran out of uses.
    case "expired-invites": {
      for (const invite of await ctx.db.query("invites").take(CLEANUP_SCAN_CAP)) {
        if (records >= budget) {
          more = true;
          break;
        }
        const expired = invite.expiresAt !== undefined && invite.expiresAt < now;
        const exhausted = invite.maxUses !== undefined && invite.uses >= invite.maxUses;
        if (!expired && !exhausted) continue;
        records += 1;
        await ctx.db.delete(invite._id);
      }
      break;
    }

    // 7. Temporary grants, reset codes and lockout timers that have lapsed.
    case "expired-unlocks": {
      for (const unlock of await ctx.db.query("conversationUnlocks").take(CLEANUP_SCAN_CAP)) {
        if (records >= budget) {
          more = true;
          break;
        }
        if (unlock.expiresAt >= now) continue;
        records += 1;
        await ctx.db.delete(unlock._id);
      }
      for (const reset of await ctx.db.query("pinResets").take(CLEANUP_SCAN_CAP)) {
        if (records >= budget) {
          more = true;
          break;
        }
        if (reset.expiresAt >= now) continue;
        records += 1;
        await ctx.db.delete(reset._id);
      }
      // Optional site locks: drop an EXPIRED recovery code or lockout timer and
      // nothing else — the lock itself and every hash stay exactly as they are.
      for (const lock of await ctx.db.query("siteLocks").take(CLEANUP_SCAN_CAP)) {
        if (records >= budget) {
          more = true;
          break;
        }
        const codeExpired = lock.recoveryCodeExpiresAt !== undefined && lock.recoveryCodeExpiresAt < now;
        const lockoutOver = lock.lockedUntil !== undefined && lock.lockedUntil < now;
        if (!codeExpired && !lockoutOver) continue;
        records += 1;
        await ctx.db.patch(lock._id, {
          ...(codeExpired
            ? { recoveryCodeHash: undefined, recoveryCodeExpiresAt: undefined, recoveryAttempts: undefined }
            : {}),
          ...(lockoutOver ? { lockedUntil: undefined } : {}),
          updatedAt: now,
        });
      }
      for (const pin of await ctx.db.query("adminPinSettings").take(CLEANUP_SCAN_CAP)) {
        if (records >= budget) {
          more = true;
          break;
        }
        if (pin.lockedUntil === undefined || pin.lockedUntil >= now) continue;
        records += 1;
        await ctx.db.patch(pin._id, { lockedUntil: undefined, failedAttempts: 0, updatedAt: now });
      }
      break;
    }

    // 8. Rate-limit counters whose window closed long ago.
    case "rate-limit-counters": {
      for (const row of await ctx.db.query("rateLimits").take(CLEANUP_SCAN_CAP)) {
        if (records >= budget) {
          more = true;
          break;
        }
        if (now - row.windowStart < RATE_LIMIT_GRACE_MS) continue;
        records += 1;
        await ctx.db.delete(row._id);
      }
      break;
    }

    default:
      throw new ConvexError("Unknown cleanup category.");
  }

  return { records, bytes, more };
}

/**
 * The READ-ONLY counterpart of `runCategory` (a Convex query cannot write, and a
 * preview must never be able to). Same category ids, same eligibility rules; the
 * test suite asserts both switches cover exactly `GENERAL_CATEGORIES`.
 */
async function countCategory(
  ctx: QueryCtx,
  categoryId: string,
  budget: number,
): Promise<CategoryOutcome & { note?: string }> {
  const now = Date.now();
  let records = 0;
  let bytes = 0;
  let more = false;

  switch (categoryId) {
    case "orphaned-records": {
      const report = (await ctx.runQuery(internal.maintenance.orphanAudit, {})) as { records: number; bytes: number };
      records = report.records;
      bytes = report.bytes;
      more = records > budget;
      break;
    }
    case "unreferenced-files": {
      const referenced = await referencedStorageIds(ctx);
      for (const object of await ctx.db.system.query("_storage").take(CLEANUP_SCAN_CAP)) {
        if (records >= budget) {
          more = true;
          break;
        }
        if (referenced.has(object._id as string)) continue;
        const attachment = await ctx.db
          .query("attachments")
          .withIndex("by_storage", (q) => q.eq("storageId", object._id))
          .first();
        if (attachment) continue;
        if (now - object._creationTime < ORPHAN_FILE_GRACE_MS) continue;
        records += 1;
        bytes += object.size ?? 0;
      }
      break;
    }
    case "expired-sessions": {
      for (const session of await ctx.db.query("authSessions").take(CLEANUP_SCAN_CAP)) {
        if (records >= budget) {
          more = true;
          break;
        }
        if (session.expirationTime < now) records += 1;
      }
      for (const code of await ctx.db.query("authVerificationCodes").take(CLEANUP_SCAN_CAP)) {
        if (records >= budget) {
          more = true;
          break;
        }
        if (code.expirationTime < now) records += 1;
      }
      break;
    }
    case "ephemeral-rows": {
      for (const row of await ctx.db.query("typing").take(CLEANUP_SCAN_CAP)) {
        if (records >= budget) {
          more = true;
          break;
        }
        if (now - row.at > STALE_EPHEMERAL_MS) records += 1;
      }
      for (const table of ["voiceSignals", "dmCallSignals"] as const) {
        for (const row of await ctx.db.query(table).take(CLEANUP_SCAN_CAP)) {
          if (records >= budget) {
            more = true;
            break;
          }
          if (now - row._creationTime > STALE_EPHEMERAL_MS) records += 1;
        }
      }
      for (const row of await ctx.db.query("presence").take(CLEANUP_SCAN_CAP)) {
        if (records >= budget) {
          more = true;
          break;
        }
        if (!(await ctx.db.get(row.userId))) records += 1;
      }
      break;
    }
    case "finished-calls": {
      const terminal = new Set(["declined", "missed", "cancelled", "ended", "failed"]);
      for (const invite of await ctx.db.query("callInvites").take(CLEANUP_SCAN_CAP)) {
        if (records >= budget) {
          more = true;
          break;
        }
        if (!terminal.has(invite.status)) continue;
        const at = invite.endedAt ?? invite.startedAt ?? invite._creationTime;
        if (now - at >= TERMINAL_CALL_GRACE_MS) records += 1;
      }
      for (const invitation of await ctx.db.query("callInvitations").take(CLEANUP_SCAN_CAP)) {
        if (records >= budget) {
          more = true;
          break;
        }
        const final =
          invitation.status === "expired" || invitation.status === "declined" || invitation.status === "cancelled";
        if (!final) continue;
        const at = invitation.resolvedAt ?? invitation.expiresAt;
        if (now - at >= TERMINAL_CALL_GRACE_MS) records += 1;
      }
      break;
    }
    case "expired-invites": {
      for (const invite of await ctx.db.query("invites").take(CLEANUP_SCAN_CAP)) {
        if (records >= budget) {
          more = true;
          break;
        }
        const expired = invite.expiresAt !== undefined && invite.expiresAt < now;
        const exhausted = invite.maxUses !== undefined && invite.uses >= invite.maxUses;
        if (expired || exhausted) records += 1;
      }
      break;
    }
    case "expired-unlocks": {
      for (const unlock of await ctx.db.query("conversationUnlocks").take(CLEANUP_SCAN_CAP)) {
        if (records >= budget) {
          more = true;
          break;
        }
        if (unlock.expiresAt < now) records += 1;
      }
      for (const reset of await ctx.db.query("pinResets").take(CLEANUP_SCAN_CAP)) {
        if (records >= budget) {
          more = true;
          break;
        }
        if (reset.expiresAt < now) records += 1;
      }
      for (const lock of await ctx.db.query("siteLocks").take(CLEANUP_SCAN_CAP)) {
        if (records >= budget) {
          more = true;
          break;
        }
        const codeExpired = lock.recoveryCodeExpiresAt !== undefined && lock.recoveryCodeExpiresAt < now;
        const lockoutOver = lock.lockedUntil !== undefined && lock.lockedUntil < now;
        if (codeExpired || lockoutOver) records += 1;
      }
      for (const pin of await ctx.db.query("adminPinSettings").take(CLEANUP_SCAN_CAP)) {
        if (records >= budget) {
          more = true;
          break;
        }
        if (pin.lockedUntil !== undefined && pin.lockedUntil < now) records += 1;
      }
      break;
    }
    case "rate-limit-counters": {
      for (const row of await ctx.db.query("rateLimits").take(CLEANUP_SCAN_CAP)) {
        if (records >= budget) {
          more = true;
          break;
        }
        if (now - row.windowStart >= RATE_LIMIT_GRACE_MS) records += 1;
      }
      break;
    }
    default:
      return { records: 0, bytes: 0, more: false, note: "Unknown category." };
  }

  return { records, bytes, more };
}

/** Every selected category once (delete mode). One failing category never stops the rest. */
async function runCategories(
  ctx: MutationCtx,
  categories: readonly string[],
  budget: number,
): Promise<{
  records: number;
  bytes: number;
  more: boolean;
  perCategory: Array<{ id: string; records: number; bytes: number; more: boolean }>;
  notes: string[];
}> {
  let records = 0;
  let bytes = 0;
  let more = false;
  const perCategory: Array<{ id: string; records: number; bytes: number; more: boolean }> = [];
  const notes: string[] = [];

  for (const id of categories) {
    try {
      const outcome = await runCategory(ctx, id, budget);
      records += outcome.records;
      bytes += outcome.bytes;
      more = more || outcome.more;
      perCategory.push({ id, ...outcome });
    } catch (error) {
      // One failing category must not abort the others. The message is bounded and
      // secret-free by construction: this module never reads a credential.
      const message = error instanceof Error ? error.message.slice(0, 160) : "failed";
      notes.push(`${categoryById(id)?.label ?? id}: ${message}`);
      perCategory.push({ id, records: 0, bytes: 0, more: false });
    }
  }

  return { records, bytes, more, perCategory, notes };
}

// ---------------------------------------------------------------------------
// Job bookkeeping
// ---------------------------------------------------------------------------

/** A job that stopped reporting progress for this long is treated as dead. */
const JOB_STALE_MS = 15 * 60_000;
/** Batches a single scheduled burst may chain before yielding to the scheduler. */
const MAX_DEPTH_PER_RUN = 20;
/** Delay before the next chained batch (keeps a large cleanup gentle). */
const BATCH_DELAY_MS = 250;
/** Budget per general-cleanup batch, per category. */
const CATEGORY_BUDGET = 200;

async function runningJobRow(ctx: QueryCtx | MutationCtx): Promise<Doc<"cleanupJobs"> | null> {
  return (
    (await ctx.db
      .query("cleanupJobs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .first()) ?? null
  );
}

/** Refuse to start a second job while one is running (recovering dead ones). */
async function requireNoRunningJob(ctx: MutationCtx): Promise<void> {
  const running = await runningJobRow(ctx);
  if (!running) return;
  const touched = running.updatedAt ?? running.startedAt;
  if (Date.now() - touched > JOB_STALE_MS) {
    await ctx.db.patch(running._id, {
      status: "failed",
      finishedAt: Date.now(),
      updatedAt: Date.now(),
      lastError: "Abandoned: this cleanup stopped reporting progress.",
    });
    return;
  }
  throw new ConvexError("Another cleanup is already running. Wait for it to finish, or cancel it first.");
}

async function finishJob(
  ctx: MutationCtx,
  job: Doc<"cleanupJobs">,
  status: "completed" | "failed" | "cancelled",
  extras: { summary?: string[]; lastError?: string } = {},
): Promise<void> {
  const summary = extras.summary ?? job.summary ?? [];
  await ctx.db.patch(job._id, {
    status,
    finishedAt: Date.now(),
    updatedAt: Date.now(),
    summary,
    ...(extras.lastError ? { lastError: extras.lastError } : {}),
  });
  await auditAdmin(ctx, {
    action: `cleanup.${job.kind}.${status}`,
    actorId: job.actorId,
    actorName: job.actorName,
    targetType: "cleanup",
    targetId: job._id as string,
    detail: `${jobResultLabel({ ...job, status })} · scope: ${job.scopeLabel} · range: ${job.rangeLabel}${
      extras.lastError ? ` · ${extras.lastError}` : ""
    }`,
  });
}

// ---------------------------------------------------------------------------
// Public: reads
// ---------------------------------------------------------------------------

/**
 * What this administrator may do here. The UI uses it to hide what it cannot do,
 * but the server re-checks every call — the client is decoration.
 */
export const permissions = query({
  args: {},
  handler: async (ctx) => {
    const userId = await currentUserId(ctx);
    const role = await requirePanelAccess(ctx, userId);
    const isOwner = isOwnerRole(role);
    return {
      role,
      isOwner,
      canDeleteScoped: true,
      canDeleteSiteWide: isOwner,
      siteWideNote: isOwner
        ? "You can delete messages across the whole site."
        : "Deleting every message site-wide requires an Owner Admin. You can still clean up a community, channel, or conversation.",
      categories: GENERAL_CATEGORIES.map((category) => ({
        ...category,
        allowed: category.minRole === "owner" ? isOwner : true,
      })),
      timeZone: localTimeZone(),
      timeZoneLabel: timeZoneLabel(),
    };
  },
});

/**
 * The communities/channels/conversations a cleanup may target.
 *
 * Conversations are read only when the panel asks for them
 * (`includeConversations`): a DM list changes constantly, and an always-on
 * subscription would re-run this query on every new message.
 */
export const scopes = query({
  args: { includeConversations: v.optional(v.boolean()) },
  handler: async (ctx, { includeConversations }) => {
    const userId = await currentUserId(ctx);
    await requirePanelAccess(ctx, userId);

    const servers = await ctx.db.query("servers").take(PREVIEW_TARGET_LIMIT);
    const communities = servers.map((server) => ({ id: server._id as string, label: server.name }));
    const channels: Array<{ id: string; label: string; communityId: string }> = [];
    for (const server of servers) {
      for (const channel of await ctx.db
        .query("channels")
        .withIndex("by_server", (q) => q.eq("serverId", server._id))
        .take(200)) {
        channels.push({ id: channel._id as string, label: `#${channel.name}`, communityId: server._id as string });
      }
    }

    const conversations: Array<{ id: string; label: string; isGroup: boolean }> = [];
    if (includeConversations) {
      for (const conversation of await ctx.db.query("dmConversations").take(PREVIEW_TARGET_LIMIT)) {
        conversations.push({
          id: conversation._id as string,
          label: conversation.name ?? "Direct conversation",
          isGroup: Boolean(conversation.name),
        });
      }
    }

    return { communities, channels, conversations };
  },
});

/** Recent cleanup jobs — the durable history shown in the panel. */
export const history = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const userId = await currentUserId(ctx);
    await requirePanelAccess(ctx, userId);
    const take = Math.min(Math.max(limit ?? CLEANUP_HISTORY_LIMIT, 1), 100);
    const rows = await ctx.db.query("cleanupJobs").withIndex("by_started").order("desc").take(take);
    return rows.map((row) => ({
      jobId: row._id,
      kind: row.kind,
      status: row.status,
      scopeLabel: row.scopeLabel,
      rangeLabel: row.rangeLabel,
      categories: row.categories ?? [],
      actorName: row.actorName,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt ?? null,
      messagesDeleted: row.channelMessagesDeleted + row.dmMessagesDeleted,
      channelMessagesDeleted: row.channelMessagesDeleted,
      dmMessagesDeleted: row.dmMessagesDeleted,
      attachmentsDeleted: row.attachmentsDeleted,
      recordsDeleted: row.recordsDeleted,
      bytesFreed: row.bytesFreed,
      errors: row.errors,
      lastError: row.lastError ?? null,
      summary: row.summary ?? [],
      result: jobResultLabel(row),
    }));
  },
});

/** One job, for the live progress indicator. */
export const job = query({
  args: { jobId: v.id("cleanupJobs") },
  handler: async (ctx, { jobId }) => {
    const userId = await currentUserId(ctx);
    await requirePanelAccess(ctx, userId);
    const row = await ctx.db.get(jobId);
    if (!row) return null;
    return {
      jobId: row._id,
      kind: row.kind,
      status: row.status,
      scopeLabel: row.scopeLabel,
      rangeLabel: row.rangeLabel,
      categories: row.categories ?? [],
      actorName: row.actorName,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt ?? null,
      batches: row.batches,
      messagesDeleted: row.channelMessagesDeleted + row.dmMessagesDeleted,
      channelMessagesDeleted: row.channelMessagesDeleted,
      dmMessagesDeleted: row.dmMessagesDeleted,
      attachmentsDeleted: row.attachmentsDeleted,
      recordsDeleted: row.recordsDeleted,
      bytesFreed: row.bytesFreed,
      errors: row.errors,
      lastError: row.lastError ?? null,
      summary: row.summary ?? [],
      result: jobResultLabel(row),
    };
  },
});

/** Internal: is a job running right now? (the previews warn about it) */
export const runningJob = internalQuery({
  args: {},
  handler: async (ctx) => {
    const row = await runningJobRow(ctx);
    if (!row) return null;
    return { jobId: row._id as string, kind: row.kind, scopeLabel: row.scopeLabel, startedAt: row.startedAt };
  },
});

/** Internal: the read-only message count behind the Preview action. */
export const previewCount = internalQuery({
  args: {
    scopeKind: v.union(v.literal("all"), v.literal("community"), v.literal("channel"), v.literal("conversation")),
    scopeId: v.optional(v.string()),
    rangeKind: v.union(v.literal("all"), v.literal("before"), v.literal("between")),
    before: v.optional(v.number()),
    from: v.optional(v.number()),
    to: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<MessagePreview> => {
    const scope = await resolveScope(ctx, { kind: args.scopeKind, id: args.scopeId });
    const range = buildRange(args);
    const counts = await countMessages(ctx, scope, range);
    const timeZone = localTimeZone();
    return {
      ...counts,
      scopeKind: scope.kind,
      scopeId: scope.kind === "all" ? null : scope.id,
      scopeLabel: scopeLabel(scope),
      rangeLabel: rangeLabel(range, timeZone),
      timeZone,
      timeZoneLabel: timeZoneLabel(timeZone),
      siteWide: isSiteWide(scope, range),
    };
  },
});

/** Internal: read-only per-category figures behind the General preview action. */
export const generalCount = internalQuery({
  args: { categories: v.array(v.string()), budget: v.number() },
  handler: async (ctx, { categories, budget }): Promise<CategoryCount[]> => {
    const out: CategoryCount[] = [];
    for (const id of categories) out.push({ id, ...(await countCategory(ctx, id, budget)) });
    return out;
  },
});

/** Internal: does an account have panel access at all? (used before any preview) */
export const previewAccess = internalQuery({
  args: {},
  handler: async (ctx) => {
    await requireActor(ctx);
    return true;
  },
});

// ---------------------------------------------------------------------------
// Public: preview actions (read-only — never a live subscription)
// ---------------------------------------------------------------------------

const scopeArgs = {
  scopeKind: v.union(v.literal("all"), v.literal("community"), v.literal("channel"), v.literal("conversation")),
  scopeId: v.optional(v.string()),
  rangeKind: v.union(v.literal("all"), v.literal("before"), v.literal("between")),
  before: v.optional(v.number()),
  from: v.optional(v.number()),
  to: v.optional(v.number()),
} as const;

/**
 * Preview Message Cleanup. An ACTION, not a query: a preview reads a lot and must
 * never become a subscription that re-runs whenever any message changes. It
 * writes nothing.
 */
export const previewMessages = action({
  args: scopeArgs,
  handler: async (ctx, args): Promise<MessagePreview> => {
    await ctx.runQuery(internal.cleanup.previewAccess, {});
    return await ctx.runQuery(internal.cleanup.previewCount, {
      scopeKind: args.scopeKind,
      scopeId: args.scopeId,
      rangeKind: args.rangeKind,
      before: args.before,
      from: args.from,
      to: args.to,
    });
  },
});

/** Preview General System Cleanup: how many records, how many bytes, no changes. */
export const previewGeneral = action({
  args: { categories: v.array(v.string()) },
  handler: async (ctx, { categories }): Promise<GeneralPreview> => {
    await ctx.runQuery(internal.cleanup.previewAccess, {});
    const me = (await ctx.runQuery(internal.cleanup.actor, {})) as Actor;
    const clean = sanitizeCategoryIds(categories);
    for (const id of clean) {
      if (!categoryAllowedFor(me, id)) {
        throw new ConvexError(`“${categoryById(id)?.label ?? id}” can only be cleaned up by an Owner Admin.`);
      }
    }
    const results = (await ctx.runQuery(internal.cleanup.generalCount, {
      categories: clean,
      budget: CATEGORY_BUDGET,
    })) as CategoryCount[];
    const merged = results.map((entry) => {
      const category = categoryById(entry.id);
      return {
        id: entry.id,
        label: category?.label ?? entry.id,
        description: category?.description ?? "",
        includes: category?.includes ?? [],
        safety: category?.safety ?? "",
        minRole: category?.minRole ?? "admin",
        measurable: category?.measurable ?? false,
        records: entry.records,
        bytes: entry.bytes,
        // The scan is bounded per batch, so a preview never claims an exact figure
        // it did not read — an over-full batch is reported as "at least".
        atLeast: entry.more,
        note: entry.note ?? null,
      };
    });
    return {
      categories: merged,
      alreadyRunning: (await ctx.runQuery(internal.cleanup.runningJob, {})) !== null,
    };
  },
});

// ---------------------------------------------------------------------------
// Public: start / cancel
// ---------------------------------------------------------------------------

/**
 * Start a message cleanup. Scope and range are re-validated here, the
 * site-wide confirmation is checked, the total is counted (so the progress bar
 * has a denominator) and the first batch is scheduled immediately.
 */
export const startMessageCleanup = mutation({
  args: { ...scopeArgs, confirmPhrase: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ jobId: Id<"cleanupJobs">; total: number; approximate: boolean }> => {
    const me = await requireActor(ctx);
    const scope = await resolveScope(ctx, { kind: args.scopeKind, id: args.scopeId });
    const range = buildRange(args);

    if (scope.kind === "all" && !me.isOwner) {
      throw new ConvexError(
        "Deleting messages across the whole site requires an Owner Admin. Choose a community, channel, or conversation instead.",
      );
    }
    const phrase = requiredPhrase(scope, range);
    if (phrase && !phraseMatches(phrase, args.confirmPhrase ?? "")) {
      throw new ConvexError(`Type ${phrase} to confirm a site-wide deletion.`);
    }

    await requireNoRunningJob(ctx);

    const timeZone = localTimeZone();
    const counts = await countMessages(ctx, scope, range);
    const startedAt = Date.now();
    const jobId = await ctx.db.insert("cleanupJobs", {
      kind: "messages",
      status: "running",
      scopeKind: scope.kind,
      scopeId: scope.kind === "all" ? undefined : scope.id,
      scopeLabel: scopeLabel(scope),
      rangeLabel: rangeLabel(range, timeZone),
      from: range.kind === "between" ? range.from : undefined,
      to: range.kind === "between" ? range.to : range.kind === "before" ? range.before : undefined,
      actorId: me.userId,
      actorName: me.name,
      startedAt,
      updatedAt: startedAt,
      batches: 0,
      channelMessagesDeleted: 0,
      dmMessagesDeleted: 0,
      attachmentsDeleted: 0,
      recordsDeleted: 0,
      bytesFreed: 0,
      errors: 0,
      doneScopes: [],
      summary: [
        `Scan found ${counts.approximate ? "at least " : ""}${counts.total} message${counts.total === 1 ? "" : "s"} in range`,
      ],
    });

    await auditAdmin(ctx, {
      action: "cleanup.messages.start",
      actorId: me.userId,
      actorName: me.name,
      targetType: "cleanup",
      targetId: jobId as string,
      detail: `Started message cleanup · scope: ${scopeLabel(scope)} · range: ${rangeLabel(range, timeZone)} · ${
        counts.approximate ? "at least " : ""
      }${counts.total} messages in range`,
    });

    await ctx.scheduler.runAfter(0, internal.cleanup.runJobBatch, { jobId, depth: 0 });
    return { jobId, total: counts.total, approximate: counts.approximate };
  },
});

/** Start a general system cleanup for the selected categories. */
export const startGeneralCleanup = mutation({
  args: { categories: v.array(v.string()) },
  handler: async (ctx, { categories }): Promise<{ jobId: Id<"cleanupJobs"> }> => {
    const me = await requireActor(ctx);
    const clean = sanitizeCategoryIds(categories);
    if (clean.length === 0) throw new ConvexError("Choose at least one thing to clean up.");
    for (const id of clean) {
      if (!categoryAllowedFor(me, id)) {
        throw new ConvexError(`“${categoryById(id)?.label ?? id}” can only be cleaned up by an Owner Admin.`);
      }
    }
    await requireNoRunningJob(ctx);

    const labels = clean.map((id) => categoryById(id)?.label ?? id);
    const startedAt = Date.now();
    const jobId = await ctx.db.insert("cleanupJobs", {
      kind: "general",
      status: "running",
      scopeKind: "all",
      scopeLabel: "General system cleanup",
      rangeLabel: "Not date-based — expiry rules and references decide",
      categories: clean,
      actorId: me.userId,
      actorName: me.name,
      startedAt,
      updatedAt: startedAt,
      batches: 0,
      channelMessagesDeleted: 0,
      dmMessagesDeleted: 0,
      attachmentsDeleted: 0,
      recordsDeleted: 0,
      bytesFreed: 0,
      errors: 0,
      summary: [`Categories: ${labels.join(", ")}`],
    });

    await auditAdmin(ctx, {
      action: "cleanup.general.start",
      actorId: me.userId,
      actorName: me.name,
      targetType: "cleanup",
      targetId: jobId as string,
      detail: `Started general system cleanup · categories: ${labels.join(", ")}`,
    });

    await ctx.scheduler.runAfter(0, internal.cleanup.runJobBatch, { jobId, depth: 0 });
    return { jobId };
  },
});

/** Stop a running job. Batches already committed stay; nothing further runs. */
export const cancelJob = mutation({
  args: { jobId: v.id("cleanupJobs") },
  handler: async (ctx, { jobId }) => {
    const me = await requireActor(ctx);
    const job = await ctx.db.get(jobId);
    if (!job) throw new ConvexError("That cleanup job no longer exists.");
    if (job.status !== "running") return { cancelled: false, status: job.status };
    await ctx.db.patch(jobId, { status: "cancelled", finishedAt: Date.now(), updatedAt: Date.now() });
    await auditAdmin(ctx, {
      action: "cleanup.cancel",
      actorId: me.userId,
      actorName: me.name,
      targetType: "cleanup",
      targetId: jobId as string,
      detail: `Cancelled a ${job.kind} cleanup (${job.scopeLabel}) started by ${job.actorName}`,
    });
    return { cancelled: true, status: "cancelled" as const };
  },
});

// ---------------------------------------------------------------------------
// The batch runner
// ---------------------------------------------------------------------------

/**
 * One bounded batch of a running job, then it schedules the next one.
 *
 * This is what makes a large cleanup safe: each call removes a small, bounded
 * amount, records progress on the job row (which the panel subscribes to), and
 * schedules the following batch — yielding to the scheduler every
 * `MAX_DEPTH_PER_RUN` steps so a big job never holds resources. The job can be
 * cancelled between batches, and the actor's authorization is re-checked before
 * any further work.
 */
export const runJobBatch = internalMutation({
  args: { jobId: v.id("cleanupJobs"), depth: v.number() },
  handler: async (ctx, { jobId, depth }): Promise<{ status: string }> => {
    const job = await ctx.db.get(jobId);
    if (!job) return { status: "missing" };
    if (job.status !== "running") return { status: job.status };

    // Authorization is re-checked on EVERY batch: a revoked administrator's job
    // stops instead of continuing on stale authority.
    const auth = (await ctx.runQuery(internal.cleanup.authz, { actorId: job.actorId })) as {
      isAdmin: boolean;
      isOwner: boolean;
    };
    const ownerOnly = (job.categories ?? []).filter((id) => categoryById(id)?.minRole === "owner");
    const needsOwner = (job.kind === "messages" && job.scopeKind === "all") || ownerOnly.length > 0;
    if (!auth.isAdmin || (needsOwner && !auth.isOwner)) {
      const reason = !auth.isAdmin
        ? "Stopped: the administrator who started this cleanup no longer has panel access."
        : "Stopped: this cleanup needs Owner Admin authority.";
      await ctx.db.patch(jobId, { status: "failed", finishedAt: Date.now(), updatedAt: Date.now(), lastError: reason });
      await auditAdmin(ctx, {
        action: `cleanup.${job.kind}.failed`,
        actorId: job.actorId,
        actorName: job.actorName,
        targetType: "cleanup",
        targetId: jobId as string,
        detail: `${reason} (${job.scopeLabel})`,
      });
      return { status: "unauthorized" };
    }

    /** Continue, or finish — never abandon a job that still has work. */
    const scheduleNext = async () => {
      const nextDepth = depth + 1 < MAX_DEPTH_PER_RUN ? depth + 1 : 0;
      const delay = depth + 1 < MAX_DEPTH_PER_RUN ? BATCH_DELAY_MS : BATCH_DELAY_MS * 4;
      await ctx.scheduler.runAfter(delay, internal.cleanup.runJobBatch, { jobId, depth: nextDepth });
    };

    try {
      if (job.kind === "messages") {
        const range = storedRangeOf(job);
        const finished = new Set<string>(job.doneScopes ?? []);
        let batches = 0;
        let deleted = 0;
        let dm = 0;
        let attachments = 0;
        let bytes = 0;
        let idlePass = false;

        while (batches < CLEANUP_BATCHES_PER_RUN) {
          const sweep = await sweepMessages(ctx, { ...job, doneScopes: [...finished] }, range, CLEANUP_BATCH_SIZE);
          batches += 1;
          deleted += sweep.channelMessages;
          dm += sweep.dmMessages;
          attachments += sweep.attachments;
          bytes += sweep.bytes;
          for (const id of sweep.finished) finished.add(id);
          const progress = sweep.channelMessages + sweep.dmMessages;
          await ctx.db.patch(jobId, {
            batches: job.batches + batches,
            channelMessagesDeleted: job.channelMessagesDeleted + deleted,
            dmMessagesDeleted: job.dmMessagesDeleted + dm,
            attachmentsDeleted: job.attachmentsDeleted + attachments,
            bytesFreed: job.bytesFreed + bytes,
            doneScopes: [...finished],
            cursorCreatedAt: Date.now(),
            updatedAt: Date.now(),
          });
          if (progress === 0) {
            idlePass = true;
            break;
          }
        }

        const summary = [...(job.summary ?? [])];
        if (deleted + dm > 0) {
          summary.push(
            `Deleted ${deleted + dm} message${deleted + dm === 1 ? "" : "s"}${
              attachments > 0 ? ` and ${attachments} attached file${attachments === 1 ? "" : "s"}` : ""
            }`,
          );
        }
        if (idlePass) {
          summary.push("No further messages matched — finished");
          await finishJob(ctx, { ...job, channelMessagesDeleted: job.channelMessagesDeleted + deleted, dmMessagesDeleted: job.dmMessagesDeleted + dm, attachmentsDeleted: job.attachmentsDeleted + attachments, bytesFreed: job.bytesFreed + bytes }, "completed", {
            summary: summary.slice(-10),
          });
          return { status: "completed" };
        }
        await ctx.db.patch(jobId, { summary: summary.slice(-10), updatedAt: Date.now() });
        await scheduleNext();
        return { status: "running" };
      }

      // General system cleanup: one bounded pass over every selected category.
      const pass = await runCategories(ctx, job.categories ?? [], CATEGORY_BUDGET);
      const batches = job.batches + 1;
      const summary = [...(job.summary ?? [])];
      summary.push(
        `Pass ${batches}: ${pass.perCategory
          .map((entry) => `${categoryById(entry.id)?.label ?? entry.id} ${entry.records}`)
          .join(", ")}`,
      );
      if (pass.notes.length > 0) summary.push(...pass.notes);
      const totals = {
        batches,
        recordsDeleted: job.recordsDeleted + pass.records,
        bytesFreed: job.bytesFreed + pass.bytes,
        errors: job.errors + pass.notes.length,
      };
      await ctx.db.patch(jobId, {
        ...totals,
        ...(pass.notes.length > 0 ? { lastError: pass.notes[pass.notes.length - 1] } : {}),
        summary: summary.slice(-10),
        updatedAt: Date.now(),
      });

      if (!pass.more) {
        summary.push("Nothing else is eligible — finished");
        await finishJob(ctx, { ...job, ...totals }, "completed", { summary: summary.slice(-12) });
        return { status: "completed" };
      }
      await scheduleNext();
      return { status: "running" };
    } catch (error) {
      // A thrown batch is ATOMIC: Convex rolls back everything this mutation wrote,
      // so the database is never left half-updated. The job records the failure and
      // stops instead of looping on a persistent error.
      const message = error instanceof Error ? error.message.slice(0, 200) : "Cleanup batch failed.";
      const fresh = await ctx.db.get(jobId);
      if (fresh) {
        await ctx.db.patch(jobId, { errors: fresh.errors + 1, lastError: message, updatedAt: Date.now() });
        await finishJob(ctx, { ...fresh, errors: fresh.errors + 1 }, "failed", {
          lastError: message,
          summary: [...(fresh.summary ?? []), `Failed: ${message}`].slice(-12),
        });
      }
      return { status: "failed" };
    }
  },
});
