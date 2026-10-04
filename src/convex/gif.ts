import { ConvexError, v, type Infer } from "convex/values";

/**
 * GIF messages.
 *
 * A GIF message only ever stores a small, provider-owned record — never a copy
 * of the bytes. Only GIPHY is supported, and only GIPHY-owned media hosts are
 * accepted, so a client can never make a message render an arbitrary URL
 * (`javascript:`, `data:`, a lookalike domain, an HTML/script payload…).
 *
 * The client receives these values from our own `gifs.search` action, but they
 * are re-validated here before anything is written, because the client is never
 * trusted.
 */
export const gifValidator = v.object({
  provider: v.literal("giphy"),
  id: v.string(),
  /** Full (still animated) GIF, used for the inline message and the viewer. */
  url: v.string(),
  /** Small preview/thumbnail GIF, used for the picker grid and pending preview. */
  previewUrl: v.string(),
  title: v.optional(v.string()),
  width: v.number(),
  height: v.number(),
});
export type GifValue = Infer<typeof gifValidator>;

// https + a genuine giphy.com host (or subdomain). Anything else — http, data:,
// javascript:, lookalike domains, embedded quotes/brackets — is rejected.
// Note: `evil-giphy.com` fails because the suffix must be exactly `.giphy.com`.
const GIPHY_MEDIA_URL = /^https:\/\/(?:[a-z0-9-]+\.)*giphy\.com\/[^\s"'<>\\]{1,500}$/i;
const GIPHY_ID = /^[A-Za-z0-9_-]{2,64}$/;

function safeMediaUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  if (!GIPHY_MEDIA_URL.test(value)) return null;
  return value;
}

/** Plain-text title: strips control characters and caps the length. */
function safeTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    // Never allow markup characters through, even though the renderer escapes
    // text — the title is never treated as HTML anywhere.
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return clean || undefined;
}

/** Validate + normalize a GIF record. Returns null when anything is untrusted. */
export function sanitizeGif(raw: unknown): GifValue | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.provider !== "giphy") return null;
  if (typeof r.id !== "string" || !GIPHY_ID.test(r.id)) return null;
  const url = safeMediaUrl(r.url);
  const previewUrl = safeMediaUrl(r.previewUrl);
  if (!url || !previewUrl) return null;
  const width = Math.round(Number(r.width));
  const height = Math.round(Number(r.height));
  if (
    !Number.isFinite(width) || !Number.isFinite(height) ||
    width < 1 || height < 1 || width > 2000 || height > 2000
  ) {
    return null;
  }
  return { provider: "giphy", id: r.id, url, previewUrl, title: safeTitle(r.title), width, height };
}

/** Throw when a client-supplied GIF cannot be trusted. */
export function requireGif(raw: unknown): GifValue {
  const gif = sanitizeGif(raw);
  if (!gif) throw new ConvexError("That GIF can't be sent.");
  return gif;
}

/** Map a GIPHY API object to our validated record (or null when unusable). */
export function normalizeGiphy(doc: unknown): GifValue | null {
  if (!doc || typeof doc !== "object") return null;
  const d = doc as Record<string, unknown>;
  const images = (d.images && typeof d.images === "object" ? d.images : {}) as Record<string, { url?: string; width?: number; height?: number }>;
  const pick = (key: string): { url?: string; width?: number; height?: number } => images[key] ?? {};
  const full = pick("downsized").url ? pick("downsized") : pick("original").url ? pick("original") : pick("fixed_height");
  const preview = pick("fixed_height_small").url ? pick("fixed_height_small") : pick("preview_gif").url ? pick("preview_gif") : full;
  const dim = pick("fixed_height").height ? pick("fixed_height") : full;
  return sanitizeGif({
    provider: "giphy",
    id: d.id,
    url: full.url,
    previewUrl: preview.url ?? full.url,
    title: d.title,
    width: Number(dim.width) || 200,
    height: Number(dim.height) || 200,
  });
}
