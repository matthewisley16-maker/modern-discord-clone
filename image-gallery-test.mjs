// Unit tests for the multi-image message gallery rules: which attachments are
// images, how many previews are drawn, the "+N more" count, the grid shape and
// Previous/Next/counter behaviour used by the lightbox.
// Run: bun image-gallery-test.mjs
import {
  clampGalleryIndex,
  galleryCounter,
  galleryLayout,
  galleryOverflowCount,
  galleryOverflowLabel,
  galleryPreviewCount,
  GALLERY_PREVIEW_LIMIT,
  isGalleryImage,
  splitMessageAttachments,
  stepGalleryIndex,
} from "./src/lib/message-gallery";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e ?? ""}`); };

function eq(name, got, expected) {
  const g = JSON.stringify(got), x = JSON.stringify(expected);
  if (g === x) ok(name); else bad(name, `got ${g}, expected ${x}`);
}

const img = (id, ext = "png", url = `https://cdn.example/${id}.${ext}`) => ({
  _id: id, name: `${id}.${ext}`, contentType: `image/${ext === "jpg" ? "jpeg" : ext}`, url, size: 1024,
});
const file = (id, contentType = "application/pdf") => ({
  _id: id, name: `${id}.pdf`, contentType, url: `https://cdn.example/${id}.pdf`, size: 2048,
});

// ---- image detection ----
eq("a png is an image", isGalleryImage(img("a")), true);
eq("a jpeg with a .jpg name is an image", isGalleryImage({ ...img("b"), name: "b.jpg", contentType: "image/jpeg" }), true);
eq("a webp is an image", isGalleryImage(img("c", "webp")), true);
eq("a pdf is not an image", isGalleryImage(file("d")), false);
eq("audio is not an image", isGalleryImage({ _id: "e", name: "e.mp3", contentType: "audio/mpeg", url: "https://cdn/e.mp3" }), false);
eq("an unresolved storage url is not usable", isGalleryImage({ ...img("f"), url: null }), false);
eq("a missing attachment is not usable", isGalleryImage(null), false);
eq("svg is never treated as an in-app gallery image", isGalleryImage({ _id: "g", name: "g.svg", contentType: "image/svg+xml", url: "https://cdn/g.svg" }), false);

// ---- splitting one message's attachments ----
const mixed = [img("1"), file("2"), img("3", "jpg"), { _id: "4", name: "4.mp3", contentType: "audio/mpeg", url: "https://cdn/4.mp3" }];
eq("images are grouped", splitMessageAttachments(mixed).images.map((a) => a._id), ["1", "3"]);
eq("non-images keep their own rendering", splitMessageAttachments(mixed).files.map((a) => a._id), ["2", "4"]);
eq("an empty message yields nothing", splitMessageAttachments([]), { images: [], files: [] });
eq("null is tolerated", splitMessageAttachments(null), { images: [], files: [] });
eq("garbage entries are ignored", splitMessageAttachments([null, undefined, img("5")]).images.length, 1);

// ---- preview count + "+N more" ----
eq("the preview limit is 4", GALLERY_PREVIEW_LIMIT, 4);
eq("no images -> no previews", galleryPreviewCount(0), 0);
eq("one image -> one preview (single-image layout preserved)", galleryPreviewCount(1), 1);
eq("four images -> four previews", galleryPreviewCount(4), 4);
eq("nine images -> four previews", galleryPreviewCount(9), 4);
eq("four images hide nothing", galleryOverflowCount(4), 0);
eq("nine images hide five", galleryOverflowCount(9), 5);
eq("eight images read +4 more", galleryOverflowLabel(8), "+4 more");
eq("nine images read +5 more", galleryOverflowLabel(9), "+5 more");
eq("one image has no overlay", galleryOverflowLabel(1), "");
eq("an invalid total is safe", galleryOverflowLabel(Number.NaN), "");

// ---- grid shape ----
eq("one image keeps the single preview", galleryLayout(1), "single");
eq("two images form a pair", galleryLayout(2), "pair");
eq("three images form a triple", galleryLayout(3), "triple");
eq("four images form a quad", galleryLayout(4), "quad");
eq("many images still use the quad grid", galleryLayout(12), "quad");

// ---- lightbox navigation ----
eq("the first index is 0", clampGalleryIndex(-3, 8), 0);
eq("the last index is total-1", clampGalleryIndex(99, 8), 7);
eq("an empty gallery clamps to 0", clampGalleryIndex(4, 0), 0);
eq("next advances", stepGalleryIndex(2, 1, 8), 3);
eq("next wraps around", stepGalleryIndex(7, 1, 8), 0);
eq("previous walks back", stepGalleryIndex(2, -1, 8), 1);
eq("previous wraps around", stepGalleryIndex(0, -1, 8), 7);
eq("a single image stays put", stepGalleryIndex(0, 1, 1), 0);
eq("an empty gallery stays at 0", stepGalleryIndex(0, -1, 0), 0);
eq("the counter is one-based", galleryCounter(0, 8), "1 of 8");
eq("the counter tracks the index", galleryCounter(2, 8), "3 of 8");
eq("the counter clamps", galleryCounter(20, 8), "8 of 8");
eq("an empty counter is explicit", galleryCounter(0, 0), "0 of 0");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
