// End-to-end tests for the storage retention / cleanup system.
//
// Run: bun storage-cleanup-test.mjs
//
// Everything runs against the dev deployment using the owner-scoped
// `storage.pruneOldMessages` entry point, which is the same code path as the
// automatic job (eligibility, batching, orphan attachment cleanup) but scoped
// to one test community, so no production data outside it can be touched.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BIG_BYTES = 1_000_000_000_000;

async function makeGuild(owner, label) {
  const serverId = await owner.client.mutation(api.communities.create, {
    name: `Storage ${label} ${stamp}`,
    description: "storage cleanup test",
  });
  const details = await owner.client.query(api.communities.details, { serverId });
  const channelId = details.channels.find((c) => c.name === "general")._id;
  return { serverId, channelId };
}

async function send(owner, channelId, body) {
  return owner.client.mutation(api.chat.sendMessage, { channelId, body });
}

/** Upload small bytes and return the storage id. */
async function upload(client, name, contentType, bytes) {
  const url = await client.mutation(api.uploads.generateUploadUrl, {});
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: bytes,
  });
  const json = await res.json();
  return json.storageId;
}

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...new Array(64).fill(1)]);
const GIF = {
  provider: "giphy",
  id: "3o7aCTfyhYawdOXcFW",
  url: "https://media.giphy.com/media/3o7aCTfyhYawdOXcFW/giphy.gif",
  previewUrl: "https://media.giphy.com/media/3o7aCTfyhYawdOXcFW/200.gif",
  title: "Wave",
  width: 480,
  height: 270,
};

// Rate limits are per user (5 communities + 5 prunes per minute), so scenarios
// are spread across several owners to avoid tripping them.
const O = [
  await newUser("stoa"),
  await newUser("stob"),
  await newUser("stoc"),
  await newUser("stod"),
];
const A = O[0];
const B = await newUser("storageb");

// ---------------------------------------------------------------------------
// 1. Normal usage → do nothing.
// ---------------------------------------------------------------------------
await expectTrue("normal usage does nothing (messages kept)", async () => {
  const { serverId, channelId } = await makeGuild(O[0], "normal");
  for (let i = 0; i < 3; i++) await send(A, channelId, `normal ${i}`);
  // rows/budgetRows = 3/10 = 0.3 → below the 0.70 warning threshold.
  const dry = await A.client.mutation(api.storage.pruneOldMessages, {
    serverId, olderThanMs: 0, budgetBytes: BIG_BYTES, budgetRows: 10, dryRun: true,
  });
  if (dry.statusBefore !== "normal") throw new Error(`expected normal, got ${dry.statusBefore}`);
  const run = await A.client.mutation(api.storage.pruneOldMessages, {
    serverId, olderThanMs: 0, budgetBytes: BIG_BYTES, budgetRows: 10,
  });
  if (run.deleted !== 0) throw new Error(`expected 0 deleted, got ${run.deleted}`);
  const msgs = await A.client.query(api.chat.messages, { channelId });
  if (msgs.length !== 3) throw new Error(`expected 3 messages kept, got ${msgs.length}`);
  return true;
});

// ---------------------------------------------------------------------------
// 2. Warning threshold → prepare only, delete no messages.
// ---------------------------------------------------------------------------
await expectTrue("warning threshold deletes no messages", async () => {
  const { serverId, channelId } = await makeGuild(O[0], "warn");
  for (let i = 0; i < 3; i++) await send(A, channelId, `warn ${i}`);
  // rows/budgetRows = 3/4 = 0.75 → warning band [0.70, 0.85).
  const run = await A.client.mutation(api.storage.pruneOldMessages, {
    serverId, olderThanMs: 0, budgetBytes: BIG_BYTES, budgetRows: 4,
  });
  if (run.statusBefore !== "warning") throw new Error(`expected warning, got ${run.statusBefore}`);
  if (run.deleted !== 0) throw new Error(`expected 0 deleted, got ${run.deleted}`);
  const msgs = await A.client.query(api.chat.messages, { channelId });
  if (msgs.length !== 3) throw new Error(`expected 3 messages kept, got ${msgs.length}`);
  return true;
});

// ---------------------------------------------------------------------------
// 3. Cleanup threshold → oldest messages deleted in batches.
// ---------------------------------------------------------------------------
await expectTrue("cleanup threshold deletes oldest in multiple batches", async () => {
  const owner = O[1];
  const { serverId, channelId } = await makeGuild(owner, "cleanup");
  for (let i = 0; i < 10; i++) await send(owner, channelId, `cleanup ${i}`);
  const dry = await owner.client.mutation(api.storage.pruneOldMessages, {
    serverId, olderThanMs: 0, budgetBytes: BIG_BYTES, budgetRows: 10 / 0.9, dryRun: true,
  });
  if (dry.statusBefore !== "cleanup") throw new Error(`expected cleanup, got ${dry.statusBefore}`);
  const before = await owner.client.query(api.chat.messages, { channelId });
  const run = await owner.client.mutation(api.storage.pruneOldMessages, {
    serverId, olderThanMs: 0, budgetBytes: BIG_BYTES, budgetRows: 10 / 0.9,
    batchSize: 2, maxBatches: 20,
  });
  if (run.batches < 2) throw new Error(`expected multiple batches, got ${run.batches}`);
  if (run.deleted < 2 || run.deleted >= 10) throw new Error(`unexpected deleted count ${run.deleted}`);
  const after = await owner.client.query(api.chat.messages, { channelId });
  if (after.length !== before.length - run.deleted) throw new Error("wrong number of messages removed");
  // The oldest surviving message must be newer than the oldest deleted one.
  if (after[0] && after[0]._creationTime <= before[0]._creationTime) throw new Error("recent message was deleted before older ones");
  return true;
});

// ---------------------------------------------------------------------------
// 4. Oldest eligible messages are selected (oldest-first), and critical band.
// ---------------------------------------------------------------------------
await expectTrue("oldest eligible messages are selected first", async () => {
  const owner = O[1];
  const { serverId, channelId } = await makeGuild(owner, "oldest");
  for (let i = 1; i <= 5; i++) await send(owner, channelId, `oldest ${i}`);
  const msgs = await owner.client.query(api.chat.messages, { channelId });
  if (msgs.length !== 5) throw new Error("setup failed");
  const dry = await owner.client.mutation(api.storage.pruneOldMessages, {
    serverId, olderThanMs: 0, budgetBytes: BIG_BYTES, budgetRows: 100,
    batchSize: 2, dryRun: true,
  });
  if (!Array.isArray(dry.candidateIds) || dry.candidateIds.length !== 2) {
    throw new Error(`expected 2 candidates, got ${dry.candidateIds?.length}`);
  }
  // chat.messages is ascending, so the first two are the oldest.
  if (dry.candidateIds[0] !== msgs[0]._id || dry.candidateIds[1] !== msgs[1]._id) {
    throw new Error("selection was not oldest-first");
  }
  const crit = await owner.client.mutation(api.storage.pruneOldMessages, {
    serverId, olderThanMs: 0, budgetBytes: BIG_BYTES, budgetRows: 5 / 0.99, dryRun: true,
  });
  if (crit.statusBefore !== "critical") throw new Error(`expected critical, got ${crit.statusBefore}`);
  return true;
});

// ---------------------------------------------------------------------------
// 5. Attachments are cleaned ONLY when orphaned.
// ---------------------------------------------------------------------------
await expectTrue("orphaned attachment is deleted, shared attachment is kept", async () => {
  const owner = O[2];
  const { serverId, channelId } = await makeGuild(owner, "orphan");
  const s1 = await upload(owner.client, "shared.png", "image/png", PNG);
  const s2 = await upload(owner.client, "orphan.png", "image/png", PNG);

  // Old message X owns s1…
  const x = await send(owner, channelId, "old with shared attachment");
  await owner.client.mutation(api.uploads.attach, { storageId: s1, name: "shared.png", size: PNG.length, contentType: "image/png", messageId: x });
  // …old message Z owns s2 (nothing else references it).
  const z = await send(owner, channelId, "old with orphan attachment");
  await owner.client.mutation(api.uploads.attach, { storageId: s2, name: "orphan.png", size: PNG.length, contentType: "image/png", messageId: z });

  await sleep(2500);
  // Recent message Y shares the very same storage object s1.
  const y = await send(owner, channelId, "recent still using s1");
  await owner.client.mutation(api.uploads.attach, { storageId: s1, name: "shared.png", size: PNG.length, contentType: "image/png", messageId: y });

  const run = await owner.client.mutation(api.storage.pruneOldMessages, {
    serverId, olderThanMs: 2000, budgetBytes: BIG_BYTES, budgetRows: 3 / 0.9,
    batchSize: 10, maxBatches: 5,
  });
  if (run.deleted !== 2) throw new Error(`expected 2 deleted, got ${run.deleted}`);

  const remainingMsgs = await owner.client.query(api.chat.messages, { channelId });
  if (remainingMsgs.length !== 1 || remainingMsgs[0]._id !== y) throw new Error("wrong messages survived");

  const kept = await owner.client.query(api.uploads.listForMessage, { messageId: y });
  if (kept.length !== 1 || !kept[0].url) throw new Error("shared attachment was wrongly removed");
  const orphanUrl = await owner.client.query(api.uploads.storageUrl, { storageId: s2 });
  if (orphanUrl !== null) throw new Error("orphaned storage object was not removed");
  return true;
});

// ---------------------------------------------------------------------------
// 6. Recent messages are protected by the retention window.
// ---------------------------------------------------------------------------
await expectTrue("recent messages survive the retention window", async () => {
  const owner = O[2];
  const { serverId, channelId } = await makeGuild(owner, "recent");
  for (let i = 0; i < 3; i++) await send(owner, channelId, `old ${i}`);
  await sleep(2500);
  const recentIds = [];
  for (let i = 0; i < 3; i++) recentIds.push(await send(owner, channelId, `recent ${i}`));

  const run = await owner.client.mutation(api.storage.pruneOldMessages, {
    serverId, olderThanMs: 2000, budgetBytes: BIG_BYTES, budgetRows: 6 / 0.9,
    batchSize: 10, maxBatches: 10,
  });
  if (run.deleted !== 3) throw new Error(`expected only the 3 old messages deleted, got ${run.deleted}`);
  const msgs = await owner.client.query(api.chat.messages, { channelId });
  const ids = new Set(msgs.map((m) => m._id));
  for (const id of recentIds) if (!ids.has(id)) throw new Error("a recent message was deleted");
  return true;
});

// ---------------------------------------------------------------------------
// 7. Account / profile / community data is never touched.
// ---------------------------------------------------------------------------
await expectTrue("account, profile and community data are untouched", async () => {
  const owner = O[3];
  const { serverId, channelId } = await makeGuild(owner, "intact");
  for (let i = 0; i < 4; i++) await send(owner, channelId, `prune me ${i}`);
  await owner.client.mutation(api.storage.pruneOldMessages, {
    serverId, olderThanMs: 0, budgetBytes: BIG_BYTES, budgetRows: 4 / 0.9, batchSize: 10, maxBatches: 5,
  });
  const me = await owner.client.query(api.users.me, {});
  if (!me?.userId) throw new Error("account was affected");
  const details = await owner.client.query(api.communities.details, { serverId });
  if (!details?.server) throw new Error("community was deleted");
  if (!details.channels.length) throw new Error("channels were deleted");
  if (!details.members.some((m) => m.userId === owner.userId)) throw new Error("membership was deleted");
  return true;
});

// ---------------------------------------------------------------------------
// 8. Cleanup stops once usage returns to the safe target.
// ---------------------------------------------------------------------------
await expectTrue("cleanup stops at the safe target (does not delete everything)", async () => {
  const owner = O[3];
  const { serverId, channelId } = await makeGuild(owner, "safe");
  for (let i = 0; i < 6; i++) await send(owner, channelId, `safe ${i}`);
  // 6/0.9 = 6.67 → ratio 0.9. Each deletion of 1 row drops the ratio by ~0.15,
  // so it should stop after ~2 deletions, well above safeRatio 0.65.
  const run = await owner.client.mutation(api.storage.pruneOldMessages, {
    serverId, olderThanMs: 0, budgetBytes: BIG_BYTES, budgetRows: 6 / 0.9,
    batchSize: 1, maxBatches: 20,
  });
  if (run.deleted < 1) throw new Error("expected some cleanup to happen");
  if (run.deleted >= 6) throw new Error("cleanup did not stop at the safe level");
  const msgs = await owner.client.query(api.chat.messages, { channelId });
  if (msgs.length === 0) throw new Error("cleanup drained the community instead of stopping safely");
  return true;
});

// ---------------------------------------------------------------------------
// 9. Errors are handled cleanly (no crash), and requests are authorized.
// ---------------------------------------------------------------------------
await expectError("non-owner cannot prune a community they do not own", async () => {
  const { serverId } = await makeGuild(O[0], "authz");
  await B.client.mutation(api.storage.pruneOldMessages, { serverId, olderThanMs: 0 });
});
await expectError("cleanup requires a signed-in user", async () => {
  const anon = new ConvexHttpClient(URL);
  await anon.mutation(api.storage.requestCleanup, {});
});
await expectOk("client can request background cleanup without blocking", async () => {
  const res = await O[0].client.mutation(api.storage.requestCleanup, {});
  if (res?.scheduled !== true) throw new Error("cleanup was not scheduled");
});

// ---------------------------------------------------------------------------
// 10. Locking prevents concurrent cleanup runs.
// ---------------------------------------------------------------------------
await expectTrue("concurrent cleanup runs are locked", async () => {
  const owner = O[2];
  const { serverId, channelId } = await makeGuild(owner, "lock");
  for (let i = 0; i < 6; i++) await send(owner, channelId, `lock ${i}`);
  const args = {
    serverId, olderThanMs: 0, budgetBytes: BIG_BYTES, budgetRows: 6 / 0.9, batchSize: 2, maxBatches: 5,
  };
  const results = await Promise.allSettled([
    owner.client.mutation(api.storage.pruneOldMessages, args),
    owner.client.mutation(api.storage.pruneOldMessages, args),
  ]);
  const rejected = results.filter((r) => r.status === "rejected");
  // At most one may be rejected, and only with the lock message.
  if (rejected.length > 1) throw new Error("more than one run was rejected");
  for (const r of rejected) {
    const msg = String(r.reason?.message ?? r.reason);
    if (!/already running/i.test(msg)) throw new Error(`unexpected rejection: ${msg}`);
  }
  if (results.every((r) => r.status === "rejected")) throw new Error("both runs were rejected");
  const msgs = await owner.client.query(api.chat.messages, { channelId });
  if (msgs.length >= 6) throw new Error("no cleanup happened");
  return true;
});

// ---------------------------------------------------------------------------
// 11. New messages (and DMs, replies, GIFs, files) still work after cleanup.
// ---------------------------------------------------------------------------
await expectTrue("new channel message, reply, GIF and file work after cleanup", async () => {
  const owner = O[3];
  const { serverId, channelId } = await makeGuild(owner, "after");
  for (let i = 0; i < 4; i++) await send(owner, channelId, `before ${i}`);
  await owner.client.mutation(api.storage.pruneOldMessages, {
    serverId, olderThanMs: 0, budgetBytes: BIG_BYTES, budgetRows: 4 / 0.9, batchSize: 1, maxBatches: 2,
  });
  const remaining = await owner.client.query(api.chat.messages, { channelId });
  if (remaining.length === 0) throw new Error("expected a surviving message to reply to");

  const fresh = await send(owner, channelId, `after cleanup ${Date.now()}`);
  const reply = await owner.client.mutation(api.chat.sendMessage, {
    channelId, body: "a reply after cleanup", replyToId: remaining[remaining.length - 1]._id,
  });
  const gifMsg = await owner.client.mutation(api.chat.sendMessage, { channelId, body: "", gif: GIF });
  const withFile = await send(owner, channelId, "file after cleanup");
  const storageId = await upload(owner.client, "after.png", "image/png", PNG);
  await owner.client.mutation(api.uploads.attach, {
    storageId, name: "after.png", size: PNG.length, contentType: "image/png", messageId: withFile,
  });

  const msgs = await owner.client.query(api.chat.messages, { channelId });
  const byId = new Map(msgs.map((m) => [m._id, m]));
  if (!byId.has(fresh)) throw new Error("new message missing");
  const replyMsg = byId.get(reply);
  if (!replyMsg?.reply || replyMsg.reply.deleted) throw new Error("reply did not resolve");
  const gifResolved = byId.get(gifMsg);
  if (gifResolved?.gif?.id !== GIF.id) throw new Error("GIF message missing");
  const fileMsg = byId.get(withFile);
  if (!fileMsg?.attachments?.length || !fileMsg.attachments[0].url) throw new Error("file attachment missing");
  return true;
});

await expectTrue("direct messages still work after cleanup", async () => {
  const convo = await A.client.mutation(api.dms.startDirect, { userId: B.userId });
  const id = await A.client.mutation(api.dms.sendMessage, { conversationId: convo, body: "dm after cleanup" });
  const msgs = (await A.client.query(api.dms.messages, { conversationId: convo })).messages;
  if (!msgs.some((m) => m._id === id)) throw new Error("DM message missing");
  return true;
});

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
