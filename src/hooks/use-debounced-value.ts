import { useEffect, useState } from "react";

/**
 * Debounce a value that is fed into a Convex query argument.
 *
 * WHY THIS EXISTS
 * ---------------
 * A `useQuery` is a reactive subscription whose identity is its ARGUMENTS.
 * Passing a search box's raw keystrokes straight into those arguments makes
 * every character a brand-new subscription plus a separate function execution —
 * the previous one is torn down and the replacement runs immediately. Typing a
 * 30-character term cost 30 executions, and for `search.global` and
 * `dms.messages` every one of those also scanned the message text index. That
 * per-keystroke storm is what pushed this deployment into a hard usage limit
 * and paused it.
 *
 * Debouncing collapses a burst of keystrokes into a single execution once the
 * typist pauses. Only the QUERY ARGUMENT is debounced — never the visible
 * value — so the input stays controlled and instant.
 *
 * The 300ms default matches the existing search boxes in the Admin Panel.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
