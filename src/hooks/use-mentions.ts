import { useCallback, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export type MentionSuggestion = {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  decorationId: string | null;
  presence: string;
  isFollowing: boolean;
  followsYou: boolean;
  isMutual: boolean;
  isFriend: boolean;
};

type Token = { term: string; start: number; end: number };

/** Find the `@token` the caret currently sits in, if any. */
function activeToken(value: string, caret: number): Token | null {
  const upto = value.slice(0, caret);
  const m = /(^|\s)@([a-z0-9._]{0,24})$/i.exec(upto);
  if (!m) return null;
  const term = m[2];
  return { term, start: caret - term.length - 1, end: caret };
}

/**
 * Mention autocomplete for a composer input. Suggestions come from the backend
 * and are prioritized (mutual → following → friends → community members).
 * Selecting one inserts the handle of a REAL user and keeps the caret after it.
 */
export function useMentions({
  value,
  setValue,
  inputRef,
  serverId,
  conversationId,
}: {
  value: string;
  setValue: (next: string) => void;
  inputRef: { current: HTMLInputElement | null };
  serverId?: Id<"servers">;
  conversationId?: Id<"dmConversations">;
}) {
  const [token, setToken] = useState<Token | null>(null);
  const [index, setIndex] = useState(0);

  const args = token ? { ...(serverId ? { serverId } : {}), ...(conversationId ? { conversationId } : {}), q: token.term } : "skip";
  const suggestions = (useQuery(api.mentions.candidates, args as never) as MentionSuggestion[] | undefined) ?? [];
  const open = token !== null && suggestions.length > 0;

  const onValueChange = useCallback(
    (next: string, caret: number | null) => {
      setValue(next);
      const at = caret ?? next.length;
      const found = activeToken(next, at);
      setToken(found);
      setIndex(0);
    },
    [setValue],
  );

  const close = useCallback(() => setToken(null), []);

  const choose = useCallback(
    (user: MentionSuggestion) => {
      if (!token) return;
      const before = value.slice(0, token.start);
      const after = value.slice(token.end);
      const insert = `@${user.username} `;
      const next = `${before}${insert}${after}`;
      setValue(next);
      setToken(null);
      const caret = before.length + insert.length;
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) { el.focus(); el.setSelectionRange(caret, caret); }
      });
    },
    [token, value, setValue, inputRef],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (!open) {
        if (e.key === "Escape") setToken(null);
        return;
      }
      if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => (i + 1) % suggestions.length); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => (i - 1 + suggestions.length) % suggestions.length); }
      else if (e.key === "Enter" || e.key === "Tab") {
        const pick = suggestions[index] ?? suggestions[0];
        if (pick) { e.preventDefault(); choose(pick); }
      } else if (e.key === "Escape") {
        e.preventDefault();
        setToken(null);
      }
    },
    [open, suggestions, index, choose],
  );

  return { suggestions, open, index, setIndex, onValueChange, onKeyDown, choose, close };
}
