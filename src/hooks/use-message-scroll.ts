import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Message-list scrolling that behaves the way people expect:
 *
 *  - Opening a conversation jumps instantly to the newest message (after the
 *    messages have rendered), so there is never a partial scroll position.
 *  - Returning to a conversation you were reading keeps your position; if you
 *    were at the bottom you come back to the bottom.
 *  - New messages auto-scroll only when you're already near the bottom;
 *    otherwise they're counted and offered via a "↓ N new messages" button.
 *  - Late-loading media can't shove the view: while you're at the bottom the
 *    view stays pinned as content grows.
 */
export function useMessageScroll(key: string | undefined, messageCount: number) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);

  const atBottomRef = useRef(true);
  const keyRef = useRef<string | undefined>(key);
  const countRef = useRef<number>(messageCount);

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    atBottomRef.current = near;
    setAtBottom(near);
    if (near) setNewCount(0);
  }, []);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    atBottomRef.current = true;
    setAtBottom(true);
    setNewCount(0);
  }, []);

  // Runs before paint: switching conversations pins to the bottom instantly,
  // and messages arriving afterwards keep the view pinned while at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    if (keyRef.current !== key) {
      keyRef.current = key;
      countRef.current = messageCount;
      el.scrollTop = el.scrollHeight;
      atBottomRef.current = true;
      setAtBottom(true);
      setNewCount(0);
      return;
    }

    if (messageCount !== countRef.current) {
      const grew = messageCount > countRef.current;
      countRef.current = messageCount;
      if (grew) {
        if (atBottomRef.current) el.scrollTop = el.scrollHeight;
        else setNewCount((n) => n + 1);
      }
    }
  }, [key, messageCount]);

  // Keep pinned to the bottom as images/embeds finish loading, and clean up
  // observers whenever the conversation changes.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const pin = () => { if (atBottomRef.current) el.scrollTop = el.scrollHeight; };
    const ro = new ResizeObserver(pin);
    const attach = () => { for (const child of Array.from(el.children)) ro.observe(child); };
    attach();
    const mo = new MutationObserver(() => { attach(); pin(); });
    mo.observe(el, { childList: true, subtree: true });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [key]);

  return { scrollRef, atBottom, newCount, scrollToBottom, onScroll: measure };
}
