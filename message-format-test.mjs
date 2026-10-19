// Unit tests for Freecord's message formatting + 30,000-character limit.
// Run: bun message-format-test.mjs
//
// Covers the two halves of the request:
//   1. pasting rich text must keep its formatting (paragraphs, blank lines,
//      indentation, bold/italic/underline/strike, links, lists, headings,
//      quotes, code, emoji, non-English text) and must never execute markup;
//   2. every length limit is 30,000 characters, counted identically on the
//      client and the server.
import { readFileSync } from "node:fs";
import {
  MESSAGE_MAX_LENGTH,
  MESSAGE_TOO_LONG,
  formatCharacterCount,
  isMessageTooLong,
  messageLength,
  parseInline,
  parseMessageBody,
  plainSummary,
  stripLoneSurrogates,
  truncateText,
} from "./src/lib/message-format.ts";
import {
  decodeEntities,
  htmlToMarkdown,
  normalizePlainText,
  pastedMarkdown,
} from "./src/lib/paste-html.ts";

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name}${detail === undefined ? "" : ` -> ${detail}`}`); }
}
const eq = (name, actual, expected) =>
  check(name, actual === expected, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);

const body = (text) => parseMessageBody(text);
const flat = (text) => parseMessageBody(text).map((b) =>
  b.kind === "code" ? b.value
    : b.kind === "list" ? b.items.map((i) => i.map((n) => n.value).join("")).join("|")
      : b.nodes.map((n) => n.value).join("")).join("¶");
const marksOf = (text) => parseMessageBody(text)[0].nodes.map((n) => `${n.value}:${n.marks.join("+")}`);
const hrefs = (text) => parseInline(text).filter((n) => n.kind === "link").map((n) => n.href);

// ---------------------------------------------------------------------------
// 1. The character limit
// ---------------------------------------------------------------------------
console.log("\n-- limit --");
eq("the maximum is 30,000", MESSAGE_MAX_LENGTH, 30000);
eq("the counter formats thousands", formatCharacterCount(30000), "30,000");
eq("the counter formats a long number", formatCharacterCount(12450), "12,450");
eq("plain ASCII is counted by code point", messageLength("hello"), 5);
eq("an emoji counts as ONE character", messageLength("😀"), 1);
eq("a family emoji counts as one grapheme's code points", messageLength("👨‍👩‍👧"), 5);
eq("non-English text is counted", messageLength("日本語です"), 5);
eq("newlines count", messageLength("a\nb"), 3);
eq("empty text is zero", messageLength(""), 0);
eq("exactly 30,000 characters is allowed", isMessageTooLong("a".repeat(MESSAGE_MAX_LENGTH)), false);
eq("30,001 characters is too long", isMessageTooLong("a".repeat(MESSAGE_MAX_LENGTH + 1)), true);
eq("exactly 30,000 emoji are allowed", isMessageTooLong("😀".repeat(MESSAGE_MAX_LENGTH)), false);
eq("30,001 emoji are too long", isMessageTooLong("😀".repeat(MESSAGE_MAX_LENGTH + 1)), true);
check("the emoji case really is 60,000 UTF-16 units",
  "😀".repeat(MESSAGE_MAX_LENGTH).length === 60000,
  "so counting by String#length would have refused it");
eq("the shared over-limit wording", MESSAGE_TOO_LONG, "Messages can be up to 30,000 characters.");

// ---------------------------------------------------------------------------
// 2. Pasting rich text — paragraphs, blank lines, formatting, links, lists
// ---------------------------------------------------------------------------
console.log("\n-- pasting rich text --");
eq("a paragraph survives",
  htmlToMarkdown("<p>Hello world</p>"), "Hello world");
eq("two paragraphs keep a blank line between them",
  htmlToMarkdown("<p>First</p><p>Second</p>"), "First\n\nSecond");
eq("an empty paragraph inserts no phantom text",
  htmlToMarkdown("<p>One</p><p>&nbsp;</p><p>Two</p>"), "One\n\nTwo");
eq("a <br> becomes a real line break",
  htmlToMarkdown("<p>one<br>two</p>"), "one\ntwo");
eq("bold is preserved",
  htmlToMarkdown("<p>Very <strong>bold</strong> indeed</p>"), "Very **bold** indeed");
eq("italic is preserved",
  htmlToMarkdown("<p>An <em>italic</em> word</p>"), "An *italic* word");
eq("underline is preserved",
  htmlToMarkdown("<p><u>underlined</u></p>"), "__underlined__");
eq("strikethrough is preserved",
  htmlToMarkdown("<p><s>gone</s></p>"), "~~gone~~");
eq("nested bold inside italic composes",
  htmlToMarkdown("<p><em>a <strong>b</strong></em></p>"), "*a **b***");
eq("a labelled link keeps its destination",
  htmlToMarkdown('<p><a href="https://freecord.app">Freecord</a></p>'), "[Freecord](https://freecord.app)");
eq("a bare-URL link stays a URL",
  htmlToMarkdown('<p><a href="https://freecord.app">https://freecord.app</a></p>'), "https://freecord.app");
eq("a bullet list is preserved",
  htmlToMarkdown("<ul><li>alpha</li><li>beta</li></ul>"), "- alpha\n- beta");
eq("a numbered list is preserved",
  htmlToMarkdown("<ol><li>alpha</li><li>beta</li></ol>"), "1. alpha\n2. beta");
eq("a heading is preserved",
  htmlToMarkdown("<h2>Release notes</h2>"), "## Release notes");
eq("a blockquote is preserved",
  htmlToMarkdown("<blockquote><p>quoted line</p></blockquote>"), "> quoted line");
eq("a table row stays readable",
  htmlToMarkdown("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>"),
  "| A | B |\n| 1 | 2 |");
eq("entities are decoded",
  htmlToMarkdown("<p>A &amp; B &lt;3</p>"), "A & B <3");
eq("emoji survive a paste",
  htmlToMarkdown("<p>Nice work 😀🎉</p>"), "Nice work 😀🎉");
eq("non-English text survives a paste",
  htmlToMarkdown("<p>日本語 and Ελληνικά</p>"), "日本語 and Ελληνικά");
eq("indentation inside a pasted code block survives",
  htmlToMarkdown("<pre><code>if (x) {\n  return 1;\n}</code></pre>"),
  "```\nif (x) {\n  return 1;\n}\n```");

// The exact shape test 1 of the request describes: multiple paragraphs, bold
// text, links and a list in ONE paste.
const richPaste = htmlToMarkdown(
  '<meta charset="utf-8"><p>Hi <strong>team</strong>,</p><p>Please read ' +
  '<a href="https://freecord.app/notes">the notes</a> before Friday.</p>' +
  "<ul><li>Item <em>one</em></li><li>Item two</li></ul>",
);
eq("a multi-paragraph paste with bold, a link and a list converts as one message",
  richPaste,
  "Hi **team**,\n\nPlease read [the notes](https://freecord.app/notes) before Friday.\n\n- Item *one*\n- Item two");

// ---------------------------------------------------------------------------
// 3. Sanitisation — pasted markup can never run
// ---------------------------------------------------------------------------
console.log("\n-- sanitisation --");
eq("a script's contents are dropped",
  htmlToMarkdown("<p>safe</p><script>alert(1)</script>"), "safe");
eq("a style block is dropped",
  htmlToMarkdown("<style>body{display:none}</style><p>visible</p>"), "visible");
eq("an iframe is dropped",
  htmlToMarkdown('<iframe src="https://evil.example"></iframe><p>after</p>'), "after");
eq("an onerror handler cannot survive",
  htmlToMarkdown('<img src="x" onerror="alert(1)">'), "");
eq("a javascript: link is not linkified",
  htmlToMarkdown('<p><a href="javascript:alert(1)">click me</a></p>'), "click me");
eq("a data: link is not linkified",
  htmlToMarkdown('<p><a href="data:text/html;base64,PHNjcmlwdD4=">x</a></p>'), "x");
eq("escaped markup stays literal text and is never re-parsed",
  htmlToMarkdown("<p>&lt;b&gt;not bold&lt;/b&gt;</p>"), "<b>not bold</b>");
eq("a real tag is removed rather than echoed",
  htmlToMarkdown("<p>hi</p>").includes("<"), false);
check("the converter never returns HTML for a hostile document",
  !htmlToMarkdown('<div onclick="x()"><b onmouseover="y()">hi</b><script>z()</script></div>').includes("<"),
  "output must be plain text only");
eq("a huge payload is refused instead of parsed",
  htmlToMarkdown(`<p>${"x".repeat(2_000_001)}</p>`), "");

// ---------------------------------------------------------------------------
// 4. Plain-text clipboards — blank lines and indentation
// ---------------------------------------------------------------------------
console.log("\n-- plain text --");
eq("CRLF line endings are normalised",
  normalizePlainText("a\r\nb\r\n"), "a\nb");
eq("blank lines are kept",
  normalizePlainText("para one\n\npara two"), "para one\n\npara two");
eq("indentation is kept",
  normalizePlainText("def f():\n    return 1"), "def f():\n    return 1");
eq("zero-width characters from word processors are removed",
  normalizePlainText("a\u200bb\ufeffc"), "abc");
eq("runs of empty paragraphs are capped at one blank line",
  normalizePlainText("a\n\n\n\n\nb"), "a\n\nb");
eq("plain text is used when the clipboard has no HTML",
  pastedMarkdown({ text: "line one\n\n  indented" }), "line one\n\n  indented");
eq("HTML wins when the browser provides it",
  pastedMarkdown({ html: "<p><b>rich</b></p>", text: "rich" }), "**rich**");
eq("an empty clipboard inserts nothing",
  pastedMarkdown({ html: "", text: "" }), "");
eq("plain text is never turned into markup",
  pastedMarkdown({ text: "<script>alert(1)</script>" }), "<script>alert(1)</script>");

// ---------------------------------------------------------------------------
// 5. Rendering the stored body — what the reader sees
// ---------------------------------------------------------------------------
console.log("\n-- rendering --");
eq("a plain message is one paragraph",
  body("just text").map((b) => b.kind).join(","), "paragraph");
eq("blank lines split paragraphs",
  body("one\n\ntwo").map((b) => b.kind).join(","), "paragraph,paragraph");
eq("a single newline stays inside its paragraph",
  flat("one\ntwo"), "one\ntwo");
eq("bold is rendered as a bold span",
  marksOf("**bold**").join(","), "bold:bold");
eq("italic is rendered",
  marksOf("*italic*").join(","), "italic:italic");
eq("underscore italic is rendered",
  marksOf("_italic_").join(","), "italic:italic");
eq("underline (__x__) is rendered",
  marksOf("__u__").join(","), "u:underline");
eq("strikethrough is rendered",
  marksOf("~~s~~").join(","), "s:strike");
eq("inline code is rendered",
  marksOf("`c`").join(","), "c:code");
eq("nested marks are combined",
  marksOf("**a *b* c**").join(","), "a :bold,b:bold+italic, c:bold");
eq("snake_case is NOT italicised",
  flat("my_var_name stays put"), "my_var_name stays put");
eq("a multiplication star is not italicised",
  flat("2 * 3 * 4"), "2 * 3 * 4");
eq("bullets render as a list",
  body("- a\n- b").map((b) => (b.kind === "list" ? `${b.ordered}:${b.items.length}` : b.kind)).join(","),
  "false:2");
eq("numbers render as an ordered list",
  body("1. a\n2. b").map((b) => (b.kind === "list" ? `${b.ordered}:${b.items.length}` : b.kind)).join(","),
  "true:2");
eq("a quote renders as a quote",
  body("> quoted").map((b) => b.kind).join(","), "quote");
eq("a heading renders as a heading",
  body("### small").map((b) => (b.kind === "heading" ? `heading${b.level}` : b.kind)).join(","), "heading3");
eq("a fenced block renders as code",
  flat("```\ncode\n```"), "code");
eq("URLs become links", hrefs("see https://freecord.app now").join(","), "https://freecord.app");
eq("a bare www host becomes https", hrefs("see www.freecord.app").join(","), "https://www.freecord.app");
eq("markdown links become links",
  hrefs(parseMessageBody("[x](https://freecord.app)")[0].nodes[0].href ? "[x](https://freecord.app)" : "").join(","),
  "https://freecord.app");
eq("mentions are recognised",
  parseInline("@alice hello").map((n) => n.kind).join(","), "mention,text");
eq("a mention inside bold keeps both",
  parseInline("**@alice**").map((n) => `${n.kind}:${n.marks.join("+")}`).join(","), "mention:bold");
eq("trailing punctuation is not part of a link",
  hrefs("see https://freecord.app, then go").join(","), "https://freecord.app");
eq("an unclosed marker stays literal", flat("**oops"), "**oops");
eq("an empty message renders nothing", body("").length, 0);
eq("a summary strips the markers", plainSummary("**bold** and _italic_"), "bold and italic");

// ---------------------------------------------------------------------------
// 6. Round trip: paste -> store -> read -> re-render (the "refresh" case)
// ---------------------------------------------------------------------------
console.log("\n-- round trip --");
const kindsof = (text) => parseMessageBody(text).map((b) => b.kind).join(",");
// Copying that message back out of Freecord and pasting it in again is a plain
// text paste: it must come back byte-for-byte.
eq("a message copied out of Freecord and pasted back is unchanged",
  pastedMarkdown({ text: richPaste }), richPaste);
eq("the stored body re-renders to the same block structure on reload",
  kindsof(richPaste), "paragraph,paragraph,list");
eq("the stored body is exactly what was sent", richPaste, htmlToMarkdown(
  '<meta charset="utf-8"><p>Hi <strong>team</strong>,</p><p>Please read ' +
  '<a href="https://freecord.app/notes">the notes</a> before Friday.</p>' +
  "<ul><li>Item <em>one</em></li><li>Item two</li></ul>"));
const nodekinds = (text) => parseMessageBody(text)
  .flatMap((b) => (b.kind === "list" ? b.items.flat() : b.kind === "code" ? [] : b.nodes))
  .map((n) => n.kind).join(",");
eq("bold/links/lists are all still there after the trip",
  nodekinds(richPaste).includes("link") && nodekinds(richPaste).includes("text"), true);
const storedMarks = parseMessageBody(richPaste).flatMap((b) => (b.kind === "paragraph" ? b.nodes : []))
  .filter((n) => n.marks.includes("bold")).map((n) => n.value);
eq("the bold run is still bold after a refresh", storedMarks.join(","), "team");

// A body with every supported feature, stored and re-read twice.
const everything = [
  "# Heading", "", "A **bold** and *italic* and __underlined__ and ~~struck~~ line.",
  "> a quote", "", "- bullet one", "- bullet two", "", "1. first", "2. second", "",
  "A [link](https://freecord.app) and `inline code`.", "", "```", "fenced code", "```",
].join("\n");
eq("a full-featured body survives a copy-out/copy-in cycle",
  pastedMarkdown({ text: everything }), everything);
eq("every block type is recognised",
  kindsof(everything),
  "heading,paragraph,quote,list,list,paragraph,code");

// ---------------------------------------------------------------------------
// 7. Long messages in every surface share this one code path
// ---------------------------------------------------------------------------
console.log("\n-- long messages --");
const long = "Paragraph one.\n\n".repeat(2000) + "Final line.";
check(`a ${messageLength(long)}-character draft is over the limit`, isMessageTooLong(long));
const longOk = "x".repeat(MESSAGE_MAX_LENGTH - 1) + "\n";
eq("a 30,000-character draft (newline included) is exactly at the limit",
  messageLength(longOk), MESSAGE_MAX_LENGTH);
eq("…and is allowed", isMessageTooLong(longOk), false);
eq("an over-long message is never truncated by the parser",
  flat("word ".repeat(7000)).length, 35000);
eq("a bare-text HTML flavour keeps the plain line breaks",
  pastedMarkdown({ html: "line one\nline two", text: "line one\nline two" }), "line one\nline two");

// ---------------------------------------------------------------------------
// 8. Performance on a maximum-size message and a large paste
// ---------------------------------------------------------------------------
console.log("\n-- performance --");
const huge = ("**bold** and https://example.com/path plus @alice and *italic* text. ".repeat(600)).slice(0, MESSAGE_MAX_LENGTH);
const parseStart = performance.now();
const parsedHuge = parseMessageBody(huge);
const parseMs = performance.now() - parseStart;
check(`a full ${messageLength(huge)}-character message parses quickly (${parseMs.toFixed(1)}ms)`, parseMs < 150, `${parseMs}ms`);
check("...and still yields blocks", parsedHuge.length > 0);
check("...with its formatting intact",
  parsedHuge.some((b) => b.kind === "paragraph" && b.nodes.some((n) => n.marks.includes("bold"))));

const bigPaste = `<p>${"word ".repeat(2000)}</p><ul>${"<li>item</li>".repeat(500)}</ul>`;
const htmlStart = performance.now();
const converted = htmlToMarkdown(bigPaste);
const htmlMs = performance.now() - htmlStart;
check(`a ${bigPaste.length}-character paste converts quickly (${htmlMs.toFixed(1)}ms)`, htmlMs < 300, `${htmlMs}ms`);
check("...and keeps its list", converted.includes("- item"));

// ---------------------------------------------------------------------------
// 9. Source invariants — every limit was actually raised
// ---------------------------------------------------------------------------
console.log("\n-- source invariants --");
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const chat = read("./src/convex/chat.ts");
const dms = read("./src/convex/dms.ts");
const channelView = read("./src/components/dashboard/ChannelView.tsx");
const dmView = read("./src/components/dashboard/DmView.tsx");
const newMessageDialog = read("./src/components/dashboard/NewMessageDialog.tsx");

check("chat.ts uses the shared limit", chat.includes("MESSAGE_MAX_LENGTH"));
check("chat.ts never truncates an edited message", !chat.includes("slice(0, 4000)"));
check("chat.ts has no 4000-character message limit", !/4000/.test(chat));
check("dms.ts uses the shared limit", dms.includes("MESSAGE_MAX_LENGTH"));
check("dms.ts never truncates an edited message", !dms.includes("slice(0, 4000)"));
check("dms.ts has no 4000-character message limit", !/4000/.test(dms));
for (const [name, source] of [
  ["ChannelView", channelView],
  ["DmView", dmView],
]) {
  check(`${name} composer is a multi-line textarea`, source.includes("<textarea"));
  check(`${name} composer has no stale 4000 maxLength`, !source.includes("maxLength={4000}"));
  check(`${name} composer converts pastes`, source.includes("pastedMarkdown("));
  check(`${name} composer shows the counter`, source.includes("formatCharacterCount(draftLength)"));
  check(`${name} composer blocks over-long sends`, source.includes("tooLong"));
}
check("NewMessageDialog has no stale 4000 maxLength", !newMessageDialog.includes("maxLength={4000}"));
check("NewMessageDialog converts pastes", newMessageDialog.includes("pastedMarkdown("));
check("MentionText renders the parsed blocks", read("./src/components/dashboard/MentionText.tsx").includes("parseMessageBody"));
check("no 4000 limit survives in the shared formatting module",
  !/4000/.test(read("./src/lib/message-format.ts")));
check("the composer still guards the send button",
  read("./src/components/dashboard/ChannelView.tsx").includes("|| tooLong}"));

// ---------------------------------------------------------------------------
// 10. Every query result must be valid Unicode (JSON-safe)
// ---------------------------------------------------------------------------
// A Convex query result is serialized to JSON. One lone UTF-16 surrogate in a
// string makes the ENTIRE function fail with
// `Could not parse return value as json: unexpected end of hex escape`.
// That is exactly how a message preview cut through the middle of an emoji took
// the whole dashboard down: `dms.listConversations` is a top-level dashboard
// subscription, so its failure unmounted the dashboard and only the dashboard.
console.log("\n-- JSON-safe previews --");

/** True when the string contains half of a surrogate pair (invalid Unicode). */
function hasLoneSurrogate(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
const emoji = "😀"; // one code point, TWO UTF-16 units

check("the detector catches a half emoji", hasLoneSurrogate(`half ${emoji.slice(0, 1)}`));
// The exact old shape — `slice(0, max - 1)` cutting a pair — must be caught,
// otherwise these assertions could pass while the production bug is back.
check("the detector catches the old slice(0, max - 1) cut",
  hasLoneSurrogate(`${"a".repeat(88)}${emoji}`.slice(0, 89)));

// Put the emoji on every offset around each cut point: the old
// `text.slice(0, max - 1)` left its first half behind at two of them.
for (const max of [2, 3, 4, 5, 10, 90, 140]) {
  for (const offset of [max - 3, max - 2, max - 1, max]) {
    const body = "a".repeat(Math.max(0, offset)) + emoji + " tail text";
    const summary = plainSummary(body, max);
    check(`plainSummary(${max}) at offset ${offset} is valid Unicode`, !hasLoneSurrogate(summary), JSON.stringify(summary));
    check(`plainSummary(${max}) at offset ${offset} survives a JSON round-trip`,
      JSON.parse(JSON.stringify(summary)) === summary);
  }
}
eq("an unpaired high surrogate is removed", stripLoneSurrogates(`boom ${emoji.slice(0, 1)}`), "boom ");
eq("an unpaired low surrogate is removed", stripLoneSurrogates(`boom ${emoji.slice(1)}`), "boom ");
eq("a complete emoji is kept", stripLoneSurrogates(`boom ${emoji}`), `boom ${emoji}`);
check("plainSummary sanitizes a legacy body before returning it",
  !hasLoneSurrogate(plainSummary(`legacy ${emoji.slice(0, 1)}`, 40)));
eq("truncateText drops the half emoji instead of keeping it", truncateText(`ab${emoji}`, 3), "ab");
eq("truncateText keeps an emoji that fits", truncateText(`ab${emoji}`, 4), `ab${emoji}`);
eq("truncateText leaves short text untouched", truncateText("abc", 10), "abc");
eq("truncateText strips an unpaired surrogate even when it fits",
  truncateText(`ab${emoji.slice(0, 1)}`, 99), "ab");
check("a surrogate-range HTML entity never becomes half an emoji",
  !hasLoneSurrogate(decodeEntities("&#xD83D;")));

// Source invariants: the two paths that made this happen cannot come back.
check("plainSummary truncates with the pair-safe helper",
  read("./src/lib/message-format.ts").includes("truncateText(text, Math.max(0, max - 1))"));
check("channel notifications never slice raw message text", !chat.includes("text.slice(0, 80)"));
check("DM notifications never slice raw message text", !dms.includes("text.slice(0, 80)"));
check("DM message bodies are stored without lone surrogates",
  (dms.match(/stripLoneSurrogates\(body\.trim\(\)\)/g) ?? []).length >= 2);
check("channel message bodies are stored without lone surrogates",
  chat.includes("stripLoneSurrogates(value.trim())") && chat.includes("stripLoneSurrogates(body.trim())"));

// The same class of bug in the OTHER fields the dashboard subscribes to: a
// group/profile/community/channel name cut mid-emoji would break the very same
// top-level queries. Every user-written field that is stored is cut this way.
const profilesSource = read("./src/convex/profiles.ts");
const communitiesSource = read("./src/convex/communities.ts");
const voiceSource = read("./src/convex/voice.ts");
const adminSource = read("./src/convex/admin.ts");
const usersSource = read("./src/convex/users.ts");
check("group names are cut pair-safely", dms.includes("truncateText(name.trim(), 50)"));
check("profile text is cut pair-safely", profilesSource.includes("truncateText(args.customStatus, 120)"));
check("profile activity text is cut pair-safely", profilesSource.includes("truncateText(args.activityName, 80)"));
check("community names/descriptions are cut pair-safely",
  communitiesSource.includes("truncateText(patch.description.trim(), 200)") &&
  communitiesSource.includes("truncateText(args.description.trim(), 200)"));
check("channel and category names are cut pair-safely", voiceSource.includes("truncateText(patch.name.trim(), 40)"));
check("the dashboard announcement is cut pair-safely", adminSource.includes("truncateText(args.announcement.trim(), 280)"));
check("profile status/bio saves are cut pair-safely", usersSource.includes("truncateText(args.bio, 400)"));
check("users.me never returns a half-emoji name",
  usersSource.includes("name: user?.name ? stripLoneSurrogates(user.name) : null"));
check("a legacy half-emoji account name is repaired on load",
  usersSource.includes("const safeName = stripLoneSurrogates(user.name);"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
