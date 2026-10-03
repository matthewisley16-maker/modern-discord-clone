import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { query } from "./_generated/server";
import { avatarUrlOf, isBlockedEitherWay, presenceInfoOf, profileOf } from "./lib";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

/** Matches an @username token (3–24 chars, letters/numbers/dot/underscore). */
const MENTION_RE = /@[a-z0-9._]{2,24}/gi;

/** Unique, lower-cased usernames mentioned in a message body. */
export function extractUsernames(body: string): string[] {
  return [...new Set((body.match(MENTION_RE) ?? []).map((m) => m.slice(1).toLowerCase()))];
}

/**
 * Resolve the @usernames in a body to real user ids, restricted to people who
 * can actually see the message (server members / DM participants). Used so the
 * client can render clickable mentions backed by real ids — never guessed.
 */
export async function resolveMentions(
  ctx: QueryCtx,
  body: string,
  scope: { serverId?: Id<"servers">; conversationId?: Id<"dmConversations"> },
): Promise<{ username: string; userId: Id<"users"> }[]> {
  const usernames = extractUsernames(body);
  if (usernames.length === 0) return [];
  const out: { username: string; userId: Id<"users"> }[] = [];
  for (const uname of usernames) {
    const target = await ctx.db.query("users").withIndex("username", (q) => q.eq("username", uname)).unique();
    if (!target) continue;
    if (scope.serverId) {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_server_user", (q) => q.eq("serverId", scope.serverId!).eq("userId", target._id))
        .unique();
      if (!membership) continue;
    } else if (scope.conversationId) {
      const member = await ctx.db
        .query("dmMembers")
        .withIndex("by_pair", (q) => q.eq("conversationId", scope.conversationId!).eq("userId", target._id))
        .unique();
      if (!member) continue;
    }
    out.push({ username: uname, userId: target._id });
  }
  return out;
}

/**
 * Mention suggestions for the composer, salted with real relationships.
 *
 * Priority: mutual follows → people you follow → friends → other people in the
 * current community/DM. Blocked users and the requester are never returned.
 */
export const candidates = query({
  args: {
    serverId: v.optional(v.id("servers")),
    conversationId: v.optional(v.id("dmConversations")),
    q: v.optional(v.string()),
  },
  handler: async (ctx, { serverId, conversationId, q }) => {
    const me = await getAuthUserId(ctx);
    if (!me) return [];

    const ids = new Set<string>();
    let scoped = false;

    if (serverId) {
      const mine = await ctx.db
        .query("memberships")
        .withIndex("by_server_user", (x) => x.eq("serverId", serverId).eq("userId", me))
        .unique();
      if (!mine) return [];
      scoped = true;
      for (const m of await ctx.db.query("memberships").withIndex("by_server", (x) => x.eq("serverId", serverId)).collect()) {
        ids.add(m.userId as string);
      }
    } else if (conversationId) {
      const members = await ctx.db.query("dmMembers").withIndex("by_conversation", (x) => x.eq("conversationId", conversationId)).collect();
      if (!members.some((m) => m.userId === me)) return [];
      scoped = true;
      for (const m of members) ids.add(m.userId as string);
    }

    // People the viewer follows / friends / community co-members always eligible.
    const follows = await ctx.db.query("follows").withIndex("by_follower", (x) => x.eq("followerId", me)).collect();
    const followingSet = new Set(follows.map((f) => f.followingId as string));
    const followers = await ctx.db.query("follows").withIndex("by_following", (x) => x.eq("followingId", me)).collect();
    const followerSet = new Set(followers.map((f) => f.followerId as string));
    const asA = await ctx.db.query("friendships").withIndex("by_a", (x) => x.eq("userA", me)).collect();
    const asB = await ctx.db.query("friendships").withIndex("by_b", (x) => x.eq("userB", me)).collect();
    const friendSet = new Set<string>([...asA.map((f) => f.userB as string), ...asB.map((f) => f.userA as string)]);

    if (!scoped) {
      for (const id of followingSet) ids.add(id);
      for (const id of friendSet) ids.add(id);
      const mine = await ctx.db.query("memberships").withIndex("by_user", (x) => x.eq("userId", me)).collect();
      for (const m of mine) {
        for (const row of await ctx.db.query("memberships").withIndex("by_server", (x) => x.eq("serverId", m.serverId)).collect()) {
          ids.add(row.userId as string);
        }
      }
    }

    ids.delete(me as string);
    const term = (q ?? "").trim().toLowerCase();

    const cards: {
      userId: Id<"users">;
      username: string;
      displayName: string;
      avatarUrl: string | null;
      presence: string;
      isFollowing: boolean;
      followsYou: boolean;
      isMutual: boolean;
      isFriend: boolean;
      rank: number;
    }[] = [];

    for (const idStr of ids) {
      const id = idStr as Id<"users">;
      const user = await ctx.db.get(id);
      if (!user?.username) continue;
      const profile = await profileOf(ctx, id);
      const displayName = profile?.displayName || user.name || user.username;
      if (term && !displayName.toLowerCase().includes(term) && !user.username.toLowerCase().includes(term)) continue;
      if (await isBlockedEitherWay(ctx, me, id)) continue;
      const isFollowing = followingSet.has(idStr);
      const followsYou = followerSet.has(idStr);
      const isMutual = isFollowing && followsYou;
      const isFriend = friendSet.has(idStr);
      // Lower rank sorts first: mutual → following → friend → in-server → other.
      const rank = isMutual ? 0 : isFollowing ? 1 : isFriend ? 2 : 3;
      const { status } = await presenceInfoOf(ctx, id, me);
      cards.push({
        userId: id,
        username: user.username,
        displayName,
        avatarUrl: await avatarUrlOf(ctx, id),
        presence: status,
        isFollowing,
        followsYou,
        isMutual,
        isFriend,
        rank,
      });
    }

    cards.sort((a, b) => a.rank - b.rank || a.displayName.localeCompare(b.displayName));
    return cards.slice(0, 8);
  },
});
