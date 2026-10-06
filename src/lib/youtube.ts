/**
 * YouTube link detection.
 *
 * FreeBuff never downloads or re-hosts video files. We only recognise a
 * YouTube link already present in a message and render YouTube's own embed,
 * so a multi-hour video costs FreeBuff no storage at all.
 */

export type YouTubeRef = { id: string; start?: number };

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Parse a URL into a YouTube reference, or null if it isn't a YouTube video. */
export function parseYouTubeUrl(raw: string): YouTubeRef | null {
  const trimmed = raw.trim().replace(/[.,;:!?]+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^(www|m|music)\./, "").toLowerCase();
  if (host !== "youtube.com" && host !== "youtu.be" && host !== "youtube-nocookie.com") return null;

  let id = "";
  const parts = url.pathname.split("/").filter(Boolean);
  if (host === "youtu.be") id = parts[0] ?? "";
  else if (url.pathname === "/watch") id = url.searchParams.get("v") ?? "";
  else if (["shorts", "embed", "live", "v"].includes(parts[0] ?? "")) id = parts[1] ?? "";
  id = (id || "").split(/[?&#]/)[0];

  if (!ID_RE.test(id)) return null;

  const t = url.searchParams.get("t") ?? url.searchParams.get("start") ?? "";
  let start: number | undefined;
  if (t) {
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
    if (m && (m[1] || m[2] || m[3])) {
      start = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
    } else if (/^\d+$/.test(t)) {
      start = Number(t);
    }
  }
  return { id, start };
}

const URL_IN_TEXT = /https?:\/\/[^\s<>()[\]"']+/gi;

/** Every distinct YouTube video linked in a message body, in order. */
export function youtubeLinksIn(text: string): { url: string; ref: YouTubeRef }[] {
  const out: { url: string; ref: YouTubeRef }[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const url = match[0];
    const ref = parseYouTubeUrl(url);
    if (!ref || seen.has(ref.id)) continue;
    seen.add(ref.id);
    out.push({ url, ref });
  }
  return out;
}

export function youtubeThumbnail(id: string) {
  return `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
}

export function youtubeWatchUrl(id: string, start?: number) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}${start ? `&t=${start}s` : ""}`;
}

/** Privacy-enhanced embed (youtube-nocookie) with minimal, clean controls. */
export function youtubeEmbedUrl(id: string, start?: number, autoplay = true) {
  const params = new URLSearchParams({ rel: "0", modestbranding: "1", playsinline: "1" });
  if (autoplay) params.set("autoplay", "1");
  if (start) params.set("start", String(start));
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?${params.toString()}`;
}
