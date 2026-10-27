/**
 * Cross-browser fullscreen helpers.
 *
 * Fullscreen is owned by the BROWSER, not by the call UI: the user can leave it
 * with Esc, F11 or the OS at any moment, and Safari only exposes the prefixed
 * API. Both call surfaces (the DM call window and the community voice panel) go
 * through this module so they always agree with what the browser is actually
 * doing instead of keeping their own idea of "is it fullscreen?".
 */

type WebkitDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type WebkitElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

/** The in-app view of a call surface (mirrors the panels' own View types). */
export type FullscreenView = "compact" | "float" | "full";

function host(): WebkitDocument | null {
  return typeof document === "undefined" ? null : (document as WebkitDocument);
}

/** The element currently in fullscreen, if any (prefixed API included). */
export function fullscreenElement(): Element | null {
  const doc = host();
  if (!doc) return null;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/** Is THIS element the one in fullscreen right now? */
export function isFullscreenElement(el: Element | null | undefined): boolean {
  return Boolean(el) && fullscreenElement() === el;
}

/**
 * Can this browser put an ELEMENT fullscreen at all? (an iPhone cannot — only
 * a <video> element can, through its own `webkitEnterFullscreen`.)
 */
export function fullscreenSupported(): boolean {
  const doc = host();
  if (!doc) return false;
  const root = doc.documentElement as WebkitElement;
  const canAsk = typeof root.requestFullscreen === "function" || typeof root.webkitRequestFullscreen === "function";
  const allowed = (doc.webkitFullscreenEnabled ?? doc.fullscreenEnabled) !== false;
  return canAsk && allowed;
}

/** Ask the browser to fullscreen `el`. Resolves to whether it worked. */
export async function requestFullscreen(el: HTMLElement | null | undefined): Promise<boolean> {
  if (!el) return false;
  const target = el as WebkitElement;
  try {
    if (typeof target.requestFullscreen === "function") await target.requestFullscreen();
    else if (typeof target.webkitRequestFullscreen === "function") await target.webkitRequestFullscreen();
    else return false;
    return true;
  } catch {
    // Denied by the user, blocked by the browser, or unsupported.
    return false;
  }
}

/** Leave fullscreen. A no-op when nothing is fullscreen. */
export async function exitFullscreen(): Promise<void> {
  const doc = host();
  if (!doc || !fullscreenElement()) return;
  try {
    if (typeof doc.exitFullscreen === "function") await doc.exitFullscreen();
    else if (typeof doc.webkitExitFullscreen === "function") await doc.webkitExitFullscreen();
  } catch {
    // Already out of fullscreen.
  }
}

/**
 * Put `el` fullscreen, releasing anything else that is fullscreen first, and
 * report whether it now owns the screen.
 */
export async function enterFullscreen(el: HTMLElement | null | undefined): Promise<boolean> {
  if (!el) return false;
  if (isFullscreenElement(el)) return true;
  // Releasing first keeps the browser from refusing the new request because a
  // previous fullscreen transition is still in flight.
  if (fullscreenElement()) await exitFullscreen();
  return requestFullscreen(el);
}

/** Subscribe to fullscreen changes. Returns the unsubscribe function. */
export function onFullscreenChange(handler: () => void): () => void {
  const doc = host();
  if (!doc) return () => {};
  doc.addEventListener("fullscreenchange", handler);
  doc.addEventListener("webkitfullscreenchange", handler);
  return () => {
    doc.removeEventListener("fullscreenchange", handler);
    doc.removeEventListener("webkitfullscreenchange", handler);
  };
}

/**
 * Which view a call surface must return to after leaving fullscreen.
 *
 * A minimized call always comes back minimized (the mini window is not a
 * fullscreen surface); otherwise the view the user had before fullscreen, with
 * the floating window as the safe fallback so the call is never left hidden.
 */
export function viewAfterFullscreen(previous: FullscreenView | null, minimized: boolean): FullscreenView {
  if (minimized) return "compact";
  return previous ?? "float";
}
