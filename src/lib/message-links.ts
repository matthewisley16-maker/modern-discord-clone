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
