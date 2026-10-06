/**
 * The DM messages query returns `{ messages, locked, readByOthers, memberCount }`.
 * An earlier server version returned a bare array. Accepting both shapes here
 * means a frontend/backend version mismatch can never crash the message list
 * with `x?.map is not a function` — it just renders an empty list instead.
 */
export function normalizeDmMessages<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === "object") {
    const inner = (raw as { messages?: unknown }).messages;
    if (Array.isArray(inner)) return inner as T[];
  }
  return [];
}
