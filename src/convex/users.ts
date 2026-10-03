import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { enforceRateLimit } from "./authHelpers";
import { USERNAME_PATTERN, normalizeUsername, assertValidUsername } from "./auth";
import { avatarUrlOf, currentUserId, displayNameOf, presenceInfoOf, profileOf, settingsOf, audit, areFriends, isBlockedEitherWay } from "./lib";

// ---------- Identity helpers (username is unique, display name is not) ----------

const RESERVED_USERNAMES = new Set(["freecord", "admin", "administrator", "system", "support", "moderator", "root"]);

/** A username is unacceptable if it's reserved or already taken. */
async function usernameTaken(ctx: MutationCtx, username: string, exceptUserId?: string) {
  if (RESERVED_USERNAMES.has(username)) return true;
  const existing = await ctx.db.query("users").withIndex("username", (q) => q.eq("username", username)).unique();
  return existing !== null && existing._id !== exceptUserId;
}

/**
 * Derive a sensible display name from an email WITHOUT ever exposing the full
 * address (no domain, no numeric noise). Returns "" when nothing usable.
 */
function humanizeEmail(email?: string | null): string {
  if (!email || !email.includes("@")) return "";
  const local = email.split("@")[0] ?? "";
  const cleaned = local.replace(/[._\-]+/g, " ").replace(/\d+/g, " ").trim();
  const source = cleaned || local.replace(/[._\-]+/g, " ").trim();
  const words = source.split(/\s+/).filter(Boolean).slice(0, 3);
  const name = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ").trim();
  return name.slice(0, 40);
}

/** Build a unique, valid username from an email (falling back to "user"). */
async function generateUniqueUsername(ctx: MutationCtx, email?: string | null): Promise<string> {
  let base = "";
  if (email && email.includes("@")) {
    base = (email.split("@")[0] ?? "").toLowerCase().replace(/[^a-z0-9._]/g, "").replace(/^[._]+|[._]+$/g, "");
  }
  if (base.length < 3) base = "user";
  base = base.slice(0, 20);
  let candidate = base;
  if (!(await usernameTaken(ctx, candidate))) return candidate;
  for (let i = 0; i < 25; i++) {
    candidate = `${base}${Math.floor(1000 + Math.random() * 9000)}`.slice(0, 24);
    if (USERNAME_PATTERN.test(candidate) && !(await usernameTaken(ctx, candidate))) return candidate;
  }
  // Extremely unlikely final fallback, still guaranteed unique-ish + valid.
  candidate = `user${Date.now().toString(36).slice(-6)}`;
  return candidate;
}

/**
 * Guarantee the signed-in account has BOTH a unique username and a display
 * name. Covers email-only (OTP) accounts and legacy accounts that only ever
 * had one of the two fields. Safe to call on every app load — it is a no-op
 * once both exist.
 */
export const ensureIdentity = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await currentUserId(ctx);
    const user = await ctx.db.get(userId);
    if (!user) return null;

    let username = user.username ?? null;
    if (!username || !USERNAME_PATTERN.test(username)) {
      username = await generateUniqueUsername(ctx, user.email);
      await ctx.db.patch(userId, { username });
    }

    const fallbackName = user.name || humanizeEmail(user.email) || username;
    const profile = await profileOf(ctx, userId);
    if (!profile) {
      await ctx.db.insert("profiles", { userId, displayName: fallbackName.slice(0, 40) || username });
    } else if (!profile.displayName) {
      await ctx.db.patch(profile._id, { displayName: fallbackName.slice(0, 40) || username });
    }
    if (!user.name) await ctx.db.patch(userId, { name: (humanizeEmail(user.email) || username).slice(0, 40) });

    return { username };
  },
});

/** Real-time username availability check for the Settings UI. */
export const usernameAvailable = query({
  args: { username: v.string() },
  handler: async (ctx, { username }) => {
    const me = await getAuthUserId(ctx);
    const normalized = normalizeUsername(username);
    if (normalized.length < 3 || normalized.length > 24) {
      return { available: false, reason: "Usernames must be 3-24 characters." };
    }
    if (!USERNAME_PATTERN.test(normalized)) {
      return { available: false, reason: "Only letters, numbers, dots, and underscores are allowed." };
    }
    if (RESERVED_USERNAMES.has(normalized)) {
      return { available: false, reason: "That username is reserved." };
    }
    const existing = await ctx.db.query("users").withIndex("username", (q) => q.eq("username", normalized)).unique();
    if (existing && existing._id !== me) return { available: false, reason: "That username is already taken." };
    return { available: true, reason: null as string | null };
  },
});

/**
 * Change the unique username. Uniqueness is enforced on the users table, and
 * the password auth account handle is re-pointed so the user can keep signing
 * in with the new username. Display name is never touched here.
 */
export const setUsername = mutation({
  args: { username: v.string() },
  handler: async (ctx, { username }) => {
    const me = await currentUserId(ctx);
    const normalized = normalizeUsername(username);
    assertValidUsername(normalized);
    await enforceRateLimit(ctx, `username:${me}`, 10, 60_000);

    if (RESERVED_USERNAMES.has(normalized)) throw new Error("That username is reserved. Please choose another.");
    if (await usernameTaken(ctx, normalized, me)) throw new Error("That username is already taken. Please choose another.");

    const account = await ctx.db.query("authAccounts").withIndex("userIdAndProvider", (q) => q.eq("userId", me).eq("provider", "password")).unique();
    if (account) {
      const clash = await ctx.db.query("authAccounts").withIndex("providerAndAccountId", (q) => q.eq("provider", "password").eq("providerAccountId", normalized)).unique();
      if (clash && clash._id !== account._id) throw new Error("That username is already taken. Please choose another.");
      await ctx.db.patch(account._id, { providerAccountId: normalized });
    }
    await ctx.db.patch(me, { username: normalized });
    await audit(ctx, "user.username", me, `Changed username to ${normalized}`, "user", me);
    return { username: normalized };
  },
});

/** Change the display name (not unique) without touching the username. */
export const setDisplayName = mutation({
  args: { displayName: v.string() },
  handler: async (ctx, { displayName }) => {
    const me = await currentUserId(ctx);
    const name = displayName.trim();
    if (name.length < 1 || name.length > 40) throw new Error("Display names must be 1-40 characters.");
    if (/@(everyone|here)/i.test(name)) throw new Error("That display name isn't allowed.");
    const existing = await profileOf(ctx, me);
    if (existing) await ctx.db.patch(existing._id, { displayName: name });
    else await ctx.db.insert("profiles", { userId: me, displayName: name });
    await ctx.db.patch(me, { name });
    return { displayName: name };
  },
});

/**
 * Get the current signed in user. Returns null if the user is not signed in.
 * Usage: const signedInUser = await ctx.runQuery(api.authHelpers.currentUser);
 * THIS FUNCTION IS READ-ONLY. DO NOT MODIFY.
 */
export const currentUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    return await ctx.db.get(userId);
  },
});

/** Full account + profile + settings bundle for the signed-in user. */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    const profile = await profileOf(ctx, userId);
    const settings = await settingsOf(ctx, userId);
    // Own presence: never default to "online" — a stale session must read offline.
    const { status: presenceStatus, lastSeen } = await presenceInfoOf(ctx, userId, userId);
    return {
      userId,
      username: user?.username ?? null,
      email: user?.email ?? null,
      name: user?.name ?? null,
      image: user?.image ?? null,
      // Authoritative, freshly resolved avatar so the Dashboard updates instantly.
      avatarUrl: await avatarUrlOf(ctx, userId),
      createdAt: user?._creationTime ?? null,
      profile: profile ?? null,
      settings: settings ?? null,
      presence: presenceStatus,
      lastSeen,
    };
  },
});

/** Public profile view: username, display name, avatar, banner, bio, badges, mutuals, counts. */
export const publicProfile = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const viewerId = await getAuthUserId(ctx);
    const user = await ctx.db.get(userId);
    if (!user) return null;
    const profile = await profileOf(ctx, userId);
    const settings = await settingsOf(ctx, userId);
    const { status: presenceStatus, lastSeen } = await presenceInfoOf(ctx, userId, viewerId);

    const followers = await ctx.db
      .query("follows")
      .withIndex("by_following", (q) => q.eq("followingId", userId))
      .collect();
    const following = await ctx.db
      .query("follows")
      .withIndex("by_follower", (q) => q.eq("followerId", userId))
      .collect();

    // Mutual communities + mutual friends (only when signed in).
    let mutualCommunities: { _id: string; name: string }[] = [];
    let mutualFriends: { userId: string; name: string }[] = [];
    let isFollowing = false;
    let followsYou = false;
    let isMutual = false;
    let isFriend = false;
    let isBlocked = false;

    if (viewerId) {
      const viewerMemberships = await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", viewerId))
        .collect();
      const targetMemberships = await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
      const targetIds = new Set(targetMemberships.map((m) => m.serverId as string));
      for (const m of viewerMemberships) {
        if (targetIds.has(m.serverId as string)) {
          const server = await ctx.db.get(m.serverId);
          if (server) mutualCommunities.push({ _id: server._id, name: server.name });
        }
      }
      isFollowing =
        (await ctx.db
          .query("follows")
          .withIndex("by_pair", (q) => q.eq("followerId", viewerId).eq("followingId", userId))
          .unique()) !== null;
      followsYou =
        (await ctx.db
          .query("follows")
          .withIndex("by_pair", (q) => q.eq("followerId", userId).eq("followingId", viewerId))
          .unique()) !== null;
      isMutual = isFollowing && followsYou;
      isFriend = await areFriends(ctx, viewerId, userId);
      isBlocked = await isBlockedEitherWay(ctx, viewerId, userId);
    }

    // Presence is hidden when the owner disabled visibility.
    const presenceVisible = settings?.presenceVisible !== false;
    return {
      userId,
      username: user.username ?? null,
      displayName: profile?.displayName ?? user.name ?? user.username ?? "Freecord member",
      bio: profile?.bio ?? "",
      avatarColor: profile?.avatarColor ?? "violet",
      bannerColor: profile?.bannerColor ?? "violet",
      avatarUrl: profile?.avatarStorageId ? await ctx.storage.getUrl(profile.avatarStorageId) : user.image ?? null,
      bannerUrl: profile?.bannerStorageId ? await ctx.storage.getUrl(profile.bannerStorageId) : null,
      customStatus: profile?.customStatus ?? "",
      badges: profile?.badges ?? [],
      createdAt: user._creationTime,
      presence: presenceStatus,
      lastSeen,
      presenceVisible,
      followers: followers.length,
      following: following.length,
      mutualCommunities,
      mutualFriends,
      isFollowing,
      followsYou,
      isMutual,
      isFriend,
      isBlocked,
      publicProfile: settings?.publicProfile !== false,
    };
  },
});

/** Update profile fields (display name, bio, colors, custom status, avatar/banner). */
export const updateProfile = mutation({
  args: {
    displayName: v.optional(v.string()),
    bio: v.optional(v.string()),
    avatarColor: v.optional(v.string()),
    bannerColor: v.optional(v.string()),
    customStatus: v.optional(v.string()),
    avatarStorageId: v.optional(v.id("_storage")),
    bannerStorageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const userId = await currentUserId(ctx);
    const existing = await profileOf(ctx, userId);
    const patch: Record<string, unknown> = {};
    if (args.displayName !== undefined) {
      const name = args.displayName.trim();
      if (name.length < 1 || name.length > 40) throw new Error("Display name must be 1-40 characters.");
      patch.displayName = name;
    }
    if (args.bio !== undefined) patch.bio = args.bio.slice(0, 400);
    if (args.avatarColor !== undefined) patch.avatarColor = args.avatarColor;
    if (args.bannerColor !== undefined) patch.bannerColor = args.bannerColor;
    if (args.customStatus !== undefined) patch.customStatus = args.customStatus.slice(0, 80);
    if (args.avatarStorageId !== undefined) patch.avatarStorageId = args.avatarStorageId;
    if (args.bannerStorageId !== undefined) patch.bannerStorageId = args.bannerStorageId;

    if (existing) await ctx.db.patch(existing._id, patch);
    else await ctx.db.insert("profiles", { userId, displayName: args.displayName?.trim() || "Freecord member", ...patch });
  },
});

/** Update presence status. */
export const setStatus = mutation({
  args: { status: v.union(v.literal("online"), v.literal("idle"), v.literal("dnd"), v.literal("invisible"), v.literal("offline")) },
  handler: async (ctx, { status }) => {
    const userId = await currentUserId(ctx);
    const existing = await ctx.db.query("presence").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    if (existing) await ctx.db.patch(existing._id, { status, lastSeen: Date.now() });
    else await ctx.db.insert("presence", { userId, status, lastSeen: Date.now() });
    const profile = await profileOf(ctx, userId);
    if (profile) await ctx.db.patch(profile._id, { status });
  },
});

/** Presence heartbeat so other clients see real-time updates. */
export const heartbeat = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await currentUserId(ctx);
    const existing = await ctx.db.query("presence").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    if (existing) await ctx.db.patch(existing._id, { lastSeen: Date.now() });
    else await ctx.db.insert("presence", { userId, status: "online", lastSeen: Date.now() });
  },
});

export const updateSettings = mutation({
  args: {
    dmPrivacy: v.optional(v.string()),
    friendRequestPrivacy: v.optional(v.string()),
    followPrivacy: v.optional(v.string()),
    searchable: v.optional(v.boolean()),
    publicProfile: v.optional(v.boolean()),
    presenceVisible: v.optional(v.boolean()),
    readReceipts: v.optional(v.boolean()),
    activityVisible: v.optional(v.boolean()),
    notifyFriendRequests: v.optional(v.boolean()),
    notifyDMs: v.optional(v.boolean()),
    notifyMentions: v.optional(v.boolean()),
    notifyInvites: v.optional(v.boolean()),
    notifyFollows: v.optional(v.boolean()),
    notifyCalls: v.optional(v.boolean()),
    voiceEchoCancellation: v.optional(v.boolean()),
    voiceNoiseSuppression: v.optional(v.boolean()),
    voiceAutoMute: v.optional(v.boolean()),
    voiceInputVolume: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await currentUserId(ctx);
    const existing = await settingsOf(ctx, userId);
    if (existing) await ctx.db.patch(existing._id, args);
    else await ctx.db.insert("userSettings", { userId, ...args });
  },
});

/** Search people (respects searchable + publicProfile privacy, never returns blocked users). */
export const searchUsers = query({
  args: { q: v.string() },
  handler: async (ctx, { q }) => {
    const viewerId = await getAuthUserId(ctx);
    const term = q.trim().toLowerCase();
    if (term.length < 1) return [];
    const all = await ctx.db.query("profiles").take(500);
    const results: { userId: string; username: string; displayName: string; avatarColor: string; avatarUrl: string | null; presence: string; lastSeen: number | null }[] = [];
    for (const profile of all) {
      const user = await ctx.db.get(profile.userId);
      if (!user) continue;
      const settings = await settingsOf(ctx, profile.userId);
      if (settings?.searchable === false) continue;
      if (viewerId && (await isBlockedEitherWay(ctx, viewerId, profile.userId))) continue;
      const username = user.username ?? "";
      const haystack = `${profile.displayName} ${username}`.toLowerCase();
      if (!haystack.includes(term)) continue;
      const { status, lastSeen } = await presenceInfoOf(ctx, profile.userId, viewerId);
      results.push({
        userId: profile.userId,
        username,
        displayName: profile.displayName,
        avatarColor: profile.avatarColor ?? "violet",
        avatarUrl: await avatarUrlOf(ctx, profile.userId),
        presence: status,
        lastSeen,
      });
      if (results.length >= 25) break;
    }
    return results;
  },
});

/** Sessions/devices for the signed-in user. */
export const mySessions = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const sessions = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .collect();
    const currentSessionId = await getAuthSessionId(ctx);
    return sessions.map((s) => ({
      sessionId: s._id,
      createdAt: s._creationTime,
      expiresAt: s.expirationTime,
      current: s._id === currentSessionId,
    }));
  },
});

/** Revoke a specific session (device). */
export const revokeSession = mutation({
  args: { sessionId: v.id("authSessions") },
  handler: async (ctx, { sessionId }) => {
    const userId = await currentUserId(ctx);
    const session = await ctx.db.get(sessionId);
    if (!session || session.userId !== userId) throw new Error("Session not found.");
    const tokens = await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionId", (q) => q.eq("sessionId", sessionId))
      .collect();
    for (const t of tokens) await ctx.db.delete(t._id);
    await ctx.db.delete(sessionId);
    await audit(ctx, "session.revoke", userId, `Revoked session ${sessionId}`, "session", sessionId);
  },
});

/** Sign out everywhere except the current session. */
export const revokeOtherSessions = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await currentUserId(ctx);
    const currentSessionId = await getAuthSessionId(ctx);
    const sessions = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", userId))
      .collect();
    for (const s of sessions) {
      if (s._id === currentSessionId) continue;
      const tokens = await ctx.db
        .query("authRefreshTokens")
        .withIndex("sessionId", (q) => q.eq("sessionId", s._id))
        .collect();
      for (const t of tokens) await ctx.db.delete(t._id);
      await ctx.db.delete(s._id);
    }
    await audit(ctx, "session.revoke_others", userId, "Revoked all other sessions");
  },
});

/**
 * Delete the account and all owned data. Requires typing the username to confirm.
 * Rate limited to prevent abuse.
 */
export const deleteAccount = mutation({
  args: { confirmUsername: v.string() },
  handler: async (ctx, { confirmUsername }) => {
    const userId = await currentUserId(ctx);
    await enforceRateLimit(ctx, `delete:${userId}`, 3, 60_000);
    const user = await ctx.db.get(userId);
    if (!user) throw new Error("Account not found.");
    if ((user.username ?? "").toLowerCase() !== confirmUsername.trim().toLowerCase()) {
      throw new Error("That username doesn't match your account.");
    }

    // Owned communities: transfer nothing, delete them (and their data).
    const ownedServers = (await ctx.db.query("servers").collect()).filter((s) => s.ownerId === userId);
    for (const server of ownedServers) {
      const channels = await ctx.db.query("channels").withIndex("by_server", (q) => q.eq("serverId", server._id)).collect();
      for (const channel of channels) {
        const messages = await ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("channelId", channel._id)).collect();
        for (const m of messages) {
          const reacts = await ctx.db.query("reactions").withIndex("by_message", (q) => q.eq("messageId", m._id)).collect();
          for (const r of reacts) await ctx.db.delete(r._id);
          const files = await ctx.db.query("attachments").withIndex("by_message", (q) => q.eq("messageId", m._id)).collect();
          for (const f of files) { await ctx.storage.delete(f.storageId); await ctx.db.delete(f._id); }
          await ctx.db.delete(m._id);
        }
        await ctx.db.delete(channel._id);
      }
      const members = await ctx.db.query("memberships").withIndex("by_server", (q) => q.eq("serverId", server._id)).collect();
      for (const m of members) await ctx.db.delete(m._id);
      const roles = await ctx.db.query("communityRoles").withIndex("by_server", (q) => q.eq("serverId", server._id)).collect();
      for (const r of roles) await ctx.db.delete(r._id);
      await ctx.db.delete(server._id);
    }

    // Memberships in other communities.
    const memberships = await ctx.db.query("memberships").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    for (const m of memberships) await ctx.db.delete(m._id);

    // DMs authored or participated in.
    const dmMemberships = await ctx.db.query("dmMembers").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    for (const dm of dmMemberships) await ctx.db.delete(dm._id);

    // Social graph + notifications + presence + profile.
    for (const table of ["friendRequests", "follows", "blocks", "notifications"] as const) {
      const rows = await ctx.db.query(table).collect();
      for (const row of rows) {
        const r = row as unknown as { fromId?: string; toId?: string; followerId?: string; followingId?: string; blockerId?: string; blockedId?: string; userId?: string };
        if ([r.fromId, r.toId, r.followerId, r.followingId, r.blockerId, r.blockedId, r.userId].includes(userId as string)) {
          await ctx.db.delete(row._id);
        }
      }
    }
    const friendships = (await ctx.db.query("friendships").collect()).filter((f) => f.userA === userId || f.userB === userId);
    for (const f of friendships) await ctx.db.delete(f._id);
    const presence = await ctx.db.query("presence").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    if (presence) await ctx.db.delete(presence._id);
    const profile = await profileOf(ctx, userId);
    if (profile) {
      if (profile.avatarStorageId) await ctx.storage.delete(profile.avatarStorageId);
      if (profile.bannerStorageId) await ctx.storage.delete(profile.bannerStorageId);
      await ctx.db.delete(profile._id);
    }
    const settings = await settingsOf(ctx, userId);
    if (settings) await ctx.db.delete(settings._id);

    // Auth records.
    const accounts = await ctx.db.query("authAccounts").withIndex("userIdAndProvider", (q) => q.eq("userId", userId)).collect();
    for (const a of accounts) {
      const codes = await ctx.db.query("authVerificationCodes").withIndex("accountId", (q) => q.eq("accountId", a._id)).collect();
      for (const c of codes) await ctx.db.delete(c._id);
      await ctx.db.delete(a._id);
    }
    const sessions = await ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", userId)).collect();
    for (const s of sessions) {
      const tokens = await ctx.db.query("authRefreshTokens").withIndex("sessionId", (q) => q.eq("sessionId", s._id)).collect();
      for (const t of tokens) await ctx.db.delete(t._id);
      await ctx.db.delete(s._id);
    }

    await audit(ctx, "account.delete", userId, `Deleted account ${user.username ?? userId}`);
    await ctx.db.delete(userId);
  },
});
