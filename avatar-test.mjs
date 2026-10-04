// Avatar propagation tests for Freecord.
// Verifies the profile picture a user saves is the one the Dashboard, chats,
// member lists and DM sidebar read — immediately, without re-login.
// Run: bun avatar-test.mjs
import { ConvexHttpClient } from "convex/browser";
import { api } from "./src/convex/_generated/api.js";

const URL = "https://academic-porcupine-929.convex.cloud";
const stamp = Date.now().toString(36);
let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e?.message ?? e}`); };
async function expectTrue(name, fn) {
  try {
    const v = await fn();
    if (!v) throw new Error("assertion was false");
    ok(name);
  } catch (e) { bad(name, e); }
}
async function expectOk(name, fn) {
  try { await fn(); ok(name); } catch (e) { bad(name, e); }
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

/** Upload raw bytes to Convex storage and return the storage id. */
async function upload(client, bytes, contentType = "image/png") {
  const url = await client.mutation(api.uploads.generateUploadUrl, {});
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": contentType }, body: bytes });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  const json = await res.json();
  return json.storageId;
}

// Two differently-sized PNGs so the resolved URLs differ between saves.
const pngA = new Uint8Array(64).fill(7);
const pngB = new Uint8Array(96).fill(9);

const A = await newUser("avaowner");
const B = await newUser("avabob");

// --- Membership + message so we can inspect member lists and chat authors ---
let serverId, channelId;
await expectOk("owner creates a public community with a channel", async () => {
  serverId = await A.client.mutation(api.communities.create, { name: `Avatar Guild ${stamp}`, description: "avatars", isPublic: true });
  const d = await A.client.query(api.communities.details, { serverId });
  channelId = d.channels.find((c) => c.name === "general")._id;
});
await expectOk("B joins the community", () => B.client.mutation(api.communities.join, { serverId }));
await expectOk("A sends a message", () => A.client.mutation(api.chat.sendMessage, { channelId, body: `hello avatars ${stamp}` }));

// --- Baseline: no avatar set yet ---
await expectTrue("users.me has an avatarUrl field (null before upload)", async () => {
  const me = await A.client.query(api.users.me, {});
  return "avatarUrl" in me && me.avatarUrl === null;
});

// --- A uploads and saves the first profile picture ---
let firstUrl;
await expectOk("A uploads and saves a profile picture", async () => {
  const storageId = await upload(A.client, pngA);
  await A.client.mutation(api.profiles.updateCustomization, { avatarStorageId: storageId });
  const me = await A.client.query(api.users.me, {});
  firstUrl = me.avatarUrl;
  if (!firstUrl) throw new Error("avatarUrl was not resolved");
});

await expectTrue("A's saved picture is a real URL", () => typeof firstUrl === "string" && firstUrl.startsWith("http"));
await expectTrue("community member list shows A's picture", async () => {
  const d = await A.client.query(api.communities.details, { serverId });
  const card = d.members.find((m) => m.userId === A.userId);
  return card?.avatarUrl === firstUrl;
});
await expectTrue("B sees A's picture in the member list", async () => {
  const d = await B.client.query(api.communities.details, { serverId });
  const card = d.members.find((m) => m.userId === A.userId);
  return card?.avatarUrl === firstUrl;
});
await expectTrue("channel messages carry the author's picture", async () => {
  const msgs = await B.client.query(api.chat.messages, { channelId });
  const mine = msgs.find((m) => m.body === `hello avatars ${stamp}`);
  return mine?.authorAvatarUrl === firstUrl;
});
await expectTrue("profiles.getProfile shows the same picture", async () => {
  const p = await B.client.query(api.profiles.getProfile, { userId: A.userId });
  return p?.avatarUrl === firstUrl;
});

// --- A CHANGES the picture; everything must update with no re-login/refresh ---
let secondUrl;
await expectOk("A changes the profile picture", async () => {
  const storageId = await upload(A.client, pngB);
  await A.client.mutation(api.profiles.updateCustomization, { avatarStorageId: storageId });
  const me = await A.client.query(api.users.me, {});
  secondUrl = me.avatarUrl;
});
await expectTrue("the new picture is different from the old one", () => secondUrl && secondUrl !== firstUrl);
await expectTrue("users.me reflects the new picture immediately", async () => {
  const me = await A.client.query(api.users.me, {});
  return me.avatarUrl === secondUrl;
});
await expectTrue("member list reflects the new picture immediately", async () => {
  const d = await B.client.query(api.communities.details, { serverId });
  return d.members.find((m) => m.userId === A.userId)?.avatarUrl === secondUrl;
});
await expectTrue("chat messages reflect the new picture immediately", async () => {
  const msgs = await B.client.query(api.chat.messages, { channelId });
  return msgs.find((m) => m.body === `hello avatars ${stamp}`)?.authorAvatarUrl === secondUrl;
});

// --- DM sidebar ---
await expectOk("A sets B's DM picture and starts a conversation", async () => {
  const storageId = await upload(B.client, pngA);
  await B.client.mutation(api.profiles.updateCustomization, { avatarStorageId: storageId });
  await A.client.mutation(api.dms.startDirect, { userId: B.userId });
  await B.client.mutation(api.dms.sendMessage, { conversationId: (await A.client.query(api.dms.listConversations, {}))[0].conversationId, body: "hi" });
});
await expectTrue("DM sidebar shows the other member's picture", async () => {
  const convos = await A.client.query(api.dms.listConversations, {});
  const convo = convos[0];
  const bCard = convo.members.find((m) => m.userId === B.userId);
  return typeof bCard?.avatarUrl === "string" && bCard.avatarUrl.startsWith("http");
});
await expectTrue("DM messages carry the author's picture", async () => {
  const convos = await A.client.query(api.dms.listConversations, {});
  const msgs = await A.client.query(api.dms.messages, { conversationId: convos[0].conversationId });
  const fromB = msgs.find((m) => m.userId === B.userId);
  return typeof fromB?.authorAvatarUrl === "string" && fromB.authorAvatarUrl.startsWith("http");
});

// --- Search + friends cards ---
await expectTrue("friend cards carry an avatarUrl", async () => {
  await A.client.mutation(api.social.sendFriendRequest, { toId: B.userId });
  const reqs = await B.client.query(api.social.listRequests, {});
  const incoming = reqs.incoming[0];
  await B.client.mutation(api.social.respondFriendRequest, { requestId: incoming.requestId, accept: true });
  const friends = await A.client.query(api.social.listFriends, {});
  return friends.every((f) => "avatarUrl" in f);
});

// --- Avatar decorations flow through every surface (own effects included) ---
await expectOk("A equips an avatar decoration", async () => {
  await A.client.mutation(api.profiles.updateCustomization, { decorationId: "dec_stars" });
});
await expectTrue("channel messages carry the author's decoration", async () => {
  const msgs = await B.client.query(api.chat.messages, { channelId });
  return msgs.find((m) => m.body === `hello avatars ${stamp}`)?.authorDecorationId === "dec_stars";
});
await expectTrue("DM messages carry the author's decoration", async () => {
  const convos = await A.client.query(api.dms.listConversations, {});
  const conversationId = convos[0].conversationId;
  await A.client.mutation(api.dms.sendMessage, { conversationId, body: `deco ${stamp}` });
  const msgs = await A.client.query(api.dms.messages, { conversationId });
  return msgs.find((m) => m.body === `deco ${stamp}`)?.authorDecorationId === "dec_stars";
});
await expectTrue("DM sidebar card carries the decoration", async () => {
  const convos = await B.client.query(api.dms.listConversations, {});
  const aCard = convos.flatMap((c) => c.members).find((m) => m.userId === A.userId);
  return aCard?.decorationId === "dec_stars";
});
await expectTrue("community member list carries the decoration", async () => {
  const d = await B.client.query(api.communities.details, { serverId });
  return d.members.find((m) => m.userId === A.userId)?.decorationId === "dec_stars";
});
await expectTrue("users.me exposes the decoration for the Dashboard", async () => {
  const me = await A.client.query(api.users.me, {});
  return me.profile?.decorationId === "dec_stars";
});
await expectTrue("changing the decoration updates messages immediately", async () => {
  await A.client.mutation(api.profiles.updateCustomization, { decorationId: "dec_crown" });
  const msgs = await B.client.query(api.chat.messages, { channelId });
  return msgs.find((m) => m.body === `hello avatars ${stamp}`)?.authorDecorationId === "dec_crown";
});
await expectTrue("removing the decoration clears it everywhere", async () => {
  await A.client.mutation(api.profiles.updateCustomization, { decorationId: "" });
  const msgs = await B.client.query(api.chat.messages, { channelId });
  const d = await B.client.query(api.communities.details, { serverId });
  // "" and null both mean "no decoration" — the value must simply be cleared.
  return !msgs.find((m) => m.body === `hello avatars ${stamp}`)?.authorDecorationId
    && !d.members.find((m) => m.userId === A.userId)?.decorationId;
});

// Clean up the test community so it never lingers in the database.
try { await A.client.mutation(api.communities.deleteCommunity, { serverId }); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
