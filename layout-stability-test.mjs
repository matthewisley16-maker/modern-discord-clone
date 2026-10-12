// Layout-stability guards for the far-left server rail, the community sidebar
// and the message hover highlight.
//
// WHY THESE ASSERTIONS
// --------------------
// Two reported bugs are pure CSS/layout properties, which means a browser is the
// only place they used to be caught — and the next innocent edit could bring
// them straight back:
//
//   1. opening/expanding a rail folder must never resize the rail, the sidebar
//      or the surrounding panels (the layout was shrinking);
//   2. hovering a message must light up the WHOLE message tile, never half of it
//      (the highlight used to be painted per-child / on a partial overlay).
//
// Both are decided entirely by the declarations in `src/index.css`, so this
// suite parses that stylesheet and asserts the invariants directly. Pure: no
// browser, no Convex, no network.
//
// Run: bun layout-stability-test.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e ?? ""}`); };
const check = (name, condition, detail) => (condition ? ok(name) : bad(name, detail));

const css = readFileSync(join(process.cwd(), "src", "index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Every rule in the stylesheet as `{ selector, declarations }`. `@media` blocks
 * are flattened (their inner rules are collected too), because an override at a
 * narrower breakpoint is exactly the kind of rule that must stay width-safe.
 */
const rules = (() => {
  const out = [];
  const clean = css.replace(/@[^{]+\{/g, " ");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) out.push({ selector: m[1].trim(), declarations: m[2] });
  return out;
})();

/** Declarations of every rule whose selector list contains `selector`. */
function declsOf(selector) {
  return rules
    .filter((r) => r.selector.split(",").map((s) => s.trim()).includes(selector))
    .map((r) => {
      const map = {};
      for (const part of r.declarations.split(";")) {
        const i = part.indexOf(":");
        if (i > 0) map[part.slice(0, i).trim()] = part.slice(i + 1).trim();
      }
      return map;
    });
}

/** The single value of `prop` across every rule for `selector` (must agree). */
function prop(selector, name) {
  const found = declsOf(selector).map((d) => d[name]).filter((v) => v !== undefined);
  if (found.length === 0) return null;
  return found.every((v) => v === found[0]) ? found[0] : `MIXED(${found.join(" | ")})`;
}

const px = (v) => {
  const n = Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
};

/** The value from the FIRST rule for `selector` (the base, breakpoint-free rule). */
function baseProp(selector, name) {
  for (const d of declsOf(selector)) if (d[name] !== undefined) return d[name];
  return null;
}

/** Every single width (px) a selector declares across all of its rules. */
function allWidths(selector) {
  return declsOf(selector).map((d) => px(d.width)).filter((n) => n !== null);
}

/**
 * A fixed-width column must never be able to be resized by its CONTENT: every
 * rule that sets `width` has to pin matching `min-width` and `max-width` in the
 * same declaration block (a breakpoint may change the value, but not un-pin it).
 */
function checkPinnedWidth(label, selector) {
  const rulesFor = declsOf(selector).filter((d) => d.width !== undefined);
  check(`${label} declares a width`, rulesFor.length > 0, selector);
  const unpinned = rulesFor.filter((d) => d["min-width"] !== d.width || d["max-width"] !== d.width);
  check(
    `${label} pins min-width and max-width to every declared width`,
    unpinned.length === 0,
    JSON.stringify(unpinned),
  );
}

// ---------- 1. The far-left rail keeps ONE width, always ----------
{
  checkPinnedWidth("rail", ".fc-rail");
  check("rail never shrinks in the shell's flex row", prop(".fc-rail", "flex-shrink") === "0");
  const railWidths = allWidths(".fc-rail");
  check("the narrow-screen rail override is not wider", railWidths.every((w) => w <= railWidths[0]), railWidths.join(", "));
  // Expanded folder contents must not be able to widen the column: the rail clips
  // horizontally and every row inside it is bounded by the rail's own width.
  check("rail hides horizontal overflow", prop(".fc-rail", "overflow-x") === "hidden");
  check("rail scrolls vertically instead of growing", prop(".fc-rail", "overflow-y") === "auto");
  // A reserved scrollbar gutter means opening a folder (which can turn the rail
  // scrollable) cannot shift or narrow anything horizontally.
  check("rail reserves a stable scrollbar gutter", prop(".fc-rail", "scrollbar-gutter") === "stable");

  const servers = declsOf(".fc-rail-servers");
  check(".fc-rail-servers is width-bounded", servers.some((d) => d["min-width"] === "0" && d["max-width"] === "100%"), JSON.stringify(servers));
  const item = declsOf(".fc-rail-item");
  check(".fc-rail-item is width-bounded", item.some((d) => d["min-width"] === "0" && d["max-width"] === "100%"), JSON.stringify(item));

  // The widest thing inside the rail still fits inside the narrowest rail.
  const narrowest = Math.min(...railWidths);
  const childWidths = declsOf(".fc-rail-server").map((d) => px(d.width)).filter((n) => n !== null);
  const nestedWidths = declsOf(".fc-rail-item-nested .fc-rail-server").map((d) => px(d.width)).filter((n) => n !== null);
  const widestChild = Math.max(...childWidths, ...nestedWidths, 0);
  check(
    "rail rows fit inside the narrowest rail",
    widestChild > 0 && widestChild <= narrowest,
    `child ${widestChild}px vs rail ${narrowest}px`,
  );
}

// ---------- 2. The community sidebar and main panel keep their dimensions ----------
{
  checkPinnedWidth("sidebar", ".fc-sidebar");
  const sidebarWidth = px(baseProp(".fc-sidebar", "width"));
  const sidebarWidths = allWidths(".fc-sidebar");
  check("the narrow-screen sidebar override is not wider", sidebarWidths.every((w) => w <= sidebarWidth), sidebarWidths.join(", "));
  check("sidebar never shrinks next to the main panel", prop(".fc-sidebar", "flex-shrink") === "0");
  check("sidebar clips content instead of growing", prop(".fc-sidebar", "overflow") === "hidden");
  const sidebarChildren = declsOf(".fc-sidebar > *");
  check(
    "sidebar sections do not shrink",
    sidebarChildren.some((d) => d["flex-shrink"] === "0"),
    JSON.stringify(sidebarChildren),
  );
  check("main panel can absorb width without shrinking panes", prop(".fc-main", "min-width") === "0");
  check("main content row can absorb width", prop(".fc-main-content", "min-width") === "0");
  check("sidebar scroll box hides horizontal overflow", prop(".fc-sidebar-scroll", "overflow-x") === "hidden");
  check("sidebar scroll box can shrink to fit", prop(".fc-sidebar-scroll", "min-height") === "0");
  check(
    "rail-vs-sidebar gap: every rail width stays narrower than every sidebar width",
    Math.max(...allWidths(".fc-rail")) < Math.min(...sidebarWidths),
    `rail ${allWidths(".fc-rail").join(", ")} vs sidebar ${sidebarWidths.join(", ")}`,
  );
}

// ---------- 3. Message hover lights the WHOLE tile ----------
{
  const hoverSelectors = rules.filter((r) => r.selector.split(",").some((s) => /^\.fc-message:hover$/.test(s.trim())));
  check("a .fc-message:hover rule exists", hoverSelectors.length > 0);
  check(
    "message hover paints the row itself (full rectangle)",
    hoverSelectors.every((r) => /(^|;)\s*background(-color)?\s*:/.test(r.declarations)),
    hoverSelectors.map((r) => r.declarations).join(" | "),
  );
  const row = declsOf(".fc-message");
  check("the hovered row is a positioned rectangle", row.some((d) => d.position === "relative" && d["border-radius"] !== undefined));
  check("row starts transparent and transitions the tint", row.some((d) => d["background-color"] === "transparent" && (d.transition ?? "").includes("background-color")));
  // The old partial overlay must not come back: no `::before` paints a hover tint.
  const overlay = rules.filter((r) =>
    r.selector.split(",").some((s) => s.trim().startsWith(".fc-message") && s.includes("::before")) &&
    /background(-color)?\s*:\s*(?!transparent)/.test(r.declarations),
  );
  check("no partial ::before hover overlay on messages", overlay.length === 0, overlay.map((r) => r.selector).join(" | "));

  // Every theme tints the whole row too, so the highlight cannot be missing in
  // (or clipped by) one particular theme.
  for (const theme of ["html.fc-light .fc-message:hover", "html.fc-contrast .fc-message:hover", "html.fc-midnight .fc-message:hover"]) {
    const themed = declsOf(theme);
    check(`${theme} tints the row background`, themed.some((d) => d["background-color"] !== undefined), JSON.stringify(themed));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
