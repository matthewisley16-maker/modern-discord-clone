import { useMemo } from "react";
import type { ReactNode } from "react";
import { splitMessageBody } from "@/lib/message-links";

export type MentionRef = { username: string; userId: string };

/**
 * Renders a message body, turning:
 *  - real @username mentions into bright, clickable profile buttons, and
 *  - web URLs into real, safe links that open in a new tab,
 * while leaving everything else as plain, escaped text.
 *
 * The heavy lifting lives in `splitMessageBody` (unit-tested) so channels, DMs,
 * replies and threads all render identically.
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
  const map = useMemo(() => {
    const m = new Map<string, string>();
    for (const ref of mentions ?? []) m.set(ref.username.toLowerCase(), ref.userId);
    return m;
  }, [mentions]);

  const nodes = useMemo(() => {
    const out: ReactNode[] = [];
    let key = 0;
    for (const seg of splitMessageBody(body)) {
      if (seg.kind === "text") {
        out.push(seg.value);
      } else if (seg.kind === "url") {
        out.push(
          <a
            key={key++}
            className="fc-link"
            href={seg.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            onClick={(e) => e.stopPropagation()}
          >
            {seg.value}
          </a>,
        );
      } else {
        const userId = map.get(seg.value.slice(1).toLowerCase());
        if (userId) {
          out.push(
            <button
              key={key++}
              type="button"
              className="fc-mention fc-mention-link"
              onClick={(e) => { e.stopPropagation(); onOpenProfile(userId); }}
              title={`View ${seg.value.slice(1)}'s profile`}
            >
              {seg.value}
            </button>,
          );
        } else {
          out.push(<span key={key++} className="fc-mention">{seg.value}</span>);
        }
      }
    }
    return out;
  }, [body, map, onOpenProfile]);

  return <p className={className ?? "fc-text"}>{nodes}</p>;
}
