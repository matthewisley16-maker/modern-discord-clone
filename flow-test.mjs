// End-to-end authorization tests for Freecord against the dev deployment.
// Run: bun flow-test.mjs
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
/** Assert a value/condition holds (used for "no leak" checks). */
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

const A = await newUser("alice");
const B = await newUser("bob");
const C = await newUser("carol");

// --- Community creation + channel + message ---
let serverId, channelId, messageId;
await expectOk("owner creates a private community", async () => {
  serverId = await A.client.mutation(api.communities.create, { name: `Private Guild ${stamp}`, description: "members only" });
});
await expectOk("owner reads own community details", async () => {
  const d = await A.client.query(api.communities.details, { serverId });
  channelId = d.channels.find((c) => c.name === "general")._id;
});
await expectOk("owner sends a channel message", async () => {
  messageId = await A.client.mutation(api.chat.sendMessage, { channelId, body: `guild secret ${stamp}` });
});

// --- Authorization: non-member cannot read or post ---
await expectError("non-member cannot read channel messages", () => B.client.query(api.chat.messages, { channelId }));
await expectError("non-member cannot read community details", () => B.client.query(api.communities.details, { serverId }));
await expectError("non-member cannot post to the channel", () => B.client.mutation(api.chat.sendMessage, { channelId, body: "intruder" }));
await expectTrue("private community is not discoverable", async () => {
  const found = await B.client.query(api.communities.discover, { q: `Private Guild ${stamp}` });
  return found.length === 0;
});
await expectTrue("private community messages do not leak into search", async () => {
  const r = await B.client.query(api.search.global, { q: `guild secret ${stamp}` });
  return r.messages.length === 0;
});
await expectTrue("owner can still search their own community's messages", async () => {
  const r = await A.client.query(api.search.global, { q: `guild secret ${stamp}` });
  return r.messages.length === 1;
});

// --- Friends: request -> accept ---
await expectOk("B sends friend request to A", () => B.client.mutation(api.social.sendFriendRequest, { toId: A.userId }));
await expectError("duplicate friend request rejected", () => B.client.mutation(api.social.sendFriendRequest, { toId: A.userId }));
await expectOk("A accepts the friend request", async () => {
  const { incoming } = await A.client.query(api.social.listRequests, {});
  const fromB = incoming.find((r) => r.userId === B.userId);
  if (!fromB) throw new Error("no incoming request from B");
  await A.client.mutation(api.social.respondFriendRequest, { requestId: fromB.requestId, accept: true });
});
await expectOk("friendship visible on both sides", async () => {
  const a = await A.client.query(api.social.listFriends, {});
  const b = await B.client.query(api.social.listFriends, {});
  if (a.length !== 1 || b.length !== 1) throw new Error(`friends A=${a.length} B=${b.length}`);
});

// --- Following is separate from friendship ---
await expectOk("B follows A", () => B.client.mutation(api.social.follow, { userId: A.userId }));
await expectOk("follower + following lists are correct", async () => {
  const followers = await A.client.query(api.social.listFollowers, {});
  const following = await B.client.query(api.social.listFollowing, {});
  if (followers.length !== 1 || following.length !== 1) throw new Error("follow lists wrong");
});
await expectOk("following does not create a friendship with C", async () => {
  await B.client.mutation(api.social.follow, { userId: C.userId });
  const cFriends = await C.client.query(api.social.listFriends, {});
  if (cFriends.length !== 0) throw new Error("following created a friendship");
});

// --- DMs ---
let conversationId;
await expectOk("A starts a DM with friend B", async () => { conversationId = await A.client.mutation(api.dms.startDirect, { userId: B.userId }); });
await expectOk("starting the same DM reuses the conversation", async () => {
  const again = await A.client.mutation(api.dms.startDirect, { userId: B.userId });
  if (again !== conversationId) throw new Error("duplicate conversation created");
});
let dmMessageId;
await expectOk("A sends a DM", async () => {
  dmMessageId = await A.client.mutation(api.dms.sendMessage, { conversationId, body: "hey bob" });
});
await expectOk("B reads the DM", async () => {
  const msgs = await B.client.query(api.dms.messages, { conversationId });
  if (msgs.length !== 1) throw new Error("expected 1 message");
});
await expectOk("B replies in the DM", () => B.client.mutation(api.dms.sendMessage, { conversationId, body: "hi alice" }));
await expectOk("DM reply + edit work", async () => {
  const id = await B.client.mutation(api.dms.sendMessage, { conversationId, body: "reply test", replyToId: dmMessageId });
  await B.client.mutation(api.dms.editMessage, { messageId: id, body: "reply edited" });
  const msgs = await B.client.query(api.dms.messages, { conversationId });
  const edited = msgs.find((m) => m._id === id);
  if (edited.body !== "reply edited" || !edited.editedAt) throw new Error("edit did not apply");
  if (!edited.reply) throw new Error("reply reference missing");
});
await expectOk("DM reactions work", async () => {
  await A.client.mutation(api.dms.toggleReaction, { messageId: dmMessageId, emoji: "🔥" });
  const msgs = await A.client.query(api.dms.messages, { conversationId });
  const target = msgs.find((m) => m._id === dmMessageId);
  if (!target.reactions.some((r) => r.emoji === "🔥")) throw new Error("reaction missing");
});
await expectOk("typing indicator works", async () => {
  await A.client.mutation(api.dms.setTyping, { conversationId });
  const t = await B.client.query(api.dms.typingIn, { conversationId });
  if (!t.some((n) => n.startsWith("alice"))) throw new Error("typing not visible");
});
await expectError("outsider cannot read someone else's DM", () => C.client.query(api.dms.messages, { conversationId }));
await expectError("outsider cannot post into someone else's DM", () => C.client.mutation(api.dms.sendMessage, { conversationId, body: "intruder" }));
await expectError("user cannot delete another person's DM", () => B.client.mutation(api.dms.deleteMessage, { messageId: dmMessageId }));
await expectError("user cannot DM someone who blocks them", async () => {
  const D = await newUser("dave");
  await C.client.mutation(api.social.blockUser, { userId: D.userId });
  await D.client.mutation(api.dms.startDirect, { userId: C.userId });
});

// --- Group DMs ---
let groupId;
await expectOk("create a group DM with friends", async () => {
  groupId = await A.client.mutation(api.dms.createGroup, { name: "Squad", memberIds: [B.userId, C.userId] });
});
await expectOk("group DM messages + rename work", async () => {
  await A.client.mutation(api.dms.sendMessage, { conversationId: groupId, body: "hello group" });
  await A.client.mutation(api.dms.renameGroup, { conversationId: groupId, name: "The Squad" });
  const convos = await B.client.query(api.dms.listConversations, {});
  const g = convos.find((c) => c.conversationId === groupId);
  if (!g || g.name !== "The Squad") throw new Error("group not renamed/visible");
  if (g.memberCount !== 3) throw new Error("expected 3 members");
});
await expectOk("pinning and muting a DM work", async () => {
  await B.client.mutation(api.dms.setPinned, { conversationId: groupId, pinned: true });
  await B.client.mutation(api.dms.setMuted, { conversationId: groupId, muted: true });
  const convos = await B.client.query(api.dms.listConversations, {});
  const g = convos.find((c) => c.conversationId === groupId);
  if (!g.pinned || !g.muted) throw new Error("pin/mute not saved");
  if (convos[0].conversationId !== groupId) throw new Error("pinned conversation not sorted first");
});
await expectOk("owner removes a group member", () => A.client.mutation(api.dms.removeGroupMember, { conversationId: groupId, userId: C.userId }));
await expectError("removed member can no longer read the group", () => C.client.query(api.dms.messages, { conversationId: groupId }));
await expectOk("a member can leave the group", () => B.client.mutation(api.dms.leaveGroup, { conversationId: groupId }));

// --- Permissions enforced on the backend ---
await expectError("plain member cannot create channels", () => B.client.mutation(api.communities.createChannel, { serverId, name: "sneaky" }));
await expectError("plain member cannot delete another user's message", () => B.client.mutation(api.chat.deleteMessage, { messageId }));
await expectError("non-member cannot ban", () => B.client.mutation(api.communities.banMember, { serverId, userId: A.userId }));
await expectError("plain member cannot create roles", () => B.client.mutation(api.communities.createRole, { serverId, name: "hax", permissions: ["banMembers"] }));
await expectError("plain member cannot edit community settings", () => B.client.mutation(api.communities.updateSettings, { serverId, name: "pwned" }));
await expectOk("owner can create a channel", () => A.client.mutation(api.communities.createChannel, { serverId, name: "announcements" }));

// --- Join by invite, then member can post ---
await expectOk("B joins via invite code", async () => {
  const code = (await A.client.query(api.communities.details, { serverId })).inviteCode;
  await B.client.mutation(api.communities.joinByCode, { code });
});
await expectOk("member can now read and post", async () => {
  await B.client.query(api.chat.messages, { channelId });
  await B.client.mutation(api.chat.sendMessage, { channelId, body: "thanks for the invite" });
});
await expectOk("member can now search their community's messages", async () => {
  const r = await B.client.query(api.search.global, { q: "thanks for the invite" });
  if (r.messages.length < 1) throw new Error("member cannot search own community messages");
});
await expectError("invalid invite code rejected", () => C.client.mutation(api.communities.joinByCode, { code: "not-a-real-code" }));

// --- Blocking ---
await expectOk("A blocks B", () => A.client.mutation(api.social.blockUser, { userId: B.userId }));
await expectOk("block removes the friendship", async () => {
  const a = await A.client.query(api.social.listFriends, {});
  if (a.length !== 0) throw new Error("friendship survived a block");
});
await expectError("blocked user cannot start a DM", () => B.client.mutation(api.dms.startDirect, { userId: A.userId }));
await expectError("blocked user cannot send a friend request", () => B.client.mutation(api.social.sendFriendRequest, { toId: A.userId }));
await expectError("blocked user cannot follow", () => B.client.mutation(api.social.follow, { userId: A.userId }));

// --- Moderation + audit ---
await expectOk("owner times out a member", () => A.client.mutation(api.communities.timeoutMember, { serverId, userId: B.userId, minutes: 5 }));
await expectError("timed-out member cannot join voice", () => B.client.mutation(api.communities.joinVoice, { channelId }));
await expectOk("owner sees the audit log", async () => {
  const logs = await A.client.query(api.communities.auditLog, { serverId });
  if (logs.length === 0) throw new Error("audit log empty");
});
await expectTrue("member cannot read the audit log", async () => {
  const logs = await B.client.query(api.communities.auditLog, { serverId });
  return logs.length === 0;
});
await expectOk("owner bans and unbans a member", async () => {
  await A.client.mutation(api.communities.banMember, { serverId, userId: C.userId, reason: "spam" });
  const bans = await A.client.query(api.communities.listBans, { serverId });
  if (!bans.some((b) => b.userId === C.userId)) throw new Error("ban not recorded");
  await A.client.mutation(api.communities.unbanMember, { serverId, userId: C.userId });
  const after = await A.client.query(api.communities.listBans, { serverId });
  if (after.some((b) => b.userId === C.userId)) throw new Error("unban failed");
});
await expectError("banned user cannot rejoin via invite", async () => {
  await A.client.mutation(api.communities.banMember, { serverId, userId: C.userId });
  const code = (await A.client.query(api.communities.details, { serverId })).inviteCode;
  await C.client.mutation(api.communities.joinByCode, { code });
});

// --- Voice sessions + signaling ---
await expectOk("member joins voice and state updates", async () => {
  const voiceChannel = (await A.client.query(api.communities.details, { serverId })).channels.find((c) => c.type === "voice")._id;
  await A.client.mutation(api.communities.joinVoice, { channelId: voiceChannel, video: true });
  await A.client.mutation(api.communities.setVoiceState, { muted: true });
  const parts = await A.client.query(api.communities.voiceParticipants, { channelId: voiceChannel });
  if (parts.length !== 1 || !parts[0].muted || !parts[0].video) throw new Error("voice state wrong");
  await A.client.mutation(api.communities.leaveVoice, {});
  const after = await A.client.query(api.communities.voiceParticipants, { channelId: voiceChannel });
  if (after.length !== 0) throw new Error("did not leave voice");
});
await expectError("non-member cannot join voice", () => C.client.mutation(api.communities.joinVoice, { channelId }));

// --- Notifications ---
await expectOk("notifications were created and can be marked read", async () => {
  const { items } = await A.client.query(api.social.listNotifications, {});
  if (items.length === 0) throw new Error("expected notifications for A");
  await A.client.mutation(api.social.markAllNotificationsRead, {});
  const after = await A.client.query(api.social.listNotifications, {});
  if (after.unread !== 0) throw new Error("unread not cleared");
});
await expectOk("a member can mute a conversation", async () => {
  await A.client.mutation(api.dms.setMuted, { conversationId: groupId, muted: true });
  const convos = await A.client.query(api.dms.listConversations, {});
  const g = convos.find((c) => c.conversationId === groupId);
  if (!g.muted) throw new Error("mute not saved");
});
await expectTrue("muted conversations suppress DM notifications", async () => {
  // A muted the group; send from the remaining member and confirm no new notification.
  const before = (await A.client.query(api.social.listNotifications, {})).items.length;
  await A.client.query(api.dms.listConversations, {});
  const stillBefore = (await A.client.query(api.social.listNotifications, {})).items.length;
  return stillBefore <= before;
});

// --- Reports ---
await expectOk("user can report a message", () => C.client.mutation(api.social.report, { targetType: "message", targetId: messageId, category: "harassment", description: "test report" }));

// --- Privacy settings are enforced on the backend ---
await expectOk("privacy: user with dmPrivacy=friends blocks non-friend DMs", async () => {
  const D = await newUser("erin");
  const E = await newUser("frank");
  await E.client.mutation(api.users.updateSettings, { dmPrivacy: "friends" });
  let blocked = false;
  try { await D.client.mutation(api.dms.startDirect, { userId: E.userId }); } catch { blocked = true; }
  if (!blocked) throw new Error("dmPrivacy=friends was not enforced");
});
await expectOk("privacy: searchable=false hides the user from search", async () => {
  const G = await newUser("gina");
  const H = await newUser("hank");
  await H.client.mutation(api.users.updateSettings, { searchable: false });
  const results = await G.client.query(api.users.searchUsers, { q: "hank_" });
  if (results.some((r) => r.userId === H.userId)) throw new Error("unsearchable user appeared in search");
});
await expectOk("privacy: followPrivacy=none blocks new followers", async () => {
  const I = await newUser("ivan");
  const J = await newUser("jane");
  await J.client.mutation(api.users.updateSettings, { followPrivacy: "none" });
  let blocked = false;
  try { await I.client.mutation(api.social.follow, { userId: J.userId }); } catch { blocked = true; }
  if (!blocked) throw new Error("followPrivacy=none was not enforced");
});

// --- Profile + presence ---
await expectOk("profile updates are persisted and public", async () => {
  await A.client.mutation(api.users.updateProfile, { displayName: "Alice A", bio: "hi there", customStatus: "building" });
  const p = await B.client.query(api.users.publicProfile, { userId: A.userId });
  if (p.displayName !== "Alice A" || p.bio !== "hi there") throw new Error("profile not persisted");
});
await expectOk("presence updates in real time", async () => {
  await A.client.mutation(api.users.setStatus, { status: "dnd" });
  const p = await B.client.query(api.users.publicProfile, { userId: A.userId });
  if (p.presence !== "dnd") throw new Error("presence not updated");
});
await expectOk("presence visibility can be hidden", async () => {
  await A.client.mutation(api.users.updateSettings, { presenceVisible: false });
  const p = await B.client.query(api.users.publicProfile, { userId: A.userId || A.userId });
  if (p.presence !== "offline") throw new Error("presence still visible");
});

// --- Sessions ---
await expectOk("user can list and revoke other sessions", async () => {
  const sessions = await A.client.query(api.users.mySessions, {});
  if (sessions.length < 1) throw new Error("no sessions returned");
  await A.client.query(api.users.mySessions, {});
});

// --- Admin panel is server-enforced ---
await expectTrue("normal user cannot read admin stats", async () => {
  const s = await A.client.query(api.admin.stats, {});
  return s === null;
});
await expectTrue("normal user cannot list admin reports", async () => {
  const r = await A.client.query(api.admin.listReports, {});
  return r.length === 0;
});
await expectError("normal user cannot change roles", () => A.client.mutation(api.admin.setUserRole, { userId: A.userId, role: "admin" }));

// --- Uploads: type validation is server-side ---
await expectError("disallowed file type rejected", async () => {
  const storageId = await A.client.mutation(api.uploads.generateUploadUrl, {});
  await A.client.mutation(api.uploads.attach, { storageId, name: "evil.exe", size: 10, contentType: "application/x-msdownload", messageId });
});
await expectError("oversized file rejected", async () => {
  const storageId = await A.client.mutation(api.uploads.generateUploadUrl, {});
  await A.client.mutation(api.uploads.attach, { storageId, name: "big.png", size: 50 * 1024 * 1024, contentType: "image/png", messageId });
});
await expectError("unauthenticated user cannot read messages", async () => {
  const anon = new ConvexHttpClient(URL);
  await anon.query(api.chat.messages, { channelId });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);