/**
 * Community subcategories — the ONE list of supported options, plus the rules
 * that decide what a stored value means.
 *
 * Pure (no Convex, no DOM) on purpose: the community creation flow, the
 * "Edit Subcategory" editor, the Discover filter chips, the Admin Panel's
 * community editor and the SERVER validation all import these functions, so a
 * subcategory can never be spelled one way in the UI and another in the
 * database — and a value the server refuses can never be offered by a picker.
 *
 * OUTDATED VALUES
 * ---------------
 * `servers.category` is a plain string, so communities created before this list
 * existed (or under a subcategory we later stopped offering) still hold their
 * value. Those are handled gracefully rather than being silently rewritten:
 *
 *   - they are DISPLAYED and FILTERED as the stored text (`communityCategoryOf`),
 *     so no community becomes invisible or mis-filed in Discover,
 *   - the filter list keeps offering them while they are in use, so the members
 *     of those communities can still find them,
 *   - an editor shows the current value as "no longer offered" and lets the
 *     owner either keep it (unchanged) or switch to a supported one,
 *   - any NEW choice must be one of the supported categories.
 */

/** Every subcategory a community may be assigned to. Single source of truth. */
export const COMMUNITY_CATEGORIES = [
  "General",
  "Gaming",
  "Music",
  "Art",
  "Tech",
  "Study",
  "Sports",
  "Community",
] as const;

export type CommunityCategory = (typeof COMMUNITY_CATEGORIES)[number];

/** Used for a community with no subcategory stored at all. */
export const DEFAULT_COMMUNITY_CATEGORY: CommunityCategory = "General";

/** The supported list as a plain string array (for selects, tests, docs). */
export const SUPPORTED_COMMUNITY_CATEGORIES: string[] = [...COMMUNITY_CATEGORIES];

/**
 * The canonical supported category for a user-supplied value, or `null` when the
 * value is not one we offer. Matching is case-insensitive and ignores
 * surrounding whitespace, so the stored value is always the canonical spelling
 * ("gaming" → "Gaming").
 */
export function normalizeCommunityCategory(raw: unknown): CommunityCategory | null {
  if (typeof raw !== "string") return null;
  const term = raw.trim().toLowerCase();
  if (!term) return null;
  return COMMUNITY_CATEGORIES.find((c) => c.toLowerCase() === term) ?? null;
}

/** True when a stored value is one we no longer offer (but is still stored). */
export function isLegacyCommunityCategory(raw: unknown): boolean {
  if (typeof raw !== "string" || !raw.trim()) return false;
  return normalizeCommunityCategory(raw) === null;
}

/**
 * What a stored value is displayed, filtered and compared as:
 *   - a supported value → the canonical spelling,
 *   - an outdated/removed value → that stored text (kept, never rewritten),
 *   - nothing at all → the default subcategory.
 */
export function communityCategoryOf(raw: unknown): string {
  const normalized = normalizeCommunityCategory(raw);
  if (normalized) return normalized;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return DEFAULT_COMMUNITY_CATEGORY;
}

/**
 * The choices a subcategory picker offers: every supported category, plus — for
 * the community being edited — its own outdated value, flagged, so the editor
 * can always show what is currently assigned and "Cancel"/"Save" leave it alone.
 */
export function communityCategoryOptions(current?: unknown): { value: string; legacy: boolean }[] {
  const options: { value: string; legacy: boolean }[] = COMMUNITY_CATEGORIES.map((c) => ({
    value: c,
    legacy: false,
  }));
  const stored = typeof current === "string" ? current.trim() : "";
  if (stored && isLegacyCommunityCategory(stored) && !options.some((o) => o.value === stored)) {
    options.push({ value: stored, legacy: true });
  }
  return options;
}

/**
 * Why a submitted subcategory is not acceptable, or `null` when it is.
 *
 * `current` is the value already stored on the community. Passing it keeps an
 * outdated value valid when it is submitted UNCHANGED (so an unrelated settings
 * save can never force a rewrite), while any new choice must be supported.
 */
export function communityCategoryProblem(raw: unknown, current?: unknown): string | null {
  const supported = COMMUNITY_CATEGORIES.join(", ");
  if (typeof raw !== "string" || !raw.trim()) {
    return `Choose a subcategory (${supported}).`;
  }
  const value = raw.trim();
  if (normalizeCommunityCategory(value)) return null;
  const stored = typeof current === "string" ? current.trim() : "";
  if (stored && value.toLowerCase() === stored.toLowerCase()) return null; // unchanged outdated value
  return `“${value.slice(0, 40)}” isn't a supported subcategory. Choose one of: ${supported}.`;
}

/** True when a submitted value changes what is stored (canonical comparison). */
export function communityCategoryChanged(raw: unknown, current?: unknown): boolean {
  return communityCategoryOf(raw) !== communityCategoryOf(current);
}

/**
 * Does a community's stored subcategory belong under this filter value?
 *
 * Used by Discover: canonical values match by name, and outdated values match
 * their own filter chip case-insensitively, so "Retro Gaming" and "retro gaming"
 * are one filter rather than two.
 */
export function communityCategoryMatches(stored: unknown, filter: unknown): boolean {
  return communityCategoryOf(stored).toLowerCase() === communityCategoryOf(filter).toLowerCase();
}
