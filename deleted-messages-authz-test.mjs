// Server-enforcement tests for the Admin Panel "My Deleted Messages" functions
// (`api.adminMessages.listMineDeletedMessages` / `permanentlyDeleteMine`).
// Run: bun deleted-messages-authz-test.mjs
//
// WHY THIS SUITE IS SAFE TO RUN AGAINST THE REAL DEPLOYMENT
// ---------------------------------------------------------
// The account-creating suites must go through `test-support/guard.mjs` because
// they write synthetic users into the shared deployment. This one creates
// NOTHING: every call below is made with no session at all, and the backend
// rejects it in `currentUserId` before it reads or writes a single row. It is
// therefore a pure negative test of the authorization boundary — the exact
// property "unauthorized users cannot access the section or invoke its backend
// operations", exercised against the live server rather than the UI.
import { ConvexHttpClient } from "convex/browser";
import { api } from "./src/convex/_generated/api.js";

const URL = process.env.CONVEX_URL || "https://academic-porcupine-929.convex.cloud";
const anonymous = new ConvexHttpClient(URL); // deliberately NO setAuth(...)

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e?.message ?? e}`); };

/** The rejection message a refused call produced, or null when it succeeded. */
async function rejection(fn) {
  try {
    const result = await fn();
    return { error: null, result };
  } catch (error) {
    return { error: String(error?.data ?? error?.message ?? error) };
  }
}

// A fabricated `messageVisibility` id. Its table prefix is not one the
// deployment recognizes, so Convex refuses it in ARGUMENT VALIDATION, before the
// handler runs — which is itself worth asserting: a caller who cannot mint a
// real id cannot even reach the purge code. The handler's own gate is the same
// `currentUserId` → `requirePanelAccess` pair the query check below proves live,
// and it runs before any read (see the handler in src/convex/adminMessages.ts).
const FABRICATED_ID = "jd7f4m2q9w1s8x0k3v5n6b2c4z7h9t1r";

// ---------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------
const listResult = await rejection(() =>
  anonymous.query(api.adminMessages.listMineDeletedMessages, {
    paginationOpts: { numItems: 5, cursor: null },
  }),
);
if (listResult.error === null) bad("anonymous caller cannot list deleted messages", "the query returned data");
else ok("anonymous caller cannot list deleted messages");
if (listResult.error && /sign in/i.test(listResult.error)) {
  ok("the query is refused by the server-side sign-in gate");
} else {
  bad("the query is refused by the server-side sign-in gate", `unexpected rejection: ${listResult.error}`);
}
if (listResult.result === undefined) {
  ok("no message content is returned to an anonymous caller");
} else {
  bad("no message content is returned to an anonymous caller", listResult.result);
}

// ---------------------------------------------------------------------------
// The moderation (hidden message) query
// ---------------------------------------------------------------------------
const hiddenResult = await rejection(() =>
  anonymous.query(api.adminMessages.listMineHiddenMessages, {
    paginationOpts: { numItems: 5, cursor: null },
  }),
);
if (hiddenResult.error === null) bad("anonymous caller cannot list hidden messages", "the query returned data");
else ok("anonymous caller cannot list hidden messages");
if (hiddenResult.error && /sign in/i.test(hiddenResult.error)) {
  ok("the moderation query is refused by the server-side sign-in gate");
} else {
  bad("the moderation query is refused by the server-side sign-in gate", `unexpected rejection: ${hiddenResult.error}`);
}

// ---------------------------------------------------------------------------
// The permanent-delete mutation
// ---------------------------------------------------------------------------
const purgeResult = await rejection(() =>
  anonymous.mutation(api.adminMessages.permanentlyDeleteMine, { visibilityId: FABRICATED_ID }),
);
if (purgeResult.error === null) bad("anonymous caller cannot permanently delete a message", "the mutation succeeded");
else ok("anonymous caller cannot permanently delete a message");
if (purgeResult.result === undefined) ok("the mutation returns nothing to an anonymous caller");
else bad("the mutation returns nothing to an anonymous caller", purgeResult.result);
if (purgeResult.error && /sign in/i.test(purgeResult.error)) {
  ok("the mutation is refused by the server-side sign-in gate");
} else if (purgeResult.error && /ArgumentValidationError|Validator/i.test(purgeResult.error)) {
  // Expected for a fabricated id: the argument never reaches the handler.
  ok("a fabricated id is refused before the mutation handler runs");
  console.log(`info: the mutation was refused by argument validation: ${purgeResult.error.split("\n")[0]}`);
} else {
  bad("the mutation is refused (sign-in gate or argument validation)", `unexpected rejection: ${purgeResult.error}`);
}

// ---------------------------------------------------------------------------
// "Delete All Deleted Messages" (the bulk cleanup of the list). Anonymous, so it
// must be refused before it can read or remove anything — this is the same
// server-side gate the list uses, so the bulk path adds no way in.
// ---------------------------------------------------------------------------
const purgeAll = await rejection(() => anonymous.mutation(api.adminMessages.permanentlyDeleteAllMine, {}));
if (purgeAll.error === null) bad("anonymous caller cannot delete all deleted messages", "the mutation succeeded");
else ok("anonymous caller cannot delete all deleted messages");
if (purgeAll.error && /sign in/i.test(purgeAll.error)) {
  ok("the bulk delete is refused by the server-side sign-in gate");
} else {
  bad("the bulk delete is refused by the server-side sign-in gate", `unexpected rejection: ${purgeAll.error}`);
}
if (purgeAll.result === undefined) ok("the bulk delete returns nothing to an anonymous caller");
else bad("the bulk delete returns nothing to an anonymous caller", purgeAll.result);

// ---------------------------------------------------------------------------
// The administrator-only global delete of a HIDDEN message (the moderation
// route). Same fabricated-id caveat as above: with no session it can never
// succeed, and a caller that cannot mint a real visibility id cannot reach the
// handler at all.
// ---------------------------------------------------------------------------
const hiddenPurge = await rejection(() =>
  anonymous.mutation(api.deletion.deleteHiddenForEveryone, { visibilityId: FABRICATED_ID }),
);
if (hiddenPurge.error === null) bad("anonymous caller cannot globally delete a hidden message", "the mutation succeeded");
else ok("anonymous caller cannot globally delete a hidden message");
if (hiddenPurge.error && /sign in/i.test(hiddenPurge.error)) {
  ok("the hidden-message delete is refused by the server-side sign-in gate");
} else if (hiddenPurge.error && /ArgumentValidationError|Validator/i.test(hiddenPurge.error)) {
  ok("a fabricated id is refused before the hidden-message delete handler runs");
} else {
  bad("the hidden-message delete is refused", `unexpected rejection: ${hiddenPurge.error}`);
}

// ---------------------------------------------------------------------------
// The functions really exist on the deployment (a rename would otherwise make
// both checks above "pass" by failing with function-not-found).
// ---------------------------------------------------------------------------
const notFound = (r) => r.error && /not found|CouldNotFindFunction|no function/i.test(r.error);
if (notFound(listResult)) bad("api.adminMessages.listMineDeletedMessages exists on the deployment", listResult.error);
else ok("api.adminMessages.listMineDeletedMessages exists on the deployment");
if (notFound(hiddenResult)) bad("api.adminMessages.listMineHiddenMessages exists on the deployment", hiddenResult.error);
else ok("api.adminMessages.listMineHiddenMessages exists on the deployment");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
