/**
 * Helpers for gracefully handling Convex storage / usage-limit errors on a
 * WRITE the user just attempted (sending a message or uploading a file).
 *
 * This is strictly a per-composer notice: it never gates rendering, never
 * becomes a page-wide state, and is never used for background maintenance.
 * If a write trips a limit we recover instead of crashing: the user sees a
 * short "try again" toast (never a storage amount) and asks the backend to run
 * its (detached) cleanup. No account, session or page state is destroyed.
 */

/** Does an error look like a Convex storage / usage / document-limit error? */
export function isStorageLimitError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  if (!message) return false;
  return (
    /storage|quota|usage limit|too many documents|document limit|resource limit/.test(message) ||
    /(storage|file|upload).*(limit|exceed|full)/.test(message) ||
    /exceeded.*(limit|quota)/.test(message)
  );
}

/** Short, amount-free notice shown only next to a write that actually failed. */
export const MAINTENANCE_MESSAGE =
  "That couldn't be sent just now — please try again in a moment.";

/**
 * If a write failed with a storage/usage-limit error, surface the maintenance
 * notice and ask the backend to start cleanup in the background. Returns true
 * when the error was handled this way. Never throws.
 */
export function handleStorageError(
  err: unknown,
  requestCleanup: () => Promise<unknown>,
  onMaintenance: (message: string) => void,
): boolean {
  if (!isStorageLimitError(err)) return false;
  onMaintenance(MAINTENANCE_MESSAGE);
  // Fire-and-forget: cleanup is scheduled in the background, never awaited.
  void requestCleanup().catch(() => {});
  return true;
}
