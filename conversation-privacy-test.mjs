// End-to-end tests for Locked & Hidden Conversations (personal conversation
// privacy with a PIN), against the dev deployment.
//
// Proves the security model is enforced by the BACKEND, not the UI:
//   - a locked conversation returns no messages until the PIN is entered
//   - a hidden conversation vanishes from the normal list and only appears in
//     Secret Chats after the PIN
//   - the PIN is never returned by any API and is verified server-side
//   - repeated wrong PINs trigger a temporary lockout
//   - notifications for locked/hidden conversations never contain the content
//   - protection and hidden state persist per account across sessions
//   - managing (unhide, unprotect, change PIN) all require the PIN
//
// Run: bun conversation-privacy-test.mjs
import { ConvexHttpClient } from "convex/browser";
import { api } from "./src/convex/_generated/api.js";

const URL = "https://academic-porcupine-929.convex.cloud";
const stamp = Date.now().toString(36);
let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e?.message ?? e}`); };

async function expectOk(name, fn) {
  try { await fn(); ok(name); }
  catch (e) { bad(name, e); }
}
async function expectError(name, fn, match) {
  try {
    await fn();
    bad(name, "expected an error but it succeeded");
  } catch (e) {
    const msg = `${typeof e?.data === "string" ? e.data : JSON.stringify(e?.data)} ${e?.message ?? ""} ${e?.stack ?? ""}`;
    if (match && !msg.toLowerCase().includes(match.toLowerCase())) bad(name, `wrong error: ${msg}`);
    else ok(name);
  }
}
async function expectTrue(name, fn) {
  try { if (!(await fn())) throw new Error("assertion was false"); ok(name); }
  catch (e) { bad(name, e); }
}

async function newUser(label, extra = {}) {
  const username = `${label}_${stamp}`;
  const client = new ConvexHttpClient(URL);
  const res = await client.action(api.auth.signIn, {
    provider: "password",
    params: { flow: "signUp", username, password: "Passw0rd123", ...extra },
  });
  client.setAuth(res.tokens.token);
  const me = await client.query(api.users.me, {});
  return { client, username, userId: me.userId };
}

async function signInPassword(username) {
  const client = new ConvexHttpClient(URL);
  const res = await client.action(api.auth.signIn, {
    provider: "password",
    params: { flow: "signIn", username, password: "Passw0rd123" },
  });
  client.setAuth(res.tokens.token);
  return client;
}

const conv = (list, id) => list.find((c) => c.conversationId === id);

// ---------------------------------------------------------------------------
const A = await newUser("priv_alice");
const B = await newUser("priv_bob");

const conversationId = await A.client.mutation(api.dms.startDirect, { userId: B.userId });
const SECRET_TEXT = `super secret ${stamp}`;
await A.client.mutation(api.dms.sendMessage, { conversationId, body: SECRET_TEXT });
await B.client.mutation(api.dms.sendMessage, { conversationId, body: `bob reply ${stamp}` });

await expectTrue("baseline: unlocked conversation returns its messages", async () => {
  const msgs = await A.client.query(api.dms.messages, { conversationId });
  return msgs.messages.length === 2 && msgs.messages.some((m) => m.body === SECRET_TEXT);
});

// ---------------------------------------------------------------------------
// Lock only
// ---------------------------------------------------------------------------
await expectOk("protecting a conversation creates the PIN and locks it", () =>
  A.client.action(api.conversationPrivacy.protectConversation, {
    conversationId, hidden: false, pin: "1234", confirmPin: "1234",
  }));

await expectTrue("pinState reports a PIN but never returns a hash", async () => {
  const state = await A.client.query(api.conversationPrivacy.pinState, {});
  if (!state.hasPin) throw new Error("hasPin false");
  const serialized = JSON.stringify(state);
  if (serialized.includes("pinHash") || serialized.includes("1234")) throw new Error("PIN material leaked");
  return true;
});

await expectTrue("a locked conversation returns NO messages", async () => {
  const msgs = await A.client.query(api.dms.messages, { conversationId });
  return msgs.messages.length === 0 && msgs.locked === true;
});

await expectTrue("a locked conversation stays in the list with a lock flag and no preview", async () => {
  const list = await A.client.query(api.dms.listConversations, {});
  const row = conv(list, conversationId);
  return Boolean(row) && row.locked === true && row.unlocked === false && row.lastMessage === "";
});

await expectError("sending into a locked conversation requires unlocking", () =>
  A.client.mutation(api.dms.sendMessage, { conversationId, body: "should not send" }), "locked");

await expectError("a wrong PIN is rejected", () =>
  A.client.action(api.conversationPrivacy.unlockConversation, { conversationId, pin: "9999" }), "incorrect");

await expectOk("the correct PIN unlocks the conversation", () =>
  A.client.action(api.conversationPrivacy.unlockConversation, { conversationId, pin: "1234" }));

await expectTrue("after unlocking, messages are readable again", async () => {
  const msgs = await A.client.query(api.dms.messages, { conversationId });
  return msgs.messages.length === 2 && msgs.locked === false && msgs.messages.some((m) => m.body === SECRET_TEXT);
});

await expectTrue("after unlocking, the preview returns", async () => {
  const row = conv(await A.client.query(api.dms.listConversations, {}), conversationId);
  return row.unlocked === true && row.lastMessage.length > 0;
});

await expectOk("re-locking withholds the messages again", async () => {
  await A.client.mutation(api.conversationPrivacy.relock, { conversationId });
  const msgs = await A.client.query(api.dms.messages, { conversationId });
  if (msgs.messages.length !== 0 || msgs.locked !== true) throw new Error("still readable after relock");
});

// Other members are unaffected by A's personal lock.
await expectTrue("B (who did not lock it) still sees the conversation normally", async () => {
  const msgs = await B.client.query(api.dms.messages, { conversationId });
  const row = conv(await B.client.query(api.dms.listConversations, {}), conversationId);
  return msgs.messages.length === 2 && msgs.locked === false && row.locked === false;
});

// ---------------------------------------------------------------------------
// Hide & lock
// ---------------------------------------------------------------------------
await expectOk("hiding a locked conversation requires the PIN", () =>
  A.client.action(api.conversationPrivacy.setConversationHidden, { conversationId, hidden: true, pin: "1234" }));

await expectTrue("a hidden conversation is gone from the normal list", async () => {
  const list = await A.client.query(api.dms.listConversations, {});
  return conv(list, conversationId) === undefined;
});

await expectTrue("a hidden conversation does not count toward the unread badge", async () => {
  const total = await A.client.query(api.dms.unreadTotal, {});
  const rows = await A.client.query(api.dms.listConversations, {});
  const sum = rows.reduce((n, r) => n + r.unread, 0);
  return total === sum;
});

await expectTrue("Secret Chats is NOT unlocked just by asking for it", async () => {
  const secrets = await A.client.query(api.conversationPrivacy.secretChats, {});
  return secrets.unlocked === false && secrets.conversations.length === 0;
});

await expectTrue("without the PIN the hidden conversation's messages stay withheld", async () => {
  const msgs = await A.client.query(api.dms.messages, { conversationId });
  return msgs.messages.length === 0 && msgs.locked === true;
});

await expectOk("the PIN opens Secret Chats", () =>
  A.client.action(api.conversationPrivacy.unlockSecretChats, { pin: "1234" }));

await expectTrue("Secret Chats then lists the hidden conversation with its preview", async () => {
  const secrets = await A.client.query(api.conversationPrivacy.secretChats, {});
  const row = conv(secrets.conversations, conversationId);
  return secrets.unlocked === true && Boolean(row) && row.hidden === true && row.lastMessage.length > 0;
});

await expectOk("a hidden conversation can be made visible again", () =>
  A.client.action(api.conversationPrivacy.setConversationHidden, { conversationId, hidden: false, pin: "1234" }));

await expectTrue("it is back in the normal list", async () => {
  const row = conv(await A.client.query(api.dms.listConversations, {}), conversationId);
  return Boolean(row) && row.locked === true;
});

// ---------------------------------------------------------------------------
// Notifications must not leak locked/hidden content
// ---------------------------------------------------------------------------
await expectOk("hide the conversation again for the notification test", () =>
  A.client.action(api.conversationPrivacy.setConversationHidden, { conversationId, hidden: true, pin: "1234" }));

await expectOk("B sends a new message", () =>
  B.client.mutation(api.dms.sendMessage, { conversationId, body: `private ping ${stamp}` }));

await expectTrue("A's notification is generic and carries no content or sender", async () => {
  const { items: notes } = await A.client.query(api.social.listNotifications, {});
  const newest = notes[0];
  if (!newest) throw new Error("no notification created");
  const haystack = `${newest.title ?? ""} ${newest.body ?? ""}`.toLowerCase();
  if (haystack.includes(stamp.toLowerCase())) throw new Error("notification leaked the message body");
  if (newest.title !== "New private message") throw new Error(`unexpected title: ${newest.title}`);
  if (newest.actorId) throw new Error("notification leaked the sender");
  return true;
});

// ---------------------------------------------------------------------------
// Persistence + management
// ---------------------------------------------------------------------------
await expectTrue("the hidden+locked state persists: a brand-new session is locked again", async () => {
  const fresh = await signInPassword(A.username);
  const list = await fresh.query(api.dms.listConversations, {});
  if (conv(list, conversationId) !== undefined) throw new Error("hidden conversation visible after re-login");
  // Unlock grants are scoped to the session that entered the PIN, so signing in
  // again must NOT inherit the previous unlock.
  const secrets = await fresh.query(api.conversationPrivacy.secretChats, {});
  if (secrets.unlocked !== false) throw new Error("Secret Chats inherited an unlock from another session");
  const msgs = await fresh.query(api.dms.messages, { conversationId });
  if (msgs.messages.length !== 0 || msgs.locked !== true) throw new Error("messages leaked to a new session");
  return true;
});

await expectError("changing the PIN needs the current PIN", () =>
  A.client.action(api.conversationPrivacy.setPin, { pin: "5678", confirmPin: "5678", currentPin: "0000" }), "incorrect");

await expectOk("the PIN can be changed with the current PIN", () =>
  A.client.action(api.conversationPrivacy.setPin, { pin: "5678", confirmPin: "5678", currentPin: "1234" }));

await expectError("the old PIN no longer works", () =>
  A.client.action(api.conversationPrivacy.unlockSecretChats, { pin: "1234" }), "incorrect");

await expectOk("the new PIN works", () => A.client.action(api.conversationPrivacy.unlockSecretChats, { pin: "5678" }));

await expectError("temporary 0000 is not a choosable PIN", () =>
  A.client.action(api.conversationPrivacy.setPin, { pin: "0000", confirmPin: "0000", currentPin: "5678" }), "reserved");

await expectError("unprotecting requires the PIN", () =>
  A.client.action(api.conversationPrivacy.unprotectConversation, { conversationId, pin: "1111" }), "incorrect");

await expectOk("unprotecting with the PIN releases the conversation", () =>
  A.client.action(api.conversationPrivacy.unprotectConversation, { conversationId, pin: "5678" }));

await expectTrue("an unprotected conversation is visible again with messages", async () => {
  const row = conv(await A.client.query(api.dms.listConversations, {}), conversationId);
  const msgs = await A.client.query(api.dms.messages, { conversationId });
  return Boolean(row) && row.locked === false && msgs.locked === false && msgs.messages.length >= 3;
});

// ---------------------------------------------------------------------------
// Lockout after repeated wrong attempts (dedicated account so the main flow is
// never left locked out).
// ---------------------------------------------------------------------------
const C = await newUser("priv_carol");
const cConversation = await C.client.mutation(api.dms.startDirect, { userId: B.userId });
await expectOk("Carol protects her conversation", () =>
  C.client.action(api.conversationPrivacy.protectConversation, {
    conversationId: cConversation, hidden: false, pin: "4321", confirmPin: "4321",
  }));
for (let i = 0; i < 5; i++) {
  await expectError(`wrong attempt ${i + 1} is rejected`, () =>
    C.client.action(api.conversationPrivacy.unlockConversation, { conversationId: cConversation, pin: "0000" }), "");
}
await expectError("after 5 wrong attempts the account is temporarily locked out", () =>
  C.client.action(api.conversationPrivacy.unlockConversation, { conversationId: cConversation, pin: "4321" }), "too many");

// PIN reset guard rails (no mailbox is available in this environment, so the
// delivered email itself cannot be read back; the server-side guards are tested).
await expectTrue("resetAvailability reports whether an email exists", async () => {
  const info = await C.client.query(api.conversationPrivacy.resetAvailability, {});
  return info.hasEmail === false && info.hasPin === true;
});
await expectError("a reset request without an account email is refused", () =>
  C.client.action(api.conversationPrivacy.requestPinReset, {}), "no email");
await expectError("verifying a code with no pending request is refused", () =>
  C.client.action(api.conversationPrivacy.verifyPinResetCode, { code: "123456" }), "request a new reset code");

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
await expectOk("clean up test accounts", async () => {
  await C.client.mutation(api.users.deleteAccount, { confirmUsername: C.username });
  await B.client.mutation(api.users.deleteAccount, { confirmUsername: B.username });
  await A.client.mutation(api.users.deleteAccount, { confirmUsername: A.username });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
