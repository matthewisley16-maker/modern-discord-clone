// End-to-end tests for GIF messages against the dev deployment.
// Run: bun gif-test.mjs
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
  try { if (!(await fn())) throw new Error("assertion was false"); ok(name); }
  catch (e) { bad(name, e); }
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

const A = await newUser("gifalice");
const B = await newUser("gifbob");

// A valid, GIPHY-owned media record (the shape our own action returns).
const GIF = {
  provider: "giphy",
  id: "3o7aCTfyhYawdOXcFW",
  url: "https://media.giphy.com/media/3o7aCTfyhYawdOXcFW/giphy.gif",
  previewUrl: "https://media.giphy.com/media/3o7aCTfyhYawdOXcFW/200.gif",
  title: "Hello wave",
  width: 480,
  height: 270,
};

// --- GIF search action returns a structured, non-fake response ---
await expectTrue("gif search action returns a structured response", async () => {
  const res = await A.client.action(api.gifs.search, { query: "hello" });
  return typeof res.configured === "boolean" && Array.isArray(res.results) && (res.next === null || typeof res.next === "number");
});
await expectTrue("gif search rejects unauthenticated callers", async () => {
  const anon = new ConvexHttpClient(URL);
  const res = await anon.action(api.gifs.search, { query: "hello" });
  return res.configured === false && res.results.length === 0;
});

// --- Community channel GIF message ---
let serverId, channelId, gifMessageId;
await expectOk("owner creates a community", async () => {
  serverId = await A.client.mutation(api.communities.create, { name: `GIF Guild ${stamp}`, description: "gifs" });
  const d = await A.client.query(api.communities.details, { serverId });
  channelId = d.channels.find((c) => c.name === "general")._id;
});
await expectOk("sends a GIF-only channel message (no caption)", async () => {
  gifMessageId = await A.client.mutation(api.chat.sendMessage, { channelId, body: "", gif: GIF });
});
await expectOk("GIF message persists with its provider metadata", async () => {
  const msgs = await A.client.query(api.chat.messages, { channelId });
  const m = msgs.find((x) => x._id === gifMessageId);
  if (!m) throw new Error("message missing");
  if (m.gif?.provider !== "giphy" || m.gif?.id !== GIF.id) throw new Error("gif metadata missing");
  if (m.gif?.url !== GIF.url || m.gif?.previewUrl !== GIF.previewUrl) throw new Error("gif urls wrong");
  if (!m.gif?.width || !m.gif?.height) throw new Error("gif dimensions missing");
});
await expectOk("GIF message keeps a searchable text fallback", async () => {
  const msgs = await A.client.query(api.chat.messages, { channelId });
  const m = msgs.find((x) => x._id === gifMessageId);
  if (m.body !== "Sent a GIF") throw new Error(`unexpected body: ${m.body}`);
});
await expectOk("GIF works with a caption", async () => {
  await A.client.mutation(api.chat.sendMessage, { channelId, body: "look at this", gif: GIF });
  const msgs = await A.client.query(api.chat.messages, { channelId });
  if (!msgs.some((m) => m.gif && m.body === "look at this")) throw new Error("captioned gif missing");
});
await expectOk("GIF message supports reactions", async () => {
  await B.client.mutation(api.chat.sendMessage, { channelId, body: "x" }).catch(() => {});
  await A.client.mutation(api.chat.toggleReaction, { messageId: gifMessageId, emoji: "🔥" });
  const msgs = await A.client.query(api.chat.messages, { channelId });
  const m = msgs.find((x) => x._id === gifMessageId);
  if (!m.reactions.some((r) => r.emoji === "🔥")) throw new Error("reaction missing");
});
await expectOk("GIF message supports replies", async () => {
  await A.client.mutation(api.chat.sendMessage, { channelId, body: "replying", replyToId: gifMessageId });
  const msgs = await A.client.query(api.chat.messages, { channelId });
  const reply = msgs.find((m) => m.reply && m.reply._id === gifMessageId);
  if (!reply) throw new Error("reply reference missing");
});

// --- Server-side validation: never trust a client URL ---
await expectError("non-giphy host is rejected", () =>
  A.client.mutation(api.chat.sendMessage, { channelId, body: "", gif: { ...GIF, url: "https://evil.example.com/x.gif" } }));
await expectError("javascript: URL is rejected", () =>
  A.client.mutation(api.chat.sendMessage, { channelId, body: "", gif: { ...GIF, url: "javascript:alert(1)" } }));
await expectError("unknown provider is rejected", () =>
  A.client.mutation(api.chat.sendMessage, { channelId, body: "", gif: { ...GIF, provider: "evil" } }));
await expectError("absurd dimensions are rejected", () =>
  A.client.mutation(api.chat.sendMessage, { channelId, body: "", gif: { ...GIF, width: 999999, height: 999999 } }));
await expectError("lookalike giphy domain is rejected", () =>
  A.client.mutation(api.chat.sendMessage, { channelId, body: "", gif: { ...GIF, url: "https://evil-giphy.com/x.gif" } }));
await expectError("plain empty message is still rejected", () =>
  A.client.mutation(api.chat.sendMessage, { channelId, body: "   " }));

// --- Delete for everyone really removes the GIF ---
await expectOk("GIF message can be deleted for everyone", async () => {
  await A.client.mutation(api.deletion.deleteForEveryone, { messageId: gifMessageId });
  const msgs = await A.client.query(api.chat.messages, { channelId });
  if (msgs.some((m) => m._id === gifMessageId)) throw new Error("gif message still visible");
});

// --- DMs: direct + group, realtime-readable, reactions ---
let dmId, dmGifId;
await expectOk("A starts a DM with B", async () => {
  dmId = await A.client.mutation(api.dms.startDirect, { userId: B.userId });
});
await expectOk("GIF-only DM message is created", async () => {
  dmGifId = await A.client.mutation(api.dms.sendMessage, { conversationId: dmId, body: "", gif: GIF });
});
await expectOk("B receives the GIF DM (realtime read path)", async () => {
  const msgs = await B.client.query(api.dms.messages, { conversationId: dmId });
  const m = msgs.find((x) => x._id === dmGifId);
  if (!m?.gif || m.gif.url !== GIF.url) throw new Error("gif dm missing");
});
await expectOk("GIF DM supports reactions + replies", async () => {
  await B.client.mutation(api.dms.toggleReaction, { messageId: dmGifId, emoji: "❤️" });
  await B.client.mutation(api.dms.sendMessage, { conversationId: dmId, body: "nice", replyToId: dmGifId });
  const msgs = await A.client.query(api.dms.messages, { conversationId: dmId });
  const m = msgs.find((x) => x._id === dmGifId);
  if (!m.reactions.some((r) => r.emoji === "❤️")) throw new Error("dm reaction missing");
  if (!msgs.some((x) => x.reply && x.reply._id === dmGifId)) throw new Error("dm reply missing");
});
await expectError("unsafe GIF rejected in a DM too", () =>
  A.client.mutation(api.dms.sendMessage, { conversationId: dmId, body: "", gif: { ...GIF, previewUrl: "http://media.giphy.com/x.gif" } }));

// Clean up so nothing lingers.
try { await A.client.mutation(api.communities.deleteCommunity, { serverId }); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
