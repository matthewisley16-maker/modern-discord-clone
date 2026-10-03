import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

export type Ctx = QueryCtx | MutationCtx;

export async function currentUserId(ctx: Ctx): Promise<Id<"users">> {
  const id = await getAuthUserId(ctx);
  if (!id) throw new ConvexError("Please sign in first.");
  return id;
}

export async function displayNameOf(ctx: Ctx, userId: Id<"users">): Promise<string> {
  const profile = await ctx.db
    .query("profiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  if (profile?.displayName) return profile.displayName;
  const user = await ctx.db.get(userId);
  return user?.name || user?.username || "Freecord member";
}

export async function profileOf(ctx: Ctx, userId: Id<"users">) {
  return ctx.db
    .query("profiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

/**
 * The user's authoritative current avatar URL.
 * Resolves the uploaded profile picture first, falling back to the account
 * image. Every card/list that renders an avatar uses this so the Dashboard,
 * chats, member lists and DMs always agree on the newest picture.
 */
export async function avatarUrlOf(ctx: Ctx, userId: Id<"users">): Promise<string | null> {
  const profile = await profileOf(ctx, userId);
  if (profile?.avatarStorageId) {
    const url = await ctx.storage.getUrl(profile.avatarStorageId);
    if (url) return url;
  }
  const user = await ctx.db.get(userId);
  return user?.image ?? null;
}

export async function settingsOf(ctx: Ctx, userId: Id<"users">) {
  return ctx.db
    .query("userSettings")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

export async function isBlockedEitherWay(ctx: Ctx, a: Id<"users">, b: Id<"users">) {
  const ab = await ctx.db.query("blocks").withIndex("by_pair", (q) => q.eq("blockerId", a).eq("blockedId", b)).unique();
  if (ab) return true;
  const ba = await ctx.db.query("blocks").withIndex("by_pair", (q) => q.eq("blockerId", b).eq("blockedId", a)).unique();
  return ba !== null;
}

export async function areFriends(ctx: Ctx, a: Id<"users">, b: Id<"users">) {
  const [first, second] = a < b ? [a, b] : [b, a];
  const row = await ctx.db
    .query("friendships")
    .withIndex("by_pair", (q) => q.eq("userA", first).eq("userB", second))
    .unique();
  return row !== null;
}

export async function notify(
  ctx: MutationCtx,
  userId: Id<"users">,
  type: string,
  title: string,
  body?: string,
  link?: string,
  actorId?: Id<"users">,
) {
  // Respect notification preferences.
  const settings = await settingsOf(ctx, userId);
  const prefKey = {
    friend_request: "notifyFriendRequests",
    friend_accept: "notifyFriendRequests",
    dm: "notifyDMs",
    mention: "notifyMentions",
    invite: "notifyInvites",
    follow: "notifyFollows",
    reply: "notifyMentions",
    call: "notifyCalls",
    announcement: "notifyInvites",
  }[type] as keyof NonNullable<typeof settings> | undefined;
  if (settings && prefKey && settings[prefKey] === false) return;

  await ctx.db.insert("notifications", {
    userId,
    type,
    title,
    body,
    link,
    actorId,
    read: false,
  });
}

export async function audit(
  ctx: MutationCtx,
  action: string,
  actorId: Id<"users"> | undefined,
  detail: string,
  targetType?: string,
  targetId?: string,
) {
  await ctx.db.insert("auditLogs", {
    action,
    actorId,
    targetType,
    targetId,
    detail,
    at: Date.now(),
  });
  await ctx.db.insert("moderationLogs", { action, actorId, detail });
}

// ---------------- Community permissions ----------------

export const ROLE_PERMISSIONS: Record<string, string[]> = {
  owner: [
    "sendMessages", "deleteMessages", "manageMessages", "createChannels", "manageChannels",
    "kickMembers", "banMembers", "manageRoles", "manageCommunity", "createInvites",
    "useVoice", "manageMembers",
  ],
  admin: [
    "sendMessages", "deleteMessages", "manageMessages", "createChannels", "manageChannels",
    "kickMembers", "banMembers", "manageRoles", "manageCommunity", "createInvites",
    "useVoice", "manageMembers",
  ],
  moderator: [
    "sendMessages", "deleteMessages", "manageMessages", "createInvites", "useVoice", "kickMembers",
  ],
  member: ["sendMessages", "useVoice", "createInvites"],
};

export async function membershipOf(ctx: Ctx, serverId: Id<"servers">, userId: Id<"users">) {
  return ctx.db
    .query("memberships")
    .withIndex("by_server_user", (q) => q.eq("serverId", serverId).eq("userId", userId))
    .unique();
}

export async function requireMember(ctx: Ctx, serverId: Id<"servers">, userId: Id<"users">) {
  const membership = await membershipOf(ctx, serverId, userId);
  if (!membership) throw new ConvexError("You are not a member of this community.");
  return membership;
}

/** Backend-authoritative permission check: custom role permissions override defaults. */
export async function hasPermission(
  ctx: Ctx,
  serverId: Id<"servers">,
  userId: Id<"users">,
  permission: string,
): Promise<boolean> {
  const server = await ctx.db.get(serverId);
  if (!server) return false;
  if (server.ownerId === userId) return true;
  const membership = await membershipOf(ctx, serverId, userId);
  if (!membership) return false;
  if (membership.role === "owner") return true;

  if (membership.customRoleId) {
    const role = await ctx.db.get(membership.customRoleId);
    if (role && role.permissions.includes(permission as never)) return true;
  }
  const base = ROLE_PERMISSIONS[membership.role ?? "member"] ?? ROLE_PERMISSIONS.member;
  return base.includes(permission);
}

export async function requirePermission(
  ctx: Ctx,
  serverId: Id<"servers">,
  userId: Id<"users">,
  permission: string,
) {
  const ok = await hasPermission(ctx, serverId, userId, permission);
  if (!ok) throw new ConvexError("You don't have permission to do that.");
}

/** Returns the user's effective permission list (for UI gating only; backend still enforces). */
export async function effectivePermissions(
  ctx: Ctx,
  serverId: Id<"servers">,
  userId: Id<"users">,
): Promise<string[]> {
  const server = await ctx.db.get(serverId);
  if (!server) return [];
  if (server.ownerId === userId) return ROLE_PERMISSIONS.owner;
  const membership = await membershipOf(ctx, serverId, userId);
  if (!membership) return [];
  const set = new Set(ROLE_PERMISSIONS[membership.role ?? "member"] ?? ROLE_PERMISSIONS.member);
  if (membership.customRoleId) {
    const role = await ctx.db.get(membership.customRoleId);
    for (const p of role?.permissions ?? []) set.add(p);
  }
  return [...set];
}

export function isTimedOut(membership: Doc<"memberships"> | null) {
  return Boolean(membership?.timeoutUntil && membership.timeoutUntil > Date.now());
}
