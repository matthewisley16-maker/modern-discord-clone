// Backend tests for screen sharing (signaling relay + voice screen state).
// Run: bun screen-test.mjs
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
  const token = res?.tokens?.token;
  if (!token) throw new Error("no token from signUp");
  client.setAuth(token);
  const me = await client.query(api.users.me, {});
  return { client, username, userId: me.userId };
}

const A = await newUser("sharealice");
const B = await newUser("sharebob");

// --- Channel voice signalling ---
let serverId, voiceId;
await expectOk("owner creates a community + voice channel", async () => {
  serverId = await A.client.mutation(api.communities.create, { name: `Screen Guild ${stamp}`, description: "screen" });
  voiceId = await A.client.mutation(api.voice.createChannelFull, { serverId, name: "Gaming", type: "voice" });
  const code = (await A.client.query(api.communities.details, { serverId })).inviteCode;
  await B.client.mutation(api.communities.joinByCode, { code });
});
await expectOk("both members join the voice channel", async () => {
  await A.client.mutation(api.voice.joinVoiceChecked, { channelId: voiceId });
  await B.client.mutation(api.voice.joinVoiceChecked, { channelId: voiceId });
});

await expectOk("screen flag is stored and visible to participants", async () => {
  await A.client.mutation(api.voice.setVoiceFlags, { screen: true });
  const details = await B.client.query(api.voice.voiceChannelDetails, { channelId: voiceId });
  const a = details.participants.find((p) => p.userId === A.userId);
  if (!a || a.screen !== true) throw new Error("screen flag not reflected");
});
await expectOk("communities.setVoiceState can also set the screen flag", async () => {
  await A.client.mutation(api.communities.setVoiceState, { screen: false });
  const parts = await B.client.query(api.communities.voiceParticipants, { channelId: voiceId });
  const a = parts.find((p) => p.userId === A.userId);
  if (!a || a.screen !== false) throw new Error("screen flag not cleared");
});

await expectOk("a real screen signal relays to the peer and is cleared", async () => {
  await A.client.mutation(api.communities.sendSignal, {
    channelId: voiceId, toUserId: B.userId, kind: "screen",
    payload: JSON.stringify({ on: true, streamId: "stream-abc" }),
  });
  const inbox = await B.client.query(api.communities.pollSignals, { channelId: voiceId });
  const screen = inbox.find((s) => s.kind === "screen" && s.fromUserId === A.userId);
  if (!screen) throw new Error("screen signal not delivered");
  const meta = JSON.parse(screen.payload);
  if (meta.on !== true || meta.streamId !== "stream-abc") throw new Error("screen payload wrong");
  await B.client.mutation(api.communities.clearSignal, { signalId: screen._id });
  const after = await B.client.query(api.communities.pollSignals, { channelId: voiceId });
  if (after.some((s) => s._id === screen._id)) throw new Error("signal not cleared");
});
await expectTrue("normal offer/answer/candidate signalling still works", async () => {
  await A.client.mutation(api.communities.sendSignal, { channelId: voiceId, toUserId: B.userId, kind: "offer", payload: JSON.stringify({ type: "offer", sdp: "x" }) });
  await A.client.mutation(api.communities.sendSignal, { channelId: voiceId, toUserId: B.userId, kind: "answer", payload: JSON.stringify({ type: "answer", sdp: "y" }) });
  await A.client.mutation(api.communities.sendSignal, { channelId: voiceId, toUserId: B.userId, kind: "candidate", payload: JSON.stringify({ candidate: "z" }) });
  const inbox = await B.client.query(api.communities.pollSignals, { channelId: voiceId });
  const kinds = new Set(inbox.filter((s) => s.fromUserId === A.userId).map((s) => s.kind));
  for (const s of inbox) await B.client.mutation(api.communities.clearSignal, { signalId: s._id });
  return kinds.has("offer") && kinds.has("answer") && kinds.has("candidate");
});
await expectError("an unknown signal kind is rejected", () =>
  A.client.mutation(api.communities.sendSignal, { channelId: voiceId, toUserId: B.userId, kind: "bogus", payload: "{}" }));
await expectError("a non-member cannot relay signals in the channel", () =>
  newUser("outsider").then((C) => C.client.mutation(api.communities.sendSignal, { channelId: voiceId, toUserId: B.userId, kind: "screen", payload: "{}" })));

// --- DM call signalling ---
let dmId;
await expectOk("A starts a DM with B", async () => {
  dmId = await A.client.mutation(api.dms.startDirect, { userId: B.userId });
});
await expectOk("a screen signal relays over the DM call channel", async () => {
  await A.client.mutation(api.calls.sendDmSignal, {
    conversationId: dmId, toUserId: B.userId, kind: "screen",
    payload: JSON.stringify({ on: true, streamId: "dm-stream" }),
  });
  const inbox = await B.client.query(api.calls.pollDmSignals, { conversationId: dmId });
  const screen = inbox.find((s) => s.kind === "screen");
  if (!screen) throw new Error("dm screen signal not delivered");
  const meta = JSON.parse(screen.payload);
  if (meta.streamId !== "dm-stream") throw new Error("dm screen payload wrong");
  await B.client.mutation(api.calls.clearDmSignal, { signalId: screen._id });
});
await expectOk("stop-screen signal relays and is cleared", async () => {
  await A.client.mutation(api.calls.sendDmSignal, { conversationId: dmId, toUserId: B.userId, kind: "screen", payload: JSON.stringify({ on: false }) });
  const inbox = await B.client.query(api.calls.pollDmSignals, { conversationId: dmId });
  const off = inbox.find((s) => s.kind === "screen");
  if (!off || JSON.parse(off.payload).on !== false) throw new Error("stop signal missing");
  await B.client.mutation(api.calls.clearDmSignal, { signalId: off._id });
});
await expectError("a non-member cannot send DM call signals", async () => {
  const C = await newUser("dmoutsider");
  await C.client.mutation(api.calls.sendDmSignal, { conversationId: dmId, toUserId: B.userId, kind: "screen", payload: "{}" });
});

// Clean up.
try { await A.client.mutation(api.voice.leaveVoiceSession, {}); } catch {}
try { await B.client.mutation(api.voice.leaveVoiceSession, {}); } catch {}
try { await A.client.mutation(api.communities.deleteCommunity, { serverId }); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
