/**
 * Message length limit and the Markdown subset Freecord messages are made of.
 *
 * Freecord stores a message as ONE plain-text string, so any formatting has to
 * live inside that string. Pasted rich text is converted to this Markdown
 * subset by `src/lib/paste-html.ts`, kept verbatim in the database, and turned
 * back into real formatting by the message renderer (`MentionText`).
 *
 * Everything here is pure (no DOM, no Convex) so the composer, the character
 * counter and the SERVER-side validation all share one definition and can never
 * drift apart. The backend imports `messageLength`/`MESSAGE_MAX_LENGTH` from
 * this file, which is why plain text pasted on one device renders identically
 * after a refresh and on every other device.
 */

/**
 * The maximum length of a single message, in characters (Unicode code points).
 * Shared by the composer, its character counter and the backend mutations.
 */
export const MESSAGE_MAX_LENGTH = 30_000;

/** The one wording used for an over-long message, on both client and server. */
export const MESSAGE_TOO_LONG = `Messages can be up to ${MESSAGE_MAX_LENGTH.toLocaleString("en-US")} characters.`;

/**
 * Count a message the same way everywhere.
 *
 * `String#length` counts UTF-16 code units, so a single emoji (`😀`) counts as
 * two. Counting CODE POINTS instead means one emoji is one character, and the
 * composer's counter, the send guard and the server mutation all agree on what
 * "30,000 characters" means for Unicode text.
 */
export function messageLength(text: string): number {
  if (!text) return 0;
  // `Array.from` iterates by code point, so surrogate pairs stay one character.
  return Array.from(text).length;
}

/** `12450` -> `"12,450"`, for the `12,450 / 30,000` counter. */
export function formatCharacterCount(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString("en-US");
}

/** True when a draft is past the maximum and must not be sent. */
export function isMessageTooLong(text: string): boolean {
  return messageLength(text) > MESSAGE_MAX_LENGTH;
}

// ---------------------------------------------------------------------------
// Markdown subset
// ---------------------------------------------------------------------------

export type InlineMark = "bold" | "italic" | "underline" | "strike" | "code";

export type InlineNode =
  /** Literal text, optionally carrying the marks of the span it sits inside. */
  | { kind: "text"; value: string; marks: InlineMark[] }
  /** A safe `http(s)` link, either written as `[label](url)` or as a bare URL. */
  | { kind: "link"; value: string; href: string; marks: InlineMark[] }
  /** An `@username` token; resolved to a real member by the renderer. */
  | { kind: "mention"; value: string; marks: InlineMark[] };

export type MessageBlock =
  | { kind: "paragraph"; nodes: InlineNode[] }
  | { kind: "heading"; level: 1 | 2 | 3; nodes: InlineNode[] }
  | { kind: "quote"; nodes: InlineNode[] }
  | { kind: "code"; value: string }
  | { kind: "list"; ordered: boolean; items: InlineNode[][] };

/** Formatting markers, longest first so `**` always beats `*`. */
const DELIMITERS: { token: string; mark: InlineMark }[] = [
  { token: "**", mark: "bold" },
  { token: "__", mark: "underline" },
  { token: "~~", mark: "strike" },
  { token: "*", mark: "italic" },
  { token: "_", mark: "italic" },
];

// Punctuation that commonly trails a URL but is not part of it.
const TRAILING_PUNCT = /[.,!?;:)\]}>"']+$/;
// Sticky (`y`) so a match may only start at `lastIndex`, and so a 30,000-char
// message never has to be sliced once per character while parsing.
const URL_AT = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/iy;
const MENTION_AT = /@[a-z0-9._]{2,24}/iy;
const LINK_AT = /\[([^\]\n]*)\]\(\s*([^)\s]+)\s*\)/y;

/** `exec` a sticky pattern at exactly `index`. */
function matchAt(pattern: RegExp, text: string, index: number): RegExpExecArray | null {
  pattern.lastIndex = index;
  return pattern.exec(text);
}

/** `www.example.com` -> `https://www.example.com`; unsafe schemes -> null. */
export function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (/^www\./i.test(url)) return `https://${url}`;
  // Anything else (javascript:, data:, mailto:, file:…) is never linkified.
  return null;
}

/** Link labels are shown as plain text, so drop any stray markup inside them. */
function linkLabel(raw: string): string {
  return raw.replace(/[*_~`]/g, "").trim();
}

/**
 * Find a closing delimiter that can actually close a span: never preceded by
 * whitespace, and for `_` never followed by a word character (so `snake_case`
 * is left alone).
 */
function findClose(text: string, from: number, token: string): number {
  let index = text.indexOf(token, from);
  while (index >= 0) {
    const before = text[index - 1];
    const after = text[index + token.length] ?? "";
    const canClose = Boolean(before) && !/\s/.test(before) && (token !== "_" || !/[A-Za-z0-9]/.test(after));
    if (canClose) return index;
    index = text.indexOf(token, index + 1);
  }
  return -1;
}

/**
 * Parse one line (or paragraph) of message text into inline nodes.
 *
 * Recognises the Discord-style marker set — `**bold**`, `*italic*`/`_italic_`,
 * `__underline__`, `~~strikethrough~~`, `` `code` ``, `[label](url)` — plus
 * bare `http(s)` URLs and `@mentions`. Unclosed or mid-word markers are left as
 * literal text rather than swallowing the rest of the message.
 */
export function parseInline(text: string, marks: InlineMark[] = []): InlineNode[] {
  const out: InlineNode[] = [];
  let buffer = "";
  let index = 0;

  const flush = () => {
    if (buffer) {
      out.push({ kind: "text", value: buffer, marks });
      buffer = "";
    }
  };

  while (index < text.length) {
    const previous = index > 0 ? text[index - 1] : "";

    // Inline code: its contents are never interpreted as markup.
    if (text[index] === "`") {
      const end = text.indexOf("`", index + 1);
      if (end > index + 1) {
        flush();
        out.push({ kind: "text", value: text.slice(index + 1, end), marks: [...marks, "code"] });
        index = end + 1;
        continue;
      }
    }

    // [label](url) — the label is plain text, the URL must be http(s).
    if (text[index] === "[") {
      const match = matchAt(LINK_AT, text, index);
      const href = match ? safeHref(match[2]) : null;
      if (match && href && linkLabel(match[1])) {
        flush();
        out.push({ kind: "link", value: linkLabel(match[1]), href, marks });
        index += match[0].length;
        continue;
      }
    }

    // Formatting markers.
    let marked = false;
    for (const { token, mark } of DELIMITERS) {
      if (!text.startsWith(token, index)) continue;
      const afterOpen = text[index + token.length];
      // An opener must be followed by non-space content…
      if (!afterOpen || /\s/.test(afterOpen)) break;
      // …and `_` must not start mid-word, so `snake_case` stays literal.
      if (token === "_" && /[A-Za-z0-9]/.test(previous)) break;
      const close = findClose(text, index + token.length, token);
      if (close < 0) break;
      const inner = text.slice(index + token.length, close);
      if (!inner) break;
      flush();
      out.push(...parseInline(inner, [...marks, mark]));
      index = close + token.length;
      marked = true;
      break;
    }
    if (marked) continue;

    // Bare URLs and @mentions.
    const url = matchAt(URL_AT, text, index);
    if (url) {
      const trailing = TRAILING_PUNCT.exec(url[1])?.[0] ?? "";
      const value = trailing ? url[1].slice(0, -trailing.length) : url[1];
      if (value) {
        flush();
        out.push({ kind: "link", value, href: safeHref(value) ?? value, marks });
        index += value.length;
        continue;
      }
    }
    const mention = matchAt(MENTION_AT, text, index);
    if (mention) {
      flush();
      out.push({ kind: "mention", value: mention[0], marks });
      index += mention[0].length;
      continue;
    }

    buffer += text[index];
    index += 1;
  }

  flush();
  return out;
}

const HEADING = /^(#{1,3})\s+(.*)$/;
const QUOTE = /^\s*>\s?/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d{1,9}[.)]\s+(.*)$/;

/**
 * Split a message body into blocks (paragraphs, headings, quotes, lists and
 * fenced code) whose text is then parsed into inline formatting.
 *
 * Line breaks and blank lines survive: consecutive non-empty lines form one
 * paragraph whose `\n`s are preserved (the renderer uses `white-space: pre-wrap`),
 * and a blank line starts a new paragraph.
 */
export function parseMessageBody(body: string): MessageBlock[] {
  const text = String(body ?? "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
  const lines = text.split("\n");
  const blocks: MessageBlock[] = [];
  const paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", nodes: parseInline(paragraph.join("\n")) });
    paragraph.length = 0;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block: rendered verbatim, never parsed as markup.
    if (/^\s*```/.test(line)) {
      flushParagraph();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // past the closing fence (or the end of the message)
      blocks.push({ kind: "code", value: body.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2 | 3,
        nodes: parseInline(heading[2].trim()),
      });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      flushParagraph();
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        quoted.push(lines[i].replace(QUOTE, ""));
        i += 1;
      }
      blocks.push({ kind: "quote", nodes: parseInline(quoted.join("\n")) });
      continue;
    }

    const bullet = BULLET.test(line);
    const ordered = ORDERED.test(line);
    if (bullet || ordered) {
      flushParagraph();
      const items: InlineNode[][] = [];
      const isOrdered = ordered;
      while (i < lines.length) {
        const item = (isOrdered ? ORDERED : BULLET).exec(lines[i]);
        if (item) {
          items.push(parseInline(item[1]));
          i += 1;
          continue;
        }
        // A wrapped/indented continuation line belongs to the current item.
        if (/^\s+\S/.test(lines[i]) && items.length > 0 && !BULLET.test(lines[i]) && !ORDERED.test(lines[i])) {
          const last = items[items.length - 1];
          const tail = parseInline(lines[i].trim());
          items[items.length - 1] = [...last, { kind: "text", value: "\n", marks: [] }, ...tail];
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({ kind: "list", ordered: isOrdered, items });
      continue;
    }

    paragraph.push(line);
    i += 1;
  }

  flushParagraph();
  return blocks;
}

/**
 * A one-line, formatting-free summary of a message (reply quotes, previews).
 * Never throws, never returns markup.
 */
export function plainSummary(body: string, max = 140): string {
  const text = String(body ?? "")
    .replace(/\r\n?/g, " ")
    .replace(/\n+/g, " ")
    // Only the MARKERS are removed; a stray `*` or `#` in real text stays.
    .replace(/\[([^\]\n]*)\]\(https?:\/\/[^)\s]+\)/g, "$1")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*#{1,3}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
