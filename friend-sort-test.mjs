// Tests for the friends-list order: most recently online first, with online
// friends above offline ones and never-seen friends last.
//
// Run: bun friend-sort-test.mjs
//
// Three layers, none of which creates an account (the deployment guard forbids
// synthetic users in production):
//   1. the pure ordering rule (`src/lib/friend-sort.ts`),
//   2. the real source of the presence system and the friends list, asserting the
//      timestamps come from the database, are written on heartbeat/disconnect,
//      survive an unexpected disconnection, and that the privacy rules hide both
//      the status AND the timestamps of a hidden friend,
//   3. a live, read-only call proving the friends query answers.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "./src/convex/_generated/api.js";
import {
  ACTIVE_PRESENCE,
  OFFLINE_TIER,
  activityTimestamp,
  isActivePresence,
  neverSeen,
  presenceRank,
  sortFriendsByActivity,
} from "./src/lib/friend-sort";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, detail) => { fail++; console.log(`FAIL: ${name} -> ${detail ?? ""}`); };
const is = (name, got, expected) => {
  if (got === expected) ok(name);
  else bad(name, `got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
};
const check = (name, condition, detail) => (condition ? ok(name) : bad(name, detail));
const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");
function handlerOf(source, declaration) {
  const start = source.indexOf(declaration);
  if (start < 0) return "";
  const end = source.indexOf("\n});", start);
  return source.slice(start, end < 0 ? undefined : end);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

/** A friend card, with only the fields the ordering uses being interesting. */
function friend(id, presence, lastSeen, extra = {}) {
  return { userId: id, displayName: id, presence, lastSeen, ...extra };
}
const ids = (list) => list.map((f) => f.userId).join(",");

// ---------------------------------------------------------------------------
// 1. The rule (pure)
// ---------------------------------------------------------------------------
is("online ranks first", presenceRank("online"), 0);
is("do-not-disturb ranks above idle", presenceRank("dnd") < presenceRank("idle"), true);
is("offline ranks last", presenceRank("offline"), OFFLINE_TIER);
is("an unknown presence is treated as offline", presenceRank("something-new"), OFFLINE_TIER);
is("a missing presence is treated as offline", presenceRank(undefined), OFFLINE_TIER);
is("online counts as active", isActivePresence("online"), true);
is("idle counts as active", isActivePresence("idle"), true);
is("dnd counts as active", isActivePresence("dnd"), true);
is("invisible does NOT count as active", isActivePresence("invisible"), false);
is("offline does not count as active", isActivePresence("offline"), false);
is("an online friend is ordered by their last interaction", activityTimestamp({ presence: "online", lastActive: NOW, lastSeen: NOW - HOUR }), NOW);
is("an online friend without lastActive falls back to lastSeen", activityTimestamp({ presence: "online", lastSeen: NOW }), NOW);
is("an offline friend is ordered by lastSeen (lastActive is ignored)", activityTimestamp({ presence: "offline", lastActive: NOW, lastSeen: NOW - HOUR }), NOW - HOUR);
is("a friend with no timestamp is zero", activityTimestamp({ presence: "offline", lastSeen: null }), 0);
is("a zero timestamp counts as never seen", neverSeen({ presence: "offline", lastSeen: 0 }), true);
is("a real timestamp is not never-seen", neverSeen({ presence: "offline", lastSeen: NOW }), false);

// The order the request asks for: online, then offline by recency, then unknown.
{
  const list = [
    friend("never-online", "offline", null),
    friend("offline-old", "offline", NOW - 3 * HOUR),
    friend("idle-friend", "idle", NOW - 10 * MINUTE, { lastActive: NOW - 10 * MINUTE }),
    friend("online-recent", "online", NOW - MINUTE, { lastActive: NOW - MINUTE }),
    friend("offline-recent", "offline", NOW - 5 * MINUTE),
    friend("online-older", "online", NOW - 20 * MINUTE, { lastActive: NOW - 20 * MINUTE }),
  ];
  is("online friends come first, most recently active first",
    ids(sortFriendsByActivity(list).slice(0, 2)), "online-recent,online-older");
  is("idle friends come after online ones", sortFriendsByActivity(list)[2].userId, "idle-friend");
  is("offline friends follow, most recently online first",
    ids(sortFriendsByActivity(list).slice(3, 5)), "offline-recent,offline-old");
  is("a friend who was never online is last", sortFriendsByActivity(list)[5].userId, "never-online");
  check("every friend is kept exactly once", sortFriendsByActivity(list).length === list.length);
}
{
  // A friend who comes online moves to the top of the list.
  const before = [friend("a", "offline", NOW - HOUR), friend("b", "online", NOW - MINUTE, { lastActive: NOW - MINUTE })];
  const after = [friend("a", "online", NOW, { lastActive: NOW }), friend("b", "online", NOW - MINUTE, { lastActive: NOW - MINUTE })];
  is("offline first while offline", ids(sortFriendsByActivity(before)), "b,a");
  is("coming online moves them to the top", ids(sortFriendsByActivity(after)), "a,b");
  // Going offline keeps the last-online time and drops them into that order.
  const offlineAgain = [friend("a", "offline", NOW - 1), friend("b", "online", NOW - MINUTE, { lastActive: NOW - MINUTE })];
  is("going offline sorts them by when they were last online", ids(sortFriendsByActivity(offlineAgain)), "b,a");
}
{
  // Timestamps equal → deterministic, stable order (name, then username, then id).
  const tied = [friend("z", "offline", NOW, { displayName: "Zoe" }), friend("a", "offline", NOW, { displayName: "Amy" })];
  is("equal timestamps fall back to the display name", ids(sortFriendsByActivity(tied)), "a,z");
  const sameName = [friend("u2", "offline", NOW, { displayName: "Sam", username: "sam_b" }), friend("u1", "offline", NOW, { displayName: "Sam", username: "sam_a" })];
  is("equal names fall back to the username", ids(sortFriendsByActivity(sameName)), "u1,u2");
  const noNames = [friend("b", "offline", NOW), friend("a", "offline", NOW)];
  is("no names at all fall back to the id", ids(sortFriendsByActivity(noNames)), "a,b");
  const shuffled = [friend("c", "offline", NOW), friend("a", "offline", NOW), friend("b", "offline", NOW)];
  is("the tie order is the same every time (stable)", ids(sortFriendsByActivity(shuffled)), ids(sortFriendsByActivity([...shuffled].reverse())));
}
{
  const original = [friend("b", "offline", NOW - HOUR), friend("a", "online", NOW, { lastActive: NOW })];
  const snapshot = ids(original);
  sortFriendsByActivity(original);
  is("the input array is never mutated", ids(original), snapshot);
  is("an empty list stays empty", sortFriendsByActivity([]).length, 0);
  is("a single friend is unchanged", ids(sortFriendsByActivity([original[0]])), "b");
}
check("the active set and the ranks agree", [...ACTIVE_PRESENCE].every((p) => presenceRank(p) < OFFLINE_TIER), "an active presence ranks as offline");

// ---------------------------------------------------------------------------
// 2a. The timestamps come from the database (presence table), not samples
// ---------------------------------------------------------------------------
const profiles = read("src", "convex", "profiles.ts");
const lib = read("src", "convex", "lib.ts");
const social = read("src", "convex", "social.ts");
const schema = read("src", "convex", "schema.ts");

const presenceTable = schema.slice(schema.indexOf("presence: defineTable("), schema.indexOf("presence: defineTable(") + 500);
check("the last-online time is a stored column", presenceTable.includes("lastSeen: v.number()"), "presence.lastSeen disappeared from the schema");
check("the last interaction is stored too", presenceTable.includes("lastActive: v.optional(v.number())"), "presence.lastActive disappeared from the schema");
check("the connection state is stored", presenceTable.includes("connected: v.optional(v.boolean())"), "presence.connected disappeared from the schema");
check("the timestamp is written on every heartbeat", handlerOf(profiles, "export const heartbeat = mutation({").includes("lastSeen: now"), "the heartbeat no longer refreshes lastSeen");
check("the timestamp is written when a session ends", handlerOf(profiles, "export const disconnect = mutation({").includes("lastSeen: now"), "disconnect no longer records last-online");
check("a session that never heart-beated still gets a timestamp", handlerOf(profiles, "export const disconnect = mutation({").includes("ctx.db.insert(\"presence\", { userId, status: \"offline\", lastSeen: now, connected: false })"), "the disconnect upsert disappeared");
check("choosing a status records the time too", handlerOf(profiles, "export const setPresence = mutation({").includes("lastSeen: Date.now()"), "setPresence no longer records the time");
const presenceInfo = lib.slice(lib.indexOf("export async function presenceInfoOf("), lib.indexOf("export async function avatarUrlOf("));
check("an unexpected disconnection (no heartbeat) is treated as offline", presenceInfo.includes("Date.now() - lastSeen > 90_000"), "the staleness window disappeared");
check("…without erasing the real last-online time", !/lastSeen = null/.test(presenceInfo.split("if (viewerId && viewerId !== userId)")[0]), "the stale branch would delete the stored timestamp");
check("the effective status is derived server-side", presenceInfo.includes("status = \"offline\""), "the derived status disappeared");
check("both timestamps are returned", presenceInfo.includes("return { status, lastSeen, lastActive }"), "the returned timestamps changed shape");
check("the friend card carries them to the client", social.includes("presence: status,") && social.includes("lastActive,"), "the friend card no longer carries the timestamps");

// ---------------------------------------------------------------------------
// 2b. Privacy: hidden presence hides the timestamps as well
// ---------------------------------------------------------------------------
check("an invisible friend reads as offline to others", presenceInfo.includes('if (status === "invisible") status = "offline"'), "invisible handling disappeared");
check("a friend who hides presence reads as offline", presenceInfo.includes("settings?.presenceVisible === false"), "presenceVisible handling disappeared");
check("their timestamps are withheld from other viewers",
  presenceInfo.includes('if (status === "offline" && (p?.status === "invisible" || settings?.presenceVisible === false)) {') &&
  presenceInfo.includes("lastSeen = null;"),
  "a hidden friend's last-online time would leak");
check("the viewer still sees their own timestamps", /if \(viewerId && viewerId !== userId\) \{[\s\S]*lastSeen = null/.test(presenceInfo), "the own-view exception disappeared");
check("no session/token is exposed in a friend card", !/sessionId|token|password|pinHash/i.test(handlerOf(social, "async function publicCard(")), "the public card exposes session data");

// ---------------------------------------------------------------------------
// 2c. The friends list is ordered by that data, on both sides
// ---------------------------------------------------------------------------
const listFriends = handlerOf(social, "export const listFriends = query({");
check("the friends query imports the shared rule", social.includes('import { sortFriendsByActivity } from "../lib/friend-sort"'), "the query no longer uses the shared rule");
check("the friends query applies it", listFriends.includes("return sortFriendsByActivity(cards);"), "the query returns an unsorted list");
check("the old online-then-alphabetical sort is gone", !/rank\(x\.presence\)/.test(social), "the old alphabetical sort is still there");
check("the list is built from the real friendships table", listFriends.includes('ctx.db.query("friendships")'), "the list no longer reads real friendships");
check("the list is a reactive query (live re-ordering)", /export const listFriends = query\(\{/.test(social), "the friends list is no longer a query");

const home = read("src", "components", "dashboard", "HomeView.tsx");
check("the client applies the same rule", home.includes("sortFriendsByActivity(toSafeArray<") && home.includes('import { sortFriendsByActivity } from "@/lib/friend-sort"'), "the client list is no longer ordered by the shared rule");
check("the order updates with presence (reactive subscription)", home.includes("useQuery(api.social.listFriends, {})"), "the friends query is no longer subscribed");
check("each friend keeps their picture, username and status", home.includes("presence={f.presence}") && home.includes("url={f.avatarUrl}") && home.includes("dotSide=\"left\" showAllStates"), "a friend row lost its avatar/status");
check("an offline friend shows when they were last online", home.includes("f.presence === \"offline\" ? formatLastSeen(f.lastSeen)"), "the last-seen line disappeared");
check("a friend who was never online says so", read("src", "components", "dashboard", "ui.tsx").includes('if (!ts) return "Last online unknown";'), "the never-online label disappeared");
// The row is responsive: the name block shrinks and truncates, so a long name
// can never push a friend's status or the action buttons off a narrow screen.
{
  const css = read("src", "index.css");
  const rule = (selector) => {
    const start = css.indexOf(selector);
    if (start < 0) return "";
    const end = css.indexOf("}", start);
    return end < 0 ? "" : css.slice(start + selector.length, end);
  };
  check("the friend row's text block may shrink", rule(".fc-row-main > span {").includes("min-width: 0"), "a long name could widen the row");
  check("a long friend name truncates", rule(".fc-row-main strong {").includes("text-overflow: ellipsis"), "the friend name has no ellipsis");
  check("the friend's status line truncates too", rule(".fc-row-main small {").includes("text-overflow: ellipsis"), "the status line has no ellipsis");
  check("the row has no fixed width", !/\.fc-row \{[^}]*width: \d+px/.test(css), "a fixed row width would break small screens");
}

// ---------------------------------------------------------------------------
// 2d. The status indicators themselves (green / yellow / gray)
// ---------------------------------------------------------------------------
const ui = read("src", "components", "dashboard", "ui.tsx");
check("online is a green dot", /online: \{ color: "#3ddc97"/.test(ui), "the online colour changed");
check("idle is a yellow dot", /idle: \{ color: "#f5c451"/.test(ui), "the idle colour changed");
check("offline is a gray dot", /offline: \{ color: "#6b6880"/.test(ui), "the offline colour changed");
check("offline friends still get a dot in lists that opt in", ui.includes("showAllStates") && ui.includes("const showDot = showAllStates"), "the grey offline dot disappeared");
check("the dot is labelled for assistive tech", ui.includes("aria-label={meta.label}"), "the status dot lost its label");
check("an offline dot explains itself with the last-seen time", ui.includes("presence === \"offline\" || presence === \"invisible\" ? formatLastSeen(lastSeen)"), "the avatar title no longer shows last-seen");
const dashboard = read("src", "pages", "Dashboard.tsx");
check("presence is heart-beated while the app is open", dashboard.includes("setInterval(beat, 30_000)"), "the heartbeat interval disappeared");
check("a closing tab records the disconnect", dashboard.includes("window.addEventListener(\"beforeunload\", bye)") && dashboard.includes("disconnect({})"), "the unload disconnect disappeared");

// ---------------------------------------------------------------------------
// 3. Live: the friends query answers (read-only, no session)
// ---------------------------------------------------------------------------
const anonymous = new ConvexHttpClient(process.env.CONVEX_URL || "https://academic-porcupine-929.convex.cloud");
async function rejection(fn) {
  try {
    return { error: null, result: await fn() };
  } catch (error) {
    return { error: String(error?.data ?? error?.message ?? error) };
  }
}
const listed = await rejection(() => anonymous.query(api.social.listFriends, {}));
check("the friends list answers without a session (empty, never an error)",
  !listed.error && Array.isArray(listed.result) && listed.result.length === 0,
  listed.error ?? JSON.stringify(listed.result));
// Presence must never be exposed for someone you are not connected to.
const others = await rejection(() => anonymous.query(api.users.searchUsers, { q: "" }));
check("an anonymous caller gets no presence-carrying user list", !others.error || /sign in|authenticat/i.test(others.error ?? ""), others.error ?? JSON.stringify(others.result)?.slice(0, 120));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
