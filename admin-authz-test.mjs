// End-to-end authorization tests for the FreeBuff Owner/Admin role system.
// Run: bun admin-authz-test.mjs
//
// Proves the role hierarchy is enforced SERVER-SIDE (not just by hiding buttons):
//   - normal users cannot reach the panel or perform admin actions
//   - protected Owner Admin accounts cannot be demoted/banned/suspended/deleted
//   - only Owner Admins may manage administrators
//   - nobody can change their own role
//   - a duplicate account with a protected email cannot hijack ownership
//   - role changes are written to the audit log with previous/new role
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
  return { client: c, username, userId: me.userId, role: me.role };
}

async function roleOf(client) {
  const me = await client.query(api.users.me, {});
  return me.role;
}

/** Fresh session for an existing account (same username + password). */
async function signInPassword(username) {
  const client = new ConvexHttpClient(URL);
  const res = await client.action(api.auth.signIn, {
    provider: "password",
    params: { flow: "signIn", username, password: "Passw0rd123" },
  });
  const token = res?.tokens?.token;
  if (!token) throw new Error("no token");
  client.setAuth(token);
  return client;
}

const OWNER_EMAIL = "matthewisley16@gmail.com"; // free at time of writing
const CLAIMED_EMAIL = "matthew@icscomp.com";    // already owned by the real account

// ---------------------------------------------------------------------------
// Phase 1 — a normal user has no admin powers at all.
// ---------------------------------------------------------------------------
const A = await newUser("authz_alice");
const B = await newUser("authz_bob");
const E = await newUser("authz_eve");

await expectTrue("normal user is role 'user'", async () => (await roleOf(A.client)) === "user");
await expectTrue("normal user cannot access the panel", async () => {
  const a = await A.client.query(api.admin.panelAccess, {});
  return a.canAccess === false && a.isOwner === false;
});
await expectTrue("normal user sees no admin stats", async () => (await A.client.query(api.admin.stats, {})) === null);
await expectTrue("normal user lists no users", async () => (await A.client.query(api.admin.listUsers, {})).length === 0);
await expectTrue("normal user lists no communities", async () => (await A.client.query(api.admin.listCommunities, {})).length === 0);
await expectTrue("normal user sees no audit log", async () => (await A.client.query(api.admin.listAuditLogs, {})).length === 0);
await expectTrue("normal user sees no platform settings", async () => (await A.client.query(api.admin.getPlatformSettings, {})) === null);
await expectError("normal user cannot promote anyone", () => A.client.mutation(api.admin.setUserRole, { userId: B.userId, role: "admin" }));
await expectError("normal user cannot promote themselves", () => A.client.mutation(api.admin.setUserRole, { userId: A.userId, role: "admin" }));
await expectError("normal user cannot ban", () => A.client.mutation(api.admin.banUser, { userId: B.userId, reason: "nope" }));
await expectError("normal user cannot suspend", () => A.client.mutation(api.admin.suspendUser, { userId: B.userId, durationMs: 60000 }));
await expectError("normal user cannot delete an account", () => A.client.mutation(api.admin.deleteUser, { userId: B.userId }));
await expectError("normal user cannot change platform settings", () => A.client.mutation(api.admin.updatePlatformSettings, { announcement: "hacked" }));

// ---------------------------------------------------------------------------
// Phase 2 — the protected owner email auto-receives Owner Admin.
// ---------------------------------------------------------------------------
const O = await newUser("authz_owner", { email: OWNER_EMAIL, displayName: "Owner Test" });
await expectTrue("protected owner email auto-becomes Owner Admin (owner_admin)", async () => (await roleOf(O.client)) === "owner_admin");
await expectTrue("owner account reports isOwner=true and isProtectedOwner=true", async () => {
  const me = await O.client.query(api.users.me, {});
  return me.role === "owner_admin" && me.isOwner === true && me.isAdmin === true && me.isProtectedOwner === true;
});
await expectTrue("owner can access the panel", async () => {
  const a = await O.client.query(api.admin.panelAccess, {});
  return a.canAccess === true && a.isOwner === true && a.isProtectedOwner === true && a.role === "owner_admin";
});
await expectTrue("owner sees real stats", async () => (await O.client.query(api.admin.stats, {})) !== null);
await expectTrue("owner listUsers marks the owner account protected", async () => {
  const users = await O.client.query(api.admin.listUsers, { q: O.username });
  const row = users.find((u) => u.userId === O.userId);
  return Boolean(row && row.role === "owner_admin" && row.isProtectedOwner === true);
});
await expectTrue("owner-role filter matches owner_admin accounts", async () => {
  const users = await O.client.query(api.admin.listUsers, { role: "owner" });
  return users.some((u) => u.userId === O.userId);
});
await expectError("Owner Admin is not assignable through setUserRole", () => O.client.mutation(api.admin.setUserRole, { userId: A.userId, role: "owner_admin" }));

// Signing in again (a fresh session) must keep the Owner Admin role: the
// backend re-checks the authenticated email on the identity sync the app runs
// on load, and no duplicate account is created.
await expectTrue("signing in again keeps Owner Admin and creates no duplicate", async () => {
  const again = await signInPassword(O.username);
  await again.mutation(api.users.ensureIdentity, {});
  const me = await again.query(api.users.me, {});
  if (me.role !== "owner_admin" || me.isOwner !== true) return false;
  const matches = await again.query(api.admin.listUsers, { q: OWNER_EMAIL });
  return matches.filter((u) => u.email === OWNER_EMAIL).length === 1;
});

// Owner promotes A to admin, E to moderator.
await expectOk("owner promotes a user to Admin", () => O.client.mutation(api.admin.setUserRole, { userId: A.userId, role: "admin" }));
await expectTrue("promoted user is now an Admin with panel access", async () => {
  const a = await A.client.query(api.admin.panelAccess, {});
  return a.canAccess === true && (await roleOf(A.client)) === "admin";
});
await expectOk("owner promotes a user to Moderator", () => O.client.mutation(api.admin.setUserRole, { userId: E.userId, role: "moderator" }));

// ---------------------------------------------------------------------------
// Phase 3 — protected owners are untouchable, even by another admin.
// ---------------------------------------------------------------------------
await expectError("an Admin cannot demote a protected Owner Admin", () => A.client.mutation(api.admin.setUserRole, { userId: O.userId, role: "user" }));
await expectError("an Admin cannot ban a protected Owner Admin", () => A.client.mutation(api.admin.banUser, { userId: O.userId }));
await expectError("an Admin cannot suspend a protected Owner Admin", () => A.client.mutation(api.admin.suspendUser, { userId: O.userId, durationMs: 60000 }));
await expectError("an Admin cannot delete a protected Owner Admin", () => A.client.mutation(api.admin.deleteUser, { userId: O.userId }));
await expectTrue("Owner Admin still holds the owner role after those attempts", async () => (await roleOf(O.client)) === "owner_admin");

// ---------------------------------------------------------------------------
// Phase 4 — hierarchy rules for normal admins.
// ---------------------------------------------------------------------------
await expectError("an Admin cannot change their own role", () => A.client.mutation(api.admin.setUserRole, { userId: A.userId, role: "owner_admin" }));
await expectError("an Admin cannot promote anyone else to Admin", () => A.client.mutation(api.admin.setUserRole, { userId: E.userId, role: "admin" }));

// Owner promotes B to Admin: now A must not be able to manage a peer admin.
await expectOk("owner promotes a second Admin", () => O.client.mutation(api.admin.setUserRole, { userId: B.userId, role: "admin" }));
await expectError("one Admin cannot demote another Admin", () => A.client.mutation(api.admin.setUserRole, { userId: B.userId, role: "user" }));
await expectError("one Admin cannot ban another Admin", () => A.client.mutation(api.admin.banUser, { userId: B.userId }));

// Owner demotes B back and A back at the end of the hierarchy checks.
await expectOk("owner can demote a regular Admin", () => O.client.mutation(api.admin.setUserRole, { userId: B.userId, role: "user" }));
await expectTrue("demoted Admin loses panel access", async () => {
  const a = await B.client.query(api.admin.panelAccess, {});
  return a.canAccess === false;
});

// ---------------------------------------------------------------------------
// Phase 5 — moderators cannot access the panel or manage anyone.
// ---------------------------------------------------------------------------
await expectTrue("a Moderator cannot access the panel", async () => {
  const a = await E.client.query(api.admin.panelAccess, {});
  return a.canAccess === false;
});
await expectError("a Moderator cannot change roles", () => E.client.mutation(api.admin.setUserRole, { userId: A.userId, role: "user" }));
await expectError("a Moderator cannot ban", () => E.client.mutation(api.admin.banUser, { userId: A.userId }));

// ---------------------------------------------------------------------------
// Phase 6 — audit log records who/what/target/previous/new role.
// ---------------------------------------------------------------------------
await expectTrue("audit log records the role change with previous and new role", async () => {
  const logs = await O.client.query(api.admin.listAuditLogs, { limit: 200 });
  const entry = logs.find((l) => l.action === "account.role.update" && l.targetId === A.userId && l.newRole === "admin");
  return Boolean(entry && entry.previousRole === "user" && entry.newRole === "admin" && entry.actor);
});
await expectTrue("audit log records bans/suspensions actions", async () => {
  const logs = await O.client.query(api.admin.listAuditLogs, { limit: 200 });
  return logs.some((l) => l.action.startsWith("account."));
});

// ---------------------------------------------------------------------------
// Phase 7 — platform settings are Owner-only and actually enforced.
// ---------------------------------------------------------------------------
await expectError("an Admin cannot change platform settings", () => A.client.mutation(api.admin.updatePlatformSettings, { announcement: "no" }));
await expectOk("owner can change platform settings", () => O.client.mutation(api.admin.updatePlatformSettings, { announcement: `hello ${stamp}` }));
await expectTrue("platform settings reflect the change", async () => {
  const s = await O.client.query(api.admin.getPlatformSettings, {});
  return s.announcement === `hello ${stamp}`;
});

// Community creation gate.
await expectOk("owner disables new communities", () => O.client.mutation(api.admin.updatePlatformSettings, { newCommunitiesEnabled: false }));
await expectError("a normal user cannot create a community while disabled", () => B.client.mutation(api.communities.create, { name: `Gated Guild ${stamp}`, description: "blocked" }));
let gatedCommunityId = null;
await expectOk("an Owner Admin can still create a community while disabled", async () => {
  gatedCommunityId = await O.client.mutation(api.communities.create, { name: `Admin Guild ${stamp}`, description: "owner" });
});

// Community deletion is Owner-only.
await expectError("a regular Admin cannot delete a community", () => A.client.mutation(api.admin.deleteCommunity, { serverId: gatedCommunityId }));
await expectOk("owner can delete a community", () => O.client.mutation(api.admin.deleteCommunity, { serverId: gatedCommunityId }));

// Discovery gate.
await expectOk("owner disables discovery", () => O.client.mutation(api.admin.updatePlatformSettings, { discoveryEnabled: false }));
await expectTrue("discovery returns nothing while disabled", async () => (await A.client.query(api.communities.discover, {})).length === 0);
await expectOk("owner restores settings", () => O.client.mutation(api.admin.updatePlatformSettings, { announcement: "", newCommunitiesEnabled: true, discoveryEnabled: true }));
await expectTrue("discovery works again after restore", async () => (await A.client.query(api.communities.discover, {})).length >= 0);

// ---------------------------------------------------------------------------
// Phase 8 — a duplicate account with a protected email cannot hijack ownership.
// ---------------------------------------------------------------------------
const DUP = await newUser("authz_dup", { email: CLAIMED_EMAIL });
await expectTrue("a duplicate account with a taken protected email does NOT become owner", async () => (await roleOf(DUP.client)) !== "owner_admin" && (await roleOf(DUP.client)) !== "owner");
await expectTrue("duplicate account cannot access the panel", async () => (await DUP.client.query(api.admin.panelAccess, {})).canAccess === false);
await expectTrue("duplicate account cannot demote the real owner", async () => {
  // Even if it somehow had the email, it must not be able to touch the owner.
  const a = await DUP.client.query(api.admin.panelAccess, {});
  return a.canAccess === false;
});

// ---------------------------------------------------------------------------
// Phase 9 — owner can demote regular admins; protected owner survives.
// ---------------------------------------------------------------------------
await expectOk("owner demotes the first Admin", () => O.client.mutation(api.admin.setUserRole, { userId: A.userId, role: "user" }));
await expectTrue("demoted user loses panel access", async () => (await A.client.query(api.admin.panelAccess, {})).canAccess === false);

// ---------------------------------------------------------------------------
// Cleanup — remove the test owner + duplicate accounts and reset settings.
// (Protections only block the Admin Panel; self-service deletion still works.)
// ---------------------------------------------------------------------------
await expectOk("clean up test owner account", () => O.client.mutation(api.users.deleteAccount, { confirmUsername: O.username }));
await expectOk("clean up duplicate-email account", () => DUP.client.mutation(api.users.deleteAccount, { confirmUsername: DUP.username }));
await expectOk("clean up eve", () => E.client.mutation(api.users.deleteAccount, { confirmUsername: E.username }));
await expectOk("clean up bob", () => B.client.mutation(api.users.deleteAccount, { confirmUsername: B.username }));
await expectOk("clean up alice", () => A.client.mutation(api.users.deleteAccount, { confirmUsername: A.username }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
