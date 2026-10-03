import { useMemo } from "react";

export type MentionRef = { username: string; userId: string };

const TOKEN = /(@[a-z0-9._]{2,24})/gi;

/**
 * Renders a message body, turning real @username mentions into bright,
 * clickable buttons that open the user's profile. Unknown tokens (a handle
 * that doesn't exist, or someone who can't see the message) stay as plain,
 * non-clickable styled text so nothing misleading is shown.
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

  const parts = body.split(TOKEN);
  return (
    <p className={className ?? "fc-text"}>
      {parts.map((part, i) => {
        const match = /^@([a-z0-9._]{2,24})$/i.exec(part);
        if (!match) return part;
        const userId = map.get(match[1].toLowerCase());
        if (userId) {
          return (
            <button
              key={i}
              type="button"
              className="fc-mention fc-mention-link"
              onClick={(e) => { e.stopPropagation(); onOpenProfile(userId); }}
              title={`View ${match[1]}'s profile`}
            >
              {part}
            </button>
          );
        }
        return <span key={i} className="fc-mention">{part}</span>;
      })}
    </p>
  );
}
