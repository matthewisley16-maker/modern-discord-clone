// Unit tests for the community cover-art rules used by the Discover card.
// Run: bun community-cover-test.mjs
//
// The card must show the community's OWN uploaded cover (the URL the server
// derives from `servers.iconStorageId`), and nothing else: no generated image,
// no unrelated icon, no hardcoded picture. It falls back to the placeholder only
// when there is no cover, or when the browser reports the file failed to load.
import { communityCoverUrl, communityInitial } from "./src/lib/community-cover";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e ?? ""}`); };

function is(name, got, expected) {
  if (got === expected) ok(name);
  else bad(name, `got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
}

const UPLOADED = "https://academic-porcupine-929.convex.cloud/api/storage/kg2abc123";

// ---------------------------------------------------------------------------
// The uploaded cover is used verbatim
// ---------------------------------------------------------------------------
is("an uploaded cover is displayed", communityCoverUrl({ iconUrl: UPLOADED }), UPLOADED);
is("the exact storage URL is passed through (no rewriting)", communityCoverUrl({ iconUrl: `${UPLOADED}?x=1` }), `${UPLOADED}?x=1`);
is("a replaced cover is a different URL, so the new one is shown", communityCoverUrl({ iconUrl: "https://example.convex.cloud/api/storage/new" }) !== UPLOADED, true);

// ---------------------------------------------------------------------------
// Placeholder cases — never a random or hardcoded image
// ---------------------------------------------------------------------------
is("no cover -> placeholder", communityCoverUrl({ iconUrl: null }), null);
is("missing field -> placeholder", communityCoverUrl({}), null);
is("empty string -> placeholder", communityCoverUrl({ iconUrl: "   " }), null);
is("a non-string cover -> placeholder", communityCoverUrl({ iconUrl: 42 }), null);
is("undefined failed flag does not hide a real cover", communityCoverUrl({ iconUrl: UPLOADED, failed: false }), UPLOADED);
is("a failed image load falls back to the placeholder", communityCoverUrl({ iconUrl: UPLOADED, failed: true }), null);
is("whitespace around a cover is trimmed", communityCoverUrl({ iconUrl: `  ${UPLOADED}  ` }), UPLOADED);

// ---------------------------------------------------------------------------
// Placeholder label
// ---------------------------------------------------------------------------
is("the placeholder shows the community initial", communityInitial("Design Guild"), "D");
is("the initial is uppercase", communityInitial("art club"), "A");
is("a leading space does not blank the initial", communityInitial("  Pixel"), "P");
is("a nameless community still renders a glyph", communityInitial(""), "?");
is("null name still renders a glyph", communityInitial(null), "?");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
