/**
 * What a group chat is called — ONE rule for every surface.
 *
 * A group's name is a single optional column (`dmConversations.name`), so the
 * sidebar list, the Direct Messages page, the chat header, the group details
 * panel and the Locked & Hidden Conversations screen all have to answer the same
 * question the same way: "what do we print beside this group's picture?".
 *
 * This module is that answer (pure, unit-tested in `group-name-test.mjs`) and it
 * is imported by BOTH the Convex queries that build conversation lists and the
 * components that render them, so a list can never disagree with the chat it
 * opens.
 */

/** The label for a group that has no name of its own. */
export const UNNAMED_GROUP = "Unnamed Group";

/**
 * Stored values that mean "this group was never really named".
 *
 * Older group creation stored the literal placeholder "Group" when the creator
 * left the name blank, so rows like that are still in the database. They are not
 * a name a person chose, and showing "Group" beside every one of them is exactly
 * the placeholder text this rule exists to remove — so they read as unnamed and
 * fall back to `UNNAMED_GROUP` like any other nameless group. A group WITH a real
 * stored name is always shown exactly as it was saved (trimmed).
 */
const PLACEHOLDER_NAMES = new Set(["group", UNNAMED_GROUP.toLowerCase()]);

/**
 * The name to display for a group: its stored name, or "Unnamed Group".
 *
 * Never returns an empty string, so a caller can render the result directly
 * without inventing its own fallback (which is how a picture once ended up with
 * nothing beside it).
 */
export function groupDisplayName(raw?: string | null): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return UNNAMED_GROUP;
  if (PLACEHOLDER_NAMES.has(trimmed.toLowerCase())) return UNNAMED_GROUP;
  return trimmed;
}

/** True when a group has no name of its own (empty, or the legacy placeholder). */
export function isUnnamedGroup(raw?: string | null): boolean {
  return groupDisplayName(raw) === UNNAMED_GROUP;
}
