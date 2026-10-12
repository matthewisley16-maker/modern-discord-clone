/**
 * Community cover art selection for the Discover card.
 *
 * A community's cover is ONE authoritative column — `servers.iconStorageId` —
 * uploaded by the owner in Community settings (`communities.updateSettings`)
 * and turned into a URL by the server (`communities.discover` → `iconUrl`, the
 * same field the rail, the sidebar and community settings use). The card must
 * therefore render that exact image, never a random or generated one, and must
 * still look deliberate when there is no cover or the file cannot be loaded.
 *
 * This module is the single decision point (pure, unit-tested in
 * `community-cover-test.mjs` and `group-settings-test.mjs`) so the card, the
 * owner-facing settings panel and the Admin Panel all agree on exactly which
 * file may become a group picture, and when a real uploaded cover is shown
 * rather than the placeholder.
 */

/** The authoritative cover URL a card should use, or null for the placeholder. */
export function communityCoverUrl(input: {
  /** `communities.discover` → `iconUrl` (persistent storage URL, or null). */
  iconUrl?: string | null;
  /** True once the browser reported the image failed to load. */
  failed?: boolean;
}): string | null {
  const url = typeof input.iconUrl === "string" ? input.iconUrl.trim() : "";
  if (!url) return null;
  if (input.failed) return null;
  return url;
}

/** The letter shown on the placeholder when a community has no usable cover. */
export function communityInitial(name?: string | null): string {
  const trimmed = (name ?? "").trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : "?";
}

/**
 * Client-side limit for a group picture. This is a courtesy check only — the
 * authority is the server rule (`assertUsableCover` in `src/convex/communities.ts`),
 * which inspects the STORED object because the browser's declared MIME type is
 * never trusted. Keeping both numbers in one place stops the picker from
 * offering something the backend will refuse.
 */
export const COMMUNITY_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Exactly the types the server accepts for a group picture. */
export const COMMUNITY_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"];

/** Value for a file input's `accept`, derived from the same list. */
export const COMMUNITY_IMAGE_ACCEPT = COMMUNITY_IMAGE_TYPES.join(",");

/** Extension → stored type, used when the browser declares no MIME type at all. */
const COMMUNITY_IMAGE_EXTENSIONS: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
};

function declaredType(file: { type?: string | null } | null | undefined): string {
  return typeof file?.type === "string" ? file.type.trim().toLowerCase() : "";
}

function fileExtension(file: { name?: string | null } | null | undefined): string {
  if (typeof file?.name !== "string") return "";
  const dot = file.name.lastIndexOf(".");
  return dot < 0 ? "" : file.name.slice(dot + 1).trim().toLowerCase();
}

/**
 * The content type a picked picture must be STORED as, or null when the file is
 * not one we accept.
 *
 * A missing/empty declared type falls back to the file extension (some browsers
 * report none), but a declared type that really is an image yet not one we store
 * — SVG, BMP, TIFF, ICO… — is refused instead of being silently relabelled: SVG
 * can carry script, and the server stores exactly the type it is told here.
 */
export function communityImageContentType(
  file: { type?: string | null; name?: string | null } | null | undefined,
): string | null {
  const declared = declaredType(file);
  if (COMMUNITY_IMAGE_TYPES.includes(declared)) return declared;
  const fromExtension = COMMUNITY_IMAGE_EXTENSIONS[fileExtension(file)];
  if (!declared && fromExtension) return fromExtension;
  return null;
}

/**
 * The problem with a picked group picture, or null when it is acceptable.
 * Pure, so the picker and the tests agree on exactly what is allowed — and it
 * matches the server rule (`assertUsableCover`), which re-checks the STORED
 * object because the browser's declared MIME type is never trusted.
 */
export function communityImageProblem(
  file: { type?: string | null; name?: string | null; size?: number | null } | null | undefined,
): string | null {
  if (!file) return "Choose an image file to use as the group picture.";
  if (!communityImageContentType(file)) return "Group pictures must be a PNG, JPG, GIF, WebP or AVIF image.";
  const size = typeof file.size === "number" ? file.size : 0;
  if (size > COMMUNITY_IMAGE_MAX_BYTES) return "Group pictures must be 5 MB or smaller.";
  return null;
}
