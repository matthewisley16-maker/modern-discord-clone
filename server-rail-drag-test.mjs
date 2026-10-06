// Tests for the server rail drag-and-drop semantics.
//
// Two layers:
//   1. Pure layout math (`src/lib/server-rail.ts`) — the exact operations the
//      pointer gesture performs: reorder, drag-into-folder, drag-out-of-folder,
//      and drag-server-onto-server → auto-create a folder holding both.
//   2. End-to-end persistence — the resulting layout is written with
//      `serverOrg.save` and read back, proving order/folders/names/collapse are
//      stored on the account (so they survive refresh and other devices).
//
// Run: bun server-rail-drag-test.mjs
import { ConvexHttpClient } from "convex/browser";
import { api } from "./src/convex/_generated/api.js";
import {
  cloneItems, deleteFolderFromList, groupServersIntoFolder, insertFolderAtServer,
  insertServerRelative, moveBy, moveByToggle, moveIntoFolder, reorderWithinFolder,
  withoutServer,
} from "./src/lib/server-rail.ts";

import { guardedDeploymentUrl } from "./test-support/guard.mjs";
const URL = guardedDeploymentUrl("https://academic-porcupine-929.convex.cloud");
const stamp = Date.now().toString(36);
let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e?.message ?? e}`); };

async function expectTrue(name, fn) {
  try { if (!(await fn())) throw new Error("assertion was false"); ok(name); }
  catch (e) { bad(name, e); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const servers = (list) => list.filter((i) => i.type === "server").map((i) => i.id);
const folder = (list, id) => list.find((i) => i.type === "folder" && i.folder.id === id);
const firstFolder = (list) => list.find((i) => i.type === "folder");

// ---------------------------------------------------------------------------
// Pure layout math
// ---------------------------------------------------------------------------
const base = [
  { type: "server", id: "a" },
  { type: "server", id: "b" },
  { type: "server", id: "c" },
];

await expectTrue("drag server B onto server A creates one folder holding both", async () => {
  const next = groupServersIntoFolder(cloneItems(base), "b", "a", "New Folder", "#8b5cf6");
  const f = firstFolder(next);
  if (!f) throw new Error("no folder created");
  if (f.folder.name !== "New Folder") throw new Error(`name ${f.folder.name}`);
  if (!eq(f.folder.serverIds, ["b", "a"])) throw new Error(`contents ${JSON.stringify(f.folder.serverIds)}`);
  if (next[0].type !== "folder") throw new Error("folder did not take the target's position");
  if (!eq(servers(next), ["c"])) throw new Error(`loose servers ${JSON.stringify(servers(next))}`);
  if (!eq(next.map((i) => (i.type === "folder" ? "folder" : i.id)), ["folder", "c"])) throw new Error("layout wrong");
  return true;
});

await expectTrue("drag server B onto server C creates a folder holding both, C's position preserved", async () => {
  const next = groupServersIntoFolder(cloneItems(base), "b", "c", "New Folder", "#3ba55d");
  const f = firstFolder(next);
  if (!f || !eq(f.folder.serverIds, ["b", "c"])) throw new Error("contents wrong");
  if (!eq(next.map((i) => (i.type === "folder" ? "folder" : i.id)), ["a", "folder"])) throw new Error("folder not at target position");
  return true;
});

await expectTrue("dragging a server out of a folder onto a loose server does not duplicate it", async () => {
  const withFolder = [
    { type: "folder", folder: { id: "f1", name: "G", color: null, collapsed: false, serverIds: ["x", "y"] } },
    { type: "server", id: "z" },
  ];
  const next = groupServersIntoFolder(cloneItems(withFolder), "x", "z", "New Folder", "#8b5cf6");
  // The new folder replaces the target loose server, so find it by content.
  const f = next.find((i) => i.type === "folder" && i.folder.serverIds.includes("z"));
  if (!f || !eq(f.folder.serverIds, ["x", "z"])) throw new Error("grouped folder wrong");
  const f1 = folder(next, "f1");
  if (!f1 || !eq(f1.folder.serverIds, ["y"])) throw new Error("server left behind in original folder");
  const flat = [...servers(next), ...next.filter((i) => i.type === "folder").flatMap((i) => i.folder.serverIds)];
  if (flat.filter((id) => id === "x").length !== 1) throw new Error("duplicate x");
  return true;
});

await expectTrue("drag a server INTO an existing folder (explicit gesture)", async () => {
  const withFolder = [
    { type: "folder", folder: { id: "f1", name: "G", color: null, collapsed: true, serverIds: ["x"] } },
    { type: "server", id: "y" },
  ];
  const next = moveIntoFolder(cloneItems(withFolder), "f1", "y");
  const f1 = folder(next, "f1");
  if (!f1 || !eq(f1.folder.serverIds, ["x", "y"])) throw new Error("not added inside folder");
  if (f1.folder.collapsed !== false) throw new Error("folder did not expand to show the drop");
  if (servers(next).length !== 0) throw new Error("server still loose");
  return true;
});

await expectTrue("drag a server OUT of a folder to a top-level position", async () => {
  const withFolder = [
    { type: "folder", folder: { id: "f1", name: "G", color: null, collapsed: false, serverIds: ["x", "y"] } },
    { type: "server", id: "z" },
  ];
  const next = insertServerRelative(withoutServer(cloneItems(withFolder), "x"), "z", "x", false);
  const f1 = folder(next, "f1");
  if (!f1 || !eq(f1.folder.serverIds, ["y"])) throw new Error("still inside folder");
  if (!eq(next.map((i) => (i.type === "folder" ? "folder" : i.id)), ["folder", "x", "z"])) throw new Error("released position wrong");
  return true;
});

await expectTrue("vertical drag reorders top-level servers before/after a target", async () => {
  const up = insertServerRelative(withoutServer(cloneItems(base), "c"), "a", "c", false);
  if (!eq(up.map((i) => i.id), ["c", "a", "b"])) throw new Error(`before-drop wrong: ${JSON.stringify(up)}`);
  const down = insertServerRelative(withoutServer(cloneItems(base), "a"), "c", "a", true);
  if (!eq(down.map((i) => i.id), ["b", "c", "a"])) throw new Error(`after-drop wrong: ${JSON.stringify(down)}`);
  return true;
});

await expectTrue("servers reorder inside a folder", async () => {
  const list = [{ type: "folder", folder: { id: "f1", name: "G", color: null, collapsed: false, serverIds: ["x", "y", "z"] } }];
  const next = reorderWithinFolder(cloneItems(list), "f1", "z", "x", false);
  if (!eq(folder(next, "f1").folder.serverIds, ["z", "x", "y"])) throw new Error("in-folder order wrong");
  return true;
});

await expectTrue("a folder can be reordered among the rail (drag or menu)", async () => {
  const list = [
    { type: "server", id: "a" },
    { type: "folder", folder: { id: "f1", name: "G", color: null, collapsed: false, serverIds: ["x"] } },
  ];
  const next = insertFolderAtServer(cloneItems(list), "a", list[1].folder, true);
  if (!eq(next.map((i) => (i.type === "folder" ? "folder" : i.id)), ["a", "folder"])) throw new Error("folder not moved after server");
  const toggled = moveByToggle(cloneItems(next), "f1");
  if (folder(toggled, "f1").folder.collapsed !== true) throw new Error("collapse toggle failed");
  const up = moveBy(cloneItems(toggled), "folder:f1", -1);
  if (up[0].type !== "folder") throw new Error("moveBy failed");
  return true;
});

await expectTrue("deleting a folder releases its servers (never deletes them)", async () => {
  const list = [
    { type: "folder", folder: { id: "f1", name: "G", color: null, collapsed: false, serverIds: ["x", "y"] } },
    { type: "server", id: "z" },
  ];
  const next = deleteFolderFromList(cloneItems(list), "f1");
  if (next.some((i) => i.type === "folder")) throw new Error("folder survived");
  const flat = servers(next).sort();
  if (!eq(flat, ["x", "y", "z"])) throw new Error(`servers lost: ${JSON.stringify(flat)}`);
  return true;
});

// ---------------------------------------------------------------------------
// End-to-end persistence of the auto-created folder
// ---------------------------------------------------------------------------
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

const A = await newUser("raildrag");
const s1 = await A.client.mutation(api.communities.create, { name: `Rail One ${stamp}`, description: "one" });
const s2 = await A.client.mutation(api.communities.create, { name: `Rail Two ${stamp}`, description: "two" });
const s3 = await A.client.mutation(api.communities.create, { name: `Rail Three ${stamp}`, description: "three" });

await expectTrue("an auto-created folder persists (contents, name, order) across reload", async () => {
  // Start from [s1, s2, s3]; drag s2 onto s1 exactly like the pointer gesture.
  const initial = [
    { type: "server", id: s1 },
    { type: "server", id: s2 },
    { type: "server", id: s3 },
  ];
  const next = groupServersIntoFolder(cloneItems(initial), s2, s1, "New Folder", "#8b5cf6");
  const layout = next.map((i) => (i.type === "folder" ? `folder:${i.folder.id}` : i.id));
  const folders = next
    .filter((i) => i.type === "folder")
    .map((i) => ({ id: i.folder.id, name: i.folder.name, color: i.folder.color, collapsed: i.folder.collapsed, serverIds: i.folder.serverIds }));
  await A.client.mutation(api.serverOrg.save, { layout, folders, recent: [] });

  // Reload from a brand-new session (another device).
  const fresh = new ConvexHttpClient(URL);
  const res = await fresh.action(api.auth.signIn, {
    provider: "password",
    params: { flow: "signIn", username: A.username, password: "Passw0rd123" },
  });
  fresh.setAuth(res.tokens.token);
  const org = await fresh.query(api.serverOrg.get, {});
  const f = org.folders[0];
  if (!f) throw new Error("folder did not persist");
  if (f.name !== "New Folder") throw new Error(`name ${f.name}`);
  if (!eq([...f.serverIds].sort(), [s1, s2].sort())) throw new Error(`contents ${JSON.stringify(f.serverIds)}`);
  if (org.layout[0] !== `folder:${f.id}`) throw new Error("folder not first after reload");
  if (!org.layout.includes(s3)) throw new Error("unrelated server lost");
  return true;
});

await expectTrue("renaming the auto-created folder persists", async () => {
  const org = await A.client.query(api.serverOrg.get, {});
  const f = org.folders[0];
  await A.client.mutation(api.serverOrg.save, {
    layout: org.layout,
    folders: [{ id: f.id, name: "Gaming", color: f.color ?? undefined, collapsed: true, serverIds: f.serverIds }],
    recent: org.recent,
  });
  const again = await A.client.query(api.serverOrg.get, {});
  const g = again.folders[0];
  if (g?.name !== "Gaming" || g?.collapsed !== true) throw new Error("rename/collapse not persisted");
  return true;
});

await expectTrue("clean up rail-drag test account", async () => {
  await A.client.mutation(api.users.deleteAccount, { confirmUsername: A.username });
  return true;
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
