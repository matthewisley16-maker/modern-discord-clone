// Unit tests for the popup-menu placement math (never clipped, always inside
// the viewport, flips above/below and left/right). Pure geometry, no browser.
// Run: bun menu-position-test.mjs
import { computeMenuPosition } from "./src/lib/menu-position";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e ?? ""}`); };

const M = 8;
function inside(pos, mw, mh, vw, vh) {
  const w = Math.min(mw, vw - M * 2);
  const h = Math.min(mh, pos.maxHeight);
  return pos.left >= M - 0.001 && pos.left + w <= vw - M + 0.001 &&
    pos.top >= M - 0.001 && pos.top + h <= vh - M + 0.001;
}
function check(name, pos, mw, mh, vw, vh) {
  if (inside(pos, mw, mh, vw, vh)) ok(name);
  else bad(name, `outside viewport: ${JSON.stringify(pos)} (menu ${mw}x${mh}, viewport ${vw}x${vh})`);
}

const MW = 220, MH = 300;
const VW = 1280, VH = 800;
function anchorAt(left, top, w = 32, h = 32) {
  return { left, top, right: left + w, bottom: top + h };
}

// A button with tons of room: menu opens below, left-aligned.
{
  const a = anchorAt(200, 300);
  const pos = computeMenuPosition({ anchor: a, menuWidth: MW, menuHeight: MH, viewportWidth: VW, viewportHeight: VH });
  check("plenty of room: fully inside", pos, MW, MH, VW, VH);
  if (pos.top === a.bottom + 8 && pos.left === a.left) ok("plenty of room: opens below and left-aligned");
  else bad("plenty of room: opens below and left-aligned", JSON.stringify(pos));
}

// Bottom of the screen: flips above the trigger.
{
  const a = anchorAt(600, VH - 40);
  const pos = computeMenuPosition({ anchor: a, menuWidth: MW, menuHeight: MH, viewportWidth: VW, viewportHeight: VH });
  check("bottom of screen: fully inside", pos, MW, MH, VW, VH);
  if (pos.top + MH <= a.top) ok("bottom of screen: flips above the trigger");
  else bad("bottom of screen: flips above the trigger", JSON.stringify(pos));
}

// Bottom-right corner (the profile ⋯ case): above + shifted left.
{
  const a = anchorAt(VW - 40, VH - 40);
  const pos = computeMenuPosition({ anchor: a, menuWidth: MW, menuHeight: MH, viewportWidth: VW, viewportHeight: VH, align: "end" });
  check("bottom-right corner: fully inside", pos, MW, MH, VW, VH);
  if (pos.top + MH <= a.top && pos.left + MW <= VW - M + 0.001) ok("bottom-right corner: flips up and left");
  else bad("bottom-right corner: flips up and left", JSON.stringify(pos));
}

// Top-right corner: stays below, shifts left so it can't overflow.
{
  const a = anchorAt(VW - 40, 12);
  const pos = computeMenuPosition({ anchor: a, menuWidth: MW, menuHeight: MH, viewportWidth: VW, viewportHeight: VH, align: "end" });
  check("top-right corner: fully inside", pos, MW, MH, VW, VH);
  if (pos.top === a.bottom + 8) ok("top-right corner: opens below");
  else bad("top-right corner: opens below", JSON.stringify(pos));
}

// Left edge of the screen (e.g. edge of the server sidebar).
{
  const a = anchorAt(0, 400);
  const pos = computeMenuPosition({ anchor: a, menuWidth: MW, menuHeight: MH, viewportWidth: VW, viewportHeight: VH });
  check("left edge: fully inside", pos, MW, MH, VW, VH);
  if (pos.left >= M) ok("left edge: clamped away from the left");
  else bad("left edge: clamped away from the left", JSON.stringify(pos));
}

// Right edge without align=end: flips to the left of the trigger.
{
  const a = anchorAt(VW - 30, 400);
  const pos = computeMenuPosition({ anchor: a, menuWidth: MW, menuHeight: MH, viewportWidth: VW, viewportHeight: VH });
  check("right edge (start align): fully inside", pos, MW, MH, VW, VH);
}

// Small mobile screen, several trigger positions.
for (const [left, top, label] of [[4, 4, "top-left"], [280, 4, "top-right"], [4, 440, "bottom-left"], [280, 440, "bottom-right"]]) {
  const a = anchorAt(left, top, 28, 28);
  const pos = computeMenuPosition({ anchor: a, menuWidth: MW, menuHeight: MH, viewportWidth: 320, viewportHeight: 480 });
  check(`mobile 320x480 ${label}: fully inside`, pos, MW, MH, 320, 480);
}

// Menu taller than the viewport: capped and scrollable, still inside.
{
  const a = anchorAt(120, 300);
  const pos = computeMenuPosition({ anchor: a, menuWidth: MW, menuHeight: 900, viewportWidth: VW, viewportHeight: 400 });
  check("tall menu: capped inside the viewport", pos, MW, 900, VW, 400);
  if (pos.maxHeight <= 400 - M * 2) ok("tall menu: maxHeight is bounded by the viewport");
  else bad("tall menu: maxHeight is bounded by the viewport", String(pos.maxHeight));
}

// Menu wider than a narrow viewport: never spills horizontally.
{
  const a = anchorAt(10, 200);
  const pos = computeMenuPosition({ anchor: a, menuWidth: 500, menuHeight: MH, viewportWidth: 320, viewportHeight: 640 });
  check("wide menu on a narrow screen: fully inside", pos, 500, MH, 320, 640);
  if (pos.left === M) ok("wide menu on a narrow screen: pinned to the left margin");
  else bad("wide menu on a narrow screen: pinned to the left margin", JSON.stringify(pos));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
