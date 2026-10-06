import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { enforceRateLimit } from "./authHelpers";
import { areFriends, audit, avatarUrlOf, currentUserId, displayNameOf, isBlockedEitherWay, notify, presenceInfoOf, profileOf, settingsOf } from "./lib";
import type { Id } from "./_generated/dataModel";

function pair(a: Id<"users">, b: Id<"users">): [Id<"users">, Id<"users">] {
  return (a as string) < (b as string) ? [a, b] : [b, a];
}

async function publicCard(ctx: Parameters<typeof displayNameOf>[0], userId: Id<"users">, viewerId?: Id<"users">) {
  const profile = await profileOf(ctx, userId);
  const user = await ctx.db.get(userId);
  const { status, lastSeen } = await presenceInfoOf(ctx, userId, viewerId);
  return {
    userId,
    username: user?.username ?? "",
    displayName: profile?.displayName ?? user?.name ?? user?.username ?? "Freecord member",
    avatarColor: profile?.avatarColor ?? "violet",
    avatarUrl: await avatarUrlOf(ctx, userId),
    presence: status,
    lastSeen,
    customStatus: profile?.customStatus ?? "",
    decorationId: profile?.decorationId ?? null,
  };
}

// ---------------- Friends ----------------

export const sendFriendRequest = mutation({
  args: { toId: v.id("users") },
  handler: async (ctx, { toId }) => {
    const fromId = await currentUserId(ctx);
    if (fromId === toId) throw new Error("You can't add yourself.");
    await enforceRateLimit(ctx, `friendreq:${fromId}`, 20, 60_000);

    if (await isBlockedEitherWay(ctx, fromId, toId)) throw new Error("This user is unavailable.");
    const targetSettings = await settingsOf(ctx, toId);
    if (targetSettings?.friendRequestPrivacy === "none") throw new Error("This user isn't accepting friend requests.");
    if (await areFriends(ctx, fromId, toId)) throw new Error("You're already friends.");

    const reverse = await ctx.db
      .query("friendRequests")
      .withIndex("by_pair", (q) => q.eq("fromId", toId).eq("toId", fromId))
      .unique();
    if (reverse && reverse.status === "pending") {
      // They already asked us: accept instead of creating a duplicate.
      const [a, b] = pair(fromId, toId);
      await ctx.db.patch(reverse._id, { status: "accepted" });
      await ctx.db.insert("friendships", { userA: a, userB: b });
      await notify(ctx, toId, "friend_accept", "Friend request accepted", `You're now friends.`, "?view=friends", fromId);
      return { status: "accepted" as const };
    }
    if (reverse && reverse.status === "accepted") throw new Error("You're already friends.");

    const existing = await ctx.db
      .query("friendRequests")
      .withIndex("by_pair", (q) => q.eq("fromId", fromId).eq("toId", toId))
      .unique();
    if (existing) {
      if (existing.status === "pending") throw new Error("Friend request already sent.");
      await ctx.db.patch(existing._id, { status: "pending" });
    } else {
      await ctx.db.insert("friendRequests", { fromId, toId, status: "pending" });
    }
    await notify(ctx, toId, "friend_request", "New friend request", `${await displayNameOf(ctx, fromId)} wants to be friends.`, "?view=friends", fromId);
    return { status: "pending" as const };
  },
});

export const respondFriendRequest = mutation({
  args: { requestId: v.id("friendRequests"), accept: v.boolean() },
  handler: async (ctx, { requestId, accept }) => {
    const userId = await currentUserId(ctx);
    const request = await ctx.db.get(requestId);
    if (!request || request.toId !== userId) throw new Error("Request not found.");
    if (request.status !== "pending") throw new Error("This request is no longer pending.");
    if (accept) {
      const [a, b] = pair(request.fromId, request.toId);
      const already = await ctx.db.query("friendships").withIndex("by_pair", (q) => q.eq("userA", a).eq("userB", b)).unique();
      if (!already) await ctx.db.insert("friendships", { userA: a, userB: b });
      await ctx.db.patch(requestId, { status: "accepted" });
      await notify(ctx, request.fromId, "friend_accept", "Friend request accepted", "You're now friends.", "?view=friends", userId);
    } else {
      await ctx.db.patch(requestId, { status: "declined" });
    }
  },
});

export const cancelFriendRequest = mutation({
  args: { requestId: v.id("friendRequests") },
  handler: async (ctx, { requestId }) => {
    const userId = await currentUserId(ctx);
    const request = await ctx.db.get(requestId);
    if (!request || request.fromId !== userId) throw new Error("Request not found.");
    await ctx.db.patch(requestId, { status: "cancelled" });
  },
});

export const removeFriend = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const me = await currentUserId(ctx);
    const [a, b] = pair(me, userId);
    const friendship = await ctx.db.query("friendships").withIndex("by_pair", (q) => q.eq("userA", a).eq("userB", b)).unique();
    if (friendship) await ctx.db.delete(friendship._id);
    const requests = await ctx.db.query("friendRequests").withIndex("by_pair", (q) => q.eq("fromId", me).eq("toId", userId)).collect();
    for (const r of requests) await ctx.db.delete(r._id);
    const reverse = await ctx.db.query("friendRequests").withIndex("by_pair", (q) => q.eq("fromId", userId).eq("toId", me)).collect();
    for (const r of reverse) await ctx.db.delete(r._id);
  },
});

export const listFriends = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const asA = await ctx.db.query("friendships").withIndex("by_a", (q) => q.eq("userA", userId)).collect();
    const asB = await ctx.db.query("friendships").withIndex("by_b", (q) => q.eq("userB", userId)).collect();
    const ids = [...asA.map((f) => f.userB), ...asB.map((f) => f.userA)];
    const cards = await Promise.all(ids.map((id) => publicCard(ctx, id, userId)));
    // Online first, then alphabetical.
    return cards.sort((x, y) => {
      const rank = (s: string) => (s === "offline" ? 1 : 0);
      return rank(x.presence) - rank(y.presence) || x.displayName.localeCompare(y.displayName);
    });
  },
});

export const listRequests = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { incoming: [], outgoing: [] };
    const incoming = await ctx.db
      .query("friendRequests")
      .withIndex("by_to", (q) => q.eq("toId", userId).eq("status", "pending"))
      .collect();
    const outgoing = await ctx.db
      .query("friendRequests")
      .withIndex("by_from", (q) => q.eq("fromId", userId).eq("status", "pending"))
      .collect();
    return {
      incoming: await Promise.all(incoming.map(async (r) => ({ requestId: r._id, ...(await publicCard(ctx, r.fromId, userId)) }))),
      outgoing: await Promise.all(outgoing.map(async (r) => ({ requestId: r._id, ...(await publicCard(ctx, r.toId, userId)) }))),
    };
  },
});

// ---------------- Following ----------------

export const follow = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const me = await currentUserId(ctx);
    if (me === userId) throw new Error("You can't follow yourself.");
    await enforceRateLimit(ctx, `follow:${me}`, 60, 60_000);
    if (await isBlockedEitherWay(ctx, me, userId)) throw new Error("This user is unavailable.");
    const settings = await settingsOf(ctx, userId);
    if (settings?.followPrivacy === "none") throw new Error("This user isn't accepting new followers.");
    const existing = await ctx.db.query("follows").withIndex("by_pair", (q) => q.eq("followerId", me).eq("followingId", userId)).unique();
    if (existing) return;
    await ctx.db.insert("follows", { followerId: me, followingId: userId });
    // Deep-link straight to the follower's profile rather than the friends page.
    await notify(ctx, userId, "follow", "New follower", `${await displayNameOf(ctx, me)} started following you.`, `?profile=${me}`, me);
  },
});

export const unfollow = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const me = await currentUserId(ctx);
    const existing = await ctx.db.query("follows").withIndex("by_pair", (q) => q.eq("followerId", me).eq("followingId", userId)).unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});

export const listFollowing = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db.query("follows").withIndex("by_follower", (q) => q.eq("followerId", userId)).collect();
    return Promise.all(rows.map((r) => publicCard(ctx, r.followingId, userId)));
  },
});

export const listFollowers = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db.query("follows").withIndex("by_following", (q) => q.eq("followingId", userId)).collect();
    return Promise.all(rows.map((r) => publicCard(ctx, r.followerId, userId)));
  },
});

/** A public card enriched with the viewer's follow relationship to the target. */
async function relationCard(ctx: Parameters<typeof displayNameOf>[0], targetId: Id<"users">, viewerId?: Id<"users">) {
  const base = await publicCard(ctx, targetId, viewerId);
  let isFollowing = false;
  let followsYou = false;
  let isBlocked = false;
  if (viewerId && viewerId !== targetId) {
    isFollowing = (await ctx.db.query("follows").withIndex("by_pair", (q) => q.eq("followerId", viewerId).eq("followingId", targetId)).unique()) !== null;
    followsYou = (await ctx.db.query("follows").withIndex("by_pair", (q) => q.eq("followerId", targetId).eq("followingId", viewerId)).unique()) !== null;
    isBlocked = await isBlockedEitherWay(ctx, viewerId, targetId);
  }
  return { ...base, isFollowing, followsYou, isMutual: isFollowing && followsYou, isBlocked, isSelf: viewerId === targetId };
}

/**
 * Whether `viewerId` may browse `targetId`'s follower/following lists.
 * Reuses the profile's existing `friendsList` privacy tier:
 * everyone / friends / friends+shared communities (friends or followers) / nobody.
 */
async function canViewFollowLists(ctx: Parameters<typeof displayNameOf>[0], targetId: Id<"users">, viewerId: Id<"users"> | null) {
  if (viewerId === targetId) return true;
  if (!viewerId) return false;
  if (await isBlockedEitherWay(ctx, viewerId, targetId)) return false;
  const profile = await profileOf(ctx, targetId);
  const level = (profile?.privacy?.friendsList as string | undefined) ?? "everyone";
  if (level === "everyone") return true;
  if (level === "none") return false;
  if (await areFriends(ctx, viewerId, targetId)) return true;
  if (level === "mutual") {
    // "Friends + shared communities" also covers followers.
    const follows = await ctx.db.query("follows").withIndex("by_pair", (q) => q.eq("followerId", viewerId).eq("followingId", targetId)).unique();
    if (follows) return true;
  }
  return false;
}

/**
 * Followers, following, and mutuals for any user, with real follow state for the
 * viewer. Returns `visible: false` when the owner's privacy hides the lists.
 */
export const followLists = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const viewerId = await getAuthUserId(ctx);
    const visible = await canViewFollowLists(ctx, userId, viewerId);
    if (!visible) return { visible: false, followers: [], following: [], mutuals: [] };

    // Bounded: a hugely popular account must not make this query read the whole
    // follow graph. 500 each is far more than the modal ever renders.
    const followerRows = await ctx.db.query("follows").withIndex("by_following", (q) => q.eq("followingId", userId)).take(500);
    const followingRows = await ctx.db.query("follows").withIndex("by_follower", (q) => q.eq("followerId", userId)).take(500);

    const rank = (p: string) => (p === "offline" ? 1 : 0);
    const byPresenceThenName = <T extends { presence: string; displayName: string }>(a: T, b: T) =>
      rank(a.presence) - rank(b.presence) || a.displayName.localeCompare(b.displayName);

    const followers = (await Promise.all(followerRows.map((r) => relationCard(ctx, r.followerId, viewerId ?? undefined)))).sort(byPresenceThenName);
    const following = (await Promise.all(followingRows.map((r) => relationCard(ctx, r.followingId, viewerId ?? undefined)))).sort(byPresenceThenName);

    // Mutuals = accounts that genuinely follow each other with this user
    // (this user follows them AND they follow this user).
    const followerIds = new Set(followerRows.map((r) => r.followerId as string));
    const mutualIds = followingRows.map((r) => r.followingId).filter((id) => followerIds.has(id as string));
    const mutuals = (await Promise.all(mutualIds.map((id) => relationCard(ctx, id, viewerId ?? undefined)))).sort(byPresenceThenName);

    return { visible: true, followers, following, mutuals };
  },
});

// ---------------- Blocking ----------------

export const blockUser = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const me = await currentUserId(ctx);
    if (me === userId) throw new Error("You can't block yourself.");
    const existing = await ctx.db.query("blocks").withIndex("by_pair", (q) => q.eq("blockerId", me).eq("blockedId", userId)).unique();
    if (existing) return;
    await ctx.db.insert("blocks", { blockerId: me, blockedId: userId });
    // Blocking removes friendship and follow relationships both ways.
    const [a, b] = pair(me, userId);
    const friendship = await ctx.db.query("friendships").withIndex("by_pair", (q) => q.eq("userA", a).eq("userB", b)).unique();
    if (friendship) await ctx.db.delete(friendship._id);
    const f1 = await ctx.db.query("follows").withIndex("by_pair", (q) => q.eq("followerId", me).eq("followingId", userId)).unique();
    if (f1) await ctx.db.delete(f1._id);
    const f2 = await ctx.db.query("follows").withIndex("by_pair", (q) => q.eq("followerId", userId).eq("followingId", me)).unique();
    if (f2) await ctx.db.delete(f2._id);
    await audit(ctx, "user.block", me, `Blocked ${userId}`, "user", userId);
  },
});

export const unblockUser = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const me = await currentUserId(ctx);
    const existing = await ctx.db.query("blocks").withIndex("by_pair", (q) => q.eq("blockerId", me).eq("blockedId", userId)).unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});

export const listBlocked = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db.query("blocks").withIndex("by_blocker", (q) => q.eq("blockerId", userId)).collect();
    return Promise.all(rows.map((r) => publicCard(ctx, r.blockedId)));
  },
});

// ---------------- Reports ----------------

export const report = mutation({
  args: {
    targetType: v.union(v.literal("user"), v.literal("message"), v.literal("community"), v.literal("dmMessage")),
    targetId: v.string(),
    category: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await currentUserId(ctx);
    await enforceRateLimit(ctx, `report:${me}`, 10, 60_000);
    await ctx.db.insert("reports", {
      targetType: args.targetType,
      targetId: args.targetId,
      reporterId: me,
      category: args.category,
      description: args.description?.slice(0, 500),
      status: "open",
    });
    await audit(ctx, "report.create", me, `Reported ${args.targetType} ${args.targetId} (${args.category})`, args.targetType, args.targetId);
  },
});

// ---------------- Notifications ----------------

export const listNotifications = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { items: [], unread: 0 };
    const items = await ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(50);
    return { items, unread: items.filter((n) => !n.read).length };
  },
});

export const unreadCount = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return 0;
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_user_read", (q) => q.eq("userId", userId).eq("read", false))
      .collect();
    return unread.length;
  },
});

export const markNotificationRead = mutation({
  args: { id: v.id("notifications") },
  handler: async (ctx, { id }) => {
    const userId = await currentUserId(ctx);
    const n = await ctx.db.get(id);
    if (!n || n.userId !== userId) return;
    await ctx.db.patch(id, { read: true });
  },
});

export const markAllNotificationsRead = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await currentUserId(ctx);
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_user_read", (q) => q.eq("userId", userId).eq("read", false))
      .collect();
    for (const n of unread) await ctx.db.patch(n._id, { read: true });
  },
});

export const deleteNotification = mutation({
  args: { id: v.id("notifications") },
  handler: async (ctx, { id }) => {
    const userId = await currentUserId(ctx);
    // Only the owner can delete a notification — never another user's.
    const n = await ctx.db.get(id);
    if (!n || n.userId !== userId) return;
    await ctx.db.delete(id);
  },
});

/** Mark one notification read or unread (owner only). */
export const setNotificationRead = mutation({
  args: { id: v.id("notifications"), read: v.boolean() },
  handler: async (ctx, { id, read }) => {
    const userId = await currentUserId(ctx);
    const n = await ctx.db.get(id);
    if (!n || n.userId !== userId) return;
    await ctx.db.patch(id, { read });
  },
});

/** Remove every notification belonging to the signed-in user. */
export const clearAllNotifications = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await currentUserId(ctx);
    // Bounded so a large backlog can never build an oversized write transaction;
    // pressing "Clear all" again clears the next slice.
    const items = await ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", userId)).take(1000);
    for (const n of items) await ctx.db.delete(n._id);
    return items.length;
  },
});
