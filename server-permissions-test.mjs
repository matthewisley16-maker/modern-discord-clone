// End-to-end tests for the per-server administration system: server roles,
// channel-level permissions, owner protection and isolation between servers.
// Run: bun server-permissions-test.mjs
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
  client.setAuth(res.tokens.token);
  const me = await client.query(api.users.me, {});
  return { client, username, userId: me.userId };
}

const P = await newUser("srv_owner");
const Q = await newUser("srv_member");

// P owns server A; Q joins by invite.
let serverA, generalA, inviteCodeA;
await expectOk("owner creates a community", async () => {
  serverA = await P.client.mutation(api.communities.create, { name: `Perms Guild ${stamp}`, description: "server perms" });
  const d = await P.client.query(api.communities.details, { serverId: serverA });
  inviteCodeA = d.inviteCode;
  generalA = d.channels.find((c) => c.name === "general")._id;
});
await expectOk("member joins the community", () => Q.client.mutation(api.communities.joinByCode, { code: inviteCodeA }));

await expectTrue("platform role is unaffected by server membership", async () => {
  const me = await Q.client.query(api.users.me, {});
  return me.role === "user";
});

// ---- Baseline: members can chat ----
await expectOk("plain member can send in #general by default", () => Q.client.mutation(api.chat.sendMessage, { channelId: generalA, body: "hello" }));

// ---- Channel-level permissions ----
await expectOk("owner denies “send messages” for members on #general", () =>
  P.client.mutation(api.communities.updateChannelOverrides, {
    channelId: generalA,
    overrides: [{ target: "member", allow: [], deny: ["sendMessages"] }],
  }));
await expectError("member can no longer send in #general", () => Q.client.mutation(api.chat.sendMessage, { channelId: generalA, body: "blocked" }));
await expectOk("owner can still send (owner always has full control)", () => P.client.mutation(api.chat.sendMessage, { channelId: generalA, body: "owner still here" }));

// #staff: deny view for members.
let staffChannel;
await expectOk("owner creates #staff", async () => {
  staffChannel = await P.client.mutation(api.communities.createChannel, { serverId: serverA, name: "staff", type: "text" });
});
await expectOk("owner hides #staff from members", () =>
  P.client.mutation(api.communities.updateChannelOverrides, {
    channelId: staffChannel,
    overrides: [{ target: "member", allow: [], deny: ["viewChannels"] }],
  }));
await expectError("member cannot read a channel they cannot view", () => Q.client.query(api.chat.messages, { channelId: staffChannel }));
await expectOk("owner can read #staff", () => P.client.query(api.chat.messages, { channelId: staffChannel }));

// Clearing the override restores access.
await expectOk("clearing the override restores member access", async () => {
  await P.client.mutation(api.communities.updateChannelOverrides, { channelId: staffChannel, overrides: [] });
  await Q.client.query(api.chat.messages, { channelId: staffChannel });
});

// ---- Roles are per server ----
await expectOk("owner creates a custom role", () =>
  P.client.mutation(api.communities.createRole, { serverId: serverA, name: "Minecraft Staff", color: "#3ba55d", permissions: ["viewChannels", "sendMessages", "manageMessages"] }));
await expectTrue("custom role exists only in its own server", async () => {
  const d = await P.client.query(api.communities.details, { serverId: serverA });
  return d.roles.some((r) => r.name === "Minecraft Staff");
});

// Q owns server B — completely independent roles.
let serverB;
await expectOk("a member of one server owns their own independent server", async () => {
  serverB = await Q.client.mutation(api.communities.create, { name: `Member Owned ${stamp}`, description: "b" });
});
await expectTrue("roles do not leak between servers", async () => {
  const d = await Q.client.query(api.communities.details, { serverId: serverB });
  return d.roles.length === 0;
});
await expectOk("a user can be owner in one server while a member in another", async () => {
  const dA = await Q.client.query(api.communities.details, { serverId: serverA });
  const dB = await Q.client.query(api.communities.details, { serverId: serverB });
  if (dA.isOwner !== false || dB.isOwner !== true) throw new Error("role leaked across servers");
});

// ---- Server admin cannot touch the owner ----
await expectOk("owner promotes the member to Server Admin", () =>
  P.client.mutation(api.communities.assignRole, { serverId: serverA, userId: Q.userId, role: "admin" }));
await expectError("a Server Admin cannot ban the Server Owner", () => Q.client.mutation(api.communities.banMember, { serverId: serverA, userId: P.userId }));
await expectError("a Server Admin cannot kick the Server Owner", () => Q.client.mutation(api.communities.kickMember, { serverId: serverA, userId: P.userId }));
await expectError("a Server Admin cannot time out the Server Owner", () => Q.client.mutation(api.communities.timeoutMember, { serverId: serverA, userId: P.userId, minutes: 5 }));
await expectError("a Server Admin cannot demote the Server Owner", () => Q.client.mutation(api.communities.assignRole, { serverId: serverA, userId: P.userId, role: "member" }));
await expectError("a Server Admin cannot grant Admin to someone else", () => Q.client.mutation(api.communities.assignRole, { serverId: serverA, userId: P.userId, role: "admin" }));

// ---- Server separation from platform ----
await expectTrue("server admin still has no platform privileges", async () => {
  const access = await Q.client.query(api.admin.panelAccess, {});
  const me = await Q.client.query(api.users.me, {});
  return access.canAccess === false && me.role === "user";
});
await expectTrue("a non-member cannot read another server's channels", async () => {
  const R = await newUser("srv_outsider");
  try {
    await R.client.query(api.chat.messages, { channelId: generalA });
    return false;
  } catch {
    return true;
  } finally {
    await R.client.mutation(api.users.deleteAccount, { confirmUsername: R.username }).catch(() => {});
  }
});

// ---- Ownership transfer ----
await expectOk("owner transfers ownership to the member", () =>
  P.client.mutation(api.communities.transferOwnership, { serverId: serverA, userId: Q.userId }));
await expectTrue("new owner has full control; previous owner is now an admin", async () => {
  const asNew = await Q.client.query(api.communities.details, { serverId: serverA });
  const asOld = await P.client.query(api.communities.details, { serverId: serverA });
  return asNew.isOwner === true && asOld.isOwner === false && asOld.myRole === "admin";
});
await expectError("the previous owner can no longer transfer ownership", () =>
  P.client.mutation(api.communities.transferOwnership, { serverId: serverA, userId: P.userId }));
await expectError("a Server Admin cannot assign the owner role", () =>
  P.client.mutation(api.communities.assignRole, { serverId: serverA, userId: P.userId, role: "owner" }));

// ---- Cleanup ----
await expectOk("clean up test accounts", async () => {
  await Q.client.mutation(api.users.deleteAccount, { confirmUsername: Q.username });
  await P.client.mutation(api.users.deleteAccount, { confirmUsername: P.username });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
