import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

/**
 * Background maintenance. The cleanup job is isolated from normal app traffic:
 * it runs on its own schedule, takes a lock, and deletes only old disposable
 * message history in small batches. Users keep chatting while it runs.
 */
const crons = cronJobs();

// Continuously watch usage and start pruning long before a hard limit.
crons.interval("storage retention sweep", { minutes: 10 }, internal.storage.runCleanup, {});

export default crons;
