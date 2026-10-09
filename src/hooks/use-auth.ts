import { api } from "@/convex/_generated/api";
import { recordServiceError } from "@/lib/diagnostics";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useQuery_experimental } from "convex/react";
import { useEffect, useRef } from "react";

/**
 * The signed-in account, with honest failure handling.
 *
 * `useQuery(api.users.currentUser)` THROWS whenever the query fails, and during
 * the last outage that failure was:
 *
 *   [CONVEX Q(users:currentUser)] Server Error: This deployment has been
 *   disabled because it exceeded a configured usage limit.
 *
 * A throw cannot be handled by the hook itself, so it escaped into a generic
 * error boundary: every consumer of `useAuth` crashed, the real reason was
 * hidden, and the account could never "come back" on its own. The non-throwing
 * form gives us a real state machine instead:
 *
 *   pending → still resolving      → `isLoading: true` (no user yet)
 *   success → account, or `null`   → normal (null simply means signed out)
 *   error   → backend unreachable  → `isLoading` STAYS true, the failure is
 *             recorded as a service problem, and NO fake user is invented.
 *
 * Two rules this deliberately follows:
 *   - A failed read is never mistaken for "the account was deleted", and it
 *     never produces a duplicate user or a real user object.
 *   - Because `isLoading` stays true, `RequireAuth` shows the themed service
 *     screen instead of redirecting to `/auth` — the sign-in loop the outage
 *     used to cause. When the deployment answers again the query resolves by
 *     itself and the app returns to normal, with no reload.
 */
export function useAuth() {
  const { isLoading: isAuthLoading, isAuthenticated } = useConvexAuth();
  const { signIn, signOut } = useAuthActions();

  const query = useQuery_experimental({ query: api.users.currentUser, args: {} });
  const error = query.status === "error" ? query.error : null;

  // Feed the app-wide connection status so a disabled deployment / auth failure
  // is classified correctly (and recovers automatically when it answers again).
  // Deduped by message here and grouped upstream, so this can never flood or
  // loop.
  const lastReported = useRef<string | null>(null);
  useEffect(() => {
    if (!error) {
      lastReported.current = null;
      return;
    }
    const message = error.message || String(error);
    if (lastReported.current === message) return;
    lastReported.current = message;
    recordServiceError(error, "service");
  }, [error]);

  const user = query.status === "success" ? query.data : null;
  // An unresolved OR failed account read is NOT a loaded account.
  const isLoading = isAuthLoading || query.status !== "success";

  return { isLoading, isAuthenticated, user, error, signIn, signOut };
}
