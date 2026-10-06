import { sanitizeCollectionFields, toSafeArrayField, type CollectionContext } from "./collection";

/**
 * The DM messages query returns `{ messages, locked, readByOthers, memberCount }`.
 * An earlier server version returned a bare array. `toSafeArrayField` accepts
 * both shapes, so a frontend/backend version mismatch — or a malformed payload —
 * can never crash the message list with `x?.map is not a function`.
 *
 * It also normalizes each message's own sub-collections (`reactions`,
 * `attachments`, `mentionUsers`) so a single legacy record with a missing or
 * malformed field cannot take down the whole conversation.
 */
export function normalizeDmMessages<T>(raw: unknown, context?: CollectionContext): T[] {
  const base: CollectionContext = {
    component: "DmView",
    source: "api.dms.messages",
    ...context,
  };
  const list = toSafeArrayField<T>(raw, "messages", { ...base, label: "DM messages" });
  return list.map((message) => sanitizeDmMessage<T>(message, base));
}

/** Ensure a message's expected array fields really are arrays. */
function sanitizeDmMessage<T>(message: T, context: CollectionContext): T {
  return sanitizeCollectionFields(message, ["reactions", "attachments", "mentionUsers"], {
    ...context,
    label: "DM message",
  });
}
