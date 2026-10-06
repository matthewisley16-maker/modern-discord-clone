// Unit tests for the collection-shape guards that eliminate the
// `TypeError: x?.map is not a function` class of crash.
// Run: bun collection-test.mjs
import { toSafeArray, toSafeArrayField, sanitizeCollectionFields } from "./src/lib/collection";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e ?? ""}`); };

function eq(name, got, expected) {
  const g = JSON.stringify(got), x = JSON.stringify(expected);
  if (g === x) ok(name); else bad(name, `got ${g}, expected ${x}`);
}

// Requirement 16: every one of these inputs must be handled without throwing.
const malformed = [null, undefined, {}, { items: [] }, "", "invalid", 0, false, NaN];
for (const input of malformed) {
  let result;
  try {
    result = toSafeArray(input, { label: "Test", source: "collection-test" });
  } catch (e) {
    bad(`toSafeArray(${JSON.stringify(input)}) must not throw`, e?.message);
    continue;
  }
  if (Array.isArray(result) && result.length === 0) ok(`toSafeArray(${JSON.stringify(input)}) -> []`);
  else bad(`toSafeArray(${JSON.stringify(input)}) -> []`, `got ${JSON.stringify(result)}`);
}

// Valid arrays pass through unchanged (same reference, so React can bail out).
{
  const arr = [{ id: 1 }, { id: 2 }];
  eq("toSafeArray returns the same array contents", toSafeArray(arr), arr);
  if (toSafeArray(arr) === arr) ok("toSafeArray preserves the same array reference");
  else bad("toSafeArray preserves the same array reference");
  eq("toSafeArray([]) -> []", toSafeArray([]), []);
}

// A single object must NOT be spread into an array (no Object.values guessing).
eq("single object -> [] (not [object])", toSafeArray({ userId: "u1" }), []);
eq("single record {0:item} -> []", toSafeArray({ 0: { id: "x" } }), []);

// toSafeArrayField: unwrap a KNOWN field only.
eq("field wrapper extracts the array", toSafeArrayField({ items: [1, 2] }, "items"), [1, 2]);
eq("bare array is accepted", toSafeArrayField([1, 2], "items"), [1, 2]);
eq("field missing -> []", toSafeArrayField({ other: [1] }, "items"), []);
eq("field null -> []", toSafeArrayField({ items: null }, "items"), []);
eq("field wrong type -> []", toSafeArrayField({ items: "nope" }, "items"), []);
eq("null wrapper -> []", toSafeArrayField(null, "items"), []);
eq("undefined wrapper -> []", toSafeArrayField(undefined, "items"), []);
for (const input of [{ messages: [] }, [], null, undefined, 3, true, "x", { messages: 9 }]) {
  let result;
  try { result = toSafeArrayField(input, "messages"); }
  catch (e) { bad(`toSafeArrayField(${JSON.stringify(input)}) must not throw`, e?.message); continue; }
  if (Array.isArray(result)) ok(`toSafeArrayField(${JSON.stringify(input)}) is an array`);
  else bad(`toSafeArrayField(${JSON.stringify(input)}) is an array`);
}

// sanitizeCollectionFields: fix only the named array fields.
{
  const msg = { _id: "m1", reactions: { 0: { emoji: "x" } }, attachments: null, mentionUsers: [{ userId: "u1" }] };
  const safe = sanitizeCollectionFields(msg, ["reactions", "attachments", "mentionUsers"], { label: "Test message" });
  eq("malformed reactions -> []", safe.reactions, []);
  eq("null attachments -> []", safe.attachments, []);
  eq("valid mentionUsers preserved", safe.mentionUsers, [{ userId: "u1" }]);
  eq("other fields untouched", safe._id, "m1");

  const alreadySafe = { _id: "m2", reactions: [], attachments: [], mentionUsers: [] };
  if (sanitizeCollectionFields(alreadySafe, ["reactions", "attachments", "mentionUsers"]) === alreadySafe) {
    ok("sanitizeCollectionFields returns the same object when nothing changed");
  } else {
    bad("sanitizeCollectionFields returns the same object when nothing changed");
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
