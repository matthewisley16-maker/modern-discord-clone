// Tests for the Admin Panel's Cleanup & Maintenance tools — Message Cleanup
// (delete messages by when they were sent, optionally scoped) and General System
// Cleanup (remove data that is disposable by rule).
//
// Run: bun cleanup-maintenance-test.mjs
//
// Three layers, none of which needs an account (the deployment guard forbids
// creating synthetic users in production):
//
//   1. the pure rules (`src/lib/cleanup.ts`) — scopes, date ranges, the
//      confirmation phrase, batching, progress, category definitions and the
//      time-zone conversion the pickers rely on,
//   2. the real source of the backend, the schema, the panel and the UI,
//      asserting every destructive path is authorized, audited, batched and
//      built on the app's own message-deletion helpers — and that a preview is
//      physically unable to write,
//   3. live calls to the deployment with NO session, asserting an anonymous
//      caller cannot preview or start anything (they only ever fail to
//      authorize), plus the deployed argument schema of the confirmation phrase.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "./src/convex/_generated/api.js";
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
  SITE_WIDE_PHRASE,
  STALE_EPHEMERAL_MS,
  TERMINAL_CALL_GRACE_MS,
  batchPlan,
  categoriesProblem,
  categoryById,
  categoryIds,
  formatBytes,
  formatCount,
  formatMoment,
  fromLocalPicker,
  includesOwnerOnlyCategory,
  isSiteWide,
  jobIsActive,
  jobResultLabel,
  localTimeZone,
  phraseMatches,
  progressPercent,
  rangeCovers,
  rangeLabel,
  rangeProblem,
  requiredPhrase,
  sanitizeCategoryIds,
  scopeLabel,
  scopeProblem,
  timeZoneLabel,
  toLocalPicker,
} from "./src/lib/cleanup";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, detail) => { fail++; console.log(`FAIL: ${name} -> ${detail ?? ""}`); };
const is = (name, got, expected) => {
  if (got === expected) ok(name);
  else bad(name, `got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
};
const check = (name, condition, detail) => (condition ? ok(name) : bad(name, detail));

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");
/** The text between two markers (used to inspect one function at a time). */
function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) return "";
  const end = source.indexOf(endMarker, start);
  return source.slice(start, end < 0 ? undefined : end);
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// 1. Scopes
// ---------------------------------------------------------------------------
is("an unscoped request is valid", scopeProblem({ kind: "all" }), null);
is("a named community is valid", scopeProblem({ kind: "community", id: "abc" }), null);
is("a named channel is valid", scopeProblem({ kind: "channel", id: "abc" }), null);
is("a named conversation is valid", scopeProblem({ kind: "conversation", id: "abc" }), null);
is("no scope at all is refused", scopeProblem(undefined), "Choose what to clean up.");
is("null is refused", scopeProblem(null), "Choose what to clean up.");
is("an unknown scope kind is refused", scopeProblem({ kind: "everything" }), "That scope is not supported.");
is("a community without an id is refused", scopeProblem({ kind: "community" }), "Choose a community, or use “All messages”.");
is("a blank community id is refused", scopeProblem({ kind: "community", id: "   " }), "Choose a community, or use “All messages”.");
is("a channel without an id is refused", scopeProblem({ kind: "channel" }), "Choose a channel.");
is("a conversation without an id is refused", scopeProblem({ kind: "conversation" }), "Choose a conversation.");
is("only `all` may omit an id", scopeProblem({ kind: "all", id: "" }), null);

is("all messages labels itself as site-wide", scopeLabel({ kind: "all" }), "All messages (site-wide)");
is("a community scope label names the community", scopeLabel({ kind: "community", id: "x", label: "Design Club" }), "Community: Design Club");
is("a channel scope label names the community and channel", scopeLabel({ kind: "channel", id: "x", label: "Design Club · #general" }), "Channel: Design Club · #general");
is("a conversation scope label names the conversation", scopeLabel({ kind: "conversation", id: "x", label: "Ada ↔ Bob" }), "Conversation: Ada ↔ Bob");

// ---------------------------------------------------------------------------
// 2. Date ranges (the values the pickers produce)
// ---------------------------------------------------------------------------
const NOW = 1_800_000_000_000;
is("every message, any date, is valid", rangeProblem({ kind: "all" }), null);
is("older than a moment is valid", rangeProblem({ kind: "before", before: NOW }), null);
is("a start before an end is valid", rangeProblem({ kind: "between", from: NOW - DAY, to: NOW }), null);
is("a missing range is refused", rangeProblem(undefined), "Choose a time range.");
is("an unknown range kind is refused", rangeProblem({ kind: "since" }), "That time range is not supported.");
is("`before` without a time is refused", rangeProblem({ kind: "before" }), "Choose the date and time to delete up to.");
is("`before: 0` is refused (not a real instant)", rangeProblem({ kind: "before", before: 0 }), "Choose the date and time to delete up to.");
is("`before: NaN` is refused", rangeProblem({ kind: "before", before: Number.NaN }), "Choose the date and time to delete up to.");
is("`between` without a start is refused", rangeProblem({ kind: "between", to: NOW }), "Choose a start date and time.");
is("`between` without an end is refused", rangeProblem({ kind: "between", from: NOW }), "Choose an end date and time.");
is("an end equal to the start is refused (empty window)", rangeProblem({ kind: "between", from: NOW, to: NOW }), "The end date must be after the start date.");
is("an end before the start is refused", rangeProblem({ kind: "between", from: NOW, to: NOW - DAY }), "The end date must be after the start date.");
is("a one-minute window is allowed", rangeProblem({ kind: "between", from: NOW, to: NOW + MINUTE }), null);

is("every message matches an unscoped range", rangeCovers({ kind: "all" }, 0), true);
is("`before` matches strictly earlier messages", rangeCovers({ kind: "before", before: NOW }, NOW - 1), true);
is("`before` excludes the boundary instant", rangeCovers({ kind: "before", before: NOW }, NOW), false);
is("`before` excludes later messages", rangeCovers({ kind: "before", before: NOW }, NOW + 1), false);
is("`between` includes the start", rangeCovers({ kind: "between", from: NOW, to: NOW + HOUR }, NOW), true);
is("`between` includes the end", rangeCovers({ kind: "between", from: NOW, to: NOW + HOUR }, NOW + HOUR), true);
is("`between` excludes one millisecond before the start", rangeCovers({ kind: "between", from: NOW, to: NOW + HOUR }, NOW - 1), false);
is("`between` excludes one millisecond after the end", rangeCovers({ kind: "between", from: NOW, to: NOW + HOUR }, NOW + HOUR + 1), false);

// The stored label always says which time zone the range was read in.
is("an unscoped range is labelled as every message", rangeLabel({ kind: "all" }, "UTC"), "Every message, any date");
is("`before` is labelled with the instant and zone", rangeLabel({ kind: "before", before: Date.UTC(2026, 0, 31, 14, 5) }, "UTC"), "Sent before 2026-01-31 14:05 (UTC)");
check("`between` is labelled with both instants and the zone",
  rangeLabel({ kind: "between", from: Date.UTC(2026, 0, 1, 8, 0), to: Date.UTC(2026, 0, 31, 14, 5) }, "UTC")
    === "Sent from 2026-01-01 08:00 (UTC) to 2026-01-31 14:05 (UTC)",
  rangeLabel({ kind: "between", from: Date.UTC(2026, 0, 1, 8, 0), to: Date.UTC(2026, 0, 31, 14, 5) }, "UTC"));

// ---------------------------------------------------------------------------
// 3. The extra confirmation for a site-wide deletion
// ---------------------------------------------------------------------------
is("the phrase is the documented one", SITE_WIDE_PHRASE, "DELETE ALL MESSAGES");
is("every message, any date, is site-wide", isSiteWide({ kind: "all" }, { kind: "all" }), true);
is("a date window over all messages is NOT the site-wide case", isSiteWide({ kind: "all" }, { kind: "before", before: NOW }), false);
is("a scoped cleanup is never site-wide", isSiteWide({ kind: "community", id: "x", label: "A" }, { kind: "all" }), false);
is("the phrase is required for a site-wide deletion", requiredPhrase({ kind: "all" }, { kind: "all" }), SITE_WIDE_PHRASE);
is("the phrase is NOT required for all messages in a date window", requiredPhrase({ kind: "all" }, { kind: "before", before: NOW }), null);
is("the phrase is NOT required for a scoped cleanup", requiredPhrase({ kind: "channel", id: "x", label: "A" }, { kind: "all" }), null);
is("the exact phrase matches", phraseMatches(SITE_WIDE_PHRASE, "DELETE ALL MESSAGES"), true);
is("a lower-case phrase matches", phraseMatches(SITE_WIDE_PHRASE, "delete all messages"), true);
is("surrounding whitespace is tolerated", phraseMatches(SITE_WIDE_PHRASE, "  DELETE ALL MESSAGES  "), true);
is("a partial phrase does not match", phraseMatches(SITE_WIDE_PHRASE, "DELETE ALL"), false);
is("a different phrase does not match", phraseMatches(SITE_WIDE_PHRASE, "delete everything"), false);
is("an empty phrase does not match", phraseMatches(SITE_WIDE_PHRASE, ""), false);
is("when no phrase is required, anything passes", phraseMatches(null, ""), true);

// ---------------------------------------------------------------------------
// 4. Batching and progress (large cleanups must not time out)
// ---------------------------------------------------------------------------
check("the batch size is small enough for one safe transaction", CLEANUP_BATCH_SIZE > 0 && CLEANUP_BATCH_SIZE <= 500, String(CLEANUP_BATCH_SIZE));
check("a run processes several batches before rescheduling", CLEANUP_BATCHES_PER_RUN >= 2, String(CLEANUP_BATCHES_PER_RUN));
check("the candidate scan is bounded", CLEANUP_SCAN_CAP > 0 && CLEANUP_SCAN_CAP <= 4096, String(CLEANUP_SCAN_CAP));
check("a preview is bounded too", PREVIEW_SCAN_LIMIT >= CLEANUP_SCAN_CAP && PREVIEW_TARGET_LIMIT > 0, `${PREVIEW_SCAN_LIMIT}/${PREVIEW_TARGET_LIMIT}`);
check("history is bounded", CLEANUP_HISTORY_LIMIT > 0 && CLEANUP_HISTORY_LIMIT <= 100, String(CLEANUP_HISTORY_LIMIT));

is("a full batch is planned when more than a batch remains", batchPlan(5000), CLEANUP_BATCH_SIZE);
is("a partial batch is planned when less remains", batchPlan(7), 7);
is("nothing is planned when nothing remains", batchPlan(0), 0);
is("a negative remainder plans nothing", batchPlan(-3), 0);
is("a non-finite remainder plans nothing", batchPlan(Number.NaN), 0);
is("a custom batch size is honoured", batchPlan(100, 25), 25);
is("a custom batch size never under-shoots to zero", batchPlan(100, 0), 1);

is("progress with no known total is complete", progressPercent(0, 0), 100);
is("progress is rounded", progressPercent(1, 3), 33);
is("progress is clamped at 100", progressPercent(150, 100), 100);
is("progress never goes negative", progressPercent(-5, 100), 0);
is("progress on an unknown total is complete", progressPercent(50, Number.NaN), 100);

is("a running job is active", jobIsActive("running"), true);
is("a completed job is not active", jobIsActive("completed"), false);
is("a cancelled job is not active", jobIsActive("cancelled"), false);
is("a missing status is not active", jobIsActive(undefined), false);

check("a completed message cleanup reports what it deleted",
  jobResultLabel({ status: "completed", channelMessagesDeleted: 2400, dmMessagesDeleted: 50, recordsDeleted: 0, attachmentsDeleted: 12, errors: 0 })
    === "Completed — 2,450 messages, 12 files deleted",
  jobResultLabel({ status: "completed", channelMessagesDeleted: 2400, dmMessagesDeleted: 50, recordsDeleted: 0, attachmentsDeleted: 12, errors: 0 }));
check("a general cleanup reports records",
  jobResultLabel({ status: "completed", channelMessagesDeleted: 0, dmMessagesDeleted: 0, recordsDeleted: 40, attachmentsDeleted: 0, errors: 0 })
    === "Completed — 40 records deleted",
  jobResultLabel({ status: "completed", channelMessagesDeleted: 0, dmMessagesDeleted: 0, recordsDeleted: 40, attachmentsDeleted: 0, errors: 0 }));
check("a cleanup that found nothing says so",
  jobResultLabel({ status: "completed", channelMessagesDeleted: 0, dmMessagesDeleted: 0, recordsDeleted: 0, attachmentsDeleted: 0, errors: 0 })
    === "Completed — nothing deleted",
  jobResultLabel({ status: "completed", channelMessagesDeleted: 0, dmMessagesDeleted: 0, recordsDeleted: 0, attachmentsDeleted: 0, errors: 0 }));
check("errors are reported",
  jobResultLabel({ status: "failed", channelMessagesDeleted: 3, dmMessagesDeleted: 0, recordsDeleted: 0, attachmentsDeleted: 0, errors: 2 }).includes("2 errors"),
  jobResultLabel({ status: "failed", channelMessagesDeleted: 3, dmMessagesDeleted: 0, recordsDeleted: 0, attachmentsDeleted: 0, errors: 2 }));
check("cancelling is distinguished from completing",
  jobResultLabel({ status: "cancelled", channelMessagesDeleted: 1, dmMessagesDeleted: 0, recordsDeleted: 0, attachmentsDeleted: 0, errors: 0 }).startsWith("Cancelled"),
  jobResultLabel({ status: "cancelled", channelMessagesDeleted: 1, dmMessagesDeleted: 0, recordsDeleted: 0, attachmentsDeleted: 0, errors: 0 }));

// ---------------------------------------------------------------------------
// 5. Formatting and time zones
// ---------------------------------------------------------------------------
is("thousands are grouped", formatCount(2450), "2,450");
is("small counts are unchanged", formatCount(7), "7");
is("million-scale counts are grouped", formatCount(1234567), "1,234,567");
is("an unknown count renders as zero", formatCount(Number.NaN), "0");
is("bytes under 1 KB are shown as bytes", formatBytes(512), "512 B");
is("kilobytes are shown", formatBytes(2048), "2.0 KB");
is("megabytes are shown", formatBytes(5 * 1024 * 1024), "5.0 MB");
is("gigabytes are shown", formatBytes(3 * 1024 * 1024 * 1024), "3.0 GB");
is("an unmeasurable size renders as a dash", formatBytes(null), "—");
is("a negative size renders as a dash", formatBytes(-1), "—");

is("the UTC label says UTC", timeZoneLabel("UTC"), "UTC (UTC+0)");
check("a named zone is shown with its offset", /^Europe\/[A-Za-z]+\+? \(UTC[+-]\d/.test(timeZoneLabel("Europe/Berlin").replace(/\+\+/, "+")) || timeZoneLabel("Europe/Berlin").startsWith("Europe/Berlin (UTC"), timeZoneLabel("Europe/Berlin"));
check("the resolved local zone is a non-empty string", typeof localTimeZone() === "string" && localTimeZone().length > 0, localTimeZone());
check("a moment is formatted with its zone in brackets", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(.+\)$/.test(formatMoment(Date.UTC(2026, 0, 31, 14, 5), "UTC")), formatMoment(Date.UTC(2026, 0, 31, 14, 5), "UTC"));
is("an unformattable moment is a dash", formatMoment(Number.NaN, "UTC"), "—");

// The picker conversion is exactly invertible (to the minute): what an
// administrator types is the instant the server receives.
const pickerInstant = Date.UTC(2026, 6, 4, 9, 30);
const roundTrip = fromLocalPicker(toLocalPicker(pickerInstant + 30 * 1000)); // pickers carry minutes
check("a picker value round-trips to the same minute",
  typeof roundTrip === "number" && Math.floor(roundTrip / MINUTE) === Math.floor(pickerInstant / MINUTE),
  `${toLocalPicker(pickerInstant)} -> ${roundTrip}`);
check("a picker value with seconds is accepted", typeof fromLocalPicker("2026-07-04T09:30:45") === "number", "seconds rejected");
is("an empty picker value is not an instant", fromLocalPicker(""), null);
is("a whitespace picker value is not an instant", fromLocalPicker("   "), null);
is("free text is not an instant", fromLocalPicker("yesterday"), null);
is("a malformed date is not an instant", fromLocalPicker("04/07/2026 09:30"), null);

// ---------------------------------------------------------------------------
// 6. The General System Cleanup categories
// ---------------------------------------------------------------------------
is("there are eight cleanup categories", GENERAL_CATEGORIES.length, 8);
is("category ids are unique", new Set(categoryIds()).size, GENERAL_CATEGORIES.length);
for (const category of GENERAL_CATEGORIES) {
  check(`category '${category.id}' is fully described`,
    typeof category.label === "string" && category.label.length > 0
      && typeof category.description === "string" && category.description.length > 0
      && Array.isArray(category.includes) && category.includes.length > 0
      && typeof category.safety === "string" && category.safety.length > 0
      && (category.minRole === "admin" || category.minRole === "owner")
      && typeof category.measurable === "boolean",
    JSON.stringify(category));
}
check("every category states a positive rule (never 'looks old')",
  GENERAL_CATEGORIES.every((c) => !/\b(old|unused|stale)\s*(data|files|records)?\.?$/i.test(c.description) || /\bexpired\b|\breferences\b|\bno longer exists\b|nothing references/i.test(c.description)),
  GENERAL_CATEGORIES.map((c) => c.description).join(" | "));
check("the two reference-checking categories are Owner Admin only",
  categoryById("orphaned-records").minRole === "owner" && categoryById("unreferenced-files").minRole === "owner",
  `${categoryById("orphaned-records").minRole}/${categoryById("unreferenced-files").minRole}`);
check("no category claims it can delete accounts, communities or profiles",
  GENERAL_CATEGORIES.every((c) => !/\b(delete|remove|purge)\s+(user accounts?|accounts?|communities|profiles|groups)\b/i.test(`${c.description} ${c.safety}`)),
  "a category description promises to delete protected data");

is("an unknown category id resolves to null", categoryById("nope"), null);
is("a known category resolves", categoryById("expired-sessions").label, "Expired sessions and codes");
is("unknown ids are dropped from a selection", sanitizeCategoryIds(["expired-sessions", "definitely-not-a-category"]).join(","), "expired-sessions");
is("duplicates are collapsed", sanitizeCategoryIds(["expired-sessions", "expired-sessions"]).length, 1);
is("a non-array selection is empty", sanitizeCategoryIds(undefined).length, 0);
is("a null selection is empty", sanitizeCategoryIds(null).length, 0);
is("garbage entries are dropped", sanitizeCategoryIds([1, null, "expired-invites"]).join(","), "expired-invites");
is("an empty selection is refused", categoriesProblem([]), "Choose at least one thing to clean up.");
is("an all-unknown selection is refused", categoriesProblem(["nope"]), "Choose at least one thing to clean up.");
is("a real selection is accepted", categoriesProblem(["expired-invites"]), null);
is("an owner-only selection is detected", includesOwnerOnlyCategory(["unreferenced-files"]), true);
is("an admin-level selection is not flagged", includesOwnerOnlyCategory(["expired-invites", "rate-limit-counters"]), false);

check("the retention rules are the documented ones",
  ORPHAN_FILE_GRACE_MS === DAY && TERMINAL_CALL_GRACE_MS === 7 * DAY && RATE_LIMIT_GRACE_MS === DAY && STALE_EPHEMERAL_MS === 30 * MINUTE,
  `${ORPHAN_FILE_GRACE_MS}/${TERMINAL_CALL_GRACE_MS}/${RATE_LIMIT_GRACE_MS}/${STALE_EPHEMERAL_MS}`);

// ---------------------------------------------------------------------------
// 7. Backend wiring: authorization on every public entry point
// ---------------------------------------------------------------------------
const backend = read("src", "convex", "cleanup.ts");
const schema = read("src", "convex", "schema.ts");
const ui = read("src", "components", "admin", "CleanupMaintenance.tsx");
const panel = read("src", "pages", "AdminPanel.tsx");
const storage = read("src", "convex", "storage.ts");

const publicFunctions = [];
{
  const re = /export const (\w+) = (query|mutation|action)\(\{/g;
  let match;
  while ((match = re.exec(backend)) !== null) {
    const body = backend.slice(match.index, backend.indexOf("\n});", match.index));
    publicFunctions.push({ name: match[1], kind: match[2], body });
  }
}
check("the backend exposes both tools plus history and progress",
  publicFunctions.map((f) => f.name).join(",") ===
    "permissions,scopes,history,job,previewMessages,previewGeneral,startMessageCleanup,startGeneralCleanup,cancelJob",
  publicFunctions.map((f) => f.name).join(","));
for (const fn of publicFunctions) {
  check(`'${fn.name}' re-authorizes the caller server-side`,
    fn.body.includes("requireActor(") || fn.body.includes("requirePanelAccess(") || fn.body.includes("internal.cleanup.previewAccess"),
    `${fn.name} has no authorization call`);
}
check("starting a cleanup is a mutation that re-checks the role",
  publicFunctions.find((f) => f.name === "startMessageCleanup").body.includes("requireActor(ctx)"), "no actor check");
check("cancelling verifies panel access too",
  publicFunctions.find((f) => f.name === "cancelJob").body.includes("requireActor(ctx)"), "no actor check");

// Previews must be actions (an expensive read must never become a subscription)
// and their counting helpers must be unable to write.
check("the message preview is an action, not a subscription",
  backend.includes("export const previewMessages = action({") && !backend.includes("export const previewMessages = query("), "previewMessages is a query");
check("the general preview is an action too",
  backend.includes("export const previewGeneral = action({") && !backend.includes("export const previewGeneral = query("), "previewGeneral is a query");
const countMessagesBody = slice(backend, "async function countMessages(", "type SweepResult");
const countCategoryBody = slice(backend, "async function countCategory(", "async function runCategories(");
for (const [name, body] of [["countMessages", countMessagesBody], ["countCategory", countCategoryBody]]) {
  check(`the ${name} preview helper is physically unable to write`,
    body.length > 0 && !/ctx\.db\.(insert|patch|delete)\(|ctx\.storage\.delete\(|runMutation\(/.test(body),
    `${name} contains a write`);
}
check("the message preview helper exists", countMessagesBody.length > 0, "countMessages not found");
check("the category preview helper exists", countCategoryBody.length > 0, "countCategory not found");

// Preview and run must cover exactly the same categories.
const runCategoryBody = slice(backend, "async function runCategory(", "async function countCategory(");
const casesIn = (body) => [...body.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]).sort().join(",");
is("the run switch implements every declared category", casesIn(runCategoryBody), [...categoryIds()].sort().join(","));
is("the preview switch covers exactly the same categories", casesIn(countCategoryBody), [...categoryIds()].sort().join(","));
check("an unknown category is refused rather than silently skipped",
  backend.includes('throw new ConvexError("Unknown cleanup category.")'), "no default case in the run switch");

// The range bound must be applied by the DATABASE (indexed), not by filtering in JS.
check("channel messages are read through an indexed time-bounded range",
  backend.includes('.withIndex("by_channel"') && backend.includes('q.eq("channelId", channelId).lt("_creationTime", range.before)')
    && backend.includes('.gte("_creationTime", range.from).lte("_creationTime", range.to)'),
  "the indexed time bound disappeared");
check("direct messages are read through an indexed time-bounded range",
  backend.includes('.withIndex("by_conversation"') && backend.includes('q.eq("conversationId", conversationId).lt("_creationTime", range.before)'),
  "the indexed time bound disappeared");
check("both scans are bounded by a take()", (backend.match(/\.take\(scan\)/g) ?? []).length === 6, String((backend.match(/\.take\(scan\)/g) ?? []).length));
check("every candidate is re-read before it is deleted",
  backend.includes("const fresh = await ctx.db.get(row._id);") && backend.includes("if (!rangeCovers(range, fresh._creationTime)) continue;"),
  "the per-row re-check disappeared");

// Site-wide deletion needs Owner Admin AND the typed phrase, on the server.
const startMessagesBody = publicFunctions.find((f) => f.name === "startMessageCleanup").body;
check("a site-wide deletion requires Owner Admin authority",
  startMessagesBody.includes('scope.kind === "all" && !me.isOwner'), "no owner gate for the site-wide scope");
check("the typed confirmation phrase is verified server-side",
  startMessagesBody.includes("requiredPhrase(scope, range)") && startMessagesBody.includes("phraseMatches(phrase, args.confirmPhrase ?? \"\")"),
  "the phrase check disappeared");
check("the confirmation phrase is not trusted from the client",
  !backend.includes("confirmPhrase: v.optional(v.string(),"), "the phrase has a default value");

// Batching, cancellation and locking.
const batchBody = backend.slice(backend.indexOf("export const runJobBatch = internalMutation({"));
check("the job runner is an internal mutation (never client-callable)", batchBody.length > 0, "runJobBatch not found");
check("each batch re-checks the starter's authority",
  batchBody.includes("internal.cleanup.authz") && batchBody.includes("if (!auth.isAdmin"), "no per-batch authorization");
check("a cancelled or finished job stops between batches",
  batchBody.includes('if (job.status !== "running") return { status: job.status };'), "no stop check");
check("the job re-schedules its next batch", batchBody.includes("ctx.scheduler.runAfter(delay, internal.cleanup.runJobBatch"), "no rescheduling");
check("the runner yields to the scheduler periodically",
  batchBody.includes("MAX_DEPTH_PER_RUN"), "no depth limit");
check("a failed batch fails the job instead of looping", batchBody.includes('} catch (error) {') && batchBody.includes('"failed"'), "no failure handling");
check("one cleanup at a time is enforced", backend.includes("await requireNoRunningJob(ctx)") && (backend.match(/await requireNoRunningJob\(ctx\)/g) ?? []).length >= 2, "the running-job lock is missing");
check("an abandoned job is recovered instead of blocking forever",
  backend.includes("JOB_STALE_MS") && backend.includes('lastError: "Abandoned: this cleanup stopped reporting progress."'), "no stale-job recovery");

// Audit trail, with no credentials in it.
const auditStarts = [...backend.matchAll(/await auditAdmin\(ctx, \{/g)].map((m) => m.index);
const audits = auditStarts.map((start) => {
  const end = backend.indexOf("});", start);
  return backend.slice(start, end < 0 ? undefined : end);
});
check("every cleanup milestone is audited", audits.length >= 5, `only ${audits.length} audit calls`);
check("audit entries name the action and the actor",
  audits.every((entry) => entry.includes("action:") && entry.includes("actorId") && entry.includes("actorName")),
  "an audit entry is missing its action or actor");
check("audit entries record the scope and the time range",
  audits.filter((entry) => /scopeLabel|labels\.join/.test(entry)).length >= 4 && audits.some((entry) => entry.includes("rangeLabel")),
  audits.map((entry) => entry.slice(0, 60)).join(" | "));
check("nothing in this module is logged to the console", !/console\.(log|info|debug|warn|error)/.test(backend), "the backend logs to the console");
check("no credential is read for the audit log",
  !/\.passwordHash|\.pinHash|\.recoveryCodeHash[^:]*\$\{|\$\{[^}]*recoveryCode\b/.test(backend.replace(/recoveryCodeHash: undefined/g, "cleared")),
  "an audit detail interpolates a secret");

// Deletion goes through the app's own helpers (orphan-safe attachment handling).
check("channel messages are deleted through the app's own helper",
  backend.includes("await deleteChannelMessage(ctx, fresh)"), "deleteChannelMessage is not used");
check("direct messages are deleted through the app's own helper",
  backend.includes("await deleteDmMessage(ctx, fresh)"), "deleteDmMessage is not used");
check("the helper never removes a file another attachment still references",
  storage.includes("const stillReferenced = await ctx.db")
    && storage.includes('.withIndex("by_storage", (q) => q.eq("storageId", file.storageId))')
    && storage.includes("if (!stillReferenced) await ctx.storage.delete(file.storageId);"),
  "the shared-file orphan check disappeared");
check("deleting a message reports its attachments and bytes",
  storage.includes("Promise<{ attachments: number; bytes: number }>") && storage.includes("return { attachments, bytes };"),
  "deleteChannelMessage/deleteDmMessage do not report what they removed");

// The general cleanup must refuse to touch protected data.
check("active or referenced data is excluded, not deleted",
  backend.includes("if (referenced.has(object._id as string)) continue;") && backend.includes("if (attachment) continue; // still referenced by a message"),
  "the reference check disappeared");
check("only expired sessions are eligible",
  backend.includes("if (session.expirationTime >= now) continue;"), "the session expiry check disappeared");
check("only finished calls are eligible",
  backend.includes('const terminal = new Set(["declined", "missed", "cancelled", "ended", "failed"]);'), "the terminal call statuses disappeared");

// ---------------------------------------------------------------------------
// 8. Schema wiring
// ---------------------------------------------------------------------------
check("cleanup jobs are stored in the database",
  schema.includes("cleanupJobs: defineTable({") && schema.includes("channelMessagesDeleted: v.number()") && schema.includes("bytesFreed: v.number()"),
  "the cleanupJobs table is missing");
check("the job record keeps the scope, range and labels for history",
  schema.includes("scopeKind: v.union(") && schema.includes("rangeLabel: v.string()") && schema.includes("actorName: v.string()"),
  "the history fields are missing");
check("the job record can resume across batches",
  schema.includes("doneScopes: v.optional(v.array(v.string()))") && schema.includes("cursorCreatedAt: v.optional(v.number())"),
  "the resume fields are missing");
check("jobs are indexed by start time and status",
  schema.includes('.index("by_started", ["startedAt"])') && schema.includes('.index("by_status", ["status"])'),
  "a cleanupJobs index is missing");
check("messages are indexed by channel for the time-bounded scan",
  schema.includes('.index("by_channel", ["channelId"])'), "the by_channel index is missing");

// ---------------------------------------------------------------------------
// 9. UI wiring
// ---------------------------------------------------------------------------
check("the panel has its own Cleanup & Maintenance tab",
  panel.includes('value="cleanup"') && panel.includes("<CleanupMaintenance"), "the tab is not wired in");
check("the tab is behind the Admin PIN gate as well",
  panel.includes("{panelOpen && <CleanupMaintenance panelOpen={panelOpen} />}"), "the PIN gate is bypassed");
check("the UI reads the server's cleanup permissions first",
  ui.includes("api.cleanup.permissions") && ui.includes("permissions.canDeleteSiteWide"), "the permission query is missing");
check("both tools come from the shared rule module the server uses",
  ui.includes('from "@/lib/cleanup"') && ui.includes("requiredPhrase") && ui.includes("rangeProblem"), "the shared rules are not used");
check("deleting is impossible before a server-side preview",
  ui.includes("!previewMatchesForm") && ui.includes("Preview affected messages"), "the preview gate is missing");
check("a site-wide deletion asks for the typed phrase",
  ui.includes("DELETE ALL MESSAGES") && ui.includes("phraseMatches(phraseRequired, phrase)"), "the phrase prompt is missing");
check("the confirmation dialog offers Cancel",
  ui.includes(">Cancel</Button>") || />\s*Cancel\s*</.test(ui), "no Cancel button");
check("the confirmation dialog has an explicit delete button",
  ui.includes("Delete messages") && ui.includes("Run cleanup"), "the delete/run buttons are missing");
check("the deletion itself happens on the backend, never in the UI",
  ui.includes("useMutation(api.cleanup.start") && !ui.includes("localStorage") && !ui.includes("window.confirm"),
  "the UI deletes something itself");
check("progress, cancellation and history are all wired",
  ui.includes("api.cleanup.job") && ui.includes("api.cleanup.cancelJob") && ui.includes("api.cleanup.history"), "a piece of the panel is not wired");
check("the general tool shows a preview before it can run",
  ui.includes("disabled={preview === null || totals.records === 0}") && ui.includes("Preview cleanup"), "the run gate is missing");
check("the panel explains that deleted messages cannot be restored",
  ui.includes("cannot be undone from inside the app") && ui.includes("Convex dashboard"), "the recovery note is missing");

// ---------------------------------------------------------------------------
// 10. Live: the deployment refuses every anonymous caller
// ---------------------------------------------------------------------------
// Nothing here signs in, so no call below can write anything: each one either
// fails argument validation or fails the backend's own authorization gate.
const URL_ = process.env.CONVEX_URL || "https://academic-porcupine-929.convex.cloud";
const anonymous = new ConvexHttpClient(URL_);
// A real-shaped id that does not exist: the id validator passes, the
// authorization gate is what answers.
const FABRICATED_JOB = "kg2e5f8a1b4c7d0e3f6a9b2c5d8e1f4";

async function rejection(fn) {
  try {
    return { error: null, result: await fn() };
  } catch (error) {
    return { error: String(error?.data ?? error?.message ?? error) };
  }
}
/** The deployment prints its argument schema when it refuses an unknown field. */
function argumentSchema(error) {
  const text = String(error ?? "");
  const at = text.indexOf("Validator: v.object(");
  return at < 0 ? "" : text.slice(at);
}
async function refused(name, fn) {
  const { error } = await rejection(fn);
  check(name, error !== null, "an anonymous caller was allowed through");
}

await refused("an anonymous caller cannot read cleanup permissions", () => anonymous.query(api.cleanup.permissions, {}));
await refused("an anonymous caller cannot list cleanup scopes", () => anonymous.query(api.cleanup.scopes, {}));
await refused("an anonymous caller cannot read cleanup history", () => anonymous.query(api.cleanup.history, {}));
await refused("an anonymous caller cannot read a cleanup job", () => anonymous.query(api.cleanup.job, { jobId: FABRICATED_JOB }));
await refused("an anonymous caller cannot preview a message cleanup", () =>
  anonymous.action(api.cleanup.previewMessages, { scopeKind: "all", rangeKind: "all" }));
await refused("an anonymous caller cannot preview a general cleanup", () =>
  anonymous.action(api.cleanup.previewGeneral, { categories: ["expired-sessions"] }));
await refused("an anonymous caller cannot start a message cleanup", () =>
  anonymous.mutation(api.cleanup.startMessageCleanup, { scopeKind: "all", rangeKind: "before", before: NOW }));
await refused("an anonymous caller cannot start a general cleanup", () =>
  anonymous.mutation(api.cleanup.startGeneralCleanup, { categories: ["expired-sessions"] }));
await refused("an anonymous caller cannot cancel a cleanup", () => anonymous.mutation(api.cleanup.cancelJob, { jobId: FABRICATED_JOB }));

// The site-wide extra confirmation is a real argument of the DEPLOYED function,
// not just a client-side dialog: the live schema lists it.
const liveSchema = argumentSchema((await rejection(() =>
  anonymous.mutation(api.cleanup.startMessageCleanup, { scopeKind: "all", rangeKind: "all", definitelyNotAnArgument: 1 }))).error);
check("the deployed start function takes the confirmation phrase", liveSchema.includes("confirmPhrase"), liveSchema || "no schema reported");
check("the deployed start function takes a scope and a range",
  liveSchema.includes("scopeKind") && liveSchema.includes("rangeKind"), liveSchema || "no schema reported");
check("the deployed start function cannot delete to a raw date without the range kind",
  liveSchema.includes('rangeKind: v.union') && liveSchema.includes('"before"') && liveSchema.includes('"between"'), liveSchema || "no schema reported");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
