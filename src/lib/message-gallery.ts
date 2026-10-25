/**
 * Shared rules for grouping a message's image attachments into one gallery.
 *
 * Dependency-free so the same logic is used by the DM renderer, the channel
 * renderer and the unit tests — the preview grid, the "+N more" count and the
 * lightbox navigation can never disagree about how many images a message has.
 */

export type GalleryAsset = {
  _id: string;
  name: string;
  contentType: string;
  url: string | null;
  /** Bytes, shown by the audio/file chips. Optional so tests can stay terse. */
  size?: number;
};

/** How many thumbnails the compact preview grid shows before the "+N more" overlay. */
export const GALLERY_PREVIEW_LIMIT = 4;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;

/**
 * True for a usable image attachment. `url` is required: a storage object that
 * has gone missing (or was never resolved) must not produce a broken tile.
 */
export function isGalleryImage(asset: GalleryAsset | null | undefined): boolean {
  if (!asset || typeof asset.url !== "string" || asset.url.length === 0) return false;
  const type = typeof asset.contentType === "string" ? asset.contentType : "";
  if (/^image\/(?!svg)/i.test(type)) return true;
  return IMAGE_EXT.test(typeof asset.name === "string" ? asset.name : "");
}

/**
 * Split one message's attachments into the images that belong in the gallery
 * and everything else (audio players, file chips), which keeps its existing
 * rendering. Malformed/null entries are ignored rather than crashing a message.
 */
export function splitMessageAttachments<T extends GalleryAsset>(
  attachments: readonly T[] | null | undefined,
): { images: T[]; files: T[] } {
  const all = (Array.isArray(attachments) ? attachments : []).filter(
    (a): a is T => Boolean(a) && typeof a === "object",
  );
  const images: T[] = [];
  const files: T[] = [];
  for (const asset of all) {
    if (isGalleryImage(asset)) images.push(asset);
    else files.push(asset);
  }
  return { images, files };
}

/** Number of thumbnails actually drawn in the compact preview. */
export function galleryPreviewCount(total: number): number {
  const n = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
  return Math.min(n, GALLERY_PREVIEW_LIMIT);
}

/** How many images the "+N more" overlay stands for (0 when none are hidden). */
export function galleryOverflowCount(total: number): number {
  const n = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
  return n > GALLERY_PREVIEW_LIMIT ? n - GALLERY_PREVIEW_LIMIT : 0;
}

/** "+5 more" / "" when every image is already visible. */
export function galleryOverflowLabel(total: number): string {
  const hidden = galleryOverflowCount(total);
  return hidden > 0 ? `+${hidden} more` : "";
}

/** Grid shape for a given number of images — one image keeps the old preview. */
export function galleryLayout(total: number): "single" | "pair" | "triple" | "quad" {
  const n = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
  if (n <= 1) return "single";
  if (n === 2) return "pair";
  if (n === 3) return "triple";
  return "quad";
}

/** Clamp an index into 0…total-1 (0 for an empty gallery). */
export function clampGalleryIndex(index: number, total: number): number {
  const n = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
  if (n === 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), n - 1);
}

/** Wrap-around Previous/Next navigation. */
export function stepGalleryIndex(index: number, delta: number, total: number): number {
  const n = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
  if (n === 0) return 0;
  const base = clampGalleryIndex(index, n);
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  return ((base + step) % n + n) % n;
}

/** "3 of 8" counter shown in the viewer. */
export function galleryCounter(index: number, total: number): string {
  const n = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
  if (n === 0) return "0 of 0";
  return `${clampGalleryIndex(index, n) + 1} of ${n}`;
}
