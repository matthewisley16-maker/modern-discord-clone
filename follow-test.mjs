// End-to-end tests for the Freecord following system against the dev deployment.
// Run: bun follow-test.mjs
import { ConvexHttpClient } from "convex/browser";
import { api } from "./src/convex/_generated/api.js";

const URL = "https://academic-porcupine-929.convex.cloud";
const stamp = Date.now().toString(36);
let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e?.message ?? e}`); };

async function expectError(name, fn) {
  try { await fn(); bad(name, "expected an error but it succeeded"); }
  catch { ok(name); }
}
async function expectOk(name, fn) {
  try { await fn(); ok(name); }
  catch (e) { bad(name, e); }
}
async function expectTrue(name, fn) {
  try {
    const v = await fn();
    if (!v) throw new Error("assertion was false");
    ok(name);
  } catch (e) { bad(name, e); }
}

async function newUser(label) {
  const username = `${label}_${stamp}`;
  const client = new ConvexHttpClient(URL);
  const res = await client.action(api.auth.signIn, {
    provider: "password",
    params: { flow: "signUp", username, password: "Passw0rd123" },
  });
  const token = res?.tokens?.token;
  if (!token) throw new Error("no token from signUp");
  client.setAuth(token);
  const me = await client.query(api.users.me, {});
  return { client, username, userId: me.userId };
}

const A = await newUser("fola");
const B = await newUser("folb");
const C = await newUser("folc");

// --- Basic follow/unfollow + accurate counts ---
await expectOk("A follows B", () => A.client.mutation(api.social.follow, { userId: B.userId }));
await expectOk("duplicate follow is a no-op", () => A.client.mutation(api.social.follow, { userId: B.userId }));
await expectTrue("B sees A as a follower", async () => {
  const p = await B.client.query(api.users.publicProfile, { userId: B.userId });
  return p.followers === 1;
});
await expectTrue("A sees B in their following", async () => {
  const p = await A.client.query(api.users.publicProfile, { userId: A.userId });
  return p.following === 1;
});

// --- Lists are real and viewer-aware ---
await expectTrue("A's following list contains B", async () => {
  const lists = await A.client.query(api.social.followLists, { userId: A.userId });
  return lists.visible && lists.following.some((u) => u.userId === B.userId);
});
await expectTrue("B's followers list contains A", async () => {
  const lists = await B.client.query(api.social.followLists, { userId: B.userId });
  return lists.visible && lists.followers.some((u) => u.userId === A.userId);
});
await expectTrue("B is not yet following A, but A follows B", async () => {
  const lists = await B.client.query(api.social.followLists, { userId: B.userId });
  const a = lists.followers.find((u) => u.userId === A.userId);
  return a && a.isFollowing === false && a.followsYou === true;
});

// --- Mutual following ---
await expectOk("B follows A back", () => B.client.mutation(api.social.follow, { userId: A.userId }));
await expectTrue("A→B card shows mutual", async () => {
  const lists = await A.client.query(api.social.followLists, { userId: A.userId });
  const b = lists.following.find((u) => u.userId === B.userId);
  return b && b.isFollowing && b.followsYou && b.isMutual;
});
await expectTrue("B's profile reads isMutual for A", async () => {
  const p = await A.client.query(api.users.publicProfile, { userId: B.userId });
  return p.isFollowing && p.isMutual;
});
await expectTrue("A appears in B's mutuals", async () => {
  const lists = await B.client.query(api.social.followLists, { userId: B.userId });
  return lists.mutuals.some((u) => u.userId === A.userId);
});
await expectTrue("B appears in A's mutuals", async () => {
  const lists = await A.client.query(api.social.followLists, { userId: A.userId });
  return lists.mutuals.some((u) => u.userId === B.userId);
});

// --- Follow notification deep-links to the follower's profile ---
await expectTrue("B got a follow notification linking to A's profile", async () => {
  const { items } = await B.client.query(api.social.listNotifications, {});
  const n = items.find((x) => x.type === "follow" && x.actorId === A.userId);
  return Boolean(n) && (n.link ?? "").includes(`profile=${A.userId}`);
});

// --- Unfollow removes the relationship, counts and mutuals ---
await expectOk("A unfollows B", () => A.client.mutation(api.social.unfollow, { userId: B.userId }));
await expectTrue("B's follower count drops back to zero", async () => {
  const p = await B.client.query(api.users.publicProfile, { userId: B.userId });
  return p.followers === 0;
});
await expectTrue("A is gone from B's mutuals", async () => {
  const lists = await B.client.query(api.social.followLists, { userId: B.userId });
  return !lists.mutuals.some((u) => u.userId === A.userId);
});
await expectTrue("A no longer sees B as mutual", async () => {
  const p = await A.client.query(api.users.publicProfile, { userId: B.userId });
  return p.isFollowing === false;
});

// --- Privacy: nobody-visible follower lists stay hidden from strangers ---
await expectOk("B makes their follow lists private", () =>
  B.client.mutation(api.profiles.updateCustomization, { privacy: { friendsList: "none" } }),
);
await expectTrue("a stranger cannot read B's private lists", async () => {
  const lists = await C.client.query(api.social.followLists, { userId: B.userId });
  return lists.visible === false && lists.followers.length === 0 && lists.following.length === 0;
});
await expectTrue("B can still read their own private lists", async () => {
  const lists = await B.client.query(api.social.followLists, { userId: B.userId });
  return lists.visible === true;
});

// --- Privacy: followPrivacy = none blocks new followers ---
await expectOk("C sets followPrivacy to none", () =>
  C.client.mutation(api.users.updateSettings, { followPrivacy: "none" }),
);
await expectError("nobody can follow C when followPrivacy is none", () =>
  A.client.mutation(api.social.follow, { userId: C.userId }),
);

// --- Cannot follow yourself ---
await expectError("A cannot follow themselves", () => A.client.mutation(api.social.follow, { userId: A.userId }));

// --- Profile themes resolve to real colours (theme + decoration system) ---
await expectOk("A selects a profile theme", () => A.client.mutation(api.profiles.updateCustomization, { theme: "theme_ocean" }));
await expectTrue("the chosen theme exposes its palette", async () => {
  const p = await A.client.query(api.profiles.getProfile, { userId: A.userId });
  return p.theme === "theme_ocean" && p.themeColors?.primary === "#0ea5e9";
});
await expectTrue("an explicit custom palette is preserved", async () => {
  await A.client.mutation(api.profiles.updateCustomization, { themeColors: { primary: "#ff0000", accent: "#00ff00", background: "#000000" } });
  const p = await A.client.query(api.profiles.getProfile, { userId: A.userId });
  return p.themeColors?.primary === "#ff0000";
});
await expectOk("A picks avatar cosmetics", () => A.client.mutation(api.profiles.updateCustomization, { decorationId: "dec_stars", frameId: "frame_neon", effectId: "effect_snow" }));
await expectTrue("cosmetics persist on the profile", async () => {
  const p = await A.client.query(api.profiles.getProfile, { userId: A.userId });
  return p.decorationId === "dec_stars" && p.frameId === "frame_neon" && p.effectId === "effect_snow";
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
