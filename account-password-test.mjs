// End-to-end tests for account passwords, email+password sign-in, presence
// statuses and GIPHY config against the dev deployment.
// Run: bun account-password-test.mjs
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

function authed(res) {
  const token = res?.tokens?.token;
  if (!token) throw new Error("no token");
  const client = new ConvexHttpClient(URL);
  client.setAuth(token);
  return client;
}

async function newUser(label, extra = {}) {
  const username = `${label}_${stamp}`;
  const client = new ConvexHttpClient(URL);
  const res = await client.action(api.auth.signIn, {
    provider: "password",
    params: { flow: "signUp", username, password: "Passw0rd123", ...extra },
  });
  const c = authed(res);
  const me = await c.query(api.users.me, {});
  return { client: c, username, userId: me.userId };
}

async function signInPassword(username, password) {
  const client = new ConvexHttpClient(URL);
  const res = await client.action(api.auth.signIn, {
    provider: "password",
    params: { flow: "signIn", username, password },
  });
  return authed(res);
}

// An account with NO password (mirrors an email-only account's auth state).
async function newPasswordless(label) {
  const client = new ConvexHttpClient(URL);
  const res = await client.action(api.auth.signIn, { provider: "anonymous", params: {} });
  const c = authed(res);
  const ident = await c.mutation(api.users.ensureIdentity, {});
  const me = await c.query(api.users.me, {});
  return { client: c, username: ident?.username, userId: me.userId };
}

// ===================== 1. Set / Change / Reset password =====================

const anon = await newPasswordless("pwless");
await expectTrue("passwordless account exists with no password", async () => {
  const state = await anon.client.query(api.passwords.passwordState, {});
  return state && state.hasPassword === false && typeof state.username === "string";
});

await expectError("setPassword rejects a weak password", async () => {
  await anon.client.action(api.passwords.setPassword, { password: "short" });
});

await expectOk("setPassword attaches a password to the EXISTING account", async () => {
  await anon.client.action(api.passwords.setPassword, { password: "NewPass123" });
});

await expectTrue("passwordState flips to hasPassword without a new account", async () => {
  const state = await anon.client.query(api.passwords.passwordState, {});
  return state.hasPassword === true;
});

await expectError("setPassword refuses to overwrite an existing password", async () => {
  await anon.client.action(api.passwords.setPassword, { password: "Another123" });
});

await expectTrue("username + password loads the SAME account", async () => {
  const c = await signInPassword(anon.username, "NewPass123");
  const me = await c.query(api.users.me, {});
  return me.userId === anon.userId;
});

await expectError("changePassword rejects a wrong current password", async () => {
  await anon.client.action(api.passwords.changePassword, { currentPassword: "nope", newPassword: "Changed123" });
});

await expectOk("changePassword updates the password", async () => {
  await anon.client.action(api.passwords.changePassword, { currentPassword: "NewPass123", newPassword: "Changed123" });
});

await expectTrue("the new password works and stays the same account", async () => {
  const c = await signInPassword(anon.username, "Changed123");
  const me = await c.query(api.users.me, {});
  return me.userId === anon.userId;
});

await expectError("the old password no longer works after a change", async () => {
  await signInPassword(anon.username, "NewPass123");
});

await expectOk("resetPassword overwrites while signed in", async () => {
  await anon.client.action(api.passwords.resetPassword, { newPassword: "ResetPass123" });
});

await expectTrue("reset password loads the same account", async () => {
  const c = await signInPassword(anon.username, "ResetPass123");
  const me = await c.query(api.users.me, {});
  return me.userId === anon.userId;
});

await expectTrue("passwordState is null for signed-out callers", async () => {
  const c = new ConvexHttpClient(URL);
  return (await c.query(api.passwords.passwordState, {})) === null;
});

await expectError("password actions require authentication", async () => {
  const c = new ConvexHttpClient(URL);
  await c.action(api.passwords.setPassword, { password: "Whatever123" });
});

// ===================== 2. Email + password sign-in =====================

const email = `pwmail_${stamp}@example.com`;
const withEmail = await newUser("pwemail", { email });
await expectTrue("email + password signs into the SAME account", async () => {
  const c = new ConvexHttpClient(URL);
  const res = await c.action(api.auth.signIn, {
    provider: "email-password",
    params: { email, password: "Passw0rd123" },
  });
  const authedClient = authed(res);
  const me = await authedClient.query(api.users.me, {});
  return me.userId === withEmail.userId;
});
await expectError("email + wrong password fails generically", async () => {
  const c = new ConvexHttpClient(URL);
  await c.action(api.auth.signIn, { provider: "email-password", params: { email, password: "wrongwrong" } });
});
await expectError("email + password for an unknown email fails generically", async () => {
  const c = new ConvexHttpClient(URL);
  await c.action(api.auth.signIn, { provider: "email-password", params: { email: `nobody_${stamp}@example.com`, password: "Whatever123" } });
});

// ===================== 3. Presence statuses =====================

const A = await newUser("presA");
const B = await newUser("presB");

async function seenByB(status) {
  const profile = await B.client.query(api.users.publicProfile, { userId: A.userId });
  return { status: profile?.presence, lastSeen: profile?.lastSeen };
}

await expectTrue("Online shows as green (online) to others", async () => {
  await A.client.mutation(api.profiles.setPresence, { status: "online", manual: true });
  return (await seenByB()).status === "online";
});
await expectTrue("DND shows as red (dnd) to others", async () => {
  await A.client.mutation(api.profiles.setPresence, { status: "dnd", manual: true });
  return (await seenByB()).status === "dnd";
});
await expectTrue("DND keeps the user connected, not offline", async () => {
  const me = await A.client.query(api.users.me, {});
  return me.presence === "dnd";
});
await expectTrue("Invisible hides the indicator from others (offline)", async () => {
  await A.client.mutation(api.profiles.setPresence, { status: "invisible", manual: true });
  return (await seenByB()).status === "offline";
});
await expectTrue("Invisible still keeps the real session active for self", async () => {
  const me = await A.client.query(api.users.me, {});
  return me.presence === "invisible";
});
await expectTrue("Invisible -> Online is visible again", async () => {
  await A.client.mutation(api.profiles.setPresence, { status: "online", manual: true });
  return (await seenByB()).status === "online";
});
await expectTrue("Disconnect shows no indicator (offline) with a last-seen", async () => {
  await A.client.mutation(api.profiles.disconnect, {});
  const seen = await seenByB();
  return seen.status === "offline" && typeof seen.lastSeen === "number";
});

// ===================== 4. GIPHY config is optional =====================

await expectTrue("giphy config returns a safe shape for signed-in users", async () => {
  const cfg = await B.client.query(api.gifConfig.giphyConfig, {});
  return typeof cfg.configured === "boolean" && (cfg.apiKey === null || typeof cfg.apiKey === "string");
});
await expectTrue("giphy config is not exposed to signed-out callers", async () => {
  const c = new ConvexHttpClient(URL);
  const cfg = await c.query(api.gifConfig.giphyConfig, {});
  return cfg.configured === false && cfg.apiKey === null;
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
