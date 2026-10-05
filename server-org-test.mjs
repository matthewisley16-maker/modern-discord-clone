// End-to-end tests for the per-user server rail organization (order, folders,
// recently visited) against the dev deployment.
// Run: bun server-org-test.mjs
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
async function expectTrue(name, fn) {
  try { if (!(await fn())) throw new Error("assertion was false"); ok(name); }
  catch (e) { bad(name, e); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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

async function signInPassword(username) {
  const client = new ConvexHttpClient(URL);
  const res = await client.action(api.auth.signIn, {
    provider: "password",
    params: { flow: "signIn", username, password: "Passw0rd123" },
  });
  client.setAuth(res.tokens.token);
  return client;
}

const A = await newUser("org_alice");
const B = await newUser("org_bob");

const s1 = await A.client.mutation(api.communities.create, { name: `Org One ${stamp}`, description: "one" });
const s2 = await A.client.mutation(api.communities.create, { name: `Org Two ${stamp}`, description: "two" });
const s3 = await A.client.mutation(api.communities.create, { name: `Org Three ${stamp}`, description: "three" });

await expectTrue("new account starts with an empty layout", async () => {
  const org = await A.client.query(api.serverOrg.get, {});
  return org.layout.length === 0 && org.folders.length === 0 && org.recent.length === 0;
});

await expectOk("server order saves and reloads", async () => {
  await A.client.mutation(api.serverOrg.save, { layout: [s3, s1, s2], folders: [], recent: [] });
  const org = await A.client.query(api.serverOrg.get, {});
  if (!eq(org.layout, [s3, s1, s2])) throw new Error(`got ${JSON.stringify(org.layout)}`);
});
await expectOk("server order can be rearranged again", async () => {
  await A.client.mutation(api.serverOrg.save, { layout: [s1, s2, s3], folders: [], recent: [] });
  const org = await A.client.query(api.serverOrg.get, {});
  if (!eq(org.layout, [s1, s2, s3])) throw new Error(`got ${JSON.stringify(org.layout)}`);
});

// ---- Folders ----
await expectOk("folder with grouped servers persists", async () => {
  await A.client.mutation(api.serverOrg.save, {
    layout: [`folder:f1`, s2],
    folders: [{ id: "f1", name: "Gaming", color: "#8b5cf6", collapsed: false, serverIds: [s1, s3] }],
    recent: [],
  });
  const org = await A.client.query(api.serverOrg.get, {});
  const f = org.folders.find((x) => x.id === "f1");
  if (!f) throw new Error("folder missing");
  if (f.name !== "Gaming") throw new Error("name wrong");
  if (!eq(f.serverIds, [s1, s3])) throw new Error(`serverIds ${JSON.stringify(f.serverIds)}`);
  if (org.layout[0] !== "folder:f1") throw new Error("folder not first in layout");
  if (org.layout[1] !== s2) throw new Error("ungrouped server order wrong");
});
await expectOk("folder collapsed state persists", async () => {
  await A.client.mutation(api.serverOrg.save, {
    layout: [`folder:f1`, s2],
    folders: [{ id: "f1", name: "Gaming", color: "#8b5cf6", collapsed: true, serverIds: [s1, s3] }],
    recent: [],
  });
  const org = await A.client.query(api.serverOrg.get, {});
  if (org.folders.find((x) => x.id === "f1")?.collapsed !== true) throw new Error("not collapsed");
});
await expectOk("folder can be renamed", async () => {
  await A.client.mutation(api.serverOrg.save, {
    layout: [`folder:f1`, s2],
    folders: [{ id: "f1", name: "Friends", color: "#3ba55d", collapsed: true, serverIds: [s1, s3] }],
    recent: [],
  });
  const org = await A.client.query(api.serverOrg.get, {});
  const f = org.folders.find((x) => x.id === "f1");
  if (f?.name !== "Friends" || f?.color !== "#3ba55d") throw new Error("rename/color failed");
});
await expectOk("deleting a folder keeps its servers in the rail", async () => {
  // Same servers, no folder: the save layer must not lose them.
  await A.client.mutation(api.serverOrg.save, { layout: [s1, s3, s2], folders: [], recent: [] });
  const org = await A.client.query(api.serverOrg.get, {});
  if (org.folders.length !== 0) throw new Error("folder still present");
  const set = new Set(org.layout);
  if (!set.has(s1) || !set.has(s2) || !set.has(s3)) throw new Error(`servers lost: ${JSON.stringify(org.layout)}`);
});

// ---- Server-side validation ----
await expectTrue("foreign/unknown server ids are stripped, members are kept", async () => {
  await A.client.mutation(api.serverOrg.save, {
    layout: [s1, "not_a_real_server", `${s2}`],
    folders: [{ id: "f9", name: "Junk", collapsed: false, serverIds: ["bogus", s3] }],
    recent: [],
  });
  const org = await A.client.query(api.serverOrg.get, {});
  const flat = [...org.layout.filter((e) => !e.startsWith("folder:")), ...org.folders.flatMap((f) => f.serverIds)];
  if (flat.includes("not_a_real_server") || flat.includes("bogus")) throw new Error("foreign id kept");
  const set = new Set(flat);
  if (!set.has(s1) || !set.has(s2) || !set.has(s3)) throw new Error("member server lost");
  return true;
});

// ---- Recently visited ----
await expectOk("recently visited servers are tracked most-recent-first", async () => {
  await A.client.mutation(api.serverOrg.touchRecent, { serverId: s1 });
  await A.client.mutation(api.serverOrg.touchRecent, { serverId: s2 });
  await A.client.mutation(api.serverOrg.touchRecent, { serverId: s1 });
  const org = await A.client.query(api.serverOrg.get, {});
  if (!eq(org.recent.slice(0, 2), [s1, s2])) throw new Error(`recent ${JSON.stringify(org.recent)}`);
});

// ---- Per-account isolation + cross-device persistence ----
await expectTrue("another account has its own independent layout", async () => {
  const org = await B.client.query(api.serverOrg.get, {});
  return org.layout.length === 0 && org.folders.length === 0;
});
await expectTrue("layout follows the account to another device/session", async () => {
  const second = await signInPassword(A.username);
  const org = await second.query(api.serverOrg.get, {});
  return org.layout.length > 0 || org.folders.length > 0;
});

// ---- Cleanup ----
await expectOk("clean up test accounts", async () => {
  await B.client.mutation(api.users.deleteAccount, { confirmUsername: B.username });
  await A.client.mutation(api.users.deleteAccount, { confirmUsername: A.username });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
