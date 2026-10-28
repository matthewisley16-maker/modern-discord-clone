/**
 * "A call is on THIS screen right now."
 *
 * The optional site lock re-locks a device after a period without activity. A
 * live call is activity even when nobody touches the mouse for ten minutes — and
 * locking Freecord mid-call would unmount the call panel and drop the WebRTC
 * connection, which is exactly the interruption the lock is not for.
 *
 * So the two call surfaces (the DM call window and the community voice panel)
 * announce themselves here while they are mounted, and the auto-lock monitor
 * treats an open call as use. Deliberately plain, module-scoped and
 * React-free: it is a fact about this browser session (never sent anywhere, never
 * stored), and each call surface releases it on unmount so a crash, a hang-up or
 * a navigation can never leave a call "open" forever.
 */

let openCalls = 0;
const listeners = new Set<(active: boolean) => void>();

/** Is a call window mounted right now? */
export function callActive(): boolean {
  return openCalls > 0;
}

/**
 * Announce an open call. Returns the release function — use it as the cleanup of
 * a mount effect, so the announcement lasts exactly as long as the panel does.
 */
export function beginCall(): () => void {
  openCalls += 1;
  if (openCalls === 1) for (const listener of listeners) listener(true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openCalls = Math.max(0, openCalls - 1);
    if (openCalls === 0) for (const listener of listeners) listener(false);
  };
}

/** Subscribe to "a call opened" / "the last one closed". Returns the unsubscribe. */
export function onCallActiveChange(listener: (active: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
