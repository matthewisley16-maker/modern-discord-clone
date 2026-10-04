// End-to-end tests for identity (username + display name) and the DM call state
// machine against the dev deployment. Run: bun identity-call-test.mjs
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

const A = await newUser("ida");
const B = await newUser("idb");
const C = await newUser("idc");

// ---- Identity ----
await expectTrue("new account has both a username and a display name", async () => {
  const me = await A.client.query(api.users.me, {});
  return Boolean(me.username) && Boolean(me.profile?.displayName);
});
await expectTrue("username availability: someone else's name is rejected", async () => {
  const r = await A.client.query(api.users.usernameAvailable, { username: B.username });
  return r.available === false;
});
await expectTrue("username availability: your own current name still reads available", async () => {
  const r = await A.client.query(api.users.usernameAvailable, { username: A.username });
  return r.available === true;
});
await expectTrue("username availability: fresh name is available", async () => {
  const r = await A.client.query(api.users.usernameAvailable, { username: `fresh_${stamp}` });
  return r.available === true;
});
await expectOk("A changes their username", () => A.client.mutation(api.users.setUsername, { username: `shadow_${stamp}` }));
await expectTrue("username change persisted", async () => {
  const me = await A.client.query(api.users.me, {});
  return me.username === `shadow_${stamp}`;
});
await expectError("A cannot take B's username", () => A.client.mutation(api.users.setUsername, { username: B.username }));
await expectError("invalid username rejected", () => A.client.mutation(api.users.setUsername, { username: "no spaces!" }));
await expectOk("A changes their display name", () => A.client.mutation(api.users.setDisplayName, { displayName: "Shadowpaw" }));
await expectTrue("display name changed but username is untouched", async () => {
  const me = await A.client.query(api.users.me, {});
  return me.profile?.displayName === "Shadowpaw" && me.username === `shadow_${stamp}`;
});
await expectTrue("display names are not unique (B can use the same one)", async () => {
  const before = (await B.client.query(api.users.me, {})).username;
  await B.client.mutation(api.users.setDisplayName, { displayName: "Shadowpaw" });
  const bMe = await B.client.query(api.users.me, {});
  const aPub = await B.client.query(api.users.publicProfile, { userId: A.userId });
  return bMe.profile?.displayName === "Shadowpaw" && bMe.username === before && aPub.displayName === "Shadowpaw";
});
await expectOk("ensureIdentity is a no-op once both fields exist", () => A.client.mutation(api.users.ensureIdentity, {}));

// ---- Anonymous (email-less) account gets generated identity ----
await expectTrue("an account with no username/display name is backfilled", async () => {
  const client = new ConvexHttpClient(URL);
  const res = await client.action(api.auth.signIn, { provider: "anonymous", params: {} });
  const token = res?.tokens?.token;
  if (!token) throw new Error("no token from anonymous sign-in");
  client.setAuth(token);
  await client.mutation(api.users.ensureIdentity, {});
  const me = await client.query(api.users.me, {});
  const uname = me.username ?? "";
  const okName = /^[a-z0-9._]{3,24}$/.test(uname);
  return okName && Boolean(me.profile?.displayName) && me.profile.displayName !== me.email;
});

// ---- Call state machine ----
let inviteId;
await expectOk("A calls B", async () => {
  inviteId = await A.client.mutation(api.calls.inviteCall, { toId: B.userId, media: "voice" });
});
await expectTrue("B sees a ringing incoming call from A", async () => {
  const inc = await B.client.query(api.calls.incomingCall, {});
  return inc && inc.inviteId === inviteId && inc.fromId === A.userId && inc.media === "voice";
});
await expectTrue("A sees the outgoing call as ringing", async () => {
  const out = await A.client.query(api.calls.outgoingCall, {});
  return out && out.inviteId === inviteId && out.status === "ringing";
});
await expectOk("B accepts the call", () => B.client.mutation(api.calls.respondCall, { inviteId, accept: true }));
await expectTrue("A sees the call as accepted", async () => {
  const out = await A.client.query(api.calls.outgoingCall, {});
  return out && out.status === "accepted";
});
await expectTrue("B no longer sees a ringing call", async () => {
  const inc = await B.client.query(api.calls.incomingCall, {});
  return inc === null;
});
// WebRTC signaling relay (real DM conversation-scoped signaling)
let convoId;
await expectOk("A opens a DM with B", async () => { convoId = await A.client.mutation(api.dms.startDirect, { userId: B.userId }); });
await expectOk("A relays an offer signal to B", () => A.client.mutation(api.calls.sendDmSignal, { conversationId: convoId, toUserId: B.userId, kind: "offer", payload: JSON.stringify({ type: "offer", sdp: "x" }) }));
await expectTrue("B receives the offer signal for the call", async () => {
  const sigs = await B.client.query(api.calls.pollDmSignals, { conversationId: convoId });
  return sigs.some((s) => s.kind === "offer" && s.fromUserId === A.userId);
});
await expectTrue("B clears the signal after handling it", async () => {
  const sigs = await B.client.query(api.calls.pollDmSignals, { conversationId: convoId });
  for (const s of sigs) await B.client.mutation(api.calls.clearDmSignal, { signalId: s._id });
  const after = await B.client.query(api.calls.pollDmSignals, { conversationId: convoId });
  return after.length === 0;
});
await expectTrue("the call ends and A sees it", async () => {
  await A.client.mutation(api.calls.endCall, { inviteId });
  const out = await A.client.query(api.calls.outgoingCall, {});
  return out && out.status === "ended";
});
// Both participants can watch a single call's live status, which is what lets
// one side notice the other hanging up (no ghost calls).
await expectTrue("B can read the call status and sees it ended", async () => {
  const c = await B.client.query(api.calls.getCall, { inviteId });
  return c && c._id === inviteId && c.fromId === A.userId && c.toId === B.userId && c.status === "ended";
});
await expectTrue("a non-participant cannot read the call status", async () => {
  const c = await C.client.query(api.calls.getCall, { inviteId });
  return c === null;
});
// Stale signaling must not survive a call, or the next call could renegotiate
// against an old offer.
await expectOk("A leaves an offer behind", () => A.client.mutation(api.calls.sendDmSignal, { conversationId: convoId, toUserId: B.userId, kind: "offer", payload: JSON.stringify({ type: "offer", sdp: "stale" }) }));
await expectOk("ending clears the conversation's signaling", () => A.client.mutation(api.calls.clearConversationSignals, { conversationId: convoId }));
await expectTrue("no stale signaling remains after the call", async () => {
  const sigs = await B.client.query(api.calls.pollDmSignals, { conversationId: convoId });
  return sigs.length === 0;
});
await expectError("an oversized signal payload is rejected", () => A.client.mutation(api.calls.sendDmSignal, { conversationId: convoId, toUserId: B.userId, kind: "offer", payload: "x".repeat(60_001) }));

// ---- Missed call via timeout ----
let invite2;
await expectOk("A calls C", async () => { invite2 = await A.client.mutation(api.calls.inviteCall, { toId: C.userId, media: "video" }); });
await expectOk("the call times out", () => A.client.mutation(api.calls.timeoutCall, { inviteId: invite2 }));
await expectTrue("C is no longer ringing", async () => (await C.client.query(api.calls.incomingCall, {})) === null);
await expectTrue("A's outgoing call is missed", async () => {
  const out = await A.client.query(api.calls.outgoingCall, {});
  return out && out.status === "missed";
});

// ---- Decline ----
let invite3;
await expectOk("B calls A", async () => { invite3 = await B.client.mutation(api.calls.inviteCall, { toId: A.userId, media: "voice" }); });
await expectOk("A declines", () => A.client.mutation(api.calls.respondCall, { inviteId: invite3, accept: false }));
await expectTrue("B sees the declined call", async () => {
  const out = await B.client.query(api.calls.outgoingCall, {});
  return out && out.status === "declined";
});

// ---- Blocks prevent calls ----
await expectOk("B blocks C", () => B.client.mutation(api.social.blockUser, { userId: C.userId }));
await expectError("C cannot call B (blocked)", () => C.client.mutation(api.calls.inviteCall, { toId: B.userId, media: "voice" }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
