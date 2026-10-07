// Unit tests for collectChannelNotifyTargets — the rules that decide who gets a
// "new message in #channel" notification. src/convex/chat.ts calls this module,
// so these are the real production rules, not a copy.
// Run: bun server-notifications-test.mjs
import { collectChannelNotifyTargets } from "./src/lib/server-notifications";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e ?? ""}`); };

function eq(name, got, expected) {
  const g = JSON.stringify(got), x = JSON.stringify(expected);
  if (g === x) ok(name); else bad(name, `got ${g}, expected ${x}`);
}

const NONE = new Set();
/** Run the collector with permissive defaults plus the given overrides. */
async function targets(candidates, over = {}) {
  return collectChannelNotifyTargets({
    senderId: "author",
    candidates,
    alreadyNotified: over.alreadyNotified ?? NONE,
    mutedChannelUserIds: over.mutedChannelUserIds ?? NONE,
    isBlocked: over.isBlocked ?? (async () => false),
    canViewChannel: over.canViewChannel ?? (async () => true),
  });
}

const member = (userId, extra = {}) => ({ userId, ...extra });

// ---- The happy path (the case the user actually tests) --------------------
{
  const got = await targets([member("author"), member("bob"), member("owner")]);
  eq("sender is skipped, everyone else in the community is notified", got, ["bob", "owner"]);
}
{
  const got = await targets([member("bob", { role: "owner" }), member("carol", { role: "member" })]);
  eq("a community owner receives notifications like anyone else", got, ["bob", "carol"]);
}
eq("no members means nobody to notify", await targets([]), []);
eq("input order is preserved", await targets([member("zoe"), member("alice")]), ["zoe", "alice"]);

// ---- Someone already notified (mention / reply) ---------------------------
eq("a member already notified for this message is never notified twice",
  await targets([member("bob"), member("carol")], { alreadyNotified: new Set(["bob"]) }), ["carol"]);
eq("the reply target is not notified again",
  await targets([member("bob")], { alreadyNotified: new Set(["bob"]) }), []);

// ---- Mutes -----------------------------------------------------------------
eq("a member who muted the community is skipped",
  await targets([member("bob", { mutedCommunity: true }), member("carol")]), ["carol"]);
eq("a member who muted the channel is skipped",
  await targets([member("bob"), member("carol")], { mutedChannelUserIds: new Set(["bob"]) }), ["carol"]);
eq("muting a channel only silences that channel's members",
  await targets([member("bob"), member("carol")], { mutedChannelUserIds: new Set(["bob", "dave"]) }), ["carol"]);

// ---- Blocks, timeouts and visibility --------------------------------------
eq("a blocked member is skipped",
  await targets([member("bob"), member("carol")], { isBlocked: async (id) => id === "bob" }), ["carol"]);
eq("a timed-out member is skipped",
  await targets([member("bob", { timedOut: true }), member("carol")]), ["carol"]);
eq("a member who cannot view the channel is skipped",
  await targets([member("bob"), member("carol")], { canViewChannel: async (id) => id !== "bob" }), ["carol"]);
const stacked = await targets(
  [member("muted"), member("chan"), member("blocked"), member("gone"), member("fine")],
  {
    mutedChannelUserIds: new Set(["chan"]),
    isBlocked: async (id) => id === "blocked",
    canViewChannel: async (id) => id !== "gone",
    alreadyNotified: new Set(["muted"]),
  },
);
eq("every rule stacks (only the clean member survives)", stacked, ["fine"]);

// ---- Expensive lookups only run for surviving candidates -------------------
{
  const blockedCalls = [];
  const viewCalls = [];
  const got = await targets(
    [
      member("author"),
      member("muted", { mutedCommunity: true }),
      member("chan"),
      member("timed", { timedOut: true }),
      member("bob"),
    ],
    {
      mutedChannelUserIds: new Set(["chan"]),
      isBlocked: async (id) => { blockedCalls.push(id); return false; },
      canViewChannel: async (id) => { viewCalls.push(id); return true; },
    },
  );
  eq("only the surviving member is notified", got, ["bob"]);
  eq("the block lookup never runs for a skipped member", blockedCalls, ["bob"]);
  eq("the visibility lookup never runs for a skipped member", viewCalls, ["bob"]);
}
{
  const viewCalls = [];
  await targets([member("bob")], {
    isBlocked: async () => true,
    canViewChannel: async (id) => { viewCalls.push(id); return true; },
  });
  eq("a blocked member skips the (more expensive) visibility lookup", viewCalls, []);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
