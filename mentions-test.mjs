// End-to-end tests for the mention system against the dev deployment.
// Run: bun mentions-test.mjs
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

const A = await newUser("mena");
const B = await newUser("menb");
const C = await newUser("menc");
const D = await newUser("mend");
const E = await newUser("mene");

// A follows B, B follows A (mutual). A and C become friends.
await A.client.mutation(api.social.follow, { userId: B.userId });
await B.client.mutation(api.social.follow, { userId: A.userId });
await A.client.mutation(api.social.sendFriendRequest, { toId: C.userId });
await C.client.mutation(api.social.respondFriendRequest, {
  requestId: (await C.client.query(api.social.listRequests, {})).incoming.find((r) => r.userId === A.userId).requestId,
  accept: true,
});

// A owns a community; B, C and D join it.
let serverId, channelId, inviteCode;
await expectOk("A creates a community", async () => {
  serverId = await A.client.mutation(api.communities.create, { name: `Mention Guild ${stamp}`, description: "mentions" });
  const d = await A.client.query(api.communities.details, { serverId });
  inviteCode = d.inviteCode;
  channelId = d.channels.find((c) => c.name === "general")._id;
});
await expectOk("B joins", () => B.client.mutation(api.communities.joinByCode, { code: inviteCode }));
await expectOk("C joins", () => C.client.mutation(api.communities.joinByCode, { code: inviteCode }));
await expectOk("D joins", () => D.client.mutation(api.communities.joinByCode, { code: inviteCode }));

// --- Prioritization: mutual follow first, then friend, then member ---
await expectTrue("suggestions rank mutual-follow first", async () => {
  const list = await A.client.query(api.mentions.candidates, { serverId, q: "" });
  return list.length >= 3 && list[0].userId === B.userId && list[0].isMutual === true;
});
await expectTrue("a friend is preferred over a plain member", async () => {
  const list = await A.client.query(api.mentions.candidates, { serverId, q: "" });
  const ci = list.findIndex((c) => c.userId === C.userId);
  const di = list.findIndex((c) => c.userId === D.userId);
  return ci >= 0 && di >= 0 && ci < di;
});
await expectTrue("the requester is never suggested to themselves", async () => {
  const list = await A.client.query(api.mentions.candidates, { serverId, q: "" });
  return !list.some((c) => c.userId === A.userId);
});

// --- Search by display name and by username ---
await expectOk("B sets a display name", () => B.client.mutation(api.users.setDisplayName, { displayName: "Shadowpaw" }));
await expectTrue("search by display name finds the user", async () => {
  const list = await A.client.query(api.mentions.candidates, { serverId, q: "shadow" });
  return list.some((c) => c.userId === B.userId);
});
await expectTrue("search by username finds the user", async () => {
  const list = await A.client.query(api.mentions.candidates, { serverId, q: B.username.slice(0, 4) });
  return list.some((c) => c.userId === B.userId);
});
await expectTrue("unrelated search returns nothing", async () => {
  const list = await A.client.query(api.mentions.candidates, { serverId, q: "zzzznomatch" });
  return list.length === 0;
});

// --- Mentions resolve to real ids in message history, and notify ---
let msgId;
await expectOk("A sends a message mentioning B", async () => {
  msgId = await A.client.mutation(api.chat.sendMessage, { channelId, body: `hey @${B.username} check this` });
});
await expectTrue("the message exposes B as a resolved mention", async () => {
  const msgs = await A.client.query(api.chat.messages, { channelId });
  const m = msgs.find((x) => x._id === msgId);
  return m && m.mentionUsers.some((u) => u.userId === B.userId && u.username === B.username);
});
await expectTrue("a mention is NOT resolved for non-members", async () => {
  // D is a member, but the fake handle resolves to nobody.
  const id = await A.client.mutation(api.chat.sendMessage, { channelId, body: `@nobody_${stamp} hello` });
  const msgs = await A.client.query(api.chat.messages, { channelId });
  const m = msgs.find((x) => x._id === id);
  return m && m.mentionUsers.length === 0;
});
await expectTrue("B received a real mention notification", async () => {
  const { items } = await B.client.query(api.social.listNotifications, {});
  const n = items.find((x) => x.type === "mention" && x.actorId === A.userId);
  return Boolean(n) && (n.link ?? "").includes(`message=${msgId}`);
});
await expectTrue("the author is not notified for their own mention", async () => {
  const { items } = await A.client.query(api.social.listNotifications, {});
  return !items.some((x) => x.type === "mention" && x.link?.includes(`message=${msgId}`));
});

// --- Editing keeps mentions resolved ---
await expectOk("A edits the message", () => A.client.mutation(api.chat.editMessage, { messageId: msgId, body: `edited: hi @${B.username}` }));
await expectTrue("mentions still resolve after an edit", async () => {
  const msgs = await A.client.query(api.chat.messages, { channelId });
  const m = msgs.find((x) => x._id === msgId);
  return m && m.mentionUsers.some((u) => u.userId === B.userId);
});

// --- Blocks remove people from suggestions ---
await expectOk("A blocks D", () => A.client.mutation(api.social.blockUser, { userId: D.userId }));
await expectTrue("a blocked user is not suggested", async () => {
  const list = await A.client.query(api.mentions.candidates, { serverId, q: "" });
  return !list.some((c) => c.userId === D.userId);
});

// --- DM scoped candidates + DM mention notification ---
let convoId;
await expectOk("A opens a DM with B", async () => { convoId = await A.client.mutation(api.dms.startDirect, { userId: B.userId }); });
await expectTrue("DM suggestions include the conversation member", async () => {
  const list = await A.client.query(api.mentions.candidates, { conversationId: convoId, q: "" });
  return list.some((c) => c.userId === B.userId);
});
await expectTrue("DM suggestions exclude people outside the conversation", async () => {
  const list = await A.client.query(api.mentions.candidates, { conversationId: convoId, q: "" });
  return !list.some((c) => c.userId === C.userId);
});
await expectOk("A sends a DM mentioning B", () => A.client.mutation(api.dms.sendMessage, { conversationId: convoId, body: `hi @${B.username}` }));
await expectTrue("the DM message exposes the resolved mention", async () => {
  const msgs = await A.client.query(api.dms.messages, { conversationId: convoId });
  const m = msgs[msgs.length - 1];
  return m && m.mentionUsers.some((u) => u.userId === B.userId);
});
await expectTrue("B got a mention notification for the DM", async () => {
  const { items } = await B.client.query(api.social.listNotifications, {});
  return items.some((x) => x.type === "mention" && x.link?.includes(`dm=${convoId}`));
});

// --- Non-members cannot use server-scoped suggestions ---
await expectTrue("a non-member gets no server suggestions", async () => {
  const list = await E.client.query(api.mentions.candidates, { serverId, q: "" });
  return list.length === 0;
});

// Clean up the test community so it never lingers in the database.
try { await A.client.mutation(api.communities.deleteCommunity, { serverId }); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
