// Regression tests for the Convex request-volume fix.
// Run: bun search-debounce-test.mjs
//
// WHY THIS EXISTS
// ---------------
// The deployment was hard-paused for exceeding its "Function calls / month"
// limit. The dominant cause was NOT client polling — client timers are clean —
// but SUBSCRIPTION CHURN: a `useQuery` is a reactive subscription whose
// identity is its arguments, so feeding a search box's raw keystrokes into
// those arguments created a brand-new subscription and a separate function
// execution on every single character. Two of the affected queries
// (`search.global` and `dms.messages`) also scan the message text index, so
// each keystroke was an expensive execution as well as a new call.
//
// These assertions read the real component sources, so a future edit that
// removes the debounce fails here instead of quietly resuming the call storm.
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name}${detail === undefined ? "" : ` -> ${detail}`}`); }
}
const eq = (name, actual, expected) =>
  check(name, actual === expected, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// ---------------------------------------------------------------------------
// 1. The shared hook exists and actually debounces
// ---------------------------------------------------------------------------
console.log("\n-- the hook --");
const hook = read("./src/hooks/use-debounced-value.ts");
check("the debounce hook exists", hook.includes("export function useDebouncedValue"));
check("it holds the debounced value in state", hook.includes("useState(value)"));
check("it defers via a timer, not a synchronous set", hook.includes("setTimeout(() => setDebounced("));
check("it cancels the pending timer on every change", hook.includes("clearTimeout(timer)"));
check("it re-runs when the delay changes", hook.includes("[value, delayMs]"));
check("the default delay matches the project's existing search debounce", /delayMs = 300/.test(hook));

// ---------------------------------------------------------------------------
// 2. Every search box that feeds a query argument is debounced
// ---------------------------------------------------------------------------
console.log("\n-- no per-keystroke queries --");
/**
 * The argument expression of the FIRST `useQuery(fn, ...)` call, bounded to a
 * window so we read the real argument object rather than the whole file. The
 * regression shape is `{ q: query }` (raw keystrokes) versus the fixed shape
 * `{ q: debouncedQuery }`, so the assertions below compare those exact shapes.
 */
function queryArgs(source, fn) {
  const at = source.indexOf(`useQuery(${fn}`);
  return at === -1 ? null : source.slice(at, at + 260);
}

const sites = [
  // name, path, function, arg key, raw variable, debounced variable
  ["SearchView", "./src/components/dashboard/SearchView.tsx", "api.search.global", "q", "query", "debouncedQuery"],
  ["DiscoverView", "./src/components/dashboard/DiscoverView.tsx", "api.communities.discover", "q", "query", "debouncedQuery"],
  ["NewMessageDialog", "./src/components/dashboard/NewMessageDialog.tsx", "api.users.searchUsers", "q", "query", "debouncedQuery"],
  ["DmView message search", "./src/components/dashboard/DmView.tsx", "api.dms.messages", "search", "search", "debouncedSearch"],
  ["DmView member search", "./src/components/dashboard/DmView.tsx", "api.users.searchUsers", "q", "memberQuery", "debouncedMemberQuery"],
];

for (const [name, path, fn, key, raw, debounced] of sites) {
  const source = stripComments(read(path));
  const args = queryArgs(source, fn);
  check(`${name} imports the debounce hook`, source.includes('from "@/hooks/use-debounced-value"'));
  check(`${name} debounces \`${raw}\``, source.includes(`useDebouncedValue(${raw})`));
  check(`${name} passes the DEBOUNCED value as \`${key}\` to ${fn}`,
    args !== null && args.includes(`${key}: ${debounced}`));
  check(`${name} never passes the raw \`${raw}\` value to ${fn}`,
    args !== null && !new RegExp(`${key}:\\s*${raw}\\b`).test(args));
}

// ---------------------------------------------------------------------------
// 3. Constant-argument subscriptions are left alone
// ---------------------------------------------------------------------------
console.log("\n-- constant-arg subscriptions --");
// These run once for an empty term: no keystrokes reach them, so they must NOT
// pay a debounce delay on first paint.
for (const path of ["src/components/dashboard/HomeView.tsx", "src/pages/Onboarding.tsx"]) {
  const source = stripComments(read(`./${path}`));
  check(`${path} uses a constant empty search arg`, /useQuery\(api\.users\.searchUsers, \{ q: "" \}\)/.test(source));
  check(`${path} needs no debounce because it never sees keystrokes`, !source.includes("useDebouncedValue"));
}

// The guard above must actually be able to catch the regression it claims to
// catch: it MUST match the raw shape and MUST NOT match the fixed shape.
const rawGuard = /q:\s*query\b/;
check("the raw-value guard catches the regression shape (self-test)",
  rawGuard.test("useQuery(api.users.searchUsers, { q: query })"));
check("...and accepts the fixed shape (self-test)",
  !rawGuard.test("useQuery(api.users.searchUsers, { q: debouncedQuery })"));

// ---------------------------------------------------------------------------
// 4. The other request-drivers stay cheap
// ---------------------------------------------------------------------------
console.log("\n-- other drivers --");
const dashboard = stripComments(read("./src/pages/Dashboard.tsx"));
const heartbeat = dashboard.match(/setInterval\(beat, ([\d_]+)\)/);
check("presence heartbeat is a real interval, not a tight loop", heartbeat !== null, "no setInterval(beat, ...) found");
if (heartbeat) {
  const ms = Number(heartbeat[1].replace(/_/g, ""));
  check(`presence heartbeat is at most every 30s (${ms}ms)`, ms >= 30_000, `${ms}ms`);
}
check("presence writes nothing while the tab is hidden", dashboard.includes('document.visibilityState === "visible"'));
check("presence writes nothing while offline", dashboard.includes("navigator.onLine !== false"));

const typing = stripComments(read("./src/hooks/use-typing.ts"));
check("typing pings are throttled", /now - lastSent\.current < 2500/.test(typing));
check("only the throttled send() reaches the backend",
  typing.includes("send();") && !/onType = useCallback\([\s\S]{0,200}setChannelTyping\(/.test(typing));

const crons = stripComments(read("./src/convex/crons.ts"));
const intervals = [...crons.matchAll(/\{ (hours|minutes): (\d+) \}/g)];
check("every cron runs at most hourly", intervals.length > 0 && intervals.every(([, unit, n]) => unit === "hours" || Number(n) >= 60),
  intervals.map((m) => m[0]).join(", ") || "no interval crons found");

const statusHook = stripComments(read("./src/hooks/use-service-status.ts"));
check("the status tick timer only runs while unhealthy",
  /if \(status\.phase === "ready"\) return;/.test(statusHook));
// The backoff constant lives in the pure derivation module, not the hook.
check("retry backoff is capped",
  /MAX_RETRY_COOLDOWN_MS = 60_000/.test(stripComments(read("./src/lib/service-status.ts"))));

const usageMonitor = stripComments(read("./src/lib/usage-monitor.ts"));
check("the usage monitor is inert in production", usageMonitor.includes("import.meta.env.DEV"));

// ---------------------------------------------------------------------------
// 5. Call signaling is reactive, not polled
// ---------------------------------------------------------------------------
console.log("\n-- voice/call signaling --");
for (const path of ["./src/components/CallPanel.tsx", "./src/components/dashboard/DmCallPanel.tsx"]) {
  const source = stripComments(read(path));
  check(`${path} subscribes to signals instead of polling`,
    /useQuery\(api\.(communities|calls)\.poll[A-Za-z]*Signals/.test(source));
  const signalPollTimer = /setInterval\([^)]*[Ss]ignal/.test(source);
  check(`${path} has no signal polling timer`, !signalPollTimer);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
