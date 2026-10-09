/**
 * Group-chat photo: validation, crop geometry and rendering.
 *
 * A group photo is stored as ONE square image in Convex file storage, so it can
 * be displayed identically at every size (the conversation list, the chat
 * header, the group panel) with a plain `object-fit: cover`. The crop is baked
 * into the uploaded file instead of being described by CSS coordinates, which
 * is what keeps the preview and the saved image identical everywhere.
 *
 * Two separate halves live here on purpose:
 *
 *   - PURE geometry/validation (no DOM at all) — `photoValidationError`,
 *     `coverGeometry`, `clampOffset`, `sourceSquare`. These are unit tested in
 *     `bun group-photo-test.mjs`, including the invariants that matter:
 *     the crop must ALWAYS stay inside the source image (never sample outside
 *     the bitmap, which would produce transparent/black edges) whatever zoom and
 *     offset the user drags to.
 *   - `renderGroupPhoto` — the browser-only canvas step. It uses exactly the
 *     same geometry functions as the on-screen preview, so what the user
 *     positions is what gets uploaded.
 */

/**
 * What the file picker offers. Covers the formats the requirement names (PNG,
 * JPG/JPEG, WebP) plus the two the server already accepts for images.
 */
export const GROUP_PHOTO_ACCEPT = "image/png,image/jpeg,image/webp,image/avif,image/gif";

/** Content types accepted for a group photo (must match the server list). */
export const GROUP_PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/avif", "image/gif"] as const;

/** Hard ceiling, mirroring the server-side check in `dms.setGroupPhoto`. */
export const GROUP_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Size of the stored square (512px covers every place a group icon is drawn,
 * including retina list rows, at a fraction of a raw photo's size).
 */
export const GROUP_PHOTO_DIMENSION = 512;

/** Zoom range for the crop stage: 1 = fill the square, 3 = three times closer. */
export const GROUP_PHOTO_MIN_ZOOM = 1;
export const GROUP_PHOTO_MAX_ZOOM = 3;

const IMAGE_TYPE_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jpe: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
};

/**
 * The content type to upload a file with.
 *
 * Some pickers hand back an empty `type` (notably for files dragged in on
 * Windows). Falling back to `application/octet-stream` — as the message
 * attachment path does — would have the server store a blob it can no longer
 * recognise as an image, so the extension is used instead. Returns null when
 * neither source identifies a supported image.
 */
export function photoContentType(file: { type?: string | null; name?: string | null }): string | null {
  const declared = (file.type ?? "").toLowerCase().trim();
  if (declared && (GROUP_PHOTO_TYPES as readonly string[]).includes(declared)) return declared;
  const name = (file.name ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  const extension = dot === -1 ? "" : name.slice(dot + 1);
  return IMAGE_TYPE_BY_EXTENSION[extension] ?? null;
}

/** Human-readable reason a file can't be used as a group photo, or null if it can. */
export function photoValidationError(file: { type?: string | null; name?: string | null; size?: number | null }): string | null {
  if (!file) return "Choose an image file.";
  const size = typeof file.size === "number" ? file.size : 0;
  if (size <= 0) return "That file looks empty — please choose another image.";
  if (size > GROUP_PHOTO_MAX_BYTES) return "Group photos must be 5 MB or smaller.";
  if (!photoContentType(file)) return "Group photos must be a PNG, JPG, JPEG, WebP, AVIF or GIF image.";
  return null;
}

/** Dimensions of the photo drawn inside a square of `size`, after cover + zoom. */
export type CoverGeometry = {
  /** Rendered width/height of the whole image, in stage pixels. */
  width: number;
  height: number;
  /** How far the image may be dragged from centre before an edge would show. */
  maxOffsetX: number;
  maxOffsetY: number;
};

/**
 * "Cover" geometry: the image is scaled so it fills the square completely (the
 * SHORTER side matches the square), then multiplied by `zoom`. A square image
 * therefore exactly fills the stage at zoom 1, and a portrait/landscape one
 * overflows on its long side — which is what makes repositioning meaningful.
 */
export function coverGeometry(naturalWidth: number, naturalHeight: number, size: number, zoom: number): CoverGeometry {
  // Guard against a broken/incomplete image: a zero or non-finite natural size
  // must not divide by zero and produce NaN coordinates.
  const w = Number.isFinite(naturalWidth) && naturalWidth > 0 ? naturalWidth : size;
  const h = Number.isFinite(naturalHeight) && naturalHeight > 0 ? naturalHeight : size;
  const side = Number.isFinite(size) && size > 0 ? size : GROUP_PHOTO_DIMENSION;
  const z = clampZoom(zoom);
  const scale = side / Math.min(w, h);
  const width = w * scale * z;
  const height = h * scale * z;
  return {
    width,
    height,
    maxOffsetX: Math.max(0, (width - side) / 2),
    maxOffsetY: Math.max(0, (height - side) / 2),
  };
}

/** Clamp a zoom value into the range the stage supports. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return GROUP_PHOTO_MIN_ZOOM;
  return Math.min(GROUP_PHOTO_MAX_ZOOM, Math.max(GROUP_PHOTO_MIN_ZOOM, zoom));
}

/** Keep a drag offset inside the image, so no empty edge can ever be shown. */
export function clampOffset(
  offset: { dx: number; dy: number },
  geometry: CoverGeometry,
): { dx: number; dy: number } {
  const dx = Number.isFinite(offset.dx) ? offset.dx : 0;
  const dy = Number.isFinite(offset.dy) ? offset.dy : 0;
  return {
    dx: Math.min(geometry.maxOffsetX, Math.max(-geometry.maxOffsetX, dx)),
    dy: Math.min(geometry.maxOffsetY, Math.max(-geometry.maxOffsetY, dy)),
  };
}

/** The square region of the ORIGINAL image that the visible stage shows. */
export function sourceSquare(
  naturalWidth: number,
  naturalHeight: number,
  size: number,
  zoom: number,
  offset: { dx: number; dy: number },
): { sx: number; sy: number; side: number } {
  const geometry = coverGeometry(naturalWidth, naturalHeight, size, zoom);
  const clamped = clampOffset(offset, geometry);
  const z = clampZoom(zoom);
  const w = Number.isFinite(naturalWidth) && naturalWidth > 0 ? naturalWidth : size;
  const h = Number.isFinite(naturalHeight) && naturalHeight > 0 ? naturalHeight : size;
  const side = Number.isFinite(size) && size > 0 ? size : GROUP_PHOTO_DIMENSION;
  const scale = (side / Math.min(w, h)) * z; // stage pixels per source pixel
  const visible = side / scale; // source pixels visible in the square
  // The stage centre maps to the image centre shifted by the (clamped) drag.
  const centreX = w / 2 - clamped.dx / scale;
  const centreY = h / 2 - clamped.dy / scale;
  const maxSx = Math.max(0, w - visible);
  const maxSy = Math.max(0, h - visible);
  return {
    sx: Math.min(maxSx, Math.max(0, centreX - visible / 2)),
    sy: Math.min(maxSy, Math.max(0, centreY - visible / 2)),
    side: visible,
  };
}

/** Format an upload/render failure for a toast. */
export function groupPhotoErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.trim() || fallback;
}

/** An image the editor has decoded: a local (blob) URL plus its natural size. */
export type DecodedImage = { url: string; width: number; height: number };

/**
 * Decode a local image URL and report its natural size.
 *
 * Uses an `<img>` element rather than `createImageBitmap` so it works in every
 * browser that can run the app (Safari included). The URL is a `blob:` URL for a
 * file the user just picked, so nothing leaves the device.
 */
export function decodeImage(url: string): Promise<DecodedImage> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      if (!width || !height) {
        reject(new Error("That image couldn't be read — try a different one."));
        return;
      }
      resolve({ url, width, height });
    };
    image.onerror = () => reject(new Error("That image couldn't be opened — try a different one."));
    image.src = url;
  });
}

/**
 * Draw the chosen square into a fresh 512x512 canvas and encode it for upload.
 *
 * Browser-only (the unit tests call only the pure functions above): it touches
 * `Image`, `canvas` and `toBlob`. The framing comes from `sourceSquare`, so the
 * saved image is exactly what the preview showed.
 */
export async function renderGroupPhoto(
  source: DecodedImage,
  options: { zoom: number; offset: { dx: number; dy: number }; dimension?: number },
): Promise<Blob> {
  const dimension = options.dimension ?? GROUP_PHOTO_DIMENSION;
  const image = await loadElement(source.url);
  const square = sourceSquare(source.width, source.height, dimension, options.zoom, options.offset);
  const canvas = document.createElement("canvas");
  canvas.width = dimension;
  canvas.height = dimension;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser couldn't prepare the image.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  // Flattened onto the app's panel colour first: a transparent PNG would
  // otherwise come through as black on some surfaces. JPEG has no alpha, so a
  // flatten is required for the fallback encoding either way.
  context.fillStyle = "#17171f";
  context.fillRect(0, 0, dimension, dimension);
  context.drawImage(image, square.sx, square.sy, square.side, square.side, 0, 0, dimension, dimension);
  const blob = (await toBlob(canvas, "image/webp", 0.92)) ?? (await toBlob(canvas, "image/jpeg", 0.92));
  if (!blob) throw new Error("That image couldn't be processed — try a different one.");
  return blob;
}

function loadElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("That image couldn't be opened — try a different one."));
    image.src = url;
  });
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, quality));
}
