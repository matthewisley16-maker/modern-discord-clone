// Tests for editing a group's PICTURE and SETTINGS — the rules a person
// actually hits when they click "Edit group".
//
// Run: bun group-settings-test.mjs
//
// Three layers, none of which needs an account (the deployment guard forbids
// creating synthetic users in production):
//
//   1. the pure picker rules (`src/lib/community-cover.ts`), which decide what
//      a person may upload and under which content type it is stored,
//   2. the real source of the backend and the two editing surfaces, asserting
//      the picture path is permission-gated, validated server-side, persisted
//      in the database (not browser state) and shared by both editors,
//   3. live calls to the deployment with NO session, asserting an anonymous
//      caller cannot change a group or mint an upload URL. These only ever
//      fail to authorize, so they write nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "./src/convex/_generated/api.js";
import {
  COMMUNITY_IMAGE_ACCEPT,
  COMMUNITY_IMAGE_MAX_BYTES,
  COMMUNITY_IMAGE_TYPES,
  communityImageContentType,
  communityImageProblem,
} from "./src/lib/community-cover";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, detail) => { fail++; console.log(`FAIL: ${name} -> ${detail ?? ""}`); };
const is = (name, got, expected) => {
  if (got === expected) ok(name);
  else bad(name, `got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
};
const check = (name, condition, detail) => (condition ? ok(name) : bad(name, detail));

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");
/** The text of one top-level Convex function, from its declaration to the first `});`. */
function handlerOf(source, declaration) {
  const start = source.indexOf(declaration);
  if (start < 0) return "";
  const end = source.indexOf("\n});", start);
  return source.slice(start, end < 0 ? undefined : end);
}

// ---------------------------------------------------------------------------
// 1. What a picker may accept (pure rules)
// ---------------------------------------------------------------------------
is("the accept list is derived from the stored types", COMMUNITY_IMAGE_ACCEPT, COMMUNITY_IMAGE_TYPES.join(","));
is("the limit is 5 MB", COMMUNITY_IMAGE_MAX_BYTES, 5 * 1024 * 1024);

for (const type of COMMUNITY_IMAGE_TYPES) {
  is(`a declared ${type} is stored as itself`, communityImageContentType({ type, name: "any" }), type);
  is(`a ${type} file passes validation`, communityImageProblem({ type, name: "a", size: 1024 }), null);
}
is("a declared type is matched case- and space-insensitively", communityImageContentType({ type: "  Image/PNG ", name: "a" }), "image/png");
is("a declared type that is not one we store is refused (no relabelling)", communityImageContentType({ type: "image/bmp", name: "a.bmp" }), null);
is("an SVG is refused even though it is an image", communityImageContentType({ type: "image/svg+xml", name: "logo.svg" }), null);
is("an SVG is refused with the supported list", communityImageProblem({ type: "image/svg+xml", name: "logo.svg", size: 10 }), "Group pictures must be a PNG, JPG, GIF, WebP or AVIF image.");
is("no declared type falls back to a .JPG extension", communityImageContentType({ type: "", name: "photo.JPG" }), "image/jpeg");
is("no declared type falls back to a .jpeg extension", communityImageContentType({ name: "photo.jpeg" }), "image/jpeg");
is("no declared type falls back to a .webp extension", communityImageContentType({ type: "", name: "photo.webp" }), "image/webp");
is("a declared non-image is refused even with an image extension", communityImageContentType({ type: "application/pdf", name: "a.png" }), null);
is("a document is refused", communityImageProblem({ type: "application/pdf", name: "a.pdf", size: 10 }), "Group pictures must be a PNG, JPG, GIF, WebP or AVIF image.");
is("a text file is refused", communityImageProblem({ type: "text/plain", name: "notes.txt", size: 10 }), "Group pictures must be a PNG, JPG, GIF, WebP or AVIF image.");
is("an executable named like an image is refused", communityImageProblem({ type: "", name: "a.exe", size: 10 }), "Group pictures must be a PNG, JPG, GIF, WebP or AVIF image.");
is("an extensionless file with no type is refused", communityImageProblem({ type: "", name: "photo", size: 10 }), "Group pictures must be a PNG, JPG, GIF, WebP or AVIF image.");
is("no file at all is refused", communityImageProblem(null), "Choose an image file to use as the group picture.");
is("an oversized picture is refused with a size message", communityImageProblem({ type: "image/png", name: "a.png", size: COMMUNITY_IMAGE_MAX_BYTES + 1 }), "Group pictures must be 5 MB or smaller.");
is("a picture exactly at the limit is allowed", communityImageProblem({ type: "image/png", name: "a.png", size: COMMUNITY_IMAGE_MAX_BYTES }), null);
is("a picture with no reported size is allowed (the server re-checks)", communityImageProblem({ type: "image/png", name: "a.png" }), null);
is("the type check runs before the size check", communityImageProblem({ type: "text/plain", name: "a.txt", size: COMMUNITY_IMAGE_MAX_BYTES + 1 }), "Group pictures must be a PNG, JPG, GIF, WebP or AVIF image.");

// ---------------------------------------------------------------------------
// 2a. Backend: ONE picture rule, enforced server-side, persisted in the DB
// ---------------------------------------------------------------------------
const communities = read("src", "convex", "communities.ts");
const admin = read("src", "convex", "admin.ts");
const schema = read("src", "convex", "schema.ts");

check("the picture rule is exported for every editing surface", /export async function assertUsableCover\(/.test(communities), "assertUsableCover is no longer exported");
check("the rule verifies the stored object exists", /db\.system\.get\("_storage", storageId\)/.test(communities), "the storage lookup disappeared");
check("the rule verifies the stored content type", /COVER_TYPES\.includes\(meta\.contentType/.test(communities), "the content-type check disappeared");
check("the rule verifies the stored size", /meta\.size > COVER_MAX_BYTES/.test(communities), "the size check disappeared");
check("the stored types are the ones the client offers", COMMUNITY_IMAGE_TYPES.every((t) => communities.includes(`"${t}"`)), "the server list and the picker list disagree");

const ownerSettings = handlerOf(communities, "export const updateSettings = mutation({");
check("the owner editor validates the uploaded picture", ownerSettings.includes("await assertUsableCover(ctx, patch.iconStorageId)"), "updateSettings no longer validates the picture");
check("the owner editor can clear the picture back to the default", /if \(patch\.clearIcon\)/.test(ownerSettings) && ownerSettings.includes("clean.iconStorageId = undefined"), "clearing the picture disappeared");
check("the owner editor is gated on manageCommunity", ownerSettings.includes('requirePermission(ctx, serverId, userId, "manageCommunity")'), "the permission check moved or disappeared");
check("the replaced picture is deleted from storage", ownerSettings.includes("deleteStoredFile(ctx, blob)"), "old pictures would pile up in storage");

check("the Admin Panel reuses the SAME rule (no second validator)", admin.includes('import { assertUsableCover } from "./communities"'), "the Admin Panel stopped sharing the rule");
check("the Admin Panel defines no competing image limits", !/COVER_TYPES|COVER_MAX_BYTES/.test(admin), "a second set of image rules appeared in admin.ts");

const adminUpdate = handlerOf(admin, "export const updateCommunity = mutation({");
check("an administrator can set a group picture", adminUpdate.includes("iconStorageId: v.optional(v.id(\"_storage\"))"), "the iconStorageId argument disappeared");
check("an administrator can restore the default avatar", adminUpdate.includes("clearIcon: v.optional(v.boolean())"), "the clearIcon argument disappeared");
check("the Admin Panel validates the uploaded picture server-side", adminUpdate.includes("await assertUsableCover(ctx, patch.iconStorageId)"), "admin.updateCommunity no longer validates the picture");
check("the Admin Panel requires panel access", adminUpdate.includes("requirePanelAccess(ctx, userId)"), "the administrator gate moved or disappeared");
check("the Admin Panel persists the picture on the community row", adminUpdate.includes("update.iconStorageId = patch.iconStorageId"), "the picture would not be stored");
check("the Admin Panel clears the picture back to the default", adminUpdate.includes("update.iconStorageId = undefined"), "clearing the picture disappeared");
check("the Admin Panel deletes the picture it replaced", adminUpdate.includes("await deleteStoredFile(ctx, blob)"), "replaced pictures would pile up in storage");
check("re-selecting the same picture is a no-op", adminUpdate.includes("if (blob === patch.iconStorageId) continue;"), "a re-selected picture would be deleted");

const listCommunities = handlerOf(admin, "export const listCommunities = query({");
check("the Admin Panel list reports the stored picture", listCommunities.includes("iconUrl: server.iconStorageId ? await ctx.storage.getUrl(server.iconStorageId) : null"), "the list no longer resolves the picture");
check("the Admin Panel list says whether a picture exists", listCommunities.includes("hasIcon: Boolean(server.iconStorageId)"), "hasIcon disappeared");

const serverTable = schema.slice(schema.indexOf("servers: defineTable("), schema.indexOf("servers: defineTable(") + 2500);
check("the picture is a persistent column on the community", serverTable.includes("iconStorageId: v.optional(v.id(\"_storage\"))"), "servers.iconStorageId disappeared from the schema");
check("no browser-only field is used as the stored picture", !/iconDataUrl|iconBlobUrl|localStoragePicture/.test(schema), "a client-only field appeared in the schema");

// ---------------------------------------------------------------------------
// 2b. Both editing surfaces: sections, preview, save/cancel, confirmation
// ---------------------------------------------------------------------------
const settings = read("src", "components", "dashboard", "CommunitySettings.tsx");
check("the settings panel has the required sections", ["General", "Appearance", "Permissions", "Members"].every((t) => settings.includes(`"${t}"`)), "a required section is missing from the section list");
check("the sections are rendered as navigable tabs", settings.includes('className="fc-settings-tabs"') && settings.includes("onClick={() => setTab(t)}"), "the tab navigation disappeared");
check("the group picture section offers an upload", settings.includes('accept={COMMUNITY_IMAGE_ACCEPT}') && settings.includes("uploadIcon(f)"), "the upload control disappeared");
check("the group picture section previews the pick", settings.includes("shownIcon") && settings.includes("<img src={shownIcon}"), "the preview disappeared");
check("a picked picture is saved explicitly", settings.includes("async function saveIcon()") && settings.includes("iconStorageId });"), "the picture save disappeared");
check("a picked picture can be cancelled", settings.includes("function clearIconPick()") && settings.includes("onClick={clearIconPick}"), "the picture cancel disappeared");
check("the stored picture can be removed (default avatar)", settings.includes("clearIcon: true"), "removing the picture disappeared");
check("the uploaded type is the allowed one, never a raw guess", settings.includes("xhr.setRequestHeader(\"Content-Type\", contentType)"), "the upload header is no longer the validated type");
check("General has Save changes and Cancel", settings.includes("Save changes") && settings.includes(">Cancel</Button>"), "the save/cancel pair disappeared");
check("the General fields follow the stored values until they are edited",
  settings.includes("const general: GeneralDraft = generalDraft ?? {") && settings.includes("name: server?.name ?? \"\""),
  "the fields would be seeded from an empty loading state");
check("Cancel restores the stored General values", /function cancelEdits\(\) \{\s*setGeneralDraft\(null\);/.test(settings), "cancel no longer restores the saved values");
check("saving General clears the draft so the stored values win again", /await update\(\{[\s\S]{0,700}?slowModeSeconds: general\.slowMode,[\s\S]{0,200}?setGeneralDraft\(null\);/.test(settings), "a stale draft would survive the save");
check("no state is seeded from an effect (no cascading re-render)", !settings.includes("useEffect("), "an effect-based seed reappeared");
check("the General form is never saved from an empty loading state", !/const \[name, setName\]/.test(settings), "the form is seeded from state at first render again");
check("saving reports success", settings.includes("toast.success"), "success feedback disappeared");
check("failing saves report the error and keep the edits", settings.includes("toast.error(e instanceof Error ? e.message"), "error feedback disappeared");
check("the panel never stores the picture in browser state as the saved value", !/localStorage|sessionStorage/.test(settings), "browser storage appeared in the settings panel");
check("no secret or key is read in the client", !/apiKey|secret|serviceRole/i.test(settings), "a secret-looking identifier appeared in the client panel");

const panel = read("src", "pages", "AdminPanel.tsx");
check("each community row has an Edit group control", panel.includes("setEditCommunity({ serverId: c.serverId") && panel.includes("Edit group"), "the Edit group button disappeared");
check("the row shows the community's own stored picture", panel.includes("<img src={c.iconUrl}"), "the row thumbnail disappeared");
check("the Edit dialog is named as a group editor", panel.includes("Edit group"), "the dialog title disappeared");
check("the dialog previews a picked picture before saving", panel.includes("communityPicturePreview") && panel.includes('alt="Group picture preview"'), "the dialog preview disappeared");
check("the dialog only uploads on save", panel.includes("async function uploadCommunityPicture(") && panel.includes("const iconStorageId = picture ? await uploadCommunityPicture(picture) : undefined;"), "the upload is no longer deferred to Save");
check("the dialog sends the picture and the clear flag", panel.includes("...(iconStorageId ? { iconStorageId } : {})") && panel.includes("...(clearing ? { clearIcon: true } : {})"), "the dialog no longer sends the picture");
check("the dialog can remove a picture", panel.includes("setRemoveCommunityPicture(true)"), "the remove control disappeared");
check("closing the dialog discards an unsaved picture", panel.includes("resetCommunityPicture(); setEditCommunity(null)"), "an unsaved picture would leak");
check("the picture is validated before uploading", panel.includes("communityImageProblem(file)"), "the client-side check disappeared");
check("the dialog reports what changed", panel.includes('clearing ? "Group picture removed."'), "the per-change success message disappeared");
check("removing a member is confirmed before it happens", read("src", "components", "dashboard", "ServerPermissions.tsx").includes("window.confirm(`Kick ${m.displayName}?`)"), "the kick confirmation disappeared");

// The group-CONVERSATION picture (a DM group) keeps its own editor and is still
// wired into the group details panel, header and conversation list.
const dmView = read("src", "components", "dashboard", "DmView.tsx");
const groupPhoto = read("src", "components", "dashboard", "GroupPhotoEditor.tsx");
check("the group chat still renders its photo editor", dmView.includes("<GroupPhotoEditor"), "the group photo editor is no longer rendered");
check("only the group owner/admin may edit it", dmView.includes("canEdit={group.isOwner || group.isAdmin}"), "the client-side edit gate disappeared");
check("the editor offers Edit Group Photo", groupPhoto.includes("Edit Group Photo"), "the edit control disappeared");
check("the editor can remove the photo (default icon)", groupPhoto.includes("storageId: null"), "removing the photo disappeared");
check("the editor shows a preview before saving", groupPhoto.includes("fc-group-photo-stage"), "the preview stage disappeared");
check("the conversation itself is what stores the photo", read("src", "convex", "dms.ts").includes("export const setGroupPhoto = mutation({"), "dms.setGroupPhoto disappeared");

// ---------------------------------------------------------------------------
// 2c. The picture appears wherever the group appears (one stored field)
// ---------------------------------------------------------------------------
for (const [file, label] of [
  ["src/components/dashboard/ServerRail.tsx", "the server rail"],
  ["src/pages/Dashboard.tsx", "the channel list and conversation list"],
  ["src/components/dashboard/DiscoverView.tsx", "Discover"],
  ["src/components/dashboard/SearchView.tsx", "search"],
]) {
  const source = read(...file.split("/"));
  check(`${label} reads the stored picture`, source.includes("iconUrl"), "no iconUrl usage found");
}

// ---------------------------------------------------------------------------
// 3. Live: the deployment HAS the picture path, and refuses everyone else
// ---------------------------------------------------------------------------
// Nothing here signs in, so no call below can write anything: they either fail
// argument validation or fail the backend's own authorization gate.
const URL_ = process.env.CONVEX_URL || "https://academic-porcupine-929.convex.cloud";
const anonymous = new ConvexHttpClient(URL_);
const FABRICATED_SERVER = "jd7f4m2q9w1s8x0k3v5n6b2c4z7h9t1r";
const FABRICATED_STORAGE = "kg2e5f8a1b4c7d0e3f6a9b2c5d8e1f4";

async function rejection(fn) {
  try {
    return { error: null, result: await fn() };
  } catch (error) {
    return { error: String(error?.data ?? error?.message ?? error) };
  }
}

/** The deployment prints its argument schema when it refuses an unknown field. */
function argumentSchema(error) {
  const text = String(error ?? "");
  const at = text.indexOf("Validator: v.object(");
  return at < 0 ? "" : text.slice(at);
}

// A REAL, publicly discoverable community so the id validator passes and the
// authorization gate is the thing that answers.
const discovered = await rejection(() => anonymous.query(api.communities.discover, {}));
const realCommunity = (Array.isArray(discovered.result) ? discovered.result : []).find((c) => typeof c?.serverId === "string");

if (!realCommunity) {
  console.log("info: no public community is discoverable — live picture checks skipped");
} else {
  const realServerId = realCommunity.serverId;

  // The deployment's own schema for the two write paths: this is not the source
  // file talking, it is the deployed function telling us what it accepts.
  const adminSchema = argumentSchema((await rejection(() =>
    anonymous.mutation(api.admin.updateCommunity, { serverId: realServerId, definitelyNotAnArgument: 1 }))).error);
  const memberSchema = argumentSchema((await rejection(() =>
    anonymous.mutation(api.communities.updateSettings, { serverId: realServerId, definitelyNotAnArgument: 1 }))).error);
  check("the live Admin Panel function accepts a group picture", adminSchema.includes('iconStorageId: v.optional(v.id("_storage"))'), adminSchema || "no schema reported");
  check("the live Admin Panel function can restore the default avatar", adminSchema.includes("clearIcon: v.optional(v.boolean())"), adminSchema || "no schema reported");
  check("the live member-facing function accepts a group picture", memberSchema.includes('iconStorageId: v.optional(v.id("_storage"))'), memberSchema || "no schema reported");
  check("the live member-facing function can restore the default avatar", memberSchema.includes("clearIcon: v.optional(v.boolean())"), memberSchema || "no schema reported");

  // With valid arguments, only the authorization gate stands in the way — and it
  // must refuse, with an authorization answer (never a validation error, which
  // would mean the call never reached the permission check).
  const signedOutAttempts = [
    ["renaming a group from the Admin Panel", () => anonymous.mutation(api.admin.updateCommunity, { serverId: realServerId, name: "Nope" })],
    ["changing a group's privacy from the Admin Panel", () => anonymous.mutation(api.admin.updateCommunity, { serverId: realServerId, isPublic: true })],
    ["restoring the default picture from the Admin Panel", () => anonymous.mutation(api.admin.updateCommunity, { serverId: realServerId, clearIcon: true })],
    ["editing a group as a member", () => anonymous.mutation(api.communities.updateSettings, { serverId: realServerId, name: "Nope" })],
    ["clearing a group picture as a member", () => anonymous.mutation(api.communities.updateSettings, { serverId: realServerId, clearIcon: true })],
  ];
  for (const [label, attempt] of signedOutAttempts) {
    const result = await rejection(attempt);
    if (!result.error) {
      bad(`a signed-out caller cannot do this: ${label}`, `it SUCCEEDED: ${JSON.stringify(result.result)}`);
      continue;
    }
    const reached = !/ArgumentValidationError|not in the validator/i.test(result.error);
    const refused = /sign in|authenticat|permission|authoriz|admin/i.test(result.error);
    check(`a signed-out caller cannot do this: ${label}`, reached && refused, result.error);
  }
}

// A caller who cannot even mint a valid id never reaches the handler at all.
const fabricated = await rejection(() => anonymous.mutation(api.communities.updateSettings, { serverId: FABRICATED_SERVER, iconStorageId: FABRICATED_STORAGE }));
check("a caller who cannot mint a valid group id never reaches the handler",
  Boolean(fabricated.error) && /Validator/i.test(fabricated.error), fabricated.error ?? JSON.stringify(fabricated.result));

// Minting an upload URL is what every picture upload starts with, so it must not
// be available to someone who is not signed in.
const uploadUrl = await rejection(() => anonymous.mutation(api.uploads.generateUploadUrl, {}));
check("a signed-out caller cannot mint an upload URL", Boolean(uploadUrl.error) && /sign in|authenticat/i.test(uploadUrl.error),
  uploadUrl.error ?? JSON.stringify(uploadUrl.result));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
