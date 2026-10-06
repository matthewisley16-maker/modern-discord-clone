import { sanitizeCollectionFields, toSafeArrayField } from "./collection";

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
export function normalizeDmMessages<T>(raw: unknown): T[] {
  const list = toSafeArrayField<T>(raw, "messages", {
    label: "DM messages",
    source: "api.dms.messages",
  });
  return list.map((message) => sanitizeDmMessage<T>(message));
}

/** Ensure a message's expected array fields really are arrays. */
function sanitizeDmMessage<T>(message: T): T {
  return sanitizeCollectionFields(message, ["reactions", "attachments", "mentionUsers"], {
    label: "DM message",
    source: "api.dms.messages",
  });
}
