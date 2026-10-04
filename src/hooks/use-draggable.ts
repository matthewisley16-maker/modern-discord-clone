import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Drag a floating window around the viewport.
 *
 * - Pointer events (mouse, pen AND touch) move the window smoothly.
 * - The drag only starts on "empty" areas: clicks on buttons, links, form
 *   fields, video/audio elements or anything marked `data-no-drag` are ignored,
 *   so the call controls keep working exactly as before.
 * - The position is clamped so the window always stays reachable, and it is
 *   re-clamped whenever the browser is resized.
 * - The drag offset is captured from the element's rect, so the window never
 *   jumps when a drag begins.
 * - Position is remembered per `key` for the rest of the session (navigation /
 *   minimize / restore). It is pure UI state and never touches the call.
 */

// Session-scoped store so a floating window keeps its spot across mounts.
const positions = new Map<string, { x: number; y: number }>();

export function useDraggableWindow(key: string, enabled = true) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => positions.get(key) ?? null);
  const offset = useRef<{ dx: number; dy: number } | null>(null);
  const startPoint = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  const [dragging, setDragging] = useState(false);

  const clamp = useCallback((x: number, y: number) => {
    const el = ref.current;
    if (!el) return { x, y };
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    return {
      x: Math.max(8, Math.min(Math.max(8, window.innerWidth - w - 8), x)),
      y: Math.max(8, Math.min(Math.max(8, window.innerHeight - h - 8), y)),
    };
  }, []);

  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled) return;
      // Never hijack controls, videos, links or fields.
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest("button, a, input, select, textarea, video, audio, [data-no-drag]")) return;
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      offset.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      startPoint.current = { x: e.clientX, y: e.clientY };
      moved.current = false;
      setPos({ x: rect.left, y: rect.top });
      setDragging(true);
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [enabled],
  );

  useEffect(() => {
    if (!dragging) return;
    function move(e: PointerEvent) {
      const el = ref.current;
      const d = offset.current;
      const s = startPoint.current;
      if (!el || !d) return;
      if (s && Math.abs(e.clientX - s.x) + Math.abs(e.clientY - s.y) > 4) moved.current = true;
      const next = clamp(e.clientX - d.dx, e.clientY - d.dy);
      positions.set(key, next);
      setPos(next);
    }
    function stop() {
      offset.current = null;
      startPoint.current = null;
      setDragging(false);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [dragging, key, clamp]);

  // Keep the window fully reachable when the viewport shrinks.
  useEffect(() => {
    function onResize() {
      setPos((p) => {
        if (!p) return p;
        const next = clamp(p.x, p.y);
        positions.set(key, next);
        return next.x === p.x && next.y === p.y ? p : next;
      });
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [key, clamp]);

  const style = pos
    ? { left: pos.x, top: pos.y, right: "auto" as const, bottom: "auto" as const }
    : undefined;

  return { ref, pos, dragging, startDrag, style, wasDragged: () => moved.current };
}
