// Tests for YouTube link detection (no video is ever downloaded or stored).
// Run: bun youtube-links-test.mjs
import { parseYouTubeUrl, youtubeLinksIn } from "./src/lib/youtube.ts";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e?.message ?? e}`); };
function check(name, cond, detail) {
  if (cond) ok(name); else bad(name, detail ?? "assertion failed");
}
function expectId(name, url, id, start) {
  const r = parseYouTubeUrl(url);
  check(name, r && r.id === id && (start === undefined || r.start === start), `got ${JSON.stringify(r)}`);
}

const ID = "dQw4w9WgXcQ";

expectId("standard watch URL", `https://www.youtube.com/watch?v=${ID}`, ID);
expectId("watch URL with extra params", `https://www.youtube.com/watch?v=${ID}&list=PL123&index=2`, ID);
expectId("short youtu.be link", `https://youtu.be/${ID}`, ID);
expectId("shorts link", `https://www.youtube.com/shorts/${ID}`, ID);
expectId("embed link", `https://www.youtube.com/embed/${ID}`, ID);
expectId("live link", `https://www.youtube.com/live/${ID}`, ID);
expectId("mobile link", `https://m.youtube.com/watch?v=${ID}`, ID);
expectId("music.youtube.com link", `https://music.youtube.com/watch?v=${ID}`, ID);
expectId("nocookie embed link", `https://www.youtube-nocookie.com/embed/${ID}`, ID);
expectId("?t=90s start offset", `https://youtu.be/${ID}?t=90`, ID, 90);
expectId("t=1h2m3s start offset", `https://www.youtube.com/watch?v=${ID}&t=1h2m3s`, ID, 3723);

check("non-YouTube URL is ignored", parseYouTubeUrl("https://example.com/watch?v=abc") === null);
check("plain text is ignored", parseYouTubeUrl("just some words") === null);
check("a too-short id is rejected", parseYouTubeUrl("https://youtu.be/short") === null);
check("javascript: is rejected", parseYouTubeUrl("javascript:alert(1)") === null);

const single = youtubeLinksIn(`Check this out https://youtu.be/${ID}`);
check("detects a single link in a message", single.length === 1 && single[0].ref.id === ID, JSON.stringify(single));

const multi = youtubeLinksIn(`two videos https://youtu.be/${ID} and https://www.youtube.com/watch?v=abcdefghijk`);
check("detects multiple links cleanly", multi.length === 2, JSON.stringify(multi));

const dup = youtubeLinksIn(`again https://youtu.be/${ID} then https://www.youtube.com/watch?v=${ID}`);
check("the same video is only embedded once", dup.length === 1, JSON.stringify(dup));

const punct = youtubeLinksIn(`look (https://youtu.be/${ID}).`);
check("trailing punctuation is stripped", punct.length === 1 && punct[0].ref.id === ID, JSON.stringify(punct));

const mixed = youtubeLinksIn(`no video here https://example.com/a and https://vimeo.com/12345`);
check("non-YouTube links produce no embeds", mixed.length === 0, JSON.stringify(mixed));

check("empty body has no embeds", youtubeLinksIn("").length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
