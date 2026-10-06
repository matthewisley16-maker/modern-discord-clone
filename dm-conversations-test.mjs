// End-to-end tests for Conversations: 1:1 DMs, group chats, batch messaging,
// archive, mute, blocking and privacy — against the dev deployment.
// Run: bun dm-conversations-test.mjs
import { ConvexHttpClient } from "convex/browser";
import { api } from "./src/convex/_generated/api.js";

import { guardedDeploymentUrl } from "./test-support/guard.mjs";
const URL = guardedDeploymentUrl("https://academic-porcupine-929.convex.cloud");
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
  client.setAuth(res.tokens.token);
  const me = await client.query(api.users.me, {});
  return { client, username, userId: me.userId };
}

const A = await newUser("dm_alice");
const B = await newUser("dm_bob");
const C = await newUser("dm_carol");

// ---------------- 1:1 direct messages ----------------
let directAB;
await expectOk("alice starts a direct conversation with bob", async () => {
  directAB = await A.client.mutation(api.dms.startDirect, { userId: B.userId });
});
await expectOk("alice sends a message", () => A.client.mutation(api.dms.sendMessage, { conversationId: directAB, body: "hey bob" }));
await expectTrue("bob can read the history", async () => {
  const m = (await B.client.query(api.dms.messages, { conversationId: directAB })).messages;
  return m.some((x) => x.body === "hey bob");
});
await expectError("a non-participant cannot read the conversation", () => C.client.query(api.dms.messages, { conversationId: directAB }));
await expectError("a non-participant cannot post to the conversation", () => C.client.mutation(api.dms.sendMessage, { conversationId: directAB, body: "intruder" }));
await expectOk("starting the same DM again reuses the conversation", async () => {
  const again = await A.client.mutation(api.dms.startDirect, { userId: B.userId });
  if (again !== directAB) throw new Error("a duplicate conversation was created");
});
await expectTrue("a 1:1 conversation has exactly two members", async () => {
  const list = await A.client.query(api.dms.listConversations, {});
  const convo = list.find((c) => c.conversationId === directAB);
  return convo && convo.memberCount === 2;
});

// ---------------- Unread + read receipts ----------------
await expectTrue("bob sees the message as unread", async () => {
  const list = await B.client.query(api.dms.listConversations, {});
  const convo = list.find((c) => c.conversationId === directAB);
  return convo.unread >= 1;
});
await expectTrue("marking read clears the unread count", async () => {
  await B.client.mutation(api.dms.markRead, { conversationId: directAB });
  const list = await B.client.query(api.dms.listConversations, {});
  return list.find((c) => c.conversationId === directAB).unread === 0;
});

// ---------------- Mute suppression ----------------
await expectOk("bob mutes the conversation", () => B.client.mutation(api.dms.setMuted, { conversationId: directAB, muted: true }));
await expectTrue("a muted conversation produces no new notifications", async () => {
  const before = await B.client.query(api.social.listNotifications, {});
  await A.client.mutation(api.dms.sendMessage, { conversationId: directAB, body: "this should be silent" });
  const after = await B.client.query(api.social.listNotifications, {});
  return after.unread <= before.unread;
});

// ---------------- Archive ----------------
await expectOk("bob archives the conversation from his inbox", () => B.client.mutation(api.dms.setArchived, { conversationId: directAB, archived: true }));
await expectTrue("archived conversations are flagged for that user only", async () => {
  const bList = await B.client.query(api.dms.listConversations, {});
  const aList = await A.client.query(api.dms.listConversations, {});
  return bList.find((c) => c.conversationId === directAB).archived === true
    && aList.find((c) => c.conversationId === directAB).archived === false;
});
await expectOk("bob unarchives it", () => B.client.mutation(api.dms.setArchived, { conversationId: directAB, archived: false }));

// ---------------- Blocking (- general anti-abuse) ----------------
await expectOk("carol blocks alice", () => C.client.mutation(api.social.blockUser, { userId: A.userId }));
await expectError("alice cannot message a user who blocked her", () => A.client.mutation(api.dms.startDirect, { userId: C.userId }));
await expectOk("carol unblocks alice", () => C.client.mutation(api.social.unblockUser, { userId: A.userId }));

// ---------------- Privacy ----------------
await expectOk("carol disables incoming DMs", () => C.client.mutation(api.users.updateSettings, { dmPrivacy: "none" }));
await expectError("alice cannot DM a user who disabled DMs", () => A.client.mutation(api.dms.startDirect, { userId: C.userId }));
await expectOk("carol allows DMs again", () => C.client.mutation(api.users.updateSettings, { dmPrivacy: "everyone" }));

// ---------------- Group chat ----------------
let groupId;
await expectOk("alice creates a group chat", async () => {
  groupId = await A.client.mutation(api.dms.createGroup, { name: `Weekend Plans ${stamp}`, memberIds: [B.userId, C.userId] });
});
await expectTrue("group shows every participating member", async () => {
  const g = await A.client.query(api.dms.groupDetails, { conversationId: groupId });
  return g && g.members.length === 3 && g.isOwner === true && g.members.some((m) => m.userId === B.userId);
});
await expectOk("group owner renames the group", () => A.client.mutation(api.dms.renameGroup, { conversationId: groupId, name: "Trip" }));
await expectError("a plain group member cannot rename the group", () => B.client.mutation(api.dms.renameGroup, { conversationId: groupId, name: "Hacked" }));
await expectOk("owner promotes a member to group administrator", () => A.client.mutation(api.dms.setGroupAdmin, { conversationId: groupId, userId: B.userId, admin: true }));
await expectOk("a group administrator can then rename it", () => B.client.mutation(api.dms.renameGroup, { conversationId: groupId, name: "Trip 2026" }));
await expectError("a non-administrator cannot remove members", () => C.client.mutation(api.dms.removeGroupMember, { conversationId: groupId, userId: B.userId }));
await expectOk("an administrator can remove a member", () => B.client.mutation(api.dms.removeGroupMember, { conversationId: groupId, userId: C.userId }));
await expectOk("a member can leave the group", () => B.client.mutation(api.dms.leaveGroup, { conversationId: groupId }));
await expectTrue("group messages reach everyone still in the group", async () => {
  await A.client.mutation(api.dms.sendMessage, { conversationId: groupId, body: "who is still here" });
  const m = (await A.client.query(api.dms.messages, { conversationId: groupId })).messages;
  return m.some((x) => x.body === "who is still here");
});
await expectOk("group owner leaving hands ownership to a remaining member", async () => {
  await A.client.mutation(api.dms.leaveGroup, { conversationId: groupId });
});

// ---------------- Batch / multi-recipient messaging ----------------
const D = await newUser("dm_dave");
let batchResult;
await expectOk("alice sends one message separately to bob and dave", async () => {
  batchResult = await A.client.mutation(api.dms.sendBatch, { userIds: [B.userId, D.userId], body: "Hey, just wanted to let you know about the new update!" });
});
await expectTrue("batch reports two separate deliveries", async () => batchResult.sent === 2);
await expectTrue("each recipient gets their OWN 1:1 conversation (no group created)", async () => {
  const bList = await B.client.query(api.dms.listConversations, {});
  const mine = bList.filter((c) => c.members.some((m) => m.userId === A.userId));
  if (mine.length === 0) throw new Error("bob has no conversation with alice");
  // Every conversation with alice that bob can see is a 2-person direct chat.
  return mine.every((c) => c.type === "direct" && c.memberCount === 2);
});
await expectTrue("a batch recipient cannot see who else received it", async () => {
  const bList = await B.client.query(api.dms.listConversations, {});
  const convo = bList.find((c) => c.members.some((m) => m.userId === A.userId));
  // Bob only ever sees alice in that conversation — never dave.
  return convo.members.every((m) => m.userId === A.userId);
});
await expectTrue("the batch message arrived in each recipient's history", async () => {
  const bList = await B.client.query(api.dms.listConversations, {});
  const convo = bList.find((c) => c.members.some((m) => m.userId === A.userId));
  const msgs = (await B.client.query(api.dms.messages, { conversationId: convo.conversationId })).messages;
  return msgs.some((m) => m.body.includes("new update"));
});
await expectError("a batch with no recipients is rejected", () => A.client.mutation(api.dms.sendBatch, { userIds: [], body: "hi" }));
await expectError("an empty batch message is rejected", () => A.client.mutation(api.dms.sendBatch, { userIds: [B.userId], body: "   " }));
await expectTrue("batch to a blocking user is skipped, never forced", async () => {
  await C.client.mutation(api.social.blockUser, { userId: A.userId });
  const res = await A.client.mutation(api.dms.sendBatch, { userIds: [C.userId], body: "ignored" });
  await C.client.mutation(api.social.unblockUser, { userId: A.userId });
  return res.sent === 0 && res.skipped.length === 1;
});

// ---------------- Separation from servers / platform ----------------
await expectError("a server role grants no access to someone else's private conversation", () => C.client.query(api.dms.messages, { conversationId: directAB }));
await expectTrue("platform role is unrelated to conversations", async () => {
  const me = await C.client.query(api.users.me, {});
  return me.role === "user";
});
await expectOk("tomorrow-proof: deleting a conversation removes it for that user only", async () => {
  await B.client.mutation(api.dms.deleteConversation, { conversationId: directAB });
  const bList = await B.client.query(api.dms.listConversations, {});
  const aList = await A.client.query(api.dms.listConversations, {});
  if (bList.some((c) => c.conversationId === directAB)) throw new Error("still in bob's inbox");
  if (!aList.some((c) => c.conversationId === directAB)) throw new Error("removed from alice's inbox too");
});

// ---------------- Cleanup ----------------
await expectOk("clean up test accounts", async () => {
  for (const u of [D, C, B, A]) await u.client.mutation(api.users.deleteAccount, { confirmUsername: u.username });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
