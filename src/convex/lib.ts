import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

export type Ctx = QueryCtx | MutationCtx;

export async function currentUserId(ctx: Ctx): Promise<Id<"users">> {
  const id = await getAuthUserId(ctx);
  if (!id) throw new ConvexError("Please sign in first.");
  // Server-enforced moderation gate: a banned or temporarily suspended account
  // cannot perform any write action, no matter what the client sends. Reads use
  // getAuthUserId directly, so a moderated user can still be shown the reason.
  const user = await ctx.db.get(id);
  if (user) {
    if (user.banned) {
      throw new ConvexError(
        user.banReason
          ? `Your account has been suspended: ${user.banReason}`
          : "Your account has been suspended.",
      );
    }
    if (user.suspendedUntil && user.suspendedUntil > Date.now()) {
      throw new ConvexError("Your account is temporarily suspended.");
    }
  }
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
 * Effective presence for a viewer.
 *
 * A user is only "online" while their client is actually connected and still
 * heart-beating. A closed tab (connected === false) or a stale heartbeat means
 * offline immediately, so nobody is ever left permanently shown as online.
 * Invisible users read as offline to everyone but themselves.
 */
export async function presenceInfoOf(
  ctx: Ctx,
  userId: Id<"users">,
  viewerId?: Id<"users"> | null,
): Promise<{ status: string; lastSeen: number | null }> {
  const p = await ctx.db.query("presence").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
  const lastSeen = p?.lastSeen ?? null;
  let status = p?.status ?? "offline";
  if (!p) {
    status = "offline";
  } else if (p.connected === false) {
    // Tab closed / explicit disconnect.
    status = "offline";
  } else if (lastSeen !== null && Date.now() - lastSeen > 90_000) {
    // No heartbeat for 3 intervals — treat as gone even if "connected".
    status = "offline";
  }
  if (viewerId && viewerId !== userId) {
    if (status === "invisible") status = "offline";
    const settings = await settingsOf(ctx, userId);
    if (settings?.presenceVisible === false) status = "offline";
  }
  return { status, lastSeen };
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

/**
 * Display name, avatar and avatar decoration for a message author, resolved
 * with a single profile lookup so chat/DM payloads stay cheap. Decorations are
 * the same authoritative saved value used everywhere else, so the signed-in
 * user's own effect appears in their messages exactly like anyone else's.
 */
export async function authorCardOf(ctx: Ctx, userId: Id<"users">) {
  const profile = await profileOf(ctx, userId);
  const user = await ctx.db.get(userId);
  return {
    author: profile?.displayName || user?.name || user?.username || "Freecord member",
    authorAvatarUrl: profile?.avatarStorageId ? await ctx.storage.getUrl(profile.avatarStorageId) : user?.image ?? null,
    authorDecorationId: profile?.decorationId ?? null,
  };
}

/**
 * Per-execution memo for `authorCardOf`.
 *
 * A page of chat history is read as ONE query that expands every message. When
 * 150 messages come from 12 people, calling `authorCardOf` per message re-reads
 * the same 12 profiles/users (and re-resolves the same avatars) 150 times —
 * and that whole read is repeated on every reactive re-execution. This returns a
 * function that resolves each author at most once per execution, which cuts the
 * document reads of a message page by roughly (messages ÷ distinct authors).
 *
 * It is deliberately created per execution by the caller: cached values must
 * never outlive the function invocation that produced them.
 */
export function memoizeAuthorCards(ctx: Ctx) {
  const cache = new Map<string, Promise<Awaited<ReturnType<typeof authorCardOf>>>>();
  return (userId: Id<"users">) => {
    const key = userId as string;
    let card = cache.get(key);
    if (!card) {
      card = authorCardOf(ctx, userId);
      cache.set(key, card);
    }
    return card;
  };
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
    message: "notifyServerMessages",
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
    "viewChannels", "sendMessages", "attachFiles", "createThreads", "deleteMessages", "manageMessages",
    "mentionEveryone", "createChannels", "manageChannels", "kickMembers", "banMembers", "manageRoles",
    "manageCommunity", "createInvites", "useVoice", "manageMembers",
  ],
  admin: [
    "viewChannels", "sendMessages", "attachFiles", "createThreads", "deleteMessages", "manageMessages",
    "mentionEveryone", "createChannels", "manageChannels", "kickMembers", "banMembers", "manageRoles",
    "manageCommunity", "createInvites", "useVoice", "manageMembers",
  ],
  moderator: [
    "viewChannels", "sendMessages", "attachFiles", "createThreads", "deleteMessages", "manageMessages",
    "mentionEveryone", "createInvites", "useVoice", "kickMembers", "manageMembers",
  ],
  member: ["viewChannels", "sendMessages", "attachFiles", "createThreads", "useVoice", "createInvites"],
};

/** Built-in server roles, lowest to highest. */
export const SYSTEM_ROLES = ["member", "moderator", "admin", "owner"] as const;

/**
 * Channel-scoped permission check. This is the server-level authority: it uses
 * ONLY the membership/roles of this specific server and the channel's own
 * overrides — never the platform account role. A FreeBuff platform admin has no
 * special power here, and a server admin gains nothing on the platform side.
 */
export async function hasChannelPermission(
  ctx: Ctx,
  channelId: Id<"channels">,
  userId: Id<"users">,
  permission: string,
): Promise<boolean> {
  const channel = await ctx.db.get(channelId);
  if (!channel) return false;
  const server = await ctx.db.get(channel.serverId);
  if (!server) return false;
  // The server owner always has full control of their own server.
  if (server.ownerId === userId) return true;

  const membership = await membershipOf(ctx, channel.serverId, userId);
  if (!membership) return false;

  // Legacy private-channel gate (kept working alongside the override system).
  if (permission === "viewChannels" && channel.isPrivate) {
    const allowed = channel.allowedRoleIds ?? [];
    const roleKey = membership.role ?? "member";
    const ok = allowed.includes(roleKey) || Boolean(membership.customRoleId && allowed.includes(membership.customRoleId as string));
    if (!ok) return false;
  }

  let value = await hasPermission(ctx, channel.serverId, userId, permission);

  // Apply channel overrides: @everyone first, then the member's system role,
  // then their custom role. Within one entry deny wins over allow.
  const overrides = channel.overrides ?? [];
  const keys = ["everyone", membership.role ?? "member"];
  if (membership.customRoleId) keys.push(membership.customRoleId as string);
  for (const key of keys) {
    const entry = overrides.find((o) => o.target === key);
    if (!entry) continue;
    if (entry.allow.includes(permission as never)) value = true;
    if (entry.deny.includes(permission as never)) value = false;
  }
  return value;
}

/** Throws unless the member has the permission on this specific channel. */
export async function requireChannelPermission(
  ctx: Ctx,
  channelId: Id<"channels">,
  userId: Id<"users">,
  permission: string,
) {
  const ok = await hasChannelPermission(ctx, channelId, userId, permission);
  if (!ok) throw new ConvexError(`You don't have permission to do that in this channel.`);
}

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

// ---------------- Account roles & protected owners ----------------

/**
 * The ONLY accounts that may hold the highest "Owner Admin" role. Ownership is
 * keyed by email and is permanent: these addresses are recognised on sign-up and
 * on every identity sync, and can never be demoted, banned or deleted through
 * the application (see `admin.setUserRole` / `banUser` / `deleteUser`).
 */
export const PROTECTED_OWNER_EMAILS: readonly string[] = [
  "matthewisley16@gmail.com",
  "matthew@icscomp.com",
  "matthewisley23@gmail.com",
];

/** True when an email belongs to a protected Owner Admin account. */
export function isProtectedOwnerEmail(email?: string | null): boolean {
  if (!email) return false;
  return PROTECTED_OWNER_EMAILS.includes(email.trim().toLowerCase());
}

/**
 * Account role ranking. Higher number = more authority. Anchors the backend
 * authorization rules so a lower role can never act on a higher (or equal) one.
 */
export const ROLE_RANK: Record<string, number> = {
  member: 0,
  user: 0,
  moderator: 1,
  admin: 2,
  owner: 3,
  // Canonical Owner Admin value; `owner` is the legacy pre-rename alias kept so
  // existing rows keep their authority. Both rank the same.
  owner_admin: 3,
};

/** The canonical role assigned to the protected owner accounts. */
export const OWNER_ADMIN_ROLE = "owner_admin";

export function rankOf(role?: string | null): number {
  return ROLE_RANK[role ?? "user"] ?? 0;
}

/** True for any role that carries Owner Admin authority (owner_admin or legacy owner). */
export function isOwnerRole(role?: string | null): boolean {
  return rankOf(role) >= ROLE_RANK.owner;
}

/** The account role stored on the users table (defaults to "user"). */
export async function roleOfUser(ctx: Ctx, userId: Id<"users">): Promise<string> {
  const user = await ctx.db.get(userId);
  return user?.role ?? "user";
}

/**
 * A protected Owner Admin: the account's email is one of the protected owner
 * addresses. Ownership follows the email, so it cannot be transferred or lost
 * through a role change or an account rename.
 */
export async function isProtectedOwner(ctx: Ctx, userId: Id<"users">): Promise<boolean> {
  const user = await ctx.db.get(userId);
  return isProtectedOwnerEmail(user?.email);
}

/**
 * Keep the stored role in sync with the protected-owner emails: the three owner
 * addresses are always Owners, and nobody else can hold the owner role. Safe to
 * call repeatedly; only writes when the role actually needs to change.
 */
export async function syncOwnerRole(ctx: MutationCtx, userId: Id<"users">) {
  const user = await ctx.db.get(userId);
  if (!user) return;
  const shouldBeOwner = isProtectedOwnerEmail(user.email);
  if (shouldBeOwner && user.role !== OWNER_ADMIN_ROLE) {
    // Exactly one account per protected email may hold Owner Admin: if another
    // account already claimed this email, this duplicate is not promoted.
    const sameEmail = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", user.email))
      .collect();
    const alreadyOwned = sameEmail.some((u) => isOwnerRole(u.role) && u._id !== userId);
    if (!alreadyOwned) await ctx.db.patch(userId, { role: OWNER_ADMIN_ROLE });
  } else if (!shouldBeOwner && isOwnerRole(user.role)) {
    // Only the protected emails may hold Owner Admin; anything else is corrected.
    await ctx.db.patch(userId, { role: "user" });
  }
}

/**
 * Server-side gate for the Admin Panel. `admin` is the minimum role for read
 * access; write actions additionally enforce their own rank rules.
 */
export async function requirePanelAccess(ctx: Ctx, userId: Id<"users">): Promise<string> {
  const role = await roleOfUser(ctx, userId);
  if (rankOf(role) < ROLE_RANK.admin) {
    throw new ConvexError("Administrator access required.");
  }
  return role;
}

/** The singleton platform settings row (key = "global"), if it exists. */
export async function platformSettingsOf(ctx: Ctx) {
  return ctx.db.query("platformSettings").withIndex("by_key", (q) => q.eq("key", "global")).unique();
}

/**
 * Append a structured administrative audit entry. Records who performed the
 * action, the action, which account was affected, the previous/new role and a
 * timestamp (both in `auditLogs` — the rich table — and the legacy
 * `moderationLogs` feed).
 */
export async function auditAdmin(
  ctx: MutationCtx,
  entry: {
    action: string;
    actorId: Id<"users">;
    actorName: string;
    targetType: string;
    targetId?: string;
    targetUserId?: Id<"users">;
    targetName?: string;
    detail: string;
    previousRole?: string;
    newRole?: string;
    previousValue?: string;
    newValue?: string;
  },
) {
  await ctx.db.insert("auditLogs", {
    action: entry.action,
    actorId: entry.actorId,
    actorName: entry.actorName,
    targetType: entry.targetType,
    targetId: entry.targetId,
    targetUserId: entry.targetUserId,
    targetName: entry.targetName,
    detail: entry.detail,
    previousRole: entry.previousRole,
    newRole: entry.newRole,
    previousValue: entry.previousValue,
    newValue: entry.newValue,
    at: Date.now(),
  });
  await ctx.db.insert("moderationLogs", {
    action: entry.action,
    actorId: entry.actorId,
    detail: entry.detail,
  });
}
