/**
 * The id of THIS page load.
 *
 * The default auto-lock mode asks for the PIN/password again on every visit, and a
 * visit ends when the page is reloaded, closed and reopened, or opened in a new
 * tab. The server can see the auth session, but not the difference between "same
 * tab, still open" and "reloaded a second ago" — so the app tells it with a
 * per-page-load id.
 *
 * This is a MODULE-LEVEL constant on purpose:
 *   - a full reload (F5, address bar, reopening the browser, a new tab) evaluates
 *     the module again, so a new id is generated,
 *   - moving between routes inside Freecord keeps the same id, so switching views
 *     never re-prompts,
 *   - it is never written to `localStorage`, `sessionStorage` or a cookie, so
 *     nothing can carry it across a reload. That is the whole mechanism.
 *
 * It is a UI policy, not a security boundary: it decides when the optional lock
 * screen appears, and it grants no authority over any data (every read and write
 * still goes through its own server-side authorization).
 */

function newPageId(): string {
  const source = typeof crypto !== "undefined" ? crypto : undefined;
  if (source && typeof source.randomUUID === "function") return source.randomUUID();
  // Older browsers: still random enough for a per-page-load marker, and never
  // stored anywhere, so it never has to be secret.
  return `page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** The id of this page load — stable for its lifetime, new after a reload. */
export const PAGE_ID = newPageId();
