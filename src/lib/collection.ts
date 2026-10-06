/**
 * Collection shape safety.
 *
 * Convex query results, realtime payloads and legacy database records can hand
 * the UI a value that is not an array where one is logically expected — while
 * loading (`undefined`), a wrapper object (`{ items: [...] }`), a legacy `{}`
 * record, a single object, a string, a number, `false` … Calling
 * `.map()`/`.filter()` on such a value throws `TypeError: x?.map is not a
 * function` and (before boundaries existed) blanked the whole Dashboard.
 *
 * `toSafeArray` is the single normalization boundary used across Freecord:
 *   - an array passes through untouched (same reference, so React can bail out);
 *   - `null` / `undefined` become `[]`;
 *   - anything else becomes `[]` and, in development, reports a sanitized
 *     diagnostic so the malformed value can be traced and fixed at its source.
 *
 * It NEVER throws, so a malformed record can never take a render down. It is
 * deliberately NOT `Object.values()` — that would silently change the intended
 * data structure; use {@link toSafeArrayField} to unwrap a known wrapper field.
 */

type ValueType = "array" | "null" | "object" | "string" | "number" | "boolean" | "symbol" | "bigint" | "function" | "undefined";

/** The runtime "shape" of a value, without ever touching its contents. */
function typeOf(value: unknown): ValueType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as ValueType;
}

/** Already-warned `label:type` pairs, so a bad field warns once per session. */
const warned = new Set<string>();

/**
 * A short, sanitized description of what was received. Object keys ARE safe to
 * show (they are structural); values, message text and secrets never are.
 */
function sanitizedShape(value: unknown, type: ValueType): string {
  if (type === "object") {
    const keys = Object.keys(value as object);
    return `object with keys [${keys.slice(0, 8).join(", ")}${keys.length > 8 ? ", …" : ""}]`;
  }
  if (type === "string") return `string (length ${(value as string).length})`;
  if (type === "array") return `array (length ${(value as unknown[]).length})`;
  return type;
}

/** True only in a Vite dev build; never throws if `import.meta.env` is absent. */
function diagnosticsEnabled(): boolean {
  try {
    return Boolean(import.meta.env?.DEV);
  } catch {
    return false;
  }
}

function reportShape(label: string, source: string | undefined, value: unknown, type: ValueType) {
  // Diagnostics are development-only: production users never see this.
  if (!diagnosticsEnabled()) return;
  const key = `${label}:${type}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(
    `[FreeCord Data Shape Warning] ${label} expected an array but received ${type}.` +
      (source ? ` Source: ${source}.` : "") +
      ` Actual shape: ${sanitizedShape(value, type)}. Normalized to [].`,
  );
}

/** Optional context for a shape diagnostic. Never include private contents. */
export type CollectionContext = { label?: string; source?: string };

/**
 * Normalize a value that is logically an array into a real array.
 * Array → itself; null/undefined → `[]`; anything else → `[]` (+ DEV warning).
 * Never throws.
 */
export function toSafeArray<T = unknown>(value: unknown, context?: CollectionContext): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value === null || value === undefined) return [];
  reportShape(context?.label ?? "A collection", context?.source, value, typeOf(value));
  return [];
}

/**
 * Extract an array that may be EITHER a bare array OR a field of a wrapper
 * object (the way some queries return `{ messages / items / followers: [...] }`).
 *
 * Unlike a blind `Object.values`, this only ever unwraps the known field name,
 * preserving the intended structure. If the wrapper exists but the field is
 * missing or not an array, the field is reported and `[]` is returned.
 */
export function toSafeArrayField<T = unknown>(
  value: unknown,
  field: string,
  context?: CollectionContext,
): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value === null || value === undefined) return [];
  if (typeof value === "object") {
    const inner = (value as Record<string, unknown>)[field];
    if (Array.isArray(inner)) return inner as T[];
    if (inner === null || inner === undefined) {
      // A wrapper that simply has no items is a legitimate empty collection.
      return [];
    }
    reportShape(`${context?.label ?? "A collection"}.${field}`, context?.source, inner, typeOf(inner));
    return [];
  }
  reportShape(context?.label ?? "A collection", context?.source, value, typeOf(value));
  return [];
}

/**
 * Ensure the named fields of a record are real arrays, preserving the record's
 * type. Used to sanitize message shapes (`reactions`/`attachments`/
 * `mentionUsers`) at the render boundary: a single legacy or malformed record
 * can no longer crash the whole message list. Fields that are absent are left
 * alone; fields that are present but not arrays are replaced with `[]`.
 */
export function sanitizeCollectionFields<T>(
  value: T,
  fields: readonly string[],
  context?: CollectionContext,
): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = { ...record };
  for (const field of fields) {
    if (!(field in record)) continue;
    const current = record[field];
    if (Array.isArray(current)) continue;
    next[field] = toSafeArray(current, {
      label: `${context?.label ?? "Record"}.${field}`,
      source: context?.source,
    });
    changed = true;
  }
  return changed ? (next as T) : value;
}
