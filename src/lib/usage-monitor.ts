/**
 * Development-only Convex activity monitor.
 *
 * Counts the app's HIGH-FREQUENCY operations (heartbeats, typing pings, signal
 * relays, retries, cleanup activity) and logs a rolling 30s summary to the
 * console so a runaway feature is visible BEFORE it reaches production and can
 * hit a deployment usage limit.
 *
 * - Completely inert in production builds (`import.meta.env.DEV === false`):
 *   `trackOp` returns immediately and no timer is ever installed.
 * - Never records user data, ids, message bodies or secrets — only operation
 *   names and counts.
 */
type Counters = Record<string, number>;

const counters: Counters = {};
let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  setInterval(() => {
    const entries = Object.entries(counters);
    if (entries.length === 0) return;
    console.info("[usage] Freecord Convex ops (last 30s):", Object.fromEntries(entries));
    for (const key of Object.keys(counters)) delete counters[key];
  }, 30_000);
}

/** Record one or more occurrences of a named operation. No-op in production. */
export function trackOp(name: string, count = 1): void {
  if (!import.meta.env.DEV) return;
  counters[name] = (counters[name] ?? 0) + count;
  install();
}
