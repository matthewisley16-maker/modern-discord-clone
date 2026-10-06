// Unit tests for normalizeDmMessages — the guard against the
// `x?.map is not a function` crash when the DM messages shape is unexpected.
// Run: bun dm-messages-test.mjs
import { normalizeDmMessages } from "./src/lib/dm-messages";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e ?? ""}`); };

function eq(name, got, expected) {
  const g = JSON.stringify(got), x = JSON.stringify(expected);
  if (g === x) ok(name); else bad(name, `got ${g}, expected ${x}`);
}

const a = { _id: "m1" }, b = { _id: "m2" };

// The current server shape.
eq("object shape returns the messages array", normalizeDmMessages({ messages: [a, b], locked: true }), [a, b]);
// Legacy bare array.
eq("legacy bare array is returned as-is", normalizeDmMessages([a, b]), [a, b]);
// Missing / wrong shapes must never throw and never return a non-array.
eq("locked conversation with no messages -> []", normalizeDmMessages({ messages: [], locked: true }), []);
eq("empty object -> []", normalizeDmMessages({}), []);
eq("null -> []", normalizeDmMessages(null), []);
eq("undefined -> []", normalizeDmMessages(undefined), []);
eq("non-array messages field -> []", normalizeDmMessages({ messages: "nope" }), []);
eq("object messages field -> []", normalizeDmMessages({ messages: { 0: a } }), []);
eq("string -> []", normalizeDmMessages("nope"), []);
eq("number -> []", normalizeDmMessages(42), []);
eq("boolean -> []", normalizeDmMessages(true), []);

// The result is always an array, so `.map` can never throw.
for (const input of [{ messages: [a] }, [a], {}, null, undefined, "x", 7, { messages: 1 }]) {
  if (Array.isArray(normalizeDmMessages(input))) ok(`result is an array for ${JSON.stringify(input)}`);
  else bad(`result is an array for ${JSON.stringify(input)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
