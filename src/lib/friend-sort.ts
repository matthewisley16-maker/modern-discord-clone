/**
 * How the friends list is ordered: most recently active first.
 *
 * The rule lives here, in one pure function, because the friends list is built
 * on the server (`social.listFriends`) AND rendered on the client
 * (`HomeView.tsx`). A single rule means the order can never disagree with
 * itself, and it is unit-tested in `friend-sort-test.mjs`.
 *
 * Order, in words:
 *   1. Friends who are online right now, `online` first, then `dnd`, then
 *      `idle` — within each of those, most recently ACTIVE first, using
 *      `lastActive` (the last real interaction) and falling back to `lastSeen`.
 *   2. Then offline friends — most recently ONLINE first, by `lastSeen`.
 *   3. Friends who have never been online (`lastSeen` missing/0) last.
 *   4. Equal timestamps are broken deterministically (display name, then
 *      username, then user id) so the list never shuffles between renders,
 *      refreshes or the server and the client.
 *
 * `invisible` is deliberately NOT "active": an invisible user appears offline to
 * everyone else, and their timestamps are withheld (see `presenceInfoOf`), so
 * they sort with the offline friends — their choice is respected, not leaked.
 */

/** Presence values that mean "this person is here right now". */
export const ACTIVE_PRESENCE: ReadonlySet<string> = new Set(["online", "idle", "dnd"]);

/**
 * Presence rank, lowest (shown first) to highest. Everyone who is here comes
 * before everyone who is not — `online` above `dnd` above `idle` — and an
 * unknown/absent presence is treated as offline rather than guessed.
 */
export const PRESENCE_ORDER: Record<string, number> = { online: 0, dnd: 1, idle: 2 };

/** The rank of the offline bucket: every presence that is not "here now". */
export const OFFLINE_TIER = 3;

/** The sort rank for one presence value. */
export function presenceRank(presence?: string | null): number {
  return (typeof presence === "string" ? PRESENCE_ORDER[presence] : undefined) ?? OFFLINE_TIER;
}

/** The fields the ordering uses. Extra fields (avatar, status, …) ride along. */
export type ActivityFields = {
  presence?: string | null;
  /** Last heartbeat / disconnect — the reliable last-online timestamp. */
  lastSeen?: number | null;
  /** Last real interaction (optional; only present while online). */
  lastActive?: number | null;
  displayName?: string | null;
  username?: string | null;
  userId?: string | null;
};

/** True when the presence we were given means "here right now". */
export function isActivePresence(presence?: string | null): boolean {
  return typeof presence === "string" && ACTIVE_PRESENCE.has(presence);
}

/**
 * The timestamp to order one friend by: their most recent activity when we know
 * it (online friends), otherwise their last-online time. `0` means "never".
 */
export function activityTimestamp(friend: ActivityFields): number {
  const lastActive = typeof friend.lastActive === "number" && friend.lastActive > 0 ? friend.lastActive : 0;
  const lastSeen = typeof friend.lastSeen === "number" && friend.lastSeen > 0 ? friend.lastSeen : 0;
  return isActivePresence(friend.presence) ? Math.max(lastActive, lastSeen) : lastSeen;
}

/**
 * The friends list order. Returns a NEW array (the input is never mutated, so a
 * reactive Convex payload can't be reordered in place).
 */
export function sortFriendsByActivity<T extends ActivityFields>(friends: readonly T[]): T[] {
  return [...friends].sort((a, b) => {
    // 1. Online before idle before offline (dnd sorts with the online friends,
    //    just below plain online).
    const byTier = presenceRank(a.presence) - presenceRank(b.presence);
    if (byTier !== 0) return byTier;

    // 2. Most recent activity first; a friend who has never been online is 0 and
    //    therefore last within their group.
    const byTime = activityTimestamp(b) - activityTimestamp(a);
    if (byTime !== 0) return byTime;

    // 3. Deterministic, stable ties: name, then username, then id. Two friends
    //    with the same timestamp always come out in the same order.
    const name = (f: ActivityFields) => (f.displayName ?? "").toLocaleLowerCase();
    const byName = name(a).localeCompare(name(b));
    if (byName !== 0) return byName;
    const byUsername = (a.username ?? "").toLocaleLowerCase().localeCompare((b.username ?? "").toLocaleLowerCase());
    if (byUsername !== 0) return byUsername;
    return (a.userId ?? "").localeCompare(b.userId ?? "");
  });
}

/** True when we have never seen this friend online (no stored timestamp). */
export function neverSeen(friend: ActivityFields): boolean {
  return activityTimestamp(friend) === 0;
}
