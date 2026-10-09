// Unit tests for the per-execution author-card memo (no backend needed).
//
// WHY: `chat.messages` / `dms.messages` return a page of up to 150 messages in
// ONE query execution, and that execution repeats on every new message in the
// room. Resolving the author card per message re-read the same profiles/users
// (and re-resolved the same avatar URLs) once per message — 150 reads for a page
// written by a dozen people. `memoizeAuthorCards` resolves each author once.
//
// The fake ctx counts every profile lookup, user get and avatar resolution, so
// these tests prove the dedupe is real and that the returned card is unchanged.
//
// Run: bun author-card-cache-test.mjs
import { authorCardOf, memoizeAuthorCards } from "./src/convex/lib.ts";

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e?.message ?? e}`); };
const check = async (name, fn) => { try { await fn(); ok(name); } catch (e) { bad(name, e); } };
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const PEOPLE = {
  "users:ada": { _id: "users:ada", name: "Ada", username: "ada", image: null },
  "users:grace": { _id: "users:grace", name: "Grace", username: "grace", image: "https://img/grace.png" },
  "users:alan": { _id: "users:alan", name: "Alan", username: "alan", image: null },
};

function fakeCtx() {
  const reads = { profile: 0, user: 0, avatarUrl: 0 };
  const ctx = {
    db: {
      async get(id) {
        reads.user++;
        return PEOPLE[id] ?? null;
      },
      query(table) {
        if (table !== "profiles") throw new Error(`unexpected table ${table}`);
        const builder = {
          withIndex(_index, _range) { return builder; },
          async unique() {
            reads.profile++;
            // Only ada has a profile row; the others must fall back to users.
            return null;
          },
        };
        return builder;
      },
    },
    storage: {
      async getUrl() {
        reads.avatarUrl++;
        return "https://cdn/avatar.png";
      },
    },
  };
  return { ctx, reads };
}

await check("a card is correct with no profile row (falls back to the user)", async () => {
  const { ctx } = fakeCtx();
  const card = await authorCardOf(ctx, "users:ada");
  assert(card.author === "Ada", `expected Ada, got ${card.author}`);
});

await check("a card is correct with an account image and no uploaded avatar", async () => {
  const { ctx } = fakeCtx();
  const card = await authorCardOf(ctx, "users:grace");
  assert(card.author === "Grace", `expected Grace, got ${card.author}`);
  assert(card.authorAvatarUrl === "https://img/grace.png", "expected the account image fallback");
});

await check("150 messages from 3 people resolve each author once", async () => {
  const { ctx, reads } = fakeCtx();
  const cardFor = memoizeAuthorCards(ctx);
  const authors = Array.from({ length: 150 }, (_, i) => ["users:ada", "users:grace", "users:alan"][i % 3]);
  const cards = await Promise.all(authors.map((id) => cardFor(id)));
  assert(cards.length === 150, "every message still gets a card");
  assert(reads.user === 3, `expected 3 user reads for 150 messages, got ${reads.user}`);
  assert(reads.profile === 3, `expected 3 profile reads for 150 messages, got ${reads.profile}`);
  assert(reads.avatarUrl <= 3, `expected at most 3 avatar resolutions, got ${reads.avatarUrl}`);
});

await check("the memoized card is identical to a direct authorCardOf call", async () => {
  const direct = fakeCtx();
  const memoized = fakeCtx();
  const cardFor = memoizeAuthorCards(memoized.ctx);
  const expected = await authorCardOf(direct.ctx, "users:grace");
  const actual = await cardFor("users:grace");
  assert(JSON.stringify(actual) === JSON.stringify(expected), "memoized card must be byte-identical");
});

await check("the same author requested 50 times performs exactly one lookup", async () => {
  const { ctx, reads } = fakeCtx();
  const cardFor = memoizeAuthorCards(ctx);
  for (let i = 0; i < 50; i++) await cardFor("users:alan");
  assert(reads.user === 1, `expected 1 user read, got ${reads.user}`);
});

await check("two memos from two executions never share state", async () => {
  const first = fakeCtx();
  const second = fakeCtx();
  const cardA = memoizeAuthorCards(first.ctx);
  const cardB = memoizeAuthorCards(second.ctx);
  await cardA("users:ada");
  await cardB("users:ada");
  assert(first.reads.user === 1 && second.reads.user === 1, "each execution must do its own lookup");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
