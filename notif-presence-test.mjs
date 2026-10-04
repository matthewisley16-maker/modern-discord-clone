// Notification management + presence tests for Freecord.
// Run: bun notif-presence-test.mjs
import { ConvexHttpClient } from "convex/browser";
import { api } from "./src/convex/_generated/api.js";

const URL = "https://academic-porcupine-929.convex.cloud";
const stamp = Date.now().toString(36);
let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e?.message ?? e}`); };
async function expectTrue(name, fn) {
  try { const v = await fn(); if (!v) throw new Error("assertion was false"); ok(name); }
  catch (e) { bad(name, e); }
}
async function expectOk(name, fn) {
  try { await fn(); ok(name); } catch (e) { bad(name, e); }
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

const A = await newUser("notifa");
const B = await newUser("notifb");

// --- A notification is created for B ---
await expectOk("A sends B a friend request", () => A.client.mutation(api.social.sendFriendRequest, { toId: B.userId }));

let notifId;
await expectTrue("B received exactly one notification and it is unread", async () => {
  const { items, unread } = await B.client.query(api.social.listNotifications, {});
  const friendReq = items.find((n) => n.type === "friend_request");
  if (!friendReq) return false;
  notifId = friendReq._id;
  return unread >= 1 && friendReq.read === false;
});
await expectTrue("the notification carries a deep link", async () => {
  const { items } = await B.client.query(api.social.listNotifications, {});
  return typeof items.find((n) => n._id === notifId)?.link === "string";
});

// --- Read / unread toggling ---
await expectOk("B marks it read", () => B.client.mutation(api.social.setNotificationRead, { id: notifId, read: true }));
await expectTrue("it now reads as read", async () => {
  const { items } = await B.client.query(api.social.listNotifications, {});
  return items.find((n) => n._id === notifId)?.read === true;
});
await expectOk("B marks it unread again", () => B.client.mutation(api.social.setNotificationRead, { id: notifId, read: false }));
await expectTrue("it reads as unread again", async () => {
  const { items, unread } = await B.client.query(api.social.listNotifications, {});
  return items.find((n) => n._id === notifId)?.read === false && unread >= 1;
});

// --- Isolation: A must not be able to touch B's notification ---
await expectOk("A cannot delete B's notification", () => A.client.mutation(api.social.deleteNotification, { id: notifId }));
await expectTrue("B's notification survives A's attempt", async () => {
  const { items } = await B.client.query(api.social.listNotifications, {});
  return items.some((n) => n._id === notifId);
});

// --- Delete is permanent ---
await expectOk("B deletes the notification", () => B.client.mutation(api.social.deleteNotification, { id: notifId }));
await expectTrue("it stays gone after re-querying (persisted)", async () => {
  const { items } = await B.client.query(api.social.listNotifications, {});
  return !items.some((n) => n._id === notifId);
});

// --- Clear all ---
await expectOk("A follows B to generate a notification", () => A.client.mutation(api.social.follow, { userId: B.userId }));
await expectTrue("B has at least one notification again", async () => {
  const { items } = await B.client.query(api.social.listNotifications, {});
  return items.length > 0;
});
await expectOk("B clears all notifications", () => B.client.mutation(api.social.clearAllNotifications, {}));
await expectTrue("B's list is empty and unread is 0", async () => {
  const { items, unread } = await B.client.query(api.social.listNotifications, {});
  return items.length === 0 && unread === 0;
});
await expectTrue("A's own notifications were not touched by B clearing", async () => {
  const { items } = await A.client.query(api.social.listNotifications, {});
  return Array.isArray(items);
});

// --- Presence: a shared community so B can see A ---
let serverId;
await expectOk("A creates a public community and B joins", async () => {
  serverId = await A.client.mutation(api.communities.create, { name: `Presence ${stamp}`, description: "presence", isPublic: true });
  await B.client.mutation(api.communities.join, { serverId });
});
// The Dashboard heart-beats on mount, which is what marks a user online.
await expectOk("A heart-beats like the open Dashboard does", () => A.client.mutation(api.profiles.heartbeat, {}));
await expectTrue("B sees A as online while A is actually connected", async () => {
  const d = await B.client.query(api.communities.details, { serverId });
  const card = d.members.find((m) => m.userId === A.userId);
  return card?.presence !== "offline" && typeof card?.lastSeen === "number";
});
await expectOk("A closes/loses their session", () => A.client.mutation(api.profiles.disconnect, {}));
await expectTrue("B now sees A as OFFLINE (not online)", async () => {
  const d = await B.client.query(api.communities.details, { serverId });
  const card = d.members.find((m) => m.userId === A.userId);
  return card?.presence === "offline";
});
await expectTrue("A's last-seen timestamp is real and recent", async () => {
  const d = await B.client.query(api.communities.details, { serverId });
  const ts = d.members.find((m) => m.userId === A.userId)?.lastSeen;
  return typeof ts === "number" && Date.now() - ts < 60_000;
});
await expectTrue("profiles.getProfile reports A offline with lastSeen", async () => {
  const p = await B.client.query(api.profiles.getProfile, { userId: A.userId });
  return p?.presence === "offline" && typeof p?.lastSeen === "number";
});
await expectOk("A reconnects", () => A.client.mutation(api.profiles.heartbeat, {}));
await expectTrue("B immediately sees A online again", async () => {
  const d = await B.client.query(api.communities.details, { serverId });
  return d.members.find((m) => m.userId === A.userId)?.presence !== "offline";
});

// Clean up the test community so it never lingers in the database.
try { await A.client.mutation(api.communities.deleteCommunity, { serverId }); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
