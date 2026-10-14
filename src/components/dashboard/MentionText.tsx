import { useMemo } from "react";
import type { ReactNode } from "react";
import {
  parseMessageBody,
  type InlineMark,
  type InlineNode,
  type MessageBlock,
} from "@/lib/message-format";

export type MentionRef = { username: string; userId: string };

/** Wrap a run of text in the formatting markers it carries. */
function Marked({ marks, children }: { marks: InlineMark[]; children: ReactNode }) {
  let node: ReactNode = children;
  // Applied innermost-first so nested marks (bold + italic) compose.
  for (const mark of marks) {
    if (mark === "bold") node = <strong className="fc-md-bold">{node}</strong>;
    else if (mark === "italic") node = <em className="fc-md-italic">{node}</em>;
    else if (mark === "underline") node = <u className="fc-md-underline">{node}</u>;
    else if (mark === "strike") node = <s className="fc-md-strike">{node}</s>;
    else node = <code className="fc-md-inline-code">{node}</code>;
  }
  return <>{node}</>;
}

function renderInline(
  nodes: InlineNode[],
  mentions: Map<string, string>,
  onOpenProfile: (userId: string) => void,
): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.kind === "text") {
      return (
        <Marked key={index} marks={node.marks}>
          {node.value}
        </Marked>
      );
    }
    if (node.kind === "link") {
      return (
        <Marked key={index} marks={node.marks}>
          <a
            className="fc-link"
            href={node.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            onClick={(e) => e.stopPropagation()}
          >
            {node.value}
          </a>
        </Marked>
      );
    }
    const userId = mentions.get(node.value.slice(1).toLowerCase());
    return (
      <Marked key={index} marks={node.marks}>
        {userId ? (
          <button
            type="button"
            className="fc-mention fc-mention-link"
            onClick={(e) => { e.stopPropagation(); onOpenProfile(userId); }}
            title={`View ${node.value.slice(1)}'s profile`}
          >
            {node.value}
          </button>
        ) : (
          <span className="fc-mention">{node.value}</span>
        )}
      </Marked>
    );
  });
}

/**
 * Renders a message body.
 *
 * Real `@username` mentions become bright, clickable profile buttons, web URLs
 * become safe links that open in a new tab, and the formatting Freecord stores
 * (paragraph breaks, `**bold**`, `*italic*`, `__underline__`, `~~strike~~`,
 * `` `code` ``, lists, quotes, headings and fenced code) is rendered as real
 * elements. Everything else stays plain, escaped text.
 *
 * The parsing itself lives in the unit-tested, dependency-free
 * `src/lib/message-format.ts`, so channels, DMs, group chats and replies all
 * render identically — and pasted rich text looks the same on every device.
 */
export default function MentionText({
  body,
  mentions,
  onOpenProfile,
  className,
}: {
  body: string;
  mentions?: MentionRef[];
  onOpenProfile: (userId: string) => void;
  className?: string;
}) {
  const mentionMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const ref of mentions ?? []) map.set(ref.username.toLowerCase(), ref.userId);
    return map;
  }, [mentions]);

  const blocks = useMemo(() => parseMessageBody(body), [body]);

  const rendered = useMemo(() => blocks.map((block: MessageBlock, index: number) => {
    if (block.kind === "code") {
      return (
        <pre key={index} className="fc-md-pre">
          <code>{block.value}</code>
        </pre>
      );
    }
    if (block.kind === "list") {
      const items = block.items.map((item, itemIndex) => (
        <li key={itemIndex}>{renderInline(item, mentionMap, onOpenProfile)}</li>
      ));
      return block.ordered
        ? <ol key={index} className="fc-md-list">{items}</ol>
        : <ul key={index} className="fc-md-list">{items}</ul>;
    }
    const inline = renderInline(block.nodes, mentionMap, onOpenProfile);
    if (block.kind === "heading") {
      return <p key={index} className={`fc-md-heading fc-md-h${block.level}`}>{inline}</p>;
    }
    if (block.kind === "quote") {
      return <blockquote key={index} className="fc-md-quote">{inline}</blockquote>;
    }
    return <p key={index} className="fc-md-p">{inline}</p>;
  }), [blocks, mentionMap, onOpenProfile]);

  return <div className={className ?? "fc-text"}>{rendered}</div>;
}
