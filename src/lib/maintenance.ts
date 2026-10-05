/**
 * Helpers for gracefully handling Convex storage / usage-limit errors.
 *
 * The automatic retention system should keep Freecord far below any hard limit,
 * but if a write still trips a limit we recover instead of crashing: the
 * composer shows a short housekeeping notice (never a storage amount) and asks
 * the backend to run cleanup. No account, session or page state is destroyed.
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

/** Calm, amount-free maintenance notice shown only when it is actually needed. */
export const MAINTENANCE_MESSAGE =
  "Freecord is doing a little housekeeping — please try that again in a moment.";

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
