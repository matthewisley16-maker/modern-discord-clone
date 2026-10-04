// Unit tests for the message link/mention tokenizer (src/lib/message-links.ts).
// Run: bun link-test.mjs
import { splitMessageBody } from "./src/lib/message-links.ts";

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name}`); }
}
const urls = (body) => splitMessageBody(body).filter((s) => s.kind === "url");
const roundTrip = (body) => splitMessageBody(body).map((s) => s.value).join("");

check("bare https URL detected", urls("https://example.com").length === 1);
check("https URL keeps its href", urls("https://example.com")[0].href === "https://example.com");
check("http URL detected", urls("http://example.com")[0].href === "http://example.com");
check("bare www host becomes https", urls("www.example.com")[0].href === "https://www.example.com");

check("only the URL is clickable in mixed text", (() => {
  const segs = splitMessageBody("Visit https://example.com for more information.");
  return segs[0].kind === "text" && segs[1].kind === "url" && segs[1].value === "https://example.com" && segs[2].kind === "text" && segs[2].value === " for more information.";
})());

check("two links in one message", urls("Check https://example.com and https://example.org").length === 2);
check("no link stays plain text", splitMessageBody("This is normal text with no link.").every((s) => s.kind === "text"));

check("trailing punctuation is not part of the URL", (() => {
  const segs = splitMessageBody("Hey, check https://example.com this out!");
  const u = segs.find((s) => s.kind === "url");
  return u.value === "https://example.com" && segs[segs.length - 1].value === " this out!";
})());

check("trailing ) . after a path/query/fragment are stripped", (() => {
  const u = urls("See (https://example.com/a?b=1&c=2#frag).")[0];
  return u.value === "https://example.com/a?b=1&c=2#frag";
})());

check("only http(s) protocols are linkified (javascript: stays inert)", (() => {
  return splitMessageBody("javascript:alert(1) is bad").every((s) => s.kind !== "url");
})());

check("mentions and links coexist", (() => {
  const segs = splitMessageBody("hi @alice see https://x.io/p!");
  const m = segs.find((s) => s.kind === "mention");
  const u = segs.find((s) => s.kind === "url");
  return m?.value === "@alice" && u?.value === "https://x.io/p";
})());

check("segments reassemble to the original body (nothing lost)", (() => {
  const samples = [
    "https://example.com",
    "Visit https://example.com for more information.",
    "Check https://example.com and https://example.org!",
    "This is normal text with no link.",
    "Hey, check https://example.com this out!",
    "See (https://example.com/a?b=1&c=2#frag).",
    "hi @alice and https://x.io/p!",
  ];
  return samples.every((s) => roundTrip(s) === s);
})());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
