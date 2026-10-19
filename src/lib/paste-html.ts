/**
 * Clipboard → message text.
 *
 * Freecord never inserts pasted HTML into the page. Everything a browser puts
 * on the clipboard is converted here into the plain-text Markdown subset that
 * `src/lib/message-format.ts` understands. The converted string is what the
 * composer holds, what the backend stores, and what every device re-renders —
 * so a pasted `<script>`, `onerror=`, `javascript:` link or Word/Google-Docs
 * boilerplate can never execute, and the formatting survives a refresh.
 *
 * Pure and DOM-free (its own tiny HTML tokenizer), so it runs identically in
 * the browser and under `bun paste-html-test.mjs`.
 */

import { safeHref } from "./message-format";

type HtmlNode =
  | { kind: "element"; tag: string; attrs: string; children: HtmlNode[] }
  | { kind: "text"; value: string };

/** Elements whose CONTENT is dropped entirely (never markup, never scripts). */
const DROP_CONTENT = new Set([
  "script", "style", "head", "title", "noscript", "template", "svg", "math",
  "iframe", "object", "embed", "canvas", "form", "button", "select", "option",
  "textarea", "input", "audio", "video", "map", "colgroup", "col",
]);

/** Elements that never have children. */
const VOID_TAGS = new Set([
  "br", "hr", "img", "wbr", "meta", "link", "source", "track", "area", "base",
  "embed", "param", "input", "col",
]);

// Elements that end the current line/paragraph when they open and close.
const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "header", "footer", "main", "aside",
  "nav", "figure", "figcaption", "address", "center", "fieldset", "dl", "dt",
  "dd", "table", "thead", "tbody", "tfoot", "tr", "caption", "details",
  "summary", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
  "blockquote", "pre", "hr",
]);

const TOKEN = /<!--[\s\S]*?-->|<![^>]*>|<[^>]*>|[^<]+/g;

// Named entities that actually show up in pasted content.
const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…", copy: "©", reg: "®", trade: "™",
  laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  bull: "•", middot: "·", deg: "°", times: "×", divide: "÷", euro: "€",
  pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶", dagger: "†",
  plusmn: "±", frac12: "½", frac14: "¼", frac34: "¾", sup2: "²", sup3: "³",
  micro: "µ", shy: "", zwnj: "", zwj: "", lrm: "", rlm: "",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      // A numeric entity in the surrogate range (`&#xD83D;`) would produce HALF
      // of an emoji. That lone surrogate is not valid Unicode, and storing it
      // makes every query that returns the message fail to serialize — so the
      // entity is left as literal text instead.
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

function readAttribute(attrs: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs);
  if (!match) return null;
  return decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
}

/** A style declaration, e.g. `font-weight:normal`. Word/Docs set these on <b>. */
function declares(attrs: string, property: string, value: string): boolean {
  const style = readAttribute(attrs, "style");
  if (!style) return false;
  return new RegExp(`${property}\\s*:\\s*${value}`, "i").test(style);
}

/**
 * Tokenize HTML into a shallow tree. Malformed markup never throws: an
 * unmatched close tag is ignored, and any element left open at the end is
 * simply closed.
 */
export function parseHtml(html: string): HtmlNode[] {
  const root: HtmlNode[] = [];
  const stack: { tag: string; children: HtmlNode[] }[] = [];
  const current = () => (stack.length > 0 ? stack[stack.length - 1].children : root);

  const push = (node: HtmlNode) => current().push(node);

  for (const token of html.match(TOKEN) ?? []) {
    if (token.startsWith("<!--") || token.startsWith("<!")) continue;

    if (token.startsWith("</")) {
      const tag = /^<\/\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(token)?.[1]?.toLowerCase();
      if (!tag) continue;
      // Close the nearest matching open element (tolerate unbalanced tags).
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    if (token.startsWith("<")) {
      const name = /^<\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(token)?.[1]?.toLowerCase();
      if (!name) continue;
      const attrs = token.slice(1 + name.length, -1);
      const selfClosing = /\/\s*>$/.test(token) || VOID_TAGS.has(name);
      if (DROP_CONTENT.has(name)) {
        // Push a marker so everything inside is skipped by the renderer.
        const children: HtmlNode[] = [];
        push({ kind: "element", tag: name, attrs, children });
        if (!selfClosing) stack.push({ tag: name, children });
        continue;
      }
      if (selfClosing) {
        push({ kind: "element", tag: name, attrs, children: [] });
        continue;
      }
      const children: HtmlNode[] = [];
      push({ kind: "element", tag: name, attrs, children });
      stack.push({ tag: name, children });
      continue;
    }

    push({ kind: "text", value: token });
  }

  return root;
}

/** Wrap text in a markdown marker, keeping any surrounding whitespace outside. */
function wrap(inner: string, marker: string): string {
  if (!inner.trim()) return inner;
  const lead = /^\s*/.exec(inner)?.[0] ?? "";
  const trail = /\s*$/.exec(inner)?.[0] ?? "";
  const core = inner.slice(lead.length, inner.length - trail.length);
  if (!core) return inner;
  return `${lead}${marker}${core}${marker}${trail}`;
}

/** HTML collapses runs of whitespace; `<br>` and block tags are what break lines. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ");
}

function renderNodes(nodes: HtmlNode[], preserve = false): string {
  return nodes.map((node) => renderNode(node, preserve)).join("");
}

function renderNode(node: HtmlNode, preserve = false): string {
  // HTML collapses whitespace, but a <pre> block keeps it verbatim.
  if (node.kind === "text") {
    const decoded = decodeEntities(node.value);
    return preserve ? decoded : collapse(decoded);
  }

  const tag = node.tag;
  if (DROP_CONTENT.has(tag)) return "";
  if (VOID_TAGS.has(tag) && tag !== "br" && tag !== "hr" && tag !== "img") return "";

  const inner = renderChildren(node, preserve);

  switch (tag) {
    case "br":
      return "\n";
    case "hr":
      return "\n\n---\n\n";
    case "img": {
      // Never embed a remote image; keep the destination as plain text at most.
      const src = readAttribute(node.attrs, "src");
      const alt = readAttribute(node.attrs, "alt");
      const href = src ? safeHref(src) : null;
      return collapse(href ?? alt ?? "");
    }
    case "h1": case "h2": case "h3":
    case "h4": case "h5": case "h6": {
      const level = Math.min(3, Number(tag[1]));
      const body = inner.replace(/\s+/g, " ").trim();
      if (!body) return "";
      return `\n\n${"#".repeat(level)} ${body}\n\n`;
    }
    case "strong": case "b":
      // Google Docs/Word wrap everything in <b style="font-weight:normal">.
      if (declares(node.attrs, "font-weight", "normal")) return inner;
      return wrap(inner, "**");
    case "em": case "i":
      if (declares(node.attrs, "font-style", "normal")) return inner;
      return wrap(inner, "*");
    case "u": case "ins":
      if (declares(node.attrs, "text-decoration", "none")) return inner;
      return wrap(inner, "__");
    case "s": case "strike": case "del":
      if (declares(node.attrs, "text-decoration", "none")) return inner;
      return wrap(inner, "~~");
    case "code": case "kbd": case "samp": case "tt": {
      // Inside a <pre>, the fence already marks the code: no extra backticks.
      if (preserve) return inner;
      return wrap(inner.replace(/`/g, "'"), "`");
    }
    case "pre": {
      // Browsers ignore a single newline immediately after <pre>, so drop it.
      const body = renderNodes(node.children, true).replace(/^\n/, "").replace(/\n+$/, "");
      if (!body.trim()) return "";
      return `\n\n\`\`\`\n${body}\n\`\`\`\n\n`;
    }
    case "a": {
      const href = readAttribute(node.attrs, "href");
      const url = href ? safeHref(href) : null;
      const label = inner.replace(/\s+/g, " ").trim();
      if (!url) return label;
      if (!label) return url;
      // A bare URL keeps its own text; a real label becomes a markdown link.
      return label === url || label === href ? url : `[${label.replace(/\[/g, "").replace(/\]/g, "")}](${url})`;
    }
    case "blockquote": {
      const body = inner.replace(/^\n+|\n+$/g, "").replace(/\s+$/gm, "");
      if (!body.trim()) return "";
      const quoted = body.split("\n").map((line) => `> ${line.trim()}`.trimEnd()).join("\n");
      return `\n\n${quoted}\n\n`;
    }
    case "ul": case "ol": case "menu": {
      const items = node.children
        .filter((child): child is Extract<HtmlNode, { kind: "element" }> => child.kind === "element" && child.tag === "li")
        .map((child, index) => {
          const body = renderNodes(child.children).replace(/\s+/g, " ").trim();
          if (!body) return "";
          return `${tag === "ol" ? `${index + 1}.` : "-"} ${body}`;
        })
        .filter(Boolean);
      if (items.length === 0) return "";
      return `\n\n${items.join("\n")}\n\n`;
    }
    case "li":
      return inner;
    case "td": case "th": {
      const body = inner.replace(/\s+/g, " ").trim();
      return body ? ` ${body} |` : "";
    }
    case "tr":
      return `\n|${renderChildren(node)}`;
    case "table": {
      const body = inner.replace(/^\n+|\n+$/g, "").replace(/[ \t]+\n/g, "\n");
      if (!body.trim()) return "";
      return `\n\n${body}\n\n`;
    }
    default:
      if (BLOCK_TAGS.has(tag)) {
        const body = inner.replace(/^\n+|\n+$/g, "");
        if (!body.trim()) return "";
        return `\n\n${body}\n\n`;
      }
      return inner;
  }
}

function renderChildren(node: Extract<HtmlNode, { kind: "element" }>, preserve = false): string {
  return renderNodes(node.children, preserve);
}

/**
 * Final tidy pass: no stray nbsp, no trailing spaces, at most one blank line
 * between paragraphs (pastes from Word/Docs arrive full of nested empty
 * paragraphs), and no leading/trailing blank lines.
 */
const FENCED = /(```[\s\S]*?```)/g;

function tidy(text: string): string {
  // Fenced code keeps its indentation EXACTLY, so each fence is set aside and
  // put back untouched while only the surrounding text is cleaned up.
  const cleaned = text
    .split(FENCED)
    .map((part) =>
      part.startsWith("```")
        ? part
        : part
            .replace(/\u00a0/g, " ")
            .replace(/\u200b|\ufeff/g, "")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/[ \t]{2,}/g, " ")
            .replace(/\n{3,}/g, "\n\n"),
    )
    .join("");
  // Blank space at the very start/end of the message is dropped (a fence never
  // begins or ends with whitespace, so its contents are never touched).
  return cleaned.replace(/^\s+/, "").replace(/\s+$/, "");
}

/** How many content lines a string has (used to spot lost line breaks). */
function contentLines(text: string): number {
  return text.split("\n").filter((line) => line.trim() !== "").length;
}

/** Convert a clipboard `text/html` payload into the Freecord Markdown subset. */
export function htmlToMarkdown(html: string): string {
  if (!html) return "";
  if (html.length > 2_000_000) return ""; // refuse an absurd payload; plain text is used
  try {
    return tidy(renderNodes(parseHtml(html)));
  } catch {
    return "";
  }
}

/**
 * Clean a clipboard `text/plain` payload: normalise line endings, drop the
 * zero-width characters word processors sneak in, and keep every paragraph
 * break and indentation the user copied.
 */
export function normalizePlainText(text: string): string {
  if (!text) return "";
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\u200b|\ufeff/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The text a paste should insert: the rich clipboard flavour when the browser
 * provides one (so bold/links/lists survive), otherwise the plain flavour with
 * its line breaks intact. Never returns HTML.
 */
export function pastedMarkdown(data: { html?: string | null; text?: string | null }): string {
  const plain = normalizePlainText(data.text ?? "");
  const fromHtml = htmlToMarkdown(data.html ?? "");
  if (!fromHtml) return plain;
  if (!plain) return fromHtml;
  // Some sources put a bare, newline-carrying text node on the clipboard as
  // `text/html`; converting it as HTML collapses those line breaks into one
  // line. The plain flavour is what the browser actually RENDERS, so when the
  // HTML conversion collapsed everything the plain flavour describes, the line
  // structure lives in the plain text and that is what we keep.
  if (contentLines(fromHtml) <= 1 && contentLines(plain) > 1) return plain;
  return fromHtml;
}
