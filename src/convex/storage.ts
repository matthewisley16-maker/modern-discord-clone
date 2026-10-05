import { ConvexError, v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { enforceRateLimit } from "./authHelpers";
import { currentUserId } from "./lib";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

/**
 * Storage / retention maintenance.
 *
 * Freecord stores chat history in Convex (documents + file storage). Convex has
 * hard limits, and when they are hit the whole app starts failing. This module
 * keeps the deployment safely below its configured budget by pruning the
 * OLDEST disposable message history first — never account, community, or
 * configuration data — in small, locked, server-verified batches.
 *
 * Everything here is backend-only: no storage amount is ever surfaced in the UI.
 *
 * Configuration (in precedence order):
 *   1. code defaults below
 *   2. STORAGE_* environment variables (set in the Convex dashboard)
 *   3. the `storageConfig` singleton row (tunable at runtime)
 */

// ---------------- Defaults ----------------

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const STORAGE_DEFAULTS = {
  /** Recent messages are protected from auto-cleanup for this long. */
  retentionMs: 30 * DAY,
  /** Rows deleted per batch in the normal (cleanup) phase. */
  batchSize: 100,
  /** Larger batch while in the critical phase. */
  batchSizeCritical: 300,
  /** Max batches per run in the normal phase. */
  maxBatchesPerRun: 5,
  /** Max batches per run while critical. */
  maxBatchesCritical: 20,
  /** Thresholds as a fraction of the configured budget. */
  warningRatio: 0.7,
  cleanupRatio: 0.85,
  criticalRatio: 0.95,
  /** Keep deleting until usage falls back to at or below this fraction. */
  safeRatio: 0.65,
  /** The storage budget this app manages itself to (bytes). */
  budgetBytes: 1_000_000_000,
  /** The message-row budget this app manages itself to (rows). */
  budgetRows: 200_000,
  /** Pinned messages are intentionally kept. */
  protectPinned: true,
  /** Stale typing rows / call signals are disposable and safe to prune. */
  staleTypingMs: 10 * MINUTE,
  staleSignalMs: 30 * MINUTE,
  /** Lock duration for a single cleanup run. */
  lockMs: 120_000,
  /** Upper bound on rows scanned when estimating usage. */
  usageScanCap: 20_000,
} as const;

export type StorageConfig = {
  retentionMs: number;
  batchSize: number;
  batchSizeCritical: number;
  maxBatchesPerRun: number;
  maxBatchesCritical: number;
  warningRatio: number;
  cleanupRatio: number;
  criticalRatio: number;
  safeRatio: number;
  budgetBytes: number;
  budgetRows: number;
  protectPinned: boolean;
  staleTypingMs: number;
  staleSignalMs: number;
  lockMs: number;
  usageScanCap: number;
  /** When set, cleanup is scoped to one community (used by the owner action + tests). */
  scopeServerId?: Id<"servers">;
};

function envNumber(name: string, fallback: number, env: Record<string, string | undefined>): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Resolve the effective config from defaults → env → stored overrides. */
export async function loadConfig(ctx: MutationCtx): Promise<StorageConfig> {
  const env: Record<string, string | undefined> =
    typeof process !== "undefined" && process.env ? (process.env as Record<string, string | undefined>) : {};

  const cfg: StorageConfig = {
    retentionMs: envNumber("STORAGE_RETENTION_MS", STORAGE_DEFAULTS.retentionMs, env),
    batchSize: envNumber("STORAGE_BATCH_SIZE", STORAGE_DEFAULTS.batchSize, env),
    batchSizeCritical: envNumber("STORAGE_BATCH_SIZE_CRITICAL", STORAGE_DEFAULTS.batchSizeCritical, env),
    maxBatchesPerRun: envNumber("STORAGE_MAX_BATCHES", STORAGE_DEFAULTS.maxBatchesPerRun, env),
    maxBatchesCritical: envNumber("STORAGE_MAX_BATCHES_CRITICAL", STORAGE_DEFAULTS.maxBatchesCritical, env),
    warningRatio: envNumber("STORAGE_WARNING_RATIO", STORAGE_DEFAULTS.warningRatio, env),
    cleanupRatio: envNumber("STORAGE_CLEANUP_RATIO", STORAGE_DEFAULTS.cleanupRatio, env),
    criticalRatio: envNumber("STORAGE_CRITICAL_RATIO", STORAGE_DEFAULTS.criticalRatio, env),
    safeRatio: envNumber("STORAGE_SAFE_RATIO", STORAGE_DEFAULTS.safeRatio, env),
    budgetBytes: envNumber("STORAGE_BUDGET_BYTES", STORAGE_DEFAULTS.budgetBytes, env),
    budgetRows: envNumber("STORAGE_BUDGET_ROWS", STORAGE_DEFAULTS.budgetRows, env),
    protectPinned: STORAGE_DEFAULTS.protectPinned,
    staleTypingMs: envNumber("STORAGE_STALE_TYPING_MS", STORAGE_DEFAULTS.staleTypingMs, env),
    staleSignalMs: envNumber("STORAGE_STALE_SIGNAL_MS", STORAGE_DEFAULTS.staleSignalMs, env),
    lockMs: envNumber("STORAGE_LOCK_MS", STORAGE_DEFAULTS.lockMs, env),
    usageScanCap: envNumber("STORAGE_USAGE_SCAN_CAP", STORAGE_DEFAULTS.usageScanCap, env),
  };

  const stored = await ctx.db
    .query("storageConfig")
    .withIndex("by_key", (q) => q.eq("key", "config"))
    .unique();
  if (stored) {
    for (const [key, value] of Object.entries(stored)) {
      if (key === "_id" || key === "_creationTime" || key === "key") continue;
      if (value !== undefined && value !== null) (cfg as Record<string, unknown>)[key] = value;
    }
  }
  return cfg;
}

// ---------------- Usage estimate ----------------

export type UsageSnapshot = {
  bytes: number;
  rows: number;
  attachments: number;
  truncated: boolean;
  /** max(bytes/budgetBytes, rows/budgetRows) */
  ratio: number;
};

/** Sum the size of every attachment in a set of message ids (bounded scan). */
async function attachmentBytesForMessages(
  ctx: MutationCtx,
  messageIds: Set<string>,
  dmMessageIds: Set<string>,
  cap: number,
): Promise<number> {
  let bytes = 0;
  const rows = await ctx.db.query("attachments").take(cap);
  for (const a of rows) {
    if (a.messageId && messageIds.has(a.messageId as string)) bytes += a.size;
    else if (a.dmMessageId && dmMessageIds.has(a.dmMessageId as string)) bytes += a.size;
  }
  return bytes;
}

/**
 * Approximate current usage. Convex exposes no in-app usage API, so we measure
 * the data this app owns: attachment bytes on disk + chat message rows. The
 * scan is capped so a run can never become unbounded.
 */
export async function estimateUsage(ctx: MutationCtx, cfg: StorageConfig): Promise<UsageSnapshot> {
  const cap = cfg.usageScanCap;
  let bytes = 0;
  let rows = 0;
  let attachments = 0;
  let truncated = false;

  if (cfg.scopeServerId) {
    const channels = await ctx.db
      .query("channels")
      .withIndex("by_server", (q) => q.eq("serverId", cfg.scopeServerId as Id<"servers">))
      .collect();
    const messageIds = new Set<string>();
    for (const channel of channels) {
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
        .take(cap);
      if (msgs.length === cap) truncated = true;
      rows += msgs.length;
      for (const m of msgs) messageIds.add(m._id as string);
    }
    bytes = await attachmentBytesForMessages(ctx, messageIds, new Set(), cap);
    attachments = (await ctx.db.query("attachments").take(cap)).length;
  } else {
    const files = await ctx.db.query("attachments").take(cap);
    if (files.length === cap) truncated = true;
    attachments = files.length;
    for (const f of files) bytes += f.size;

    const msgs = await ctx.db.query("messages").take(cap);
    if (msgs.length === cap) truncated = true;
    rows += msgs.length;
    const dms = await ctx.db.query("dmMessages").take(cap);
    if (dms.length === cap) truncated = true;
    rows += dms.length;
  }

  const ratio = Math.max(
    cfg.budgetBytes > 0 ? bytes / cfg.budgetBytes : 0,
    cfg.budgetRows > 0 ? rows / cfg.budgetRows : 0,
  );
  return { bytes, rows, attachments, truncated, ratio };
}

export type CleanupStatus = "normal" | "warning" | "cleanup" | "critical";

export function classifyRatio(ratio: number, cfg: StorageConfig): CleanupStatus {
  if (ratio >= cfg.criticalRatio) return "critical";
  if (ratio >= cfg.cleanupRatio) return "cleanup";
  if (ratio >= cfg.warningRatio) return "warning";
  return "normal";
}

// ---------------- Eligibility ----------------

/** A message is only eligible when it is past retention AND not intentionally kept. */
function isEligible(doc: Doc<"messages"> | Doc<"dmMessages">, cutoff: number, cfg: StorageConfig): boolean {
  if (doc._creationTime >= cutoff) return false;
  if (cfg.protectPinned && doc.pinned) return false;
  return true;
}

type Candidate =
  | { kind: "channel"; message: Doc<"messages"> }
  | { kind: "dm"; message: Doc<"dmMessages"> };

/**
 * Pick the oldest eligible messages, oldest-first. Never random.
 * In scoped mode only the scoped community's channels are considered.
 */
async function selectEligible(ctx: MutationCtx, cfg: StorageConfig, size: number): Promise<Candidate[]> {
  const cutoff = Date.now() - cfg.retentionMs;
  const scan = size * 3 + 16;
  const out: Candidate[] = [];

  const pool: Doc<"messages">[] = [];
  if (cfg.scopeServerId) {
    const channels = await ctx.db
      .query("channels")
      .withIndex("by_server", (q) => q.eq("serverId", cfg.scopeServerId as Id<"servers">))
      .collect();
    for (const channel of channels) {
      // by_channel default order is ascending _creationTime, so this yields the
      // oldest messages in the channel first.
      const rows = await ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
        .order("asc")
        .take(scan);
      pool.push(...rows);
    }
  } else {
    pool.push(...(await ctx.db.query("messages").order("asc").take(scan)));
  }
  pool.sort((a, b) => a._creationTime - b._creationTime);
  for (const m of pool) {
    if (out.length >= size) break;
    if (isEligible(m, cutoff, cfg)) out.push({ kind: "channel", message: m });
  }

  // DMs are only pruned by the global (automatic) cleanup, never by a
  // community-scoped action.
  if (!cfg.scopeServerId) {
    const dmRows = await ctx.db.query("dmMessages").order("asc").take(scan);
    for (const m of dmRows) {
      if (out.length >= size) break;
      if (isEligible(m, cutoff, cfg)) out.push({ kind: "dm", message: m });
    }
  }

  return out;
}

// ---------------- Deletion ----------------

/**
 * Delete one channel message and its disposable related data.
 * An attachment's storage object is removed ONLY when no other attachment row
 * still references it (orphan check) so a file shared by another message stays.
 */
async function deleteChannelMessage(ctx: MutationCtx, message: Doc<"messages">): Promise<void> {
  const files = await ctx.db
    .query("attachments")
    .withIndex("by_message", (q) => q.eq("messageId", message._id))
    .collect();
  for (const file of files) {
    await ctx.db.delete(file._id);
    const stillReferenced = await ctx.db
      .query("attachments")
      .withIndex("by_storage", (q) => q.eq("storageId", file.storageId))
      .first();
    if (!stillReferenced) await ctx.storage.delete(file.storageId);
  }
  for (const r of await ctx.db.query("reactions").withIndex("by_message", (q) => q.eq("messageId", message._id)).collect()) {
    await ctx.db.delete(r._id);
  }
  for (const vis of await ctx.db.query("messageVisibility").withIndex("by_message", (q) => q.eq("messageId", message._id)).collect()) {
    await ctx.db.delete(vis._id);
  }
  await ctx.db.delete(message._id);
}

async function deleteDmMessage(ctx: MutationCtx, message: Doc<"dmMessages">): Promise<void> {
  const files = await ctx.db
    .query("attachments")
    .withIndex("by_dm_message", (q) => q.eq("dmMessageId", message._id))
    .collect();
  for (const file of files) {
    await ctx.db.delete(file._id);
    const stillReferenced = await ctx.db
      .query("attachments")
      .withIndex("by_storage", (q) => q.eq("storageId", file.storageId))
      .first();
    if (!stillReferenced) await ctx.storage.delete(file.storageId);
  }
  for (const r of await ctx.db.query("dmReactions").withIndex("by_message", (q) => q.eq("messageId", message._id)).collect()) {
    await ctx.db.delete(r._id);
  }
  for (const vis of await ctx.db.query("messageVisibility").withIndex("by_message", (q) => q.eq("messageId", message._id)).collect()) {
    await ctx.db.delete(vis._id);
  }
  await ctx.db.delete(message._id);
}

/** Delete up to `size` eligible messages, re-verifying eligibility per record. */
async function deleteBatch(
  ctx: MutationCtx,
  cfg: StorageConfig,
  size: number,
): Promise<{ deleted: number; examined: number }> {
  const candidates = await selectEligible(ctx, cfg, size);
  let deleted = 0;
  for (const candidate of candidates) {
    // Server-side re-check: the row may have changed since selection.
    const fresh = await ctx.db.get(candidate.message._id);
    if (!fresh) continue;
    if (!isEligible(fresh, Date.now() - cfg.retentionMs, cfg)) continue;
    if (candidate.kind === "channel") {
      await deleteChannelMessage(ctx, fresh as Doc<"messages">);
    } else {
      await deleteDmMessage(ctx, fresh as Doc<"dmMessages">);
    }
    deleted++;
  }
  return { deleted, examined: candidates.length };
}

/**
 * Priority 3: other disposable message-related data that is safe to regenerate.
 * Only stale rows are removed, and never in a community-scoped (test) run.
 */
async function pruneDisposable(ctx: MutationCtx, cfg: StorageConfig): Promise<number> {
  if (cfg.scopeServerId) return 0;
  const now = Date.now();
  let removed = 0;

  const typing = await ctx.db.query("typing").take(cfg.usageScanCap);
  for (const t of typing) {
    if (now - t.at > cfg.staleTypingMs) {
      await ctx.db.delete(t._id);
      removed++;
    }
  }
  const voiceSignals = await ctx.db.query("voiceSignals").take(cfg.usageScanCap);
  for (const s of voiceSignals) {
    if (now - s._creationTime > cfg.staleSignalMs) {
      await ctx.db.delete(s._id);
      removed++;
    }
  }
  const dmSignals = await ctx.db.query("dmCallSignals").take(cfg.usageScanCap);
  for (const s of dmSignals) {
    if (now - s._creationTime > cfg.staleSignalMs) {
      await ctx.db.delete(s._id);
      removed++;
    }
  }
  return removed;
}

// ---------------- Lock + state ----------------

function stateKey(cfg: StorageConfig): string {
  return cfg.scopeServerId ? `scope:${cfg.scopeServerId}` : "global";
}

async function getState(ctx: MutationCtx, key: string) {
  return ctx.db.query("storageState").withIndex("by_key", (q) => q.eq("key", key)).unique();
}

/** Try to take the single cleanup lock. Returns false when another run holds it. */
async function acquireLock(ctx: MutationCtx, cfg: StorageConfig, jobId: string): Promise<boolean> {
  const key = stateKey(cfg);
  const now = Date.now();
  const state = await getState(ctx, key);
  if (!state) {
    await ctx.db.insert("storageState", { key, lockedUntil: now + cfg.lockMs, lockedBy: jobId, consecutiveErrors: 0 });
    return true;
  }
  if (state.lockedUntil && state.lockedUntil > now) return false;
  await ctx.db.patch(state._id, { lockedUntil: now + cfg.lockMs, lockedBy: jobId });
  return true;
}

async function releaseLock(ctx: MutationCtx, cfg: StorageConfig, jobId: string): Promise<void> {
  const state = await getState(ctx, stateKey(cfg));
  // Only release a lock we still own — a stale run must not free a newer one.
  if (state && state.lockedBy === jobId) {
    await ctx.db.patch(state._id, { lockedUntil: 0, lockedBy: undefined });
  }
}

export type CleanupSummary = {
  statusBefore: CleanupStatus;
  statusAfter: CleanupStatus;
  batches: number;
  deleted: number;
  examined: number;
  disposableRemoved: number;
  truncated: boolean;
  drained: boolean; // ran out of eligible records
  /** Only populated for a dry run: the oldest eligible ids, oldest-first. */
  candidateIds?: string[];
};

/** The full batch loop. Shared by the cron job and the owner-scoped action. */
async function performCleanup(
  ctx: MutationCtx,
  cfg: StorageConfig,
  opts: { dryRun?: boolean } = {},
): Promise<CleanupSummary> {
  let snapshot = await estimateUsage(ctx, cfg);
  const statusBefore = classifyRatio(snapshot.ratio, cfg);

  if (opts.dryRun) {
    const size = statusBefore === "critical" ? cfg.batchSizeCritical : cfg.batchSize;
    const candidates = await selectEligible(ctx, cfg, size);
    return {
      statusBefore,
      statusAfter: statusBefore,
      batches: 0,
      deleted: 0,
      examined: candidates.length,
      disposableRemoved: 0,
      truncated: snapshot.truncated,
      drained: false,
      candidateIds: candidates.map((c) => c.message._id as string),
    };
  }

  // Normal usage → do nothing at all.
  if (statusBefore === "normal") {
    return {
      statusBefore,
      statusAfter: statusBefore,
      batches: 0,
      deleted: 0,
      examined: 0,
      disposableRemoved: 0,
      truncated: snapshot.truncated,
      drained: false,
    };
  }

  // Warning → prepare only: prune disposable data, keep every message.
  if (statusBefore === "warning") {
    const disposableRemoved = await pruneDisposable(ctx, cfg);
    return {
      statusBefore,
      statusAfter: statusBefore,
      batches: 0,
      deleted: 0,
      examined: 0,
      disposableRemoved,
      truncated: snapshot.truncated,
      drained: false,
    };
  }

  const critical = statusBefore === "critical";
  const maxBatches = critical ? cfg.maxBatchesCritical : cfg.maxBatchesPerRun;
  const size = critical ? cfg.batchSizeCritical : cfg.batchSize;

  let batches = 0;
  let deleted = 0;
  let examined = 0;
  let drained = false;

  // Small batches; re-measure after each batch and continue only if still needed.
  while (batches < maxBatches && snapshot.ratio > cfg.safeRatio) {
    const result = await deleteBatch(ctx, cfg, size);
    batches++;
    deleted += result.deleted;
    examined += result.examined;
    if (result.examined === 0 || result.deleted === 0) {
      drained = true; // nothing eligible left to delete
      break;
    }
    snapshot = await estimateUsage(ctx, cfg);
  }

  const disposableRemoved = await pruneDisposable(ctx, cfg);

  return {
    statusBefore,
    statusAfter: classifyRatio(snapshot.ratio, cfg),
    batches,
    deleted,
    examined,
    disposableRemoved,
    truncated: snapshot.truncated,
    drained,
  };
}

/** Persist an operational record of a run (never shown in the UI). */
async function recordRun(ctx: MutationCtx, cfg: StorageConfig, summary: CleanupSummary): Promise<void> {
  const key = stateKey(cfg);
  const state = await getState(ctx, key);
  const patch = {
    lastRunAt: Date.now(),
    lastStatus: summary.statusAfter,
    lastDeleted: summary.deleted,
    totalDeleted: (state?.totalDeleted ?? 0) + summary.deleted,
    batchesRun: summary.batches,
    truncated: summary.truncated,
    consecutiveErrors: 0,
    lastError: undefined,
    lastErrorAt: undefined,
  };
  if (state) await ctx.db.patch(state._id, patch);
  else await ctx.db.insert("storageState", { key, ...patch });
}

async function recordError(ctx: MutationCtx, cfg: StorageConfig, error: unknown): Promise<void> {
  const key = stateKey(cfg);
  const state = await getState(ctx, key);
  const message = error instanceof Error ? error.message : String(error);
  const consecutive = (state?.consecutiveErrors ?? 0) + 1;
  const patch = { lastError: message, lastErrorAt: Date.now(), consecutiveErrors: consecutive, lastRunAt: Date.now() };
  if (state) await ctx.db.patch(state._id, patch);
  else await ctx.db.insert("storageState", { key, ...patch });
}

// ---------------- Entry points ----------------

/**
 * Automatic background cleanup. Runs on a schedule (see crons.ts) and is
 * also scheduled on demand by `requestCleanup`. Locked so only one job runs.
 */
export const runCleanup = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cfg = await loadConfig(ctx);
    const jobId = crypto.randomUUID();
    if (!(await acquireLock(ctx, cfg, jobId))) return { skipped: "locked" as const };
    try {
      const summary = await performCleanup(ctx, cfg);
      await recordRun(ctx, cfg, summary);
      return summary;
    } catch (error) {
      // Never let a cleanup failure bubble up and break anything.
      await recordError(ctx, cfg, error);
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      await releaseLock(ctx, cfg, jobId);
    }
  },
});

/**
 * Client-triggered cleanup. Schedules the background job and returns
 * immediately, so sending messages never blocks on maintenance.
 */
export const requestCleanup = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await currentUserId(ctx);
    await enforceRateLimit(ctx, `storage:request:${userId}`, 3, 60_000);
    await ctx.scheduler.runAfter(0, internal.storage.runCleanup, {});
    return { scheduled: true };
  },
});

/**
 * Owner-scoped prune of one community's old history.
 *
 * This is the safe test / maintenance entry point: it only ever touches the
 * community's own old (past-retention) messages, and it uses the same
 * eligibility checks, batching and orphan attachment cleanup as the automatic
 * job. Because it is scoped to a server, it can simulate high usage without
 * risking any production data outside that community.
 */
export const pruneOldMessages = mutation({
  args: {
    serverId: v.id("servers"),
    /** Override the retention window for this run (ms). */
    olderThanMs: v.optional(v.number()),
    batchSize: v.optional(v.number()),
    maxBatches: v.optional(v.number()),
    /** Budget overrides so a small test community can simulate pressure. */
    budgetBytes: v.optional(v.number()),
    budgetRows: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await currentUserId(ctx);
    const server = await ctx.db.get(args.serverId);
    if (!server) throw new ConvexError("Community not found.");
    if (server.ownerId !== userId) throw new ConvexError("Only the community owner can prune message history.");
    await enforceRateLimit(ctx, `storage:prune:${userId}`, 5, 60_000);

    const cfg = await loadConfig(ctx);
    cfg.scopeServerId = args.serverId;
    if (args.olderThanMs !== undefined) cfg.retentionMs = Math.max(0, args.olderThanMs);
    if (args.batchSize !== undefined) cfg.batchSize = Math.min(500, Math.max(1, Math.floor(args.batchSize)));
    if (args.maxBatches !== undefined) cfg.maxBatchesPerRun = Math.min(50, Math.max(1, Math.floor(args.maxBatches)));
    if (args.budgetBytes !== undefined && args.budgetBytes > 0) cfg.budgetBytes = args.budgetBytes;
    if (args.budgetRows !== undefined && args.budgetRows > 0) cfg.budgetRows = args.budgetRows;

    const jobId = crypto.randomUUID();
    if (!(await acquireLock(ctx, cfg, jobId))) {
      throw new ConvexError("Storage maintenance is already running. Please try again shortly.");
    }
    try {
      const summary = await performCleanup(ctx, cfg, { dryRun: args.dryRun ?? false });
      await recordRun(ctx, cfg, summary);
      return summary;
    } catch (error) {
      await recordError(ctx, cfg, error);
      throw error;
    } finally {
      await releaseLock(ctx, cfg, jobId);
    }
  },
});
