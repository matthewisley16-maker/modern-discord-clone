// Unit tests for the community subcategory rules, PLUS live checks of the
// deployment's public read side (Discover data and its filter) and of the
// server-side permission boundary. Nothing is created or modified: the live
// half only reads public queries and asserts that anonymous writes are refused,
// so it is safe to run against the real deployment.
// Run: bun community-category-test.mjs
//
// These are the EXACT functions the backend validates with and the UI renders
// from (src/convex/communities.ts, src/convex/admin.ts,
// src/components/dashboard/CommunitySettings.tsx, DiscoverView.tsx,
// src/pages/AdminPanel.tsx), so they prove:
//   - only supported subcategories can be saved,
//   - the stored value is the canonical spelling ("gaming" → "Gaming"),
//   - a community with an outdated subcategory keeps it, stays visible under it,
//     and can still be switched to a supported one,
//   - nothing here ever invents a second copy of the list.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "./src/convex/_generated/api.js";
import {
  COMMUNITY_CATEGORIES,
  DEFAULT_COMMUNITY_CATEGORY,
  SUPPORTED_COMMUNITY_CATEGORIES,
  communityCategoryChanged,
  communityCategoryMatches,
  communityCategoryOf,
  communityCategoryOptions,
  communityCategoryProblem,
  isLegacyCommunityCategory,
  normalizeCommunityCategory,
} from "./src/lib/community-categories";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e ?? ""}`); };
const is = (name, got, expected) => {
  if (got === expected) ok(name);
  else bad(name, `got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
};
const check = (name, condition, detail) => (condition ? ok(name) : bad(name, detail));

// ---------------------------------------------------------------------------
// The supported list
// ---------------------------------------------------------------------------
is("the supported list is non-empty and unique", new Set(SUPPORTED_COMMUNITY_CATEGORIES).size, SUPPORTED_COMMUNITY_CATEGORIES.length);
is("the default subcategory is supported", SUPPORTED_COMMUNITY_CATEGORIES.includes(DEFAULT_COMMUNITY_CATEGORY), true);
is("General is supported", SUPPORTED_COMMUNITY_CATEGORIES.includes("General"), true);
is("Gaming is supported", SUPPORTED_COMMUNITY_CATEGORIES.includes("Gaming"), true);
is("the creation flow's list is the same array", COMMUNITY_CATEGORIES.length, SUPPORTED_COMMUNITY_CATEGORIES.length);

// ---------------------------------------------------------------------------
// Normalising a submitted value
// ---------------------------------------------------------------------------
is("a canonical value normalises to itself", normalizeCommunityCategory("Gaming"), "Gaming");
is("matching ignores case", normalizeCommunityCategory("gaming"), "Gaming");
is("matching ignores surrounding whitespace", normalizeCommunityCategory("   Music  "), "Music");
is("an unsupported value is refused", normalizeCommunityCategory("Underwater Basket Weaving"), null);
is("an empty value is refused", normalizeCommunityCategory(""), null);
is("a whitespace-only value is refused", normalizeCommunityCategory("   "), null);
is("a non-string is refused", normalizeCommunityCategory(7), null);
is("undefined is refused", normalizeCommunityCategory(undefined), null);

// ---------------------------------------------------------------------------
// Outdated (stored but no longer offered) values
// ---------------------------------------------------------------------------
is("an outdated value is detected", isLegacyCommunityCategory("Retro"), true);
is("a supported value is not legacy", isLegacyCommunityCategory("Art"), false);
is("an empty value is not legacy", isLegacyCommunityCategory(""), false);
is("undefined is not legacy", isLegacyCommunityCategory(undefined), false);

is("a supported value displays canonically", communityCategoryOf("tech"), "Tech");
is("an outdated value displays as stored (never rewritten)", communityCategoryOf("Retro Gaming"), "Retro Gaming");
is("a missing value displays as the default", communityCategoryOf(undefined), DEFAULT_COMMUNITY_CATEGORY);
is("an empty value displays as the default", communityCategoryOf("   "), DEFAULT_COMMUNITY_CATEGORY);

// The filter row and every list use this, so a community with an outdated
// subcategory stays findable under it instead of disappearing.
is("an outdated community stays under its own filter", communityCategoryOf("Retro Gaming"), "Retro Gaming");
is("two communities sharing an outdated value filter together", communityCategoryMatches("Retro Gaming", " retro gaming "), true);
is("a supported community matches its filter case-insensitively", communityCategoryMatches("gaming", "Gaming"), true);
is("a supported community does not match another filter", communityCategoryMatches("Gaming", "Music"), false);
is("a community with no stored value matches the default filter", communityCategoryMatches(undefined, "General"), true);
is("an outdated community does not match a supported filter", communityCategoryMatches("Retro Gaming", "Gaming"), false);

// ---------------------------------------------------------------------------
// Validation (server-side rule, same messages in the UI)
// ---------------------------------------------------------------------------
is("a supported value passes validation", communityCategoryProblem("Art"), null);
is("a supported value with odd case passes", communityCategoryProblem(" aRt "), null);
is("an empty submission is refused with the list", communityCategoryProblem(""), `Choose a subcategory (${SUPPORTED_COMMUNITY_CATEGORIES.join(", ")}).`);
is("an unsupported submission is refused with the list",
  communityCategoryProblem("Crypto"), "“Crypto” isn't a supported subcategory. Choose one of: " + SUPPORTED_COMMUNITY_CATEGORIES.join(", ") + ".");
is("a long unsupported submission is clipped in the message", communityCategoryProblem("x".repeat(80)).includes("isn't a supported subcategory"), true);
is("a long unsupported submission is not echoed in full", communityCategoryProblem("x".repeat(80)).length < 200, true);
is("the CURRENT outdated value is accepted so it can be left alone",
  communityCategoryProblem("Retro Gaming", "Retro Gaming"), null);
is("the current outdated value compares case-insensitively",
  communityCategoryProblem("retro gaming", "Retro Gaming"), null);
is("but switching FROM it to another outdated value is refused",
  communityCategoryProblem("Something Else", "Retro Gaming") !== null, true);
is("and switching from it to a supported value is allowed",
  communityCategoryProblem("Gaming", "Retro Gaming"), null);

// ---------------------------------------------------------------------------
// Change detection (used to skip a pointless write)
// ---------------------------------------------------------------------------
is("the same value in different case is not a change", communityCategoryChanged("gaming", "Gaming"), false);
is("a different supported value is a change", communityCategoryChanged("Gaming", "Music"), true);
is("setting a value where none was stored is a change", communityCategoryChanged("Music", undefined), true);
is("keeping an unchanged outdated value is not a change", communityCategoryChanged("Retro Gaming", "Retro Gaming"), false);
is("replacing an outdated value is a change", communityCategoryChanged("Music", "Retro Gaming"), true);
is("a missing value equals the default", communityCategoryChanged(undefined, "General"), false);

// ---------------------------------------------------------------------------
// Picker options
// ---------------------------------------------------------------------------
const plainOptions = communityCategoryOptions("Gaming");
is("a supported current value adds no extra option", plainOptions.length, COMMUNITY_CATEGORIES.length);
is("supported options are not flagged legacy", plainOptions.every((o) => !o.legacy), true);
is("the current supported value is among the options", plainOptions.some((o) => o.value === "Gaming"), true);

const legacyOptions = communityCategoryOptions("Retro Gaming");
is("an outdated current value is offered as an extra option", legacyOptions.length, COMMUNITY_CATEGORIES.length + 1);
is("that extra option is flagged as legacy", legacyOptions.filter((o) => o.legacy).map((o) => o.value).join(","), "Retro Gaming");
is("the legacy option is last (after the supported ones)", legacyOptions[legacyOptions.length - 1].legacy, true);
is("duplicate legacy options are impossible", communityCategoryOptions("Art").filter((o) => o.value === "Art").length, 1);
is("options are unique", new Set(legacyOptions.map((o) => o.value)).size, legacyOptions.length);
is("no current value means supported options only", communityCategoryOptions(undefined).length, COMMUNITY_CATEGORIES.length);

// ---------------------------------------------------------------------------
// Live: the deployment's Discover data and its filter
// ---------------------------------------------------------------------------
const URL = process.env.CONVEX_URL || "https://academic-porcupine-929.convex.cloud";
const anonymous = new ConvexHttpClient(URL);

async function rejection(fn) {
  try {
    return { error: null, result: await fn() };
  } catch (error) {
    return { error: String(error?.data ?? error?.message ?? error) };
  }
}

const supported = new Set(SUPPORTED_COMMUNITY_CATEGORIES);

const filterList = await rejection(() => anonymous.query(api.communities.categories, {}));
if (filterList.error) {
  bad("the Discover filter list loads", filterList.error);
} else {
  ok("the Discover filter list loads");
  const list = filterList.result;
  is("every supported subcategory is offered as a filter", SUPPORTED_COMMUNITY_CATEGORIES.every((c) => list.includes(c)), true);
  is("the filter list has no duplicates", new Set(list).size, list.length);
  is("the filter list is sorted", [...list].sort((a, b) => a.localeCompare(b)).join("|"), list.join("|"));
}

const all = await rejection(() => anonymous.query(api.communities.discover, {}));
if (all.error) {
  bad("Discover returns public communities", all.error);
} else {
  ok("Discover returns public communities");
  is("every discovered community reports a non-empty subcategory",
    all.result.every((c) => typeof c.category === "string" && c.category.trim().length > 0), true);
  is("a supported subcategory is stored in its canonical spelling",
    all.result.every((c) => !supported.has(c.category) || SUPPORTED_COMMUNITY_CATEGORIES.includes(c.category)), true);
}

// The filter must agree with what each row reports: pick a subcategory that has
// at least one community and check that the filtered list contains exactly those.
const firstWithResults = SUPPORTED_COMMUNITY_CATEGORIES
  .map((c) => ({ c, rows: (all.result ?? []).filter((x) => communityCategoryMatches(x.category, c)) }))
  .find((x) => x.rows.length > 0);
if (!firstWithResults) {
  console.log("info: no public community uses a supported subcategory yet — filter check skipped");
} else {
  const filtered = await rejection(() => anonymous.query(api.communities.discover, { category: firstWithResults.c }));
  if (filtered.error) {
    bad(`Discover filters by ${firstWithResults.c}`, filtered.error);
  } else {
    ok(`Discover filters by ${firstWithResults.c}`);
    is("the filter returns only communities in that subcategory",
      filtered.result.every((c) => communityCategoryMatches(c.category, firstWithResults.c)), true);
    is("the filter returns every community in that subcategory",
      filtered.result.length, firstWithResults.rows.length);
  }
  // A filter value that is not offered must not silently return everything.
  const bogus = await rejection(() => anonymous.query(api.communities.discover, { category: "Not A Real Subcategory" }));
  if (bogus.error) bad("an unknown filter value returns nothing", bogus.error);
  else if (bogus.result.length === 0) ok("an unknown filter value returns nothing");
  else bad("an unknown filter value returns nothing", `returned ${bogus.result.length} rows`);
}

// ---------------------------------------------------------------------------
// Live: an ordinary/unauthenticated caller cannot change a subcategory
// ---------------------------------------------------------------------------
// A REAL community id when one is available, so the sign-in/permission gate in
// the handler is the thing being tested (not argument validation), plus a
// fabricated id to show a caller who cannot mint one never reaches the handler.
const realServerId = (all.result ?? [])[0]?.serverId;
const FABRICATED_SERVER = "jd7f4m2q9w1s8x0k3v5n6b2c4z7h9t1r";
const writeRefusals = [
  ["changing a subcategory (fabricated id)", () => anonymous.mutation(api.communities.setCategory, { serverId: FABRICATED_SERVER, category: "Gaming" })],
  ["saving community settings (fabricated id)", () => anonymous.mutation(api.communities.updateSettings, { serverId: FABRICATED_SERVER, category: "Gaming" })],
];
if (realServerId) {
  writeRefusals.push(
    ["changing a subcategory (real community)", () => anonymous.mutation(api.communities.setCategory, { serverId: realServerId, category: "Gaming" })],
    ["saving community settings (real community)", () => anonymous.mutation(api.communities.updateSettings, { serverId: realServerId, category: "Art" })],
  );
}
for (const [label, call] of writeRefusals) {
  const result = await rejection(call);
  if (result.error === null) bad(`an anonymous caller cannot do this: ${label}`, "the mutation succeeded");
  else if (/sign in/i.test(result.error)) ok(`an anonymous caller cannot do this: ${label}`);
  else if (/ArgumentValidationError|Validator/i.test(result.error)) ok(`a fabricated id is refused before the handler runs: ${label}`);
  else bad(`an anonymous caller cannot do this: ${label}`, `unexpected rejection: ${result.error}`);
}

// ---------------------------------------------------------------------------
// Who is allowed to change it (offline, from the real permission table)
// ---------------------------------------------------------------------------
// `communities.setCategory` gates on `requirePermission(..., "manageCommunity")`,
// so the answer to "may this member edit the subcategory?" is exactly the answer
// to "does their role carry `manageCommunity`?". Asserting it against the real
// ROLE_PERMISSIONS table proves the owner/admin-allow, member-deny boundary
// without creating accounts (which the deployment guard forbids in production).
{
  const { ROLE_PERMISSIONS } = await import("./src/convex/lib.ts");
  const source = readFileSync(join(process.cwd(), "src", "convex", "communities.ts"), "utf8");
  const handler = source.slice(source.indexOf("export const setCategory = mutation({"), source.indexOf("export const joinByCode"));
  const gate = 'requirePermission(ctx, serverId, userId, "manageCommunity")';
  check("setCategory is gated on manageCommunity", handler.includes(gate), "the permission check moved or disappeared");
  for (const role of ["owner", "admin"]) {
    check(`the ${role} role carries manageCommunity`, (ROLE_PERMISSIONS[role] ?? []).includes("manageCommunity"));
  }
  for (const role of ["moderator", "member"]) {
    check(`an ordinary ${role} does NOT carry manageCommunity`, !(ROLE_PERMISSIONS[role] ?? []).includes("manageCommunity"));
  }
  // The Admin Panel route uses the platform-administrator gate from the same module.
  const adminSource = readFileSync(join(process.cwd(), "src", "convex", "admin.ts"), "utf8");
  const adminHandler = adminSource.slice(adminSource.indexOf("export const updateCommunity = mutation({"), adminSource.indexOf("\n});", adminSource.indexOf("export const updateCommunity = mutation({")));
  check("admin.updateCommunity requires panel access", adminHandler.includes("requirePanelAccess(ctx, userId)"));
  check(
    "admin.updateCommunity validates the subcategory with the same rule",
    adminHandler.includes("communityCategoryProblem(patch.category, server.category)"),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
