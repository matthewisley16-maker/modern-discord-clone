/**
 * Pure, dependency-free tokenizer for message bodies.
 *
 * Splits a message into plain text, `@mentions` and safe web links. Used by the
 * renderer (`MentionText`) and directly unit-tested, so link/mention behaviour
 * stays consistent everywhere messages are shown (channels, DMs, replies…).
 *
 * Only `http:`/`https:` URLs (including bare `www.` hosts) are recognised.
 * Dangerous schemes such as `javascript:` are never matched and remain inert
 * plain text.
 */

export type Segment =
  | { kind: "text"; value: string }
  | { kind: "url"; value: string; href: string }
  | { kind: "mention"; value: string };

const TOKEN = /(https?:\/\/[^\s<]+|www\.[^\s<]+)|(@[a-z0-9._]{2,24})/gi;
// Punctuation that commonly trails a URL but is not part of it.
const TRAILING = /[.,!?;:)\]}>"']+$/;

// A direct link to an animated image, e.g. https://site/a.gif or .../a.gif?x=1.
const GIF_LINK = /\.gif(?:[?#][^\s]*)?$/i;

/**
 * Direct animated-image (`.gif`) links inside a message, de-duplicated.
 *
 * These can be rendered inline as real animated GIFs with no provider or API
 * key involved. Only `http(s)` links ending in `.gif` qualify, so a page URL
 * (like a provider's share page) is never embedded or navigated to.
 */
export function gifUrlsIn(body: string): string[] {
  const out: string[] = [];
  for (const seg of splitMessageBody(body)) {
    if (seg.kind !== "url") continue;
    if (!GIF_LINK.test(seg.href)) continue;
    if (!out.includes(seg.href)) out.push(seg.href);
  }
  return out.slice(0, 4); // never let one message explode into dozens of GIFs
}

export function splitMessageBody(body: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const match of body.matchAll(TOKEN)) {
    const idx = match.index ?? 0;
    if (idx > last) out.push({ kind: "text", value: body.slice(last, idx) });

    if (match[1]) {
      const trailing = TRAILING.exec(match[1])?.[0] ?? "";
      const url = trailing ? match[1].slice(0, -trailing.length) : match[1];
      if (url) {
        const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
        out.push({ kind: "url", value: url, href });
      }
      if (trailing) out.push({ kind: "text", value: trailing });
    } else if (match[2]) {
      out.push({ kind: "mention", value: match[2] });
    }
    last = idx + match[0].length;
  }
  if (last < body.length) out.push({ kind: "text", value: body.slice(last) });
  return out;
}
