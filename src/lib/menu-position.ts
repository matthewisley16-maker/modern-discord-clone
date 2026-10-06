/**
 * Pure geometry for the portal popup menus (see `components/ui/floating-menu`).
 *
 * Given the trigger's rect and the menu's measured size, choose a position
 * that is always completely inside the viewport: align next to the trigger,
 * flip above/below and left/right when there isn't enough room, then clamp.
 * Kept free of DOM/react so it can be unit-tested directly.
 */
export type MenuAnchorRect = {
  top: number;
  left: number;
  right: number;
  bottom: number;
};

export type MenuPlacement = {
  top: number;
  left: number;
  maxHeight: number;
};

export function computeMenuPosition({
  anchor,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  gap = 8,
  margin = 8,
  align = "start",
}: {
  anchor: MenuAnchorRect;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  gap?: number;
  margin?: number;
  /** Preferred horizontal edge: `start` (left) or `end` (right). */
  align?: "start" | "end";
}): MenuPlacement {
  // Never wider/taller than the visible area (minus a small margin).
  const width = Math.min(menuWidth, Math.max(0, viewportWidth - margin * 2));
  const maxHeight = Math.max(1, viewportHeight - margin * 2);

  // Horizontal: prefer the requested edge; flip to the opposite edge when the
  // menu would spill past the right; then clamp inside the viewport.
  let left = align === "end" ? anchor.right - menuWidth : anchor.left;
  if (left + menuWidth > viewportWidth - margin) left = anchor.right - menuWidth;
  if (left < margin) left = anchor.left;
  left = Math.max(margin, Math.min(left, Math.max(margin, viewportWidth - margin - width)));

  // Vertical: prefer below the trigger; flip above when there is more room
  // there; then clamp inside the viewport.
  const roomBelow = viewportHeight - anchor.bottom - gap - margin;
  const roomAbove = anchor.top - gap - margin;
  let top = menuHeight <= roomBelow || roomBelow >= roomAbove ? anchor.bottom + gap : anchor.top - gap - menuHeight;
  top = Math.max(margin, Math.min(top, Math.max(margin, viewportHeight - margin - Math.min(menuHeight, maxHeight))));

  return { top, left, maxHeight };
}
