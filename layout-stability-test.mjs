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

// ---------- 4. Friends-tab avatars keep their size ----------
//
// The friends rows are `.fc-row > .fc-row-main > (<Avatar> + text)`, and the
// shared <Avatar> renders `<span class="fc-avatar"><img/></span>`. Because the
// avatar IS a <span>, a row rule aimed at the text block matched it too: the
// unscoped `.fc-row-main > span { flex: 1 }` (specificity 0-1-1) beat
// `.fc-avatar { flex-shrink: 0 }` (0-1-0), which replaced the avatar's inline
// width with flex-basis: 0% and let it GROW to share the row with the text —
// every friend's picture became an enormous ellipse and squeezed the name into
// an ellipsis.
//
// These assertions therefore evaluate the real cascade for that element instead
// of trusting a selector by eye: every rule whose selector can reach the avatar
// is matched against a model of the row, and the winning `flex` is computed the
// way a browser would (`@media` blocks are flattened above, so narrow-screen
// overrides are included).

/** One element in a model chain: a tag, its classes and its ancestors. */
function node(tag, classes, parent = null) {
  return { tag, classes, parent };
}

/** Does the compound selector `text` (no combinators) match this element? */
function compoundMatches(element, text) {
  if (!element) return false;
  const nots = [...text.matchAll(/:not\(([^)]*)\)/g)].map((m) => m[1].trim());
  const stripped = text.replace(/:not\([^)]*\)/g, "");
  const tag = (stripped.match(/^[a-zA-Z][\w-]*/) || [])[0];
  const classes = (stripped.match(/\.[\w-]+/g) || []).map((c) => c.slice(1));
  if (tag && tag !== element.tag) return false;
  if (!classes.every((c) => element.classes.includes(c))) return false;
  // `:not(...)` at the end: a NOT match is a definitive no.
  if (nots.some((inner) => inner.split(/[\s>]+/).length === 1 && compoundMatches(element, inner))) return false;
  return true;
}

/** A selector this evaluator cannot reason about (pseudo-elements, :hover, …). */
function unsupported(selector) {
  if (selector.includes("::")) return true;
  const stripped = selector.replace(/:not\([^)]*\)/g, "");
  return /:(?!not\()/.test(stripped) || selector.includes("[") || selector.includes(":has(") || selector.includes("*") || selector.includes("@");
}

/** Full selector match: compound last, ancestors per `>` and descendant hops. */
function selectorMatches(element, selector) {
  const tokens = selector.replace(/>/g, " > ").split(/\s+/).filter(Boolean);
  let index = tokens.length - 1;
  let current = element;
  if (!compoundMatches(current, tokens[index])) return false;
  index -= 1;
  while (index >= 0) {
    let child = false;
    if (tokens[index] === ">") { child = true; index -= 1; }
    const compound = tokens[index];
    if (child) {
      if (!compoundMatches(current.parent, compound)) return false;
      current = current.parent;
    } else {
      let ancestor = current.parent;
      while (ancestor && !compoundMatches(ancestor, compound)) ancestor = ancestor.parent;
      if (!ancestor) return false;
      current = ancestor;
    }
    index -= 1;
  }
  return true;
}

/** [ids, classes, types] for one selector (a `:not()` adds its argument's). */
function specificityOf(selector) {
  let ids = 0, classes = 0, types = 0;
  const stripped = selector.replace(/:not\(([^)]*)\)/g, (_, inner) => {
    const [i, c, t] = specificityOf(inner);
    ids += i; classes += c; types += t;
    return "";
  });
  ids += (stripped.match(/#[\w-]+/g) || []).length;
  classes += (stripped.match(/\.[\w-]+/g) || []).length + (stripped.match(/\[[^\]]*\]/g) || []).length;
  types += (stripped.match(/(^|[\s>+~])([a-zA-Z][\w-]*)/g) || []).length;
  return [ids, classes, types];
}

/** The three longhands a `flex` shorthand stands for. */
function flexTriple(value) {
  const parts = String(value).trim().split(/\s+/);
  if (parts.length === 1 && parts[0] === "none") return { "flex-grow": "0", "flex-shrink": "0", "flex-basis": "auto" };
  if (parts.length === 1 && /^[\d.]+$/.test(parts[0])) return { "flex-grow": parts[0], "flex-shrink": "1", "flex-basis": "0%" };
  const numeric = parts.slice(1).filter((p) => /^[\d.]+$/.test(p));
  const other = parts.slice(1).filter((p) => !/^[\d.]+$/.test(p));
  return {
    "flex-grow": parts[0] ?? "0",
    "flex-shrink": numeric[0] ?? "1",
    "flex-basis": other[0] ?? "auto",
  };
}

/**
 * The declarations that win for `element`, cascaded by (specificity, order).
 * Returns the winning value per property, plus which rules matched and whether
 * anything relevant had to be skipped because the selector was not supported.
 */
function cascade(element, props, extraRules = []) {
  const best = new Map(props.map((p) => [p, { value: null, key: [-1, -1, -1, -1], selector: null }]));
  const matched = [];
  const skipped = [];
  [...rules, ...extraRules].forEach((rule, order) => {
    rule.selector.split(",").map((s) => s.trim()).forEach((selector) => {
      if (!selector) return;
      if (unsupported(selector)) {
        // A pseudo-class/pseudo-element this evaluator does not model (":hover",
        // "::before" …). It is recorded so the assertions below can prove that
        // nothing skipped could still size the avatar.
        if (/fc-avatar|fc-row/.test(selector)) skipped.push({ selector, declarations: rule.declarations });
        return;
      }
      if (!selectorMatches(element, selector)) return;
      const declarations = {};
      for (const part of rule.declarations.split(";")) {
        const index = part.indexOf(":");
        if (index > 0) declarations[part.slice(0, index).trim()] = part.slice(index + 1).trim();
      }
      const [i, c, t] = specificityOf(selector);
      const key = [i, c, t, order];
      const better = (candidate) => {
        const current = best.get(candidate);
        if (!current) return false;
        return key.join(",").localeCompare(current.key.join(","), undefined, { numeric: true }) > 0;
      };
      if (declarations.flex !== undefined) {
        for (const [name, value] of Object.entries(flexTriple(declarations.flex))) {
          if (better(name)) best.set(name, { value, key, selector });
        }
      }
      for (const name of props) {
        if (declarations[name] !== undefined && better(name)) best.set(name, { value: declarations[name], key, selector });
      }
      matched.push(selector);
    });
  });
  return { best, matched, skipped };
}

const rowMarkup = (() => {
  // <div class="fc-row"><button class="fc-row-main"><span class="fc-avatar">
  //   <img></span><span><strong></strong><small></small></span></button></div>
  const row = node("div", ["fc-row"]);
  const main = node("button", ["fc-row-main"], row);
  const avatar = node("span", ["fc-avatar"], main);
  const image = node("img", [], avatar);
  const decoration = node("span", ["pf-decoration"], avatar);
  const text = node("span", [], main);
  const strong = node("strong", [], text);
  return { row, main, avatar, image, decoration, text, strong };
})();

{
  const avatarFlex = cascade(rowMarkup.avatar, ["flex-grow", "flex-shrink", "flex-basis", "width", "height"]);
  const grow = avatarFlex.best.get("flex-grow").value;
  const shrink = avatarFlex.best.get("flex-shrink").value;
  const basis = avatarFlex.best.get("flex-basis").value;
  check("the avatar never GROWS to fill the row", grow === "0", `flex-grow: ${grow} (from ${avatarFlex.best.get("flex-grow").selector})`);
  check("the avatar never shrinks below its own size", shrink === "0", `flex-shrink: ${shrink} (from ${avatarFlex.best.get("flex-shrink").selector})`);
  check(
    "the avatar's size is its own width/height (no 0-basis stretch)",
    basis === "auto" || basis === "100%",
    `flex-basis: ${basis} (from ${avatarFlex.best.get("flex-basis").selector})`,
  );
  check("the avatar is sized by the component, not by a stylesheet width", avatarFlex.best.get("width").value === null, JSON.stringify(avatarFlex.best.get("width")));
  // Anything the evaluator could not model must be provably unable to size the
  // avatar (a `:hover` tint, for example, is fine; a flex/width rule would not be).
  const SIZING = /(^|;)\s*(flex|flex-grow|flex-shrink|flex-basis|width|min-width|max-width|height|min-height|max-height|object-fit)\s*:/;
  check(
    "nothing skipped while matching the avatar could size it",
    avatarFlex.skipped.every((s) => !SIZING.test(s.declarations)),
    avatarFlex.skipped.filter((s) => SIZING.test(s.declarations)).map((s) => s.selector).join(" | "),
  );
  check(
    "every rule that mentions .fc-avatar was evaluated",
    avatarFlex.skipped.every((s) => !/fc-avatar/.test(s.selector)),
    avatarFlex.skipped.map((s) => s.selector).join(" | "),
  );
  check("the avatar's own rule is the one that decides its flex", /fc-avatar$/.test(avatarFlex.best.get("flex-grow").selector ?? ""), avatarFlex.best.get("flex-grow").selector ?? "");

  // The regression itself: the row's span rule must NOT reach the avatar. (It is
  // the exact selector that used to win, so this is what makes the guard bite.)
  check(
    "the unscoped row rule would still match the avatar (so the guard is meaningful)",
    selectorMatches(rowMarkup.avatar, ".fc-row-main > span"),
  );
  check(
    "the row's text rule is scoped away from the avatar",
    !selectorMatches(rowMarkup.avatar, ".fc-row-main > span:not(.fc-avatar)") &&
      declsOf(".fc-row-main > span:not(.fc-avatar)").some((d) => d.flex === "1" && d["min-width"] === "0"),
    "an unscoped `.fc-row-main > span` rule is back",
  );

  // The text block keeps the behaviour the scoped rule exists for.
  const textFlex = cascade(rowMarkup.text, ["flex-grow", "flex-shrink", "flex-basis", "min-width"]);
  check("the friend's name block still absorbs the free width", textFlex.best.get("flex-grow").value === "1", JSON.stringify(textFlex.best.get("flex-grow")));
  check("the name block can still shrink so a long name truncates", textFlex.best.get("min-width").value === "0", JSON.stringify(textFlex.best.get("min-width")));

  // The picture inside the box: clipped to it, cropped, and still a circle.
  const imageStyle = cascade(rowMarkup.image, ["width", "height", "object-fit", "border-radius"]);
  check("the picture is clipped to the avatar box (width)", imageStyle.best.get("width").value === "100%", JSON.stringify(imageStyle.best.get("width")));
  check("the picture is clipped to the avatar box (height)", imageStyle.best.get("height").value === "100%", JSON.stringify(imageStyle.best.get("height")));
  check("the picture is cropped, never distorted", imageStyle.best.get("object-fit").value === "cover", JSON.stringify(imageStyle.best.get("object-fit")));
  check("the picture stays circular", imageStyle.best.get("border-radius").value === "50%", JSON.stringify(imageStyle.best.get("border-radius")));
  check("the avatar box itself stays circular", declsOf(".fc-avatar").some((d) => d["border-radius"] === "50%"), JSON.stringify(declsOf(".fc-avatar")));

  // The source of the markup that the model above assumes: an avatar really is a
  // <span> (the reason the row rule had to be scoped) rendered beside the text.
  const avatarSource = readFileSync(join(process.cwd(), "src", "components", "dashboard", "ui.tsx"), "utf8");
  check("the shared avatar is a <span> (why `> span` reached it)", /<span className="fc-avatar"/.test(avatarSource));
  check("the avatar's size comes from its own prop", /style=\{\{ width: size, height: size/.test(avatarSource));
  check("the avatar's default size is a normal 36px", /size = 36,/.test(avatarSource));
  const friendsTab = readFileSync(join(process.cwd(), "src", "components", "dashboard", "HomeView.tsx"), "utf8");
  check("the friends rows put the picture beside the name", /<button className="fc-row-main"[\s\S]{0,400}?<Avatar[\s\S]{0,400}?<span>[\s\S]{0,120}?<strong>/.test(friendsTab), "the friend row structure changed");
  check("no friend row overrides the avatar size", !/className="fc-row-main"[\s\S]{0,600}?<Avatar[^>]*size=\{/.test(friendsTab));

  // Self-test of the guard itself: replay the ORIGINAL bug (the same rule with an
  // unscoped selector) and prove this suite would have caught it. Without this,
  // "the avatar does not grow" could just as well mean "the check matches
  // nothing".
  const regression = cascade(rowMarkup.avatar, ["flex-grow", "flex-shrink", "flex-basis"], [
    { selector: ".fc-row-main > span", declarations: "flex: 1; min-width: 0;" },
  ]);
  check(
    "the guard catches the original bug (unscoped rule ⇒ a growing avatar)",
    regression.best.get("flex-grow").value === "1" && regression.best.get("flex-basis").value === "0%",
    JSON.stringify({ grow: regression.best.get("flex-grow"), basis: regression.best.get("flex-basis") }),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
