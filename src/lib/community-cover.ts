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
 * `community-cover-test.mjs`) so the card, and any future surface, agree on
 * exactly when a real uploaded cover is shown versus the placeholder.
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
