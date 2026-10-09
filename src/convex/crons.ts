import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

/**
 * Background maintenance. The cleanup job is isolated from normal app traffic:
 * it runs on its own schedule, takes a lock, and deletes only old disposable
 * message history in small batches. Users keep chatting while it runs.
 */
const crons = cronJobs();

// Watch usage and start pruning long before a hard limit.
//
// This used to tick every 10 minutes, which — measured against this
// deployment's own numbers — was the single biggest consumer of database I/O:
// each run reads three disposable tables (up to 500 rows each) plus the oldest
// message slices even when there is nothing to delete, so 144 runs a day cost
// roughly 0.2 GB of monthly I/O on their own. That is what pushed the
// deployment past its configured Database I/O limit and paused it.
//
// Hourly is 6× cheaper and loses nothing: retention is 30 days, the sweep can
// still chain several bounded batches within one run, and stale typing rows /
// call signals are ignored by their readers after seconds (see
// `typingIn` and the signal recency checks), so pruning them less often only
// leaves harmless dead rows behind for a while. On-demand pruning after a
// failed write is unchanged (`storage.requestCleanup`).
crons.interval("storage retention sweep", { hours: 1 }, internal.storage.runCleanup, {});

export default crons;
