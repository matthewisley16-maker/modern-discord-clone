// Unit tests for the per-execution @mention resolution cache (no backend needed).
//
// WHY: `chat.messages` / `dms.messages` expand a whole page of history in ONE
// query execution, and that execution repeats on every new message. Each
// @mention used to cost a `users` lookup plus a membership check PER MESSAGE, so
// a page mentioning the same person 30 times paid for it 30 times.
//
// These tests use a fake Convex ctx that counts every index lookup, so they
// prove both the correctness of the cache AND that it actually removes reads.
//
// Run: bun mention-cache-test.mjs
import { resolveMentions } from "./src/convex/mentions.ts";

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e?.message ?? e}`); };
const check = async (name, fn) => { try { await fn(); ok(name); } catch (e) { bad(name, e); } };
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const SERVER_ID = "servers:1";
const CONVO_ID = "dmConversations:1";

const USERS = {
  ada: { _id: "users:ada" },
  grace: { _id: "users:grace" },
};
// Membership: ada is in the server; grace is NOT. Both are in the DM.
const SERVER_MEMBERS = new Set(["users:ada"]);

/**
 * Minimal fake of the parts of QueryCtx that `resolveMentions` uses, counting
 * every index lookup per table so the tests can assert on read counts.
 */
function fakeCtx() {
  const reads = { users: 0, memberships: 0, dmMembers: 0 };
  const ctx = {
    db: {
      query(table) {
        const builder = {
          withIndex(_index, range) {
            const q = { eq: () => q, gt: () => q };
            range(q);
            // Apply the constraints the caller recorded by re-walking them.
            return {
              async unique() {
                reads[table] = (reads[table] ?? 0) + 1;
                const args = collectArgs(range);
                if (table === "users") return USERS[args.username] ?? null;
                if (table === "memberships") {
                  return SERVER_MEMBERS.has(args.userId) ? { _id: "memberships:1" } : null;
                }
                if (table === "dmMembers") return { _id: "dmMembers:1" };
                return null;
              },
            };
          },
        };
        return builder;
      },
    },
  };
  return { ctx, reads };
}

/** Re-run the range callback against a recording object to capture its filters. */
function collectArgs(range) {
  const args = {};
  const q = {
    eq(field, value) { args[field] = value; return q; },
    gt(field, value) { args[field] = value; return q; },
  };
  range(q);
  return args;
}

await check("no @mentions -> no database reads at all", async () => {
  const { ctx, reads } = fakeCtx();
  const out = await resolveMentions(ctx, "hello world", { serverId: SERVER_ID }, new Map());
  assert(out.length === 0, "expected no resolved mentions");
  assert(reads.users === 0 && reads.memberships === 0, `expected 0 reads, got ${JSON.stringify(reads)}`);
});

await check("a server mention resolves only for members", async () => {
  const { ctx } = fakeCtx();
  const out = await resolveMentions(ctx, "hi @ada and @grace", { serverId: SERVER_ID }, new Map());
  assert(out.length === 1, `expected 1 resolved mention, got ${out.length}`);
  assert(out[0].username === "ada", `expected ada, got ${out[0].username}`);
  assert(out[0].userId === "users:ada", "expected the real user id");
});

await check("a DM mention resolves participants", async () => {
  const { ctx } = fakeCtx();
  const out = await resolveMentions(ctx, "hi @ada @grace", { conversationId: CONVO_ID }, new Map());
  assert(out.length === 2, `expected 2 resolved mentions, got ${out.length}`);
});

await check("one shared cache resolves each username once across many bodies", async () => {
  const { ctx, reads } = fakeCtx();
  const cache = new Map();
  const bodies = Array.from({ length: 30 }, (_, i) => `message ${i} mentioning @ada`);
  for (const body of bodies) {
    const out = await resolveMentions(ctx, body, { serverId: SERVER_ID }, cache);
    assert(out.length === 1 && out[0].userId === "users:ada", "each body still resolves ada");
  }
  // 30 messages, 30 mentions, but exactly one users lookup + one membership check.
  assert(reads.users === 1, `expected 1 users read for 30 mentions, got ${reads.users}`);
  assert(reads.memberships === 1, `expected 1 membership read for 30 mentions, got ${reads.memberships}`);
});

await check("unknown usernames are cached as misses (never re-looked-up)", async () => {
  const { ctx, reads } = fakeCtx();
  const cache = new Map();
  for (let i = 0; i < 10; i++) {
    const out = await resolveMentions(ctx, "hey @nobody_here", { serverId: SERVER_ID }, cache);
    assert(out.length === 0, "an unknown username never resolves");
  }
  assert(reads.users === 1, `expected 1 users read for 10 misses, got ${reads.users}`);
});

await check("non-members are cached as misses too (not re-checked per message)", async () => {
  const { ctx, reads } = fakeCtx();
  const cache = new Map();
  for (let i = 0; i < 10; i++) {
    const out = await resolveMentions(ctx, "hey @grace", { serverId: SERVER_ID }, cache);
    assert(out.length === 0, "a non-member must not be mentionable");
  }
  assert(reads.users === 1, `expected 1 users read, got ${reads.users}`);
  assert(reads.memberships === 1, `expected 1 membership read, got ${reads.memberships}`);
});

await check("without a cache each call still resolves correctly", async () => {
  const { ctx, reads } = fakeCtx();
  const out = await resolveMentions(ctx, "@ada", { serverId: SERVER_ID });
  assert(out.length === 1, "expected the mention to resolve");
  assert(reads.users === 1, "expected a single lookup");
});

await check("the same body is never resolved twice within one execution's cache", async () => {
  const { ctx, reads } = fakeCtx();
  const cache = new Map();
  const body = "@ada @grace @ada";
  const first = await resolveMentions(ctx, body, { conversationId: CONVO_ID }, cache);
  const second = await resolveMentions(ctx, body, { conversationId: CONVO_ID }, cache);
  assert(JSON.stringify(first) === JSON.stringify(second), "repeat resolution must be identical");
  // Two distinct usernames → two users reads total, on the first call only.
  assert(reads.users === 2, `expected 2 users reads total, got ${reads.users}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
