import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { computeMenuPosition } from "@/lib/menu-position";

/**
 * A small popup menu anchored to a trigger element.
 *
 * It renders through a portal on `document.body`, so it can never be clipped
 * by an ancestor's `overflow: hidden`, `isolation`, transform, or stacking
 * context (profile cards, sidebars, modals, scroll containers). It measures
 * the trigger and the menu, then places the menu next to the trigger, flipping
 * above/below and left/right and clamping to the viewport so it is always
 * completely visible. It repositions on scroll/resize and closes on Escape or
 * an outside pointer press.
 */
export default function FloatingMenu({
  anchor,
  onClose,
  children,
  className = "",
  role = "menu",
  ariaLabel,
  minWidth = 200,
  gap = 8,
  zIndex = 320,
  align = "start",
}: {
  /** The trigger element to anchor the menu to (e.g. the three-dot button). */
  anchor: HTMLElement | null;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  role?: string;
  ariaLabel?: string;
  minWidth?: number;
  gap?: number;
  zIndex?: number;
  /** Preferred edge to align with the anchor: `start` (left) or `end` (right). */
  align?: "start" | "end";
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  const reposition = useCallback(() => {
    const el = menuRef.current;
    if (!anchor || !el) return;
    const rect = anchor.getBoundingClientRect();
    const next = computeMenuPosition({
      anchor: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
      menuWidth: el.offsetWidth || minWidth,
      menuHeight: el.offsetHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      gap,
      align,
    });
    setPlacement(next);
  }, [align, anchor, gap, minWidth]);

  useLayoutEffect(() => {
    reposition();
  }, [reposition]);

  // Follow the trigger while scrolling/resizing so the menu stays glued to it.
  useEffect(() => {
    if (!anchor) return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; reposition(); });
    };
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [anchor, reposition]);

  // Close on Escape and on any press outside the menu (the trigger keeps
  // toggling itself).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    }
    function onDown(e: PointerEvent) {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchor?.contains(target)) return;
      onClose();
    }
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [anchor, onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={menuRef}
      role={role}
      aria-label={ariaLabel}
      data-floating-menu=""
      className={`fc-floating-menu ${className}`.trim()}
      style={{
        position: "fixed",
        top: placement?.top ?? 0,
        left: placement?.left ?? 0,
        zIndex,
        minWidth,
        maxWidth: "calc(100vw - 16px)",
        maxHeight: placement?.maxHeight,
        visibility: placement ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
