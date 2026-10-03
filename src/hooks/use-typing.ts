import { useCallback, useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * Typing indicator helper.
 *
 * - Throttles heartbeats (at most one every 2.5s) so keystrokes never spam the
 *   backend.
 * - Automatically stops when the draft is cleared or a message is sent.
 * - Clears typing state on channel/DM switch and on unmount, so nothing is ever
 *   left stuck on screen.
 *
 * Convex queries are reactive subscriptions, so other clients see the indicator
 * immediately without polling.
 */
export function useTyping(scope: { channelId?: Id<"channels">; conversationId?: Id<"dmConversations"> } | null) {
  const setChannelTyping = useMutation(api.communities.setTyping);
  const setDmTyping = useMutation(api.dms.setTyping);
  const stopTyping = useMutation(api.dms.stopTyping);
  const lastSent = useRef(0);
  const active = useRef(false);

  const send = useCallback(() => {
    if (!scope) return;
    const now = Date.now();
    if (now - lastSent.current < 2500) return;
    lastSent.current = now;
    active.current = true;
    if (scope.channelId) setChannelTyping({ channelId: scope.channelId }).catch(() => {});
    else if (scope.conversationId) setDmTyping({ conversationId: scope.conversationId }).catch(() => {});
  }, [scope, setChannelTyping, setDmTyping]);

  /** Immediately clear the indicator (send, empty draft, switch, unmount). */
  const stop = useCallback(() => {
    if (!scope || !active.current) return;
    active.current = false;
    lastSent.current = 0;
    if (scope.channelId) stopTyping({ channelId: scope.channelId }).catch(() => {});
    else if (scope.conversationId) stopTyping({ conversationId: scope.conversationId }).catch(() => {});
  }, [scope, stopTyping]);

  /** Call on every keystroke; safe to call frequently. */
  const onType = useCallback((value: string) => {
    if (!value.trim()) { stop(); return; }
    send();
  }, [send, stop]);

  // Stop when the conversation changes, and on unmount.
  useEffect(() => {
    return () => {
      if (!active.current) return;
      active.current = false;
      lastSent.current = 0;
      if (scope?.channelId) stopTyping({ channelId: scope.channelId }).catch(() => {});
      else if (scope?.conversationId) stopTyping({ conversationId: scope.conversationId }).catch(() => {});
    };
  }, [scope?.channelId, scope?.conversationId, stopTyping]);

  return { onType, stop };
}

/** Human-friendly typing summary: "Alex", "Alex and Sam", "3 people". */
export function typingLabel(names: string[]): string {
  const unique = [...new Set(names)].filter(Boolean);
  if (unique.length === 0) return "";
  if (unique.length === 1) return `${unique[0]} is typing…`;
  if (unique.length === 2) return `${unique[0]} and ${unique[1]} are typing…`;
  if (unique.length === 3) return `${unique[0]}, ${unique[1]}, and ${unique[2]} are typing…`;
  return `${unique.length} people are typing…`;
}
