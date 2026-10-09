// Unit tests for the group-photo helpers — validation, cover geometry and the
// square that actually gets cropped out of the chosen image.
// Run: bun group-photo-test.mjs
//
// The invariants asserted here are the ones that would show up as a visibly
// broken group photo: a crop that samples OUTSIDE the source bitmap (black or
// transparent edges), a preview whose framing differs from the saved image, or
// a zoom/offset combination that produces NaN coordinates.
import {
  GROUP_PHOTO_DIMENSION,
  GROUP_PHOTO_MAX_BYTES,
  GROUP_PHOTO_MAX_ZOOM,
  GROUP_PHOTO_MIN_ZOOM,
  GROUP_PHOTO_TYPES,
  clampOffset,
  clampZoom,
  coverGeometry,
  groupPhotoErrorMessage,
  photoContentType,
  photoValidationError,
  sourceSquare,
} from "./src/lib/group-photo.ts";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e?.message ?? e}`); };
const check = (name, fn) => { try { fn(); ok(name); } catch (e) { bad(name, e); } };
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const close = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;
const eq = (name, got, expected) => {
  const g = JSON.stringify(got), x = JSON.stringify(expected);
  if (g === x) ok(name); else bad(name, `got ${g}, expected ${x}`);
};

// ---------------------------------------------------------------------------
// content type + validation
// ---------------------------------------------------------------------------
eq("a PNG is accepted by declared type", photoContentType({ type: "image/png", name: "a.png" }), "image/png");
eq("a JPG is accepted", photoContentType({ type: "image/jpeg", name: "a.jpg" }), "image/jpeg");
eq("a JPEG extension is accepted", photoContentType({ type: "image/jpeg", name: "a.jpeg" }), "image/jpeg");
eq("a WebP is accepted", photoContentType({ type: "image/webp", name: "a.webp" }), "image/webp");
eq("declared type is case/space insensitive", photoContentType({ type: " Image/PNG ", name: "a" }), "image/png");
eq("an empty declared type falls back to the extension", photoContentType({ type: "", name: "photo.JPG" }), "image/jpeg");
eq("a missing declared type falls back to the extension", photoContentType({ name: "photo.webp" }), "image/webp");
eq("a non-image is rejected", photoContentType({ type: "application/pdf", name: "a.pdf" }), null);
eq("an executable with an image name is rejected", photoContentType({ type: "", name: "a.exe" }), null);
eq("an extensionless file with no type is rejected", photoContentType({ type: "", name: "photo" }), null);
eq("no file at all is rejected", photoContentType({}), null);

check("every accepted type is inside the picker's accept list", () => {
  for (const type of GROUP_PHOTO_TYPES) assert(type.startsWith("image/"), `${type} must be an image type`);
});

eq("a valid image passes validation", photoValidationError({ type: "image/png", name: "a.png", size: 2048 }), null);
check("an oversized image is rejected with a size message", () => {
  const message = photoValidationError({ type: "image/png", name: "a.png", size: GROUP_PHOTO_MAX_BYTES + 1 });
  assert(message && /5 MB/.test(message), `expected a size message, got ${message}`);
});
check("an image exactly at the limit is allowed", () => {
  assert(photoValidationError({ type: "image/png", name: "a.png", size: GROUP_PHOTO_MAX_BYTES }) === null, "the boundary must be inclusive");
});
check("an empty file is rejected", () => {
  assert(photoValidationError({ type: "image/png", name: "a.png", size: 0 }) !== null, "a 0-byte file cannot be a photo");
});
check("an unsupported type is rejected with a format message", () => {
  const message = photoValidationError({ type: "application/zip", name: "a.zip", size: 100 });
  assert(message && /PNG/.test(message), `expected a format message, got ${message}`);
});

// ---------------------------------------------------------------------------
// coverGeometry — the image always fills the square
// ---------------------------------------------------------------------------
const stage = 240;
eq("a square image exactly fills the stage at zoom 1", (() => {
  const g = coverGeometry(800, 800, stage, 1);
  return [g.width, g.height, g.maxOffsetX, g.maxOffsetY];
})(), [stage, stage, 0, 0]);

check("a landscape image is scaled to the stage height and overflows sideways", () => {
  const g = coverGeometry(1600, 800, stage, 1);
  assert(close(g.height, stage), `height should be the square's side, got ${g.height}`);
  assert(close(g.width, stage * 2), `a 2:1 image should be twice as wide, got ${g.width}`);
  assert(g.maxOffsetX > 0, "a landscape image must be draggable horizontally");
  assert(g.maxOffsetY === 0, "there is nothing to drag vertically");
});

check("a portrait image is scaled to the stage width and overflows vertically", () => {
  const g = coverGeometry(800, 1600, stage, 1);
  assert(close(g.width, stage), `width should be the square's side, got ${g.width}`);
  assert(close(g.height, stage * 2), `a 1:2 image should be twice as tall, got ${g.height}`);
  assert(g.maxOffsetY > 0 && g.maxOffsetX === 0, "only vertical dragging is possible");
});

check("zooming in grows the image (and so what can be dragged)", () => {
  const near = coverGeometry(1600, 800, stage, 1);
  const far = coverGeometry(1600, 800, stage, 2);
  assert(far.width > near.width && far.height > near.height, "zoom must magnify");
  assert(far.maxOffsetX > near.maxOffsetX, "a magnified image has more overflow to drag");
});

check("zoom is clamped into the supported range", () => {
  assert(clampZoom(0.2) === GROUP_PHOTO_MIN_ZOOM, "below the minimum clamps up");
  assert(clampZoom(99) === GROUP_PHOTO_MAX_ZOOM, "above the maximum clamps down");
  assert(clampZoom(NaN) === GROUP_PHOTO_MIN_ZOOM, "an unusable value falls back to the minimum");
  assert(close(coverGeometry(800, 800, stage, 99).width, stage * GROUP_PHOTO_MAX_ZOOM), "geometry uses the clamped zoom");
});

check("a degenerate image size cannot produce NaN", () => {
  for (const [w, h] of [[0, 0], [NaN, 100], [-5, 100]]) {
    const g = coverGeometry(w, h, stage, 1);
    assert(Number.isFinite(g.width) && Number.isFinite(g.height), `expected finite geometry for ${w}x${h}`);
    assert(g.width >= stage && g.height >= stage, "the image must still cover the square");
  }
});

// ---------------------------------------------------------------------------
// clampOffset
// ---------------------------------------------------------------------------
check("an offset beyond the image is clamped to the edge", () => {
  const g = coverGeometry(1600, 800, stage, 1);
  const c = clampOffset({ dx: 9999, dy: 9999 }, g);
  assert(close(c.dx, g.maxOffsetX) && close(c.dy, g.maxOffsetY), `got ${JSON.stringify(c)}`);
  const n = clampOffset({ dx: -9999, dy: -9999 }, g);
  assert(close(n.dx, -g.maxOffsetX) && close(n.dy, -g.maxOffsetY), `got ${JSON.stringify(n)}`);
});

check("a usable offset is left untouched", () => {
  const g = coverGeometry(1600, 800, stage, 1);
  const c = clampOffset({ dx: 10, dy: 0 }, g);
  assert(c.dx === 10 && c.dy === 0, `got ${JSON.stringify(c)}`);
});

check("a NaN offset becomes centred instead of NaN", () => {
  const c = clampOffset({ dx: NaN, dy: NaN }, coverGeometry(1600, 800, stage, 1));
  assert(c.dx === 0 && c.dy === 0, `got ${JSON.stringify(c)}`);
});

// ---------------------------------------------------------------------------
// sourceSquare — the crop must stay inside the image, at every zoom/offset
// ---------------------------------------------------------------------------
const sizes = [[1600, 800], [800, 1600], [1000, 1000], [4032, 3024], [600, 4000], [37, 91]];
const zooms = [0, 1, 1.5, 2, 3, 50];
const offsets = [[0, 0], [1e6, 1e6], [-1e6, -1e6], [12.5, -40], [NaN, NaN]];

check("the crop square never leaves the source image", () => {
  for (const [w, h] of sizes) {
    for (const zoom of zooms) {
      for (const [dx, dy] of offsets) {
        const s = sourceSquare(w, h, stage, zoom, { dx, dy });
        assert(Number.isFinite(s.sx) && Number.isFinite(s.sy) && Number.isFinite(s.side),
          `NaN crop for ${w}x${h} zoom ${zoom} offset ${dx},${dy}`);
        assert(s.side > 0, `the crop must have area (${s.side})`);
        assert(s.sx >= -1e-9 && s.sy >= -1e-9, `crop starts outside the image: ${JSON.stringify(s)}`);
        assert(s.sx + s.side <= w + 1e-6 && s.sy + s.side <= h + 1e-6,
          `crop exceeds the image for ${w}x${h} zoom ${zoom} offset ${dx},${dy}: ${JSON.stringify(s)}`);
      }
    }
  }
});

check("a centred crop shows the middle of the image", () => {
  for (const [w, h] of sizes) {
    const s = sourceSquare(w, h, stage, 1, { dx: 0, dy: 0 });
    assert(close(s.sx + s.side / 2, w / 2, 1e-6), `horizontal centre drifted: ${JSON.stringify(s)}`);
    assert(close(s.sy + s.side / 2, h / 2, 1e-6), `vertical centre drifted: ${JSON.stringify(s)}`);
  }
});

check("a square image is used whole at zoom 1", () => {
  const s = sourceSquare(1000, 1000, stage, 1, { dx: 0, dy: 0 });
  assert(close(s.sx, 0) && close(s.sy, 0) && close(s.side, 1000), `got ${JSON.stringify(s)}`);
});

check("the crop shows a shorter image and a wider image identically", () => {
  // "Cover" means the SHORTER side of the source fills the square, so the crop
  // side always equals min(width, height) at zoom 1 - for both orientations.
  assert(close(sourceSquare(1600, 800, stage, 1, { dx: 0, dy: 0 }).side, 800), "landscape: crop the short side");
  assert(close(sourceSquare(800, 1600, stage, 1, { dx: 0, dy: 0 }).side, 800), "portrait: crop the short side");
});

check("zooming in shows less of the image", () => {
  const near = sourceSquare(1600, 800, stage, 1, { dx: 0, dy: 0 }).side;
  const mid = sourceSquare(1600, 800, stage, 2, { dx: 0, dy: 0 }).side;
  const far = sourceSquare(1600, 800, stage, 3, { dx: 0, dy: 0 }).side;
  assert(near > mid && mid > far, `crop should shrink as it zooms: ${near}, ${mid}, ${far}`);
  assert(close(mid, near / 2), "doubling the zoom halves the visible source region");
});

check("dragging the image right moves the seen window left", () => {
  const centre = sourceSquare(1600, 800, stage, 1, { dx: 0, dy: 0 });
  const right = sourceSquare(1600, 800, stage, 1, { dx: 200, dy: 0 });
  const left = sourceSquare(1600, 800, stage, 1, { dx: -200, dy: 0 });
  assert(right.sx < centre.sx, "dragging right must move the visible region left");
  assert(left.sx > centre.sx, "dragging left must move the visible region right");
});

check("dragging to the far edge stops exactly at the image edge", () => {
  // maxOffsetX is how far the IMAGE may move. Dragging the image right by the
  // maximum reveals the part that was off-square to the left, so the visible
  // window ends flush against the image's LEFT edge - and vice versa. Either
  // way it must stop exactly at the edge, never past it (no blank strip).
  const draggedRight = sourceSquare(1600, 800, stage, 1, { dx: 1e6, dy: 0 });
  assert(close(draggedRight.sx, 0, 1e-6),
    `dragging right must end flush at the left edge: ${JSON.stringify(draggedRight)}`);
  const draggedLeft = sourceSquare(1600, 800, stage, 1, { dx: -1e6, dy: 0 });
  assert(close(draggedLeft.sx + draggedLeft.side, 1600, 1e-6),
    `dragging left must end flush at the right edge: ${JSON.stringify(draggedLeft)}`);
});

check("the saved crop uses the same scale as the on-screen preview", () => {
  // The preview draws the image at `geometry.width` stage pixels and the crop
  // takes `square.side` source pixels. Both must describe the SAME framing, or
  // the saved photo would not match what the user positioned.
  for (const [w, h] of sizes) {
    for (const zoom of [1, 1.7, 3]) {
      for (const [dx, dy] of [[0, 0], [30, -12], [1e6, 0]]) {
        const geometry = coverGeometry(w, h, stage, zoom);
        const square = sourceSquare(w, h, stage, zoom, { dx, dy });
        // stage pixels per source pixel, from each side.
        const fromPreview = geometry.width / w;
        const fromCrop = stage / square.side;
        assert(close(fromPreview, fromCrop, 1e-6),
          `preview scale ${fromPreview} != crop scale ${fromCrop} for ${w}x${h} zoom ${zoom} offset ${dx},${dy}`);
      }
    }
  }
});

check("the stored dimension is the square the image is rendered into", () => {
  assert(GROUP_PHOTO_DIMENSION === 512, "the stored photo is 512x512");
  const s = sourceSquare(4096, 2731, GROUP_PHOTO_DIMENSION, 1, { dx: 0, dy: 0 });
  const ratio = GROUP_PHOTO_DIMENSION / s.side;
  assert(ratio > 0 && Number.isFinite(ratio), "a 12MP photo still renders to the 512px square");
});

// ---------------------------------------------------------------------------
// error messages
// ---------------------------------------------------------------------------
eq("an Error's message is used", groupPhotoErrorMessage(new Error("Upload failed."), "fallback"), "Upload failed.");
eq("a string error is used", groupPhotoErrorMessage("nope", "fallback"), "nope");
eq("an empty error falls back", groupPhotoErrorMessage(new Error(""), "fallback"), "fallback");
eq("an unknown error falls back", groupPhotoErrorMessage({ weird: true }, "fallback"), "fallback");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
