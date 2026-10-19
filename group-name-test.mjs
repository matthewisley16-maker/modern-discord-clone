// Tests for the group name shown beside a group's picture — in the sidebar
// conversations list, on the Conversations page, in the chat header and in
// Secret Chats.
//
// Run: bun group-name-test.mjs
//
// Three layers, none of which creates an account (the deployment guard forbids
// synthetic users in production):
//   1. the pure rule (`src/lib/group-name.ts`) every surface shares,
//   2. the real source of the queries and components that must use it, plus the
//      CSS invariants that keep the name readable (centered with the picture,
//      truncated instead of widening the sidebar),
//   3. a live, read-only call proving the conversations query answers.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "./src/convex/_generated/api.js";
import { UNNAMED_GROUP, groupDisplayName, isUnnamedGroup } from "./src/lib/group-name";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, detail) => { fail++; console.log(`FAIL: ${name} -> ${detail ?? ""}`); };
const is = (name, got, expected) => {
  if (got === expected) ok(name);
  else bad(name, `got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
};
const check = (name, condition, detail) => (condition ? ok(name) : bad(name, detail));

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");
/** One top-level Convex function's text: its declaration to the first `});`. */
function handlerOf(source, declaration) {
  const start = source.indexOf(declaration);
  if (start < 0) return "";
  const end = source.indexOf("\n});", start);
  return source.slice(start, end < 0 ? undefined : end);
}
/** One CSS rule body, e.g. ruleOf(css, ".fc-dm {"). */
function ruleOf(css, selector) {
  const start = css.indexOf(selector);
  if (start < 0) return "";
  const end = css.indexOf("}", start);
  return end < 0 ? "" : css.slice(start + selector.length, end);
}

// ---------------------------------------------------------------------------
// 1. The rule (pure): a stored name is shown as stored, a missing one is not
// ---------------------------------------------------------------------------
is("the fallback label is the requested one", UNNAMED_GROUP, "Unnamed Group");
is("a real stored name is shown as stored", groupDisplayName("Design Club"), "Design Club");
is("surrounding whitespace is trimmed", groupDisplayName("  Design Club  "), "Design Club");
is("inner spacing is preserved", groupDisplayName("Design  Club"), "Design  Club");
is("an emoji name is preserved", groupDisplayName("🎨 Art Friends"), "🎨 Art Friends");
is("a name containing “group” is NOT replaced", groupDisplayName("Group Therapy"), "Group Therapy");
is("a name starting with “unnamed” but longer is preserved", groupDisplayName("Unnamed Champions"), "Unnamed Champions");
is("an empty name falls back", groupDisplayName(""), UNNAMED_GROUP);
is("a whitespace-only name falls back", groupDisplayName("   "), UNNAMED_GROUP);
is("a missing name falls back", groupDisplayName(undefined), UNNAMED_GROUP);
is("a null name falls back", groupDisplayName(null), UNNAMED_GROUP);
is("a non-string name falls back", groupDisplayName(42), UNNAMED_GROUP);
is("the legacy stored placeholder reads as unnamed", groupDisplayName("Group"), UNNAMED_GROUP);
is("the legacy placeholder is matched case-insensitively", groupDisplayName("  group "), UNNAMED_GROUP);
is("the fallback itself is idempotent", groupDisplayName(UNNAMED_GROUP), UNNAMED_GROUP);
is("isUnnamedGroup agrees on a nameless group", isUnnamedGroup(""), true);
is("isUnnamedGroup is false for a real name", isUnnamedGroup("Design Club"), false);
check("the rule never returns an empty string", ["", " ", undefined, null, "Group", "x"].every((v) => groupDisplayName(v).length > 0), "a surface would render an empty title");

// ---------------------------------------------------------------------------
// 2a. Every list reads the name from the database, through that one rule
// ---------------------------------------------------------------------------
const dms = read("src", "convex", "dms.ts");
const privacy = read("src", "convex", "conversationPrivacy.ts");

const listConversations = handlerOf(dms, "export const listConversations = query({");
check("the conversations query imports the shared rule", dms.includes('import { groupDisplayName } from "../lib/group-name"'), "the shared rule is no longer used by the query");
check("a group's name comes from its stored column", listConversations.includes("groupDisplayName(convo.name)"), "the group name is no longer read from the stored field");
check("no placeholder name is invented in the query", !/convo\.name \?\? "Group"/.test(dms), "a hardcoded \"Group\" name reappeared");
check("the list still carries the group's picture", listConversations.includes("iconUrl"), "the picture field disappeared from the list");
check("the list still carries the member count", listConversations.includes("memberCount: members.length"), "the member count disappeared from the list");
check("a direct chat still shows the other person's name", listConversations.includes("otherCards[0]?.displayName"), "the direct-chat name disappeared");

const createGroup = handlerOf(dms, "export const createGroup = mutation({");
// The name is still stored as typed; the cut is pair-safe so an emoji can never
// be left half-stored (which would break the conversations query's JSON).
check("a new group stores the name exactly as typed", createGroup.includes("const clean = truncateText(name.trim(), 50);"), "the stored name is no longer the typed name");
check("a blank name stores NO placeholder", createGroup.includes("...(clean ? { name: clean } : {})"), "a placeholder would be written into the database again");
check("the chat header row uses the shared rule", handlerOf(dms, "export const groupDetails = query({").includes("groupDisplayName(convo.name)"), "groupDetails no longer applies the rule");
check("Secret Chats lists the same name", privacy.includes("groupDisplayName(convo.name)"), "the Secret Chats query stopped using the rule");

// ---------------------------------------------------------------------------
// 2b. The sidebar list: picture, then the name immediately beside it
// ---------------------------------------------------------------------------
const dashboard = read("src", "pages", "Dashboard.tsx");
const sidebarStart = dashboard.indexOf("fc-dm-list");
const sidebar = dashboard.slice(sidebarStart, sidebarStart + 4000);

check("the sidebar row renders the picture first", sidebar.includes("<ConversationIcon convo={c} />"), "the picture is no longer rendered in the row");
check("the name follows the picture in the same row", /<ConversationIcon convo=\{c\} \/>\s*<DmRowLabel convo=\{c\} \/>/.test(sidebar), "the name is no longer directly beside the picture");
check("the row is a button that opens the conversation", sidebar.includes("onClick={() => openConversation(c.conversationId)}"), "the row no longer opens the conversation");
check("the selected group is highlighted", sidebar.includes('${selectedConversationId === c.conversationId && section === "dms" ? "active" : ""}'), "the selected-row highlight disappeared");
check("the selected row is announced to assistive tech", sidebar.includes('aria-current={selectedConversationId === c.conversationId && section === "dms" ? "true" : undefined}'), "aria-current disappeared");
check("the row's accessible name is the group's name", sidebar.includes("aria-label={`Open ${c.type === \"group\" ? \"group chat\" : \"conversation\"}"), "the accessible label disappeared");
check("the list is a reactive subscription (live updates)", dashboard.includes("useQuery(api.dms.listConversations, {})"), "the list is no longer reactive");
check("the name is loaded from the query, never hardcoded", dashboard.includes('import { groupDisplayName } from "@/lib/group-name"') && dashboard.includes("isGroup ? groupDisplayName(convo.name) : convo.name"), "the name is no longer taken from the data");
check("no placeholder group name is hardcoded in the row", !/convo\.type === "group" \? `\$\{convo\.name\}/.test(dashboard), "the name is glued to other text again");
check("a group's member count is its own chip, not part of the name", dashboard.includes('className="fc-dm-count"') && dashboard.includes("const title = isGroup ? groupDisplayName(convo.name)"), "the count is glued to the name again");
check("the chat header uses the shared rule", read("src", "components", "dashboard", "DmView.tsx").includes("groupDisplayName(convo.name)"), "the header no longer applies the rule");
check("Secret Chats rows apply the rule too", read("src", "components", "dashboard", "SecretChats.tsx").includes("groupDisplayName(row.name)"), "the Secret Chats rows no longer apply the rule");

// ---------------------------------------------------------------------------
// 2c. The Conversations page: the same rows, reachable and highlighted
// ---------------------------------------------------------------------------
check("the Conversations page exists", dashboard.includes("function ConversationsPage("), "the Conversations page disappeared");
const page = dashboard.slice(dashboard.indexOf("function ConversationsPage("), dashboard.indexOf("function ConversationsPage(") + 2500);
check("it renders the same picture + name rows", page.includes("<ConversationIcon convo={c} size={32} />") && page.includes("<DmRowLabel convo={c} />"), "the page no longer renders the shared row");
check("its rows open the conversation", page.includes("onClick={() => onOpen(c.conversationId)}"), "the page's rows no longer open a chat");
check("its selected row is highlighted too", page.includes('fc-convo-item ${active ? "active" : ""}') && page.includes('aria-current={active ? "true" : undefined}'), "the page no longer highlights the selected chat");
check("the page lists open and archived chats", page.includes("<div className=\"fc-convo-list\">{open.map(renderRow)}</div>") && page.includes("ARCHIVED — ${archived.length}"), "the page's lists disappeared");
check("the page is rendered on the Direct Messages view", /<ConversationsPage\s+open=\{activeConversations\}\s+archived=\{archivedConversations\}/.test(dashboard), "the page is no longer rendered");
check("the sidebar's CONVERSATIONS heading opens the page", dashboard.includes("function showConversationsPage()") && dashboard.includes("className=\"fc-sidebar-section-label\""), "there is no way to reach the Conversations page");
check("opening a chat leaves the page again", /function openConversation\(id[\s\S]{0,140}setConversationsPage\(false\)/.test(dashboard), "the page flag is not cleared when a chat opens");

// ---------------------------------------------------------------------------
// 2d. Layout: centered with the picture, truncated, never widening the sidebar
// ---------------------------------------------------------------------------
const css = read("src", "index.css");
const row = ruleOf(css, ".fc-dm {");
check("the row centers the picture and the name", row.includes("align-items: center"), `.fc-dm {${row}}`);
check("the text block may shrink with the row", ruleOf(css, ".fc-dm-name {").includes("min-width: 0"), "the name block can no longer shrink");
check("the name row is centered (chip, count and time aligned)", ruleOf(css, ".fc-dm-title-row {").includes("align-items: center"), "the title row is no longer centered");
const title = ruleOf(css, ".fc-dm-title {");
check("a long name truncates with an ellipsis", title.includes("text-overflow: ellipsis") && title.includes("white-space: nowrap"), `.fc-dm-title {${title}}`);
check("the name is the only part that shrinks", title.includes("min-width: 0") && title.includes("flex: 1"), "the name no longer takes the free space");
check("nothing pins the name to a fixed width", !/\.fc-dm-title \{[^}]*width: \d+px/.test(css), "a fixed title width would break long or short names");
const convoItem = ruleOf(css, ".fc-convo-item {");
check("the page's row centers the picture and the name", convoItem.includes("align-items: center"), `.fc-convo-item {${convoItem}}`);
check("the page's name may shrink too", ruleOf(css, ".fc-convo-item .fc-dm-name {").includes("flex: 1"), "the page's name block is not flexible");
check("the member-count chip cannot be squeezed away", ruleOf(css, ".fc-dm-count {").includes("flex-shrink: 0"), "the count chip would be clipped");
check("the light theme keeps the row readable", css.includes("html.fc-light .fc-convo-item { color:"), "no light-theme rule for the Conversations page");
// The sidebar is hidden (not resized) on small screens, becoming an overlay
// drawer, so the page — which renders these same rows inside the scrolling main
// pane — is what keeps names visible on a phone.
check("the sidebar becomes a drawer rather than shrinking", css.includes(".fc-sidebar { display: none; }") && css.includes(".fc-sidebar.open { display: flex;"), "the responsive sidebar rules changed");
check("the Conversations page is laid out like the other views", dashboard.includes('<div className="fc-view-head"><AtSign size={20} /><h2>Conversations</h2></div>') && dashboard.includes('<div className="fc-convo-list">{open.map(renderRow)}</div>'), "the page is not laid out like the other views");

// ---------------------------------------------------------------------------
// 3. Live: the conversations list answers (read-only, no session)
// ---------------------------------------------------------------------------
const URL_ = process.env.CONVEX_URL || "https://academic-porcupine-929.convex.cloud";
const anonymous = new ConvexHttpClient(URL_);
async function rejection(fn) {
  try {
    return { error: null, result: await fn() };
  } catch (error) {
    return { error: String(error?.data ?? error?.message ?? error) };
  }
}
const listed = await rejection(() => anonymous.query(api.dms.listConversations, {}));
check("the conversations list answers without a session (empty, never an error)",
  !listed.error && Array.isArray(listed.result) && listed.result.length === 0,
  listed.error ?? JSON.stringify(listed.result));
// Renaming is a write, so a stranger must not be able to change what the sidebar
// (and every other surface) prints for a group.
const rename = await rejection(() => anonymous.mutation(api.dms.renameGroup, { conversationId: "kn78pcaany1qw5hatvc9by0mz18fjwas", name: "Nope" }));
check("a signed-out caller cannot rename a group", Boolean(rename.error), `it SUCCEEDED: ${JSON.stringify(rename.result)}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
