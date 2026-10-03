// Three-account tests for the Freecord deletion system + voice channels.
// Run: bun deletion-voice-test.mjs
import { ConvexHttpClient } from "convex/browser";
import { api } from "./src/convex/_generated/api.js";

const URL = "https://academic-porcupine-929.convex.cloud";
const stamp = Date.now().toString(36);
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`PASS: ${n}`); };
const bad = (n, e) => { fail++; console.log(`FAIL: ${n} -> ${e?.message ?? e}`); };
async function expectError(name, fn) {
  try { await fn(); bad(name, "expected an error but it succeeded"); }
  catch { ok(name); }
}
async function expectOk(name, fn) {
  try { await fn(); ok(name); }
  catch (e) { bad(name, e); }
}
async function expectTrue(name, fn) {
  try { if (!(await fn())) throw new Error("assertion false"); ok(name); }
  catch (e) { bad(name, e); }
}

async function newUser(label) {
  const client = new ConvexHttpClient(URL);
  const res = await client.action(api.auth.signIn, {
    provider: "password",
    params: { flow: "signUp", username: `${label}_${stamp}`, password: "Passw0rd123" },
  });
  client.setAuth(res.tokens.token);
  const me = await client.query(api.users.me, {});
  return { client, userId: me.userId, username: `${label}_${stamp}` };
}

const A = await newUser("alice");
const B = await newUser("bob");
const C = await newUser("carol");

// Shared community with a text channel + a voice channel.
const serverId = await A.client.mutation(api.communities.create, { name: `DelTest ${stamp}`, description: "t", isPublic: false });
const invite = (await A.client.query(api.communities.details, { serverId })).inviteCode;
await B.client.mutation(api.communities.joinByCode, { code: invite });
await C.client.mutation(api.communities.joinByCode, { code: invite });
const details = await A.client.query(api.communities.details, { serverId });
const channelId = details.channels.find((c) => c.name === "general")._id;

// ---------- DELETE FOR ME ----------
let msgA;
await expectOk("A sends a message", async () => {
  msgA = await A.client.mutation(api.chat.sendMessage, { channelId, body: "Test message" });
});
await expectOk("B deletes the message for themselves only", () => B.client.mutation(api.deletion.deleteForMe, { messageId: msgA }));
await expectTrue("A still sees the message", async () => {
  const m = await A.client.query(api.chat.messages, { channelId });
  return m.some((x) => x._id === msgA);
});
await expectTrue("B no longer sees the message", async () => {
  const m = await B.client.query(api.chat.messages, { channelId });
  return !m.some((x) => x._id === msgA);
});
await expectTrue("C still sees the message", async () => {
  const m = await C.client.query(api.chat.messages, { channelId });
  return m.some((x) => x._id === msgA);
});
await expectTrue("the original message body is untouched for others", async () => {
  const m = await A.client.query(api.chat.messages, { channelId });
  return m.find((x) => x._id === msgA).body === "Test message";
});
await expectTrue("B's hidden list persists (survives reload)", async () => {
  const hidden = await B.client.query(api.deletion.myHiddenIds, {});
  return hidden.includes(msgA);
});
await expectTrue("C's hidden list is unaffected", async () => {
  const hidden = await C.client.query(api.deletion.myHiddenIds, {});
  return !hidden.includes(msgA);
});

// ---------- DELETE FOR EVERYONE ----------
let msg2;
await expectOk("A sends another message", async () => {
  msg2 = await A.client.mutation(api.chat.sendMessage, { channelId, body: "Gone for all" });
});
await expectOk("A deletes it for everyone", () => A.client.mutation(api.deletion.deleteForEveryone, { messageId: msg2 }));
for (const [label, user] of [["A", A], ["B", B], ["C", C]]) {
  await expectTrue(`message is gone for ${label}`, async () => {
    const m = await user.client.query(api.chat.messages, { channelId });
    return !m.some((x) => x._id === msg2);
  });
}
await expectTrue("content is not retrievable after delete-for-everyone", async () => {
  const m = await A.client.query(api.chat.messages, { channelId });
  return !m.some((x) => x.body === "Gone for all");
});

// ---------- PERMISSIONS ----------
await expectError("normal member B cannot delete A's message for everyone", async () => {
  const m = await A.client.mutation(api.chat.sendMessage, { channelId, body: "protected" });
  await B.client.mutation(api.deletion.deleteForEveryone, { messageId: m });
});
await expectError("non-member cannot delete a channel message", async () => {
  const outsider = await newUser("mallory");
  const m = await A.client.mutation(api.chat.sendMessage, { channelId, body: "private" });
  await outsider.client.mutation(api.deletion.deleteForEveryone, { messageId: m });
});
await expectTrue("owner CAN delete another user's message for everyone", async () => {
  const m = await B.client.mutation(api.chat.sendMessage, { channelId, body: "moderated" });
  await A.client.mutation(api.deletion.deleteForEveryone, { messageId: m });
  const list = await A.client.query(api.chat.messages, { channelId });
  return !list.some((x) => x._id === m);
});
await expectTrue("moderator deletion is recorded in the audit log", async () => {
  const logs = await A.client.query(api.communities.auditLog, { serverId });
  return logs.some((l) => l.action === "message.delete_moderator");
});

// ---------- Replies never leak deleted content ----------
await expectTrue("replies to deleted messages hide the original content", async () => {
  const original = await A.client.mutation(api.chat.sendMessage, { channelId, body: "secret original" });
  const reply = await A.client.mutation(api.chat.sendMessage, { channelId, body: "replying", replyToId: original });
  await A.client.mutation(api.deletion.deleteForEveryone, { messageId: original });
  const list = await A.client.query(api.chat.messages, { channelId });
  const found = list.find((x) => x._id === reply);
  return found && found.reply && found.reply.deleted === true && !found.reply.body.includes("secret original");
});

// ---------- DMs ----------
await expectOk("A and B become friends then DM", async () => {
  await B.client.mutation(api.social.sendFriendRequest, { toId: A.userId });
  const { incoming } = await A.client.query(api.social.listRequests, {});
  const fromB = incoming.find((r) => r.userId === B.userId);
  await A.client.mutation(api.social.respondFriendRequest, { requestId: fromB.requestId, accept: true });
});
let dmId;
await expectOk("DM delete-for-me hides it only for B", async () => {
  const convo = await A.client.mutation(api.dms.startDirect, { userId: B.userId });
  const m = await A.client.mutation(api.dms.sendMessage, { conversationId: convo, body: "dm hello" });
  await B.client.mutation(api.deletion.deleteDmForMe, { messageId: m });
  const forA = await A.client.query(api.dms.messages, { conversationId: convo });
  const forB = await B.client.query(api.dms.messages, { conversationId: convo });
  if (!forA.some((x) => x._id === m)) throw new Error("A lost the DM");
  if (forB.some((x) => x._id === m)) throw new Error("B still sees the DM");
  dmId = convo;
});
await expectTrue("DM delete-for-everyone removes it for both", async () => {
  const m = await A.client.mutation(api.dms.sendMessage, { conversationId: dmId, body: "dm gone" });
  await A.client.mutation(api.deletion.deleteDmForEveryone, { messageId: m });
  const forA = await A.client.query(api.dms.messages, { conversationId: dmId });
  const forB = await B.client.query(api.dms.messages, { conversationId: dmId });
  return !forA.some((x) => x._id === m) && !forB.some((x) => x._id === m);
});
await expectError("only the author can delete a DM for everyone", async () => {
  const m = await A.client.mutation(api.dms.sendMessage, { conversationId: dmId, body: "mine" });
  await B.client.mutation(api.deletion.deleteDmForEveryone, { messageId: m });
});

// ================= VOICE CHANNELS =================
let voiceId;
await expectOk("owner creates a voice channel", async () => {
  voiceId = await A.client.mutation(api.voice.createChannelFull, { serverId, name: "Gaming", type: "voice" });
});
await expectTrue("the voice channel persists and is visible to members", async () => {
  const tree = await B.client.query(api.voice.channelTree, { serverId });
  return tree.uncategorized.some((c) => c._id === voiceId && c.type === "voice");
});
await expectError("normal member cannot create a channel", () => B.client.mutation(api.voice.createChannelFull, { serverId, name: "sneaky", type: "voice" }));
await expectError("normal member cannot rename a voice channel", () => B.client.mutation(api.voice.updateChannelFull, { channelId: voiceId, name: "hacked" }));
await expectError("normal member cannot change the user limit", () => B.client.mutation(api.voice.updateChannelFull, { channelId: voiceId, userLimit: 99 }));
await expectError("normal member cannot delete a voice channel", () => B.client.mutation(api.voice.deleteChannelFull, { channelId: voiceId }));
await expectOk("owner sets a user limit of 2", () => A.client.mutation(api.voice.updateChannelFull, { channelId: voiceId, userLimit: 2 }));
await expectOk("B and C join voice", async () => {
  await B.client.mutation(api.voice.joinVoiceChecked, { channelId: voiceId });
  await C.client.mutation(api.voice.joinVoiceChecked, { channelId: voiceId });
});
await expectTrue("A sees both members in the channel in real time", async () => {
  const tree = await A.client.query(api.voice.channelTree, { serverId });
  return (tree.voiceParticipants[voiceId] ?? []).length === 2;
});
await expectError("a third user is blocked when the channel is full", async () => {
  const D = await newUser("dave");
  await D.client.mutation(api.communities.joinByCode, { code: invite });
  await D.client.mutation(api.voice.joinVoiceChecked, { channelId: voiceId });
});
await expectOk("speaking state is reported and visible", async () => {
  await B.client.mutation(api.voice.setSpeaking, { speaking: true });
  const tree = await A.client.query(api.voice.channelTree, { serverId });
  const bob = (tree.voiceParticipants[voiceId] ?? []).find((p) => p.userId === B.userId);
  if (!bob?.speaking) throw new Error("speaking flag not visible");
});
await expectOk("moderator moves a user between voice channels", async () => {
  const other = await A.client.mutation(api.voice.createChannelFull, { serverId, name: "Chill", type: "voice" });
  await A.client.mutation(api.voice.moderateUser, { action: "move", userId: B.userId, targetChannelId: other });
  const tree = await A.client.query(api.voice.channelTree, { serverId });
  return (tree.voiceParticipants[other] ?? []).some((p) => p.userId === B.userId);
});
await expectOk("moderator disconnects a user", async () => {
  await A.client.mutation(api.voice.moderateUser, { action: "disconnect", userId: C.userId });
  const tree = await A.client.query(api.voice.channelTree, { serverId });
  return !(tree.voiceParticipants[voiceId] ?? []).some((p) => p.userId === C.userId);
});
await expectOk("private voice channel is hidden from ordinary members", async () => {
  const priv = await A.client.mutation(api.voice.createChannelFull, { serverId, name: "Staff Voice", type: "voice", isPrivate: true, allowedRoleIds: ["admin"] });
  const treeB = await B.client.query(api.voice.channelTree, { serverId });
  const visibleToB = [...treeB.uncategorized, ...treeB.byCategory.flatMap((g) => g.channels)].some((c) => c._id === priv);
  if (visibleToB) throw new Error("private channel leaked to a normal member");
  const treeA = await A.client.query(api.voice.channelTree, { serverId });
  const visibleToOwner = [...treeA.uncategorized, ...treeA.byCategory.flatMap((g) => g.channels)].some((c) => c._id === priv);
  if (!visibleToOwner) throw new Error("owner cannot see their own private channel");
});
await expectOk("owner deletes a voice channel and occupants are removed", async () => {
  await A.client.mutation(api.voice.deleteChannelFull, { channelId: voiceId });
  const tree = await A.client.query(api.voice.channelTree, { serverId });
  if ([...tree.uncategorized, ...tree.byCategory.flatMap((g) => g.channels)].some((c) => c._id === voiceId)) {
    throw new Error("channel still present after delete");
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
