/**
 * Admin Panel → Cleanup & Maintenance — the rules (pure, no Convex, no DOM).
 *
 * WHAT THIS IS
 * ------------
 * The shared, testable half of the two admin cleanup tools:
 *
 *   1. Message Cleanup — delete messages by WHEN they were sent, optionally
 *      limited to one community, channel or direct conversation.
 *   2. General System Cleanup — remove data the application can regenerate or
 *      that nothing references any more, in the categories listed in
 *      `GENERAL_CATEGORIES` below.
 *
 * Both halves of the feature import THIS module (the Convex functions in
 * `src/convex/cleanup.ts` and the panel UI in
 * `src/components/admin/CleanupMaintenance.tsx`), so the browser and the server
 * can never disagree about what a range means, when a confirmation is required,
 * or what a category contains — and the server re-validates everything the UI
 * checked, because a client is never trusted.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Nothing here deletes anything, and nothing here decides authorization. The
 * rules say what a well-formed request looks like; `src/convex/cleanup.ts`
 * enforces the administrator role on every call, refuses a malformed request,
 * re-checks each row before deleting it, and records the audit entry.
 *
 * TIME
 * ----
 * Every cutoff is an absolute instant (ms since epoch) on the SERVER's clock.
 * The UI converts the administrator's local picker value into that instant and
 * always displays the time zone it applied (`timeZoneLabel`), so "older than
 * 2026-01-01 10:00" means the same thing to the person clicking the button and
 * to the database — and the label stored in cleanup history says which zone it
 * was interpreted in.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Messages deleted per batch — small enough that one transaction is always safe. */
export const CLEANUP_BATCH_SIZE = 200;
/** Batches processed per scheduled run before the job re-schedules itself. */
export const CLEANUP_BATCHES_PER_RUN = 10;
/** Rows examined per batch while selecting candidates (bounded scan). */
export const CLEANUP_SCAN_CAP = 1_000;
/** Rows a Preview may examine before it reports a lower bound instead of an exact count. */
export const PREVIEW_SCAN_LIMIT = 5_000;
/** Communities/channels/conversations a Preview may walk before it reports a lower bound. */
export const PREVIEW_TARGET_LIMIT = 200;
/** How many past jobs the history table shows. */
export const CLEANUP_HISTORY_LIMIT = 25;
/** The exact phrase an administrator must type before a site-wide deletion. */
export const SITE_WIDE_PHRASE = "DELETE ALL MESSAGES";
/** An upload must be this old before it counts as abandoned. */
export const ORPHAN_FILE_GRACE_MS = 24 * HOUR;
/** A finished call record is kept this long before it is disposable. */
export const TERMINAL_CALL_GRACE_MS = 7 * DAY;
/** A rate-limit window is kept this long past its end. */
export const RATE_LIMIT_GRACE_MS = DAY;
/** Stale typing rows / call signals older than this are disposable. */
export const STALE_EPHEMERAL_MS = 30 * MINUTE;

// ---------------------------------------------------------------------------
// Scopes and ranges
// ---------------------------------------------------------------------------

/** What a message cleanup is limited to. */
export type CleanupScopeKind = "all" | "community" | "channel" | "conversation";

/**
 * A resolved scope. `label` is always built by the SERVER from the real row it
 * looked up (never taken from the request body), so a history entry can neither
 * be spoofed nor point at something the actor cannot see.
 */
export type CleanupScope =
  | { kind: "all" }
  | { kind: "community" | "channel" | "conversation"; id: string; label: string };

/** Which messages a cleanup selects, by send time. */
export type MessageRange =
  | { kind: "all" }
  | { kind: "before"; before: number }
  | { kind: "between"; from: number; to: number };

/** The scope, as it arrives from a client (untrusted — ids/labels are re-resolved). */
export type ScopeRequest = { kind: CleanupScopeKind; id?: string };

/** The range, as it arrives from a client (untrusted — validated here). */
export type RangeRequest = { kind: "all" } | { kind: "before"; before: number } | { kind: "between"; from: number; to: number };

const isInstant = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * Why a scope request is not usable, or `null` when it is. A scoped request must
 * carry an id; only `all` may omit it.
 */
export function scopeProblem(scope: ScopeRequest | undefined | null): string | null {
  if (!scope || typeof scope.kind !== "string") return "Choose what to clean up.";
  if (!["all", "community", "channel", "conversation"].includes(scope.kind)) return "That scope is not supported.";
  if (scope.kind === "all") return null;
  if (typeof scope.id !== "string" || scope.id.trim().length === 0) {
    return scope.kind === "community"
      ? "Choose a community, or use “All messages”."
      : scope.kind === "channel"
        ? "Choose a channel."
        : "Choose a conversation.";
  }
  return null;
}

/**
 * Why a date range is not usable, or `null` when it is. `between` must have a
 * start strictly before its end — the end is inclusive, so an empty window is
 * refused instead of silently deleting nothing.
 */
export function rangeProblem(range: RangeRequest | undefined | null): string | null {
  if (!range || typeof range.kind !== "string") return "Choose a time range.";
  if (range.kind === "all") return null;
  if (range.kind === "before") {
    if (!isInstant(range.before)) return "Choose the date and time to delete up to.";
    return null;
  }
  if (range.kind === "between") {
    if (!isInstant(range.from)) return "Choose a start date and time.";
    if (!isInstant(range.to)) return "Choose an end date and time.";
    if (range.from >= range.to) return "The end date must be after the start date.";
    return null;
  }
  return "That time range is not supported.";
}

/**
 * Does a message sent at `createdAt` fall inside this range? `before` is
 * exclusive (`createdAt < before`), `between` includes both ends.
 */
export function rangeCovers(range: MessageRange, createdAt: number): boolean {
  if (range.kind === "all") return true;
  if (range.kind === "before") return createdAt < range.before;
  return createdAt >= range.from && createdAt <= range.to;
}

/**
 * A one-line description of the range, in the administrator's time zone. Stored
 * verbatim in cleanup history, so the record always says which zone was used.
 */
export function rangeLabel(range: MessageRange, timeZone?: string): string {
  if (range.kind === "all") return "Every message, any date";
  if (range.kind === "before") return `Sent before ${formatMoment(range.before, timeZone)}`;
  return `Sent from ${formatMoment(range.from, timeZone)} to ${formatMoment(range.to, timeZone)}`;
}

/** A one-line description of the scope (the server passes its own resolved label). */
export function scopeLabel(scope: CleanupScope): string {
  if (scope.kind === "all") return "All messages (site-wide)";
  if (scope.kind === "community") return `Community: ${scope.label}`;
  if (scope.kind === "channel") return `Channel: ${scope.label}`;
  return `Conversation: ${scope.label}`;
}

/** True when this request deletes across the whole site (needs the extra phrase). */
export function isSiteWide(scope: CleanupScope, range: MessageRange): boolean {
  return scope.kind === "all" && range.kind === "all";
}

/**
 * The phrase the administrator must type before the destructive confirmation is
 * accepted — only for a site-wide deletion of every message, and `null`
 * everywhere else (an ordinary range or a scoped cleanup never asks for it).
 */
export function requiredPhrase(scope: CleanupScope, range: MessageRange): string | null {
  return isSiteWide(scope, range) ? SITE_WIDE_PHRASE : null;
}

/** Case/whitespace-insensitive comparison of the typed confirmation phrase. */
export function phraseMatches(expected: string | null, typed: string): boolean {
  if (!expected) return true;
  return typed.trim().toUpperCase() === expected.toUpperCase();
}

// ---------------------------------------------------------------------------
// Batching and progress
// ---------------------------------------------------------------------------

/**
 * How many rows this batch may delete: the batch size, never more than remains.
 * Batching is what keeps a large deletion from timing out — the job deletes this
 * many, records progress, and schedules the next batch.
 */
export function batchPlan(remaining: number, batchSize: number = CLEANUP_BATCH_SIZE): number {
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  const size = Math.max(1, Math.floor(batchSize));
  return Math.min(Math.floor(remaining), size);
}

/** 0–100 progress for the progress bar; `total === 0` reports 100 (nothing left). */
export function progressPercent(done: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 100;
  const pct = Math.round((Math.max(0, done) / total) * 100);
  return Math.max(0, Math.min(100, pct));
}

/** Is this job still doing work? (Used to decide whether to keep polling.) */
export function jobIsActive(status: string | undefined | null): boolean {
  return status === "running";
}

/** A finished job's one-line result, e.g. "Completed — 2,450 messages deleted". */
export function jobResultLabel(job: {
  status: string;
  channelMessagesDeleted: number;
  dmMessagesDeleted: number;
  recordsDeleted: number;
  attachmentsDeleted: number;
  errors: number;
}): string {
  const messages = job.channelMessagesDeleted + job.dmMessagesDeleted;
  const parts =
    messages > 0
      ? [`${formatCount(messages)} messages`]
      : job.recordsDeleted > 0
        ? [`${formatCount(job.recordsDeleted)} records`]
        : ["nothing"];
  if (job.attachmentsDeleted > 0) parts.push(`${formatCount(job.attachmentsDeleted)} files`);
  if (job.errors > 0) parts.push(`${formatCount(job.errors)} error${job.errors === 1 ? "" : "s"}`);
  const verb =
    job.status === "completed"
      ? "Completed"
      : job.status === "cancelled"
        ? "Cancelled"
        : job.status === "failed"
          ? "Failed"
          : "Running";
  return `${verb} — ${parts.join(", ")} deleted`;
}

/** Thousands separators, without depending on the browser's locale. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Human-readable bytes ("1.4 MB"), or "—" when not measurable. */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

// ---------------------------------------------------------------------------
// Time-zone aware date/time handling (the pickers and every stored label)
// ---------------------------------------------------------------------------

/** The viewer's IANA time zone, or UTC when the runtime does not report one. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** "2026-01-31 14:05 (Europe/Berlin)" — always says which zone it means. */
export function formatMoment(ms: number, timeZone?: string): string {
  if (!Number.isFinite(ms)) return "—";
  const zone = timeZone || localTimeZone();
  try {
    const formatted = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(ms));
    return `${formatted.replace(",", "")} (${zone})`;
  } catch {
    return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} (UTC)`;
  }
}

/** The time zone to show next to the pickers. */
export function timeZoneLabel(timeZone?: string): string {
  const zone = timeZone || localTimeZone();
  const offsetMinutes = -new Date().getTimezoneOffset();
  if (zone === "UTC") return `UTC (UTC+0)`;
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return `${zone} (UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, "0")}` : ""})`;
}

/**
 * An instant → the value a `<input type="datetime-local">` expects, in LOCAL
 * time (no time-zone suffix, minute precision). This is the only conversion the
 * UI performs, and `fromLocalPicker` is its exact inverse.
 */
export function toLocalPicker(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * A picker value → an absolute instant, interpreted in the ADMINISTRATOR'S OWN
 * time zone (exactly what they see in the field). Returns `null` for an
 * unparseable value so the caller can show the "choose a date" message instead
 * of sending `NaN` to the server.
 */
export function fromLocalPicker(value: string): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    s ? Number(s) : 0,
    0,
  );
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

// ---------------------------------------------------------------------------
// General System Cleanup categories
// ---------------------------------------------------------------------------

/** Who may run a category: any panel administrator, or Owners only. */
export type CategoryMinRole = "admin" | "owner";

export type CleanupCategory = {
  id: string;
  /** Short name shown on the card. */
  label: string;
  /** One sentence: what this category IS. */
  description: string;
  /** Bullet list of exactly which rows/files it may remove. */
  includes: string[];
  /** Safety rule, shown so the administrator knows why it is safe. */
  safety: string;
  minRole: CategoryMinRole;
  /** Whether a storage figure can be measured for it. */
  measurable: boolean;
};

/**
 * The categories of General System Cleanup. The Convex implementation switches
 * on these exact ids, and the test suite asserts the two lists agree — so a
 * category can never be displayed without an implementation, or implemented
 * without being displayed.
 *
 * Every category is defined by a POSITIVE rule (an expired timestamp the row
 * itself carries, or "nothing references this"), never by "it looks old", and
 * none of them can touch user accounts, communities, groups, profiles, live
 * sessions, or attachments that a message still references.
 */
export const GENERAL_CATEGORIES: readonly CleanupCategory[] = [
  {
    id: "orphaned-records",
    label: "Orphaned records",
    description: "Rows whose parent community, channel, conversation or account no longer exists.",
    includes: [
      "messages in a deleted channel, and messages whose sender no longer exists",
      "direct messages in a conversation that no longer exists (or has no members)",
      "attachments, reactions and “delete for me” markers left behind by those messages",
      "channels, channel categories and conversation members with no parent",
      "file storage objects owned only by those orphaned attachments",
    ],
    safety: "A row is only eligible when its parent is genuinely gone — every parent is resolved server-side first.",
    minRole: "owner",
    measurable: true,
  },
  {
    id: "unreferenced-files",
    label: "Abandoned file uploads",
    description: "Uploaded files that no message, profile, group or community references any more.",
    includes: [
      "uploads whose message was deleted before the attachment was saved",
      "images replaced by a newer profile picture, banner, group photo or community icon",
      "uploads abandoned before they were ever attached to anything",
    ],
    safety: "Only files older than 24 hours with no reference anywhere in the database are eligible; live attachments are never touched.",
    minRole: "owner",
    measurable: true,
  },
  {
    id: "expired-sessions",
    label: "Expired sessions and codes",
    description: "Sign-in sessions and one-time codes that have already expired.",
    includes: [
      "auth sessions whose expiration time has passed",
      "refresh tokens belonging to those expired sessions",
      "verification codes that have expired",
    ],
    safety: "Only rows past their own expiry are removed — the session you are signed in with is never eligible.",
    minRole: "admin",
    measurable: false,
  },
  {
    id: "ephemeral-rows",
    label: "Stale typing and call signals",
    description: "Throwaway real-time rows that were never cleaned up.",
    includes: [
      "“is typing” rows older than 30 minutes",
      "voice and DM call signalling payloads older than 30 minutes",
      "presence rows left behind by accounts that no longer exist",
    ],
    safety: "These rows are ignored by their readers after seconds; removing an old one changes nothing that is on screen.",
    minRole: "admin",
    measurable: false,
  },
  {
    id: "finished-calls",
    label: "Finished call records",
    description: "Call invitations that ended more than seven days ago.",
    includes: [
      "direct and channel call invites with a final status (declined, missed, cancelled, ended, failed)",
      "call invitations that expired or were resolved more than seven days ago",
    ],
    safety: "A call that is still ringing or in progress is never eligible, and neither is anything from the last seven days.",
    minRole: "admin",
    measurable: false,
  },
  {
    id: "expired-invites",
    label: "Expired community invites",
    description: "Invite links that have expired or used up all of their uses.",
    includes: ["invite links whose expiry has passed", "invite links whose use limit is reached"],
    safety: "Invites that still work are kept; only expired or exhausted links are removed.",
    minRole: "admin",
    measurable: false,
  },
  {
    id: "expired-unlocks",
    label: "Expired unlocks and reset codes",
    description: "Temporary grants and one-time reset codes that have already lapsed.",
    includes: [
      "expired “locked conversation” unlock grants",
      "expired Secret Chats PIN reset codes",
      "expired pin/password recovery codes on optional site locks",
      "expired login lockout timers",
    ],
    safety: "Only grants and codes whose expiry has passed are cleared; active unlocks and lockouts are untouched.",
    minRole: "admin",
    measurable: false,
  },
  {
    id: "rate-limit-counters",
    label: "Expired rate-limit counters",
    description: "Abuse-protection counters whose counting window ended long ago.",
    includes: ["rate-limit windows that ended more than a day ago"],
    safety: "A counter whose window is still open is kept — removing it would weaken rate limiting.",
    minRole: "admin",
    measurable: false,
  },
];

/** One category by id (`null` for an unknown id). */
export function categoryById(id: string): CleanupCategory | null {
  return GENERAL_CATEGORIES.find((c) => c.id === id) ?? null;
}

/** Every category id, in display order. */
export function categoryIds(): string[] {
  return GENERAL_CATEGORIES.map((c) => c.id);
}

/** Drop unknown ids and duplicates from a client's category selection. */
export function sanitizeCategoryIds(ids: readonly string[] | undefined | null): string[] {
  if (!Array.isArray(ids)) return [];
  const known = new Set(categoryIds());
  return [...new Set(ids.filter((id) => typeof id === "string" && known.has(id)))];
}

/**
 * Why a category selection is not usable, or `null` when it is. An empty
 * selection is refused: "Run Cleanup" with nothing selected must never look like
 * it did something.
 */
export function categoriesProblem(ids: readonly string[] | undefined | null): string | null {
  if (sanitizeCategoryIds(ids).length === 0) return "Choose at least one thing to clean up.";
  return null;
}

/**
 * Does the selected set include anything an Owner Admin must authorize? Used for
 * the extra note in the confirmation dialog, not as a permission check.
 */
export function includesOwnerOnlyCategory(ids: readonly string[]): boolean {
  return sanitizeCategoryIds(ids).some((id) => categoryById(id)?.minRole === "owner");
}
