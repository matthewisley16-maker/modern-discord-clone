import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { areFriends, currentUserId, isBlockedEitherWay, presenceInfoOf, profileOf, settingsOf } from "./lib";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

const VALID_DECORATION = new Set(["dec_stars","dec_sparkles","dec_hearts","dec_flames","dec_clouds","dec_leaves","dec_bolt","dec_snow","dec_flowers","dec_rings","dec_pixel","dec_pumpkin","dec_confetti","dec_crown"]);
const VALID_FRAME = new Set(["frame_none","frame_neon","frame_galaxy","frame_gold","frame_aurora","frame_fire","frame_ocean","frame_cherry","frame_snow","frame_retro","frame_rainbow","frame_steel"]);
const VALID_EFFECT = new Set(["effect_none","effect_particles","effect_sparkles","effect_stars","effect_snow","effect_confetti","effect_glow","effect_fireflies","effect_bubbles","effect_leaves","effect_digital","effect_aurora"]);
const VALID_PLATE = new Set(["plate_none","plate_classic","plate_neon","plate_pixel","plate_galaxy","plate_rainbow","plate_fire","plate_ocean","plate_forest","plate_minimal"]);
const VALID_THEME = new Set(["theme_midnight","theme_ocean","theme_sunset","theme_forest","theme_lavender","theme_cherry","theme_neon","theme_galaxy","theme_monochrome","theme_cyber","theme_pastel","theme_ember","theme_aurora"]);
const VALID_FONT = new Set(["default","modern","pixel","retro","rounded","elegant","arcade","handwritten","bold"]);
const VALID_NAME_EFFECT = new Set(["solid","gradient","glow","neon","shadow","outline"]);
const VALID_BADGE = new Set(["badge_early","badge_verified","badge_developer","badge_owner","badge_helper","badge_moderator","badge_creator","badge_event","badge_beta","badge_supporter","badge_staff"]);
const VALID_WIDGET = new Set(["about","activity","communities","mutuals","friends","interests","links","stats","custom"]);
const VISIBILITY = new Set(["everyone","friends","mutual","none"]);

function assertIn(set: Set<string>, value: string | undefined, label: string) {
  if (value !== undefined && value !== "" && !set.has(value)) {
    throw new Error(`Unknown ${label}.`);
  }
}

function cleanColor(value: string | undefined) {
  if (value === undefined) return undefined;
  // Only allow safe CSS hex/rgb values — never raw CSS injection.
  if (/^#[0-9a-fA-F]{3,8}$/.test(value)) return value;
  if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*[\d.]+\s*)?\)$/.test(value)) return value;
  throw new Error("Colors must be hex or rgb values.");
}

/** Build the profile payload for a viewer, applying per-field privacy. */
async function buildProfile(ctx: QueryCtx, userId: Id<"users">, viewerId: Id<"users"> | null, serverId?: Id<"servers">) {
  const user = await ctx.db.get(userId);
  if (!user) return null;
  const profile = await profileOf(ctx, userId);
  const settings = await settingsOf(ctx, userId);

  // Viewer relationship, used for privacy tiers.
  let relationship: "self" | "friend" | "mutual" | "stranger" = "stranger";
  if (viewerId === userId) relationship = "self";
  else if (viewerId) {
    if (await areFriends(ctx, viewerId, userId)) relationship = "friend";
    else {
      const mine = await ctx.db.query("memberships").withIndex("by_user", (q) => q.eq("userId", viewerId)).collect();
      const theirs = await ctx.db.query("memberships").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
      const ids = new Set(theirs.map((m) => m.serverId as string));
      if (mine.some((m) => ids.has(m.serverId as string))) relationship = "mutual";
    }
  }

  const privacy = profile?.privacy ?? {};
  const canSee = (field: keyof typeof privacy) => {
    const level = (privacy[field] as string | undefined) ?? "everyone";
    if (relationship === "self") return true;
    if (level === "everyone") return true;
    if (level === "friends") return relationship === "friend";
    if (level === "mutual") return relationship === "friend" || relationship === "mutual";
    return false; // "none"
  };

  // Per-server override.
  let memberProfile = null;
  if (serverId) {
    memberProfile = await ctx.db
      .query("memberProfiles")
      .withIndex("by_server_user", (q) => q.eq("serverId", serverId).eq("userId", userId))
      .unique();
  }

  // Effective presence (stale sessions read offline; invisible hidden from others).
  const { status: shownStatus, lastSeen } = await presenceInfoOf(ctx, userId, viewerId);
  const presenceVisible = settings?.presenceVisible !== false;

  const followers = await ctx.db.query("follows").withIndex("by_following", (q) => q.eq("followingId", userId)).collect();
  const following = await ctx.db.query("follows").withIndex("by_follower", (q) => q.eq("followerId", userId)).collect();

  let mutualCommunities: { _id: string; name: string }[] = [];
  if (viewerId && canSee("mutuals")) {
    const mine = await ctx.db.query("memberships").withIndex("by_user", (q) => q.eq("userId", viewerId)).collect();
    const theirs = await ctx.db.query("memberships").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    const ids = new Set(theirs.map((m) => m.serverId as string));
    for (const m of mine) {
      if (ids.has(m.serverId as string)) {
        const server = await ctx.db.get(m.serverId);
        if (server) mutualCommunities.push({ _id: server._id, name: server.name });
      }
    }
  }

  let isFollowing = false;
  let followsYou = false;
  let isFriend = false;
  let isBlocked = false;
  if (viewerId) {
    isFollowing = (await ctx.db.query("follows").withIndex("by_pair", (q) => q.eq("followerId", viewerId).eq("followingId", userId)).unique()) !== null;
    followsYou = (await ctx.db.query("follows").withIndex("by_pair", (q) => q.eq("followerId", userId).eq("followingId", viewerId)).unique()) !== null;
    isFriend = await areFriends(ctx, viewerId, userId);
    isBlocked = await isBlockedEitherWay(ctx, viewerId, userId);
  }
  const isMutual = isFollowing && followsYou;
  // Follower/following lists follow the profile's "friendsList" privacy tier.
  const followListsVisible = canSee("friendsList") || (viewerId === userId);

  const badges = (profile?.badgeOrder ?? profile?.badges ?? []).filter((b) => VALID_BADGE.has(b));

  return {
    userId,
    username: user.username ?? "",
    displayName: memberProfile?.nickname || profile?.displayName || user.name || user.username || "Freecord member",
    globalDisplayName: profile?.displayName ?? user.name ?? user.username ?? "Freecord member",
    nickname: memberProfile?.nickname ?? null,
    bio: canSee("bio") ? (memberProfile?.bio || profile?.bio || "") : "",
    pronouns: canSee("pronouns") ? (memberProfile?.pronouns || profile?.pronouns || "") : "",
    avatarColor: profile?.avatarColor ?? "violet",
    bannerColor: profile?.bannerColor ?? "violet",
    avatarUrl: (memberProfile?.avatarStorageId ? await ctx.storage.getUrl(memberProfile.avatarStorageId) : null)
      ?? (profile?.avatarStorageId ? await ctx.storage.getUrl(profile.avatarStorageId) : null)
      ?? user.image ?? null,
    bannerUrl: (memberProfile?.bannerStorageId ? await ctx.storage.getUrl(memberProfile.bannerStorageId) : null)
      ?? (profile?.bannerStorageId ? await ctx.storage.getUrl(profile.bannerStorageId) : null),
    customStatus: canSee("customStatus") ? (memberProfile?.statusText || profile?.customStatus || "") : "",
    badges: canSee("badges") ? badges : [],
    interests: profile?.interests ?? [],
    socialLinks: canSee("socialLinks") ? (profile?.socialLinks ?? []) : [],
    theme: profile?.theme ?? "theme_midnight",
    themeColors: profile?.themeColors ?? null,
    decorationId: profile?.decorationId ?? null,
    frameId: profile?.frameId ?? null,
    effectId: profile?.effectId ?? null,
    nameplateId: profile?.nameplateId ?? null,
    nameFont: memberProfile?.nameFont ?? profile?.nameFont ?? "default",
    nameEffect: memberProfile?.nameEffect ?? profile?.nameEffect ?? "solid",
    nameColors: memberProfile?.nameColors ?? profile?.nameColors ?? ["#ffffff"],
    widgets: canSee("widgets") ? (profile?.widgets ?? []).filter((w) => w.enabled).sort((a, b) => a.position - b.position) : [],
    activity: canSee("activity") && profile?.activityName
      ? { type: profile.activityType ?? "playing", name: profile.activityName, since: profile.activitySince ?? null }
      : null,
    createdAt: user._creationTime,
    presence: shownStatus,
    lastSeen,
    relationship,
    followers: followListsVisible ? followers.length : 0,
    following: followListsVisible ? following.length : 0,
    followListsVisible,
    mutualCommunities,
    isFollowing,
    followsYou,
    isMutual,
    isFriend,
    isBlocked,
    privacy,
    isSelf: viewerId === userId,
  };
}

export const getProfile = query({
  args: { userId: v.id("users"), serverId: v.optional(v.id("servers")) },
  handler: async (ctx, { userId, serverId }) => {
    const viewerId = await getAuthUserId(ctx);
    return buildProfile(ctx, userId, viewerId, serverId);
  },
});

/** The signed-in user's own editable profile. */
export const myProfile = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    return buildProfile(ctx, userId, userId);
  },
});

export const updateCustomization = mutation({
  args: {
    displayName: v.optional(v.string()),
    bio: v.optional(v.string()),
    pronouns: v.optional(v.string()),
    customStatus: v.optional(v.string()),
    interests: v.optional(v.array(v.string())),
    socialLinks: v.optional(v.array(v.object({ label: v.string(), url: v.string() }))),
    theme: v.optional(v.string()),
    themeColors: v.optional(v.object({ primary: v.string(), accent: v.string(), background: v.string(), text: v.optional(v.string()) })),
    decorationId: v.optional(v.string()),
    frameId: v.optional(v.string()),
    effectId: v.optional(v.string()),
    nameplateId: v.optional(v.string()),
    nameFont: v.optional(v.string()),
    nameEffect: v.optional(v.string()),
    nameColors: v.optional(v.array(v.string())),
    badges: v.optional(v.array(v.string())),
    widgets: v.optional(v.array(v.object({ id: v.string(), type: v.string(), enabled: v.boolean(), position: v.number(), content: v.optional(v.string()) }))),
    activityType: v.optional(v.string()),
    activityName: v.optional(v.string()),
    clearActivity: v.optional(v.boolean()),
    privacy: v.optional(v.object({
      bio: v.optional(v.string()), pronouns: v.optional(v.string()), badges: v.optional(v.string()),
      activity: v.optional(v.string()), socialLinks: v.optional(v.string()), widgets: v.optional(v.string()),
      friendsList: v.optional(v.string()), mutuals: v.optional(v.string()), customStatus: v.optional(v.string()),
    })),
    favorites: v.optional(v.array(v.string())),
    avatarStorageId: v.optional(v.id("_storage")),
    bannerStorageId: v.optional(v.id("_storage")),
    clearAvatar: v.optional(v.boolean()),
    clearBanner: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await currentUserId(ctx);
    const existing = await profileOf(ctx, userId);
    const patch: Record<string, unknown> = {};

    if (args.displayName !== undefined) {
      const name = args.displayName.trim();
      if (name.length < 1 || name.length > 40) throw new Error("Display name must be 1-40 characters.");
      if (/@(everyone|here)/i.test(name)) throw new Error("That display name isn't allowed.");
      patch.displayName = name;
    }
    if (args.bio !== undefined) patch.bio = args.bio.slice(0, 600);
    if (args.pronouns !== undefined) patch.pronouns = args.pronouns.slice(0, 40);
    if (args.customStatus !== undefined) patch.customStatus = args.customStatus.slice(0, 120);
    if (args.interests !== undefined) patch.interests = args.interests.slice(0, 12).map((i) => i.slice(0, 24));
    if (args.socialLinks !== undefined) {
      patch.socialLinks = args.socialLinks.slice(0, 8).map((l) => ({
        label: l.label.slice(0, 24),
        // Only http(s) links — blocks javascript: and data: URLs.
        url: /^https?:\/\//i.test(l.url) ? l.url.slice(0, 200) : "",
      })).filter((l) => l.url);
    }

    assertIn(VALID_THEME, args.theme, "theme");
    assertIn(VALID_DECORATION, args.decorationId, "decoration");
    assertIn(VALID_FRAME, args.frameId, "frame");
    assertIn(VALID_EFFECT, args.effectId, "effect");
    assertIn(VALID_PLATE, args.nameplateId, "nameplate");
    assertIn(VALID_FONT, args.nameFont, "font");
    assertIn(VALID_NAME_EFFECT, args.nameEffect, "name effect");

    if (args.theme !== undefined) patch.theme = args.theme;
    if (args.decorationId !== undefined) patch.decorationId = args.decorationId;
    if (args.frameId !== undefined) patch.frameId = args.frameId;
    if (args.effectId !== undefined) patch.effectId = args.effectId;
    if (args.nameplateId !== undefined) patch.nameplateId = args.nameplateId;
    if (args.nameFont !== undefined) patch.nameFont = args.nameFont;
    if (args.nameEffect !== undefined) patch.nameEffect = args.nameEffect;
    if (args.nameColors !== undefined) patch.nameColors = args.nameColors.slice(0, 2).map(cleanColor).filter(Boolean);
    if (args.themeColors !== undefined) {
      patch.themeColors = {
        primary: cleanColor(args.themeColors.primary) ?? "#8b5cf6",
        accent: cleanColor(args.themeColors.accent) ?? "#a78bfa",
        background: cleanColor(args.themeColors.background) ?? "#0b0b10",
        text: cleanColor(args.themeColors.text),
      };
    }
    if (args.badges !== undefined) {
      const badges = args.badges.filter((b) => VALID_BADGE.has(b));
      // Only badge_owner is granted automatically; cosmetic badges are self-selected.
      patch.badgeOrder = badges;
      patch.badges = badges;
    }
    if (args.widgets !== undefined) {
      patch.widgets = args.widgets
        .filter((w) => VALID_WIDGET.has(w.type))
        .slice(0, 12)
        .map((w, i) => ({ id: w.id.slice(0, 40), type: w.type, enabled: w.enabled, position: i, content: w.content?.slice(0, 400) }));
    }
    if (args.activityName !== undefined) {
      patch.activityName = args.activityName.slice(0, 80);
      patch.activityType = args.activityType?.slice(0, 20) ?? "playing";
      patch.activitySince = Date.now();
    }
    if (args.clearActivity) {
      patch.activityName = undefined;
      patch.activityType = undefined;
      patch.activitySince = undefined;
    }
    if (args.privacy !== undefined) {
      const clean: Record<string, string> = {};
      for (const [key, value] of Object.entries(args.privacy)) {
        if (value !== undefined && VISIBILITY.has(value)) clean[key] = value;
      }
      patch.privacy = clean;
    }
    if (args.favorites !== undefined) patch.favorites = args.favorites.slice(0, 200);
    if (args.avatarStorageId !== undefined) {
      const history = (existing?.avatarHistory ?? []).slice(0, 9);
      if (existing?.avatarStorageId) history.unshift(existing.avatarStorageId);
      patch.avatarHistory = history;
      patch.avatarStorageId = args.avatarStorageId;
    }
    if (args.clearAvatar) patch.avatarStorageId = undefined;
    if (args.bannerStorageId !== undefined) patch.bannerStorageId = args.bannerStorageId;
    if (args.clearBanner) patch.bannerStorageId = undefined;

    if (existing) await ctx.db.patch(existing._id, patch);
    else await ctx.db.insert("profiles", { userId, displayName: args.displayName?.trim() || "Freecord member", ...patch });
  },
});

/** Server-specific profile overrides. */
export const updateMemberProfile = mutation({
  args: {
    serverId: v.id("servers"),
    nickname: v.optional(v.string()),
    bio: v.optional(v.string()),
    pronouns: v.optional(v.string()),
    statusText: v.optional(v.string()),
    nameFont: v.optional(v.string()),
    nameEffect: v.optional(v.string()),
    nameColors: v.optional(v.array(v.string())),
    avatarStorageId: v.optional(v.id("_storage")),
    clearAvatar: v.optional(v.boolean()),
  },
  handler: async (ctx, { serverId, ...args }) => {
    const userId = await currentUserId(ctx);
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_server_user", (q) => q.eq("serverId", serverId).eq("userId", userId))
      .unique();
    if (!membership) throw new Error("You're not a member of this community.");

    assertIn(VALID_FONT, args.nameFont, "font");
    assertIn(VALID_NAME_EFFECT, args.nameEffect, "name effect");

    const patch: Record<string, unknown> = {};
    if (args.nickname !== undefined) patch.nickname = args.nickname.trim().slice(0, 32);
    if (args.bio !== undefined) patch.bio = args.bio.slice(0, 300);
    if (args.pronouns !== undefined) patch.pronouns = args.pronouns.slice(0, 40);
    if (args.statusText !== undefined) patch.statusText = args.statusText.slice(0, 120);
    if (args.nameFont !== undefined) patch.nameFont = args.nameFont;
    if (args.nameEffect !== undefined) patch.nameEffect = args.nameEffect;
    if (args.nameColors !== undefined) patch.nameColors = args.nameColors.slice(0, 2).map(cleanColor).filter(Boolean);
    if (args.avatarStorageId !== undefined) patch.avatarStorageId = args.avatarStorageId;
    if (args.clearAvatar) patch.avatarStorageId = undefined;

    const existing = await ctx.db
      .query("memberProfiles")
      .withIndex("by_server_user", (q) => q.eq("serverId", serverId).eq("userId", userId))
      .unique();
    if (existing) await ctx.db.patch(existing._id, patch);
    else await ctx.db.insert("memberProfiles", { serverId, userId, ...patch });
  },
});

export const getMemberProfile = query({
  args: { serverId: v.id("servers"), userId: v.id("users") },
  handler: async (ctx, { serverId, userId }) => {
    return ctx.db
      .query("memberProfiles")
      .withIndex("by_server_user", (q) => q.eq("serverId", serverId).eq("userId", userId))
      .unique();
  },
});

// ---------------- Presence ----------------

export const setPresence = mutation({
  args: {
    status: v.union(v.literal("online"), v.literal("idle"), v.literal("dnd"), v.literal("invisible"), v.literal("offline")),
    manual: v.optional(v.boolean()),
  },
  handler: async (ctx, { status, manual }) => {
    const userId = await currentUserId(ctx);
    const existing = await ctx.db.query("presence").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    const patch = {
      status,
      lastSeen: Date.now(),
      lastActive: Date.now(),
      connected: status !== "offline",
      ...(manual ? { manualStatus: status } : {}),
    };
    if (existing) await ctx.db.patch(existing._id, patch);
    else await ctx.db.insert("presence", { userId, ...patch });
  },
});

/** Presence heartbeat. Marks the user connected and refreshes lastSeen. */
export const heartbeat = mutation({
  args: { active: v.optional(v.boolean()) },
  handler: async (ctx, { active }) => {
    const userId = await currentUserId(ctx);
    const existing = await ctx.db.query("presence").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    const now = Date.now();
    if (!existing) {
      await ctx.db.insert("presence", { userId, status: "online", lastSeen: now, lastActive: now, connected: true });
      return;
    }
    // Automatic idle after 5 minutes of no interaction, unless the user
    // explicitly chose a manual status.
    const manual = existing.manualStatus;
    let next = existing.status;
    if (manual && manual !== "online") next = manual;
    else if (manual === "online") next = "online";
    else if (active === false && now - (existing.lastActive ?? existing.lastSeen) > 5 * 60_000) next = "idle";
    else if (active !== false) next = "online";
    await ctx.db.patch(existing._id, {
      status: next,
      lastSeen: now,
      connected: true,
      ...(active !== false ? { lastActive: now } : {}),
    });
  },
});

/** Called on unload — soft-disconnect with a grace period handled by lastSeen. */
export const disconnect = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return;
    const existing = await ctx.db.query("presence").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    const now = Date.now();
    // Upsert so last-seen is always recorded, even for a session that never
    // heart-beated — otherwise the user would look online with no timestamp.
    if (existing) await ctx.db.patch(existing._id, { connected: false, lastSeen: now });
    else await ctx.db.insert("presence", { userId, status: "offline", lastSeen: now, connected: false });
    // Clear typing state so nothing is left stuck on screen.
    const typing = await ctx.db.query("typing").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    for (const t of typing) await ctx.db.delete(t._id);
  },
});

/** Presence for a set of users, honouring the offline grace period. */
export const presenceFor = query({
  args: { userIds: v.array(v.id("users")) },
  handler: async (ctx, { userIds }) => {
    const viewerId = await getAuthUserId(ctx);
    const out: Record<string, { status: string; lastSeen: number | null }> = {};
    for (const id of userIds.slice(0, 200)) {
      out[id] = await presenceInfoOf(ctx, id, viewerId);
    }
    return out;
  },
});

// ---------------- Appearance ----------------

export const getAppearance = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    return ctx.db.query("appearance").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
  },
});

export const updateAppearance = mutation({
  args: {
    theme: v.optional(v.string()),
    density: v.optional(v.string()),
    fontSize: v.optional(v.number()),
    messageSpacing: v.optional(v.number()),
    reducedMotion: v.optional(v.boolean()),
    customColors: v.optional(v.object({
      sidebar: v.optional(v.string()), background: v.optional(v.string()),
      channel: v.optional(v.string()), accent: v.optional(v.string()),
    })),
  },
  handler: async (ctx, args) => {
    const userId = await currentUserId(ctx);
    const clean: Record<string, unknown> = {};
    if (args.theme !== undefined) {
      if (!["dark", "light", "midnight", "contrast", "system"].includes(args.theme)) throw new Error("Unknown theme.");
      clean.theme = args.theme;
    }
    if (args.density !== undefined) {
      if (!["comfortable", "compact"].includes(args.density)) throw new Error("Unknown density.");
      clean.density = args.density;
    }
    if (args.fontSize !== undefined) clean.fontSize = Math.max(12, Math.min(20, args.fontSize));
    if (args.messageSpacing !== undefined) clean.messageSpacing = Math.max(0, Math.min(24, args.messageSpacing));
    if (args.reducedMotion !== undefined) clean.reducedMotion = args.reducedMotion;
    if (args.customColors !== undefined) {
      clean.customColors = {
        sidebar: cleanColor(args.customColors.sidebar),
        background: cleanColor(args.customColors.background),
        channel: cleanColor(args.customColors.channel),
        accent: cleanColor(args.customColors.accent),
      };
    }
    const existing = await ctx.db.query("appearance").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
    if (existing) await ctx.db.patch(existing._id, clean);
    else await ctx.db.insert("appearance", { userId, ...clean });
  },
});

// ---------------- Suggestions ----------------

/** People suggestions based on mutual communities, excluding existing friends. */
export const suggestions = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const mine = await ctx.db.query("memberships").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
    const myServerIds = new Set(mine.map((m) => m.serverId as string));
    const seen = new Set<string>([userId as string]);
    const out: { userId: string; displayName: string; username: string; avatarColor: string; mutualCount: number }[] = [];

    for (const membership of mine) {
      const members = await ctx.db.query("memberships").withIndex("by_server", (q) => q.eq("serverId", membership.serverId)).collect();
      for (const m of members) {
        const id = m.userId as string;
        if (seen.has(id)) continue;
        seen.add(id);
        if (await isBlockedEitherWay(ctx, userId, m.userId)) continue;
        if (await areFriends(ctx, userId, m.userId)) continue;
        const profile = await profileOf(ctx, m.userId);
        const user = await ctx.db.get(m.userId);
        const theirs = await ctx.db.query("memberships").withIndex("by_user", (q) => q.eq("userId", m.userId)).collect();
        const mutualCount = theirs.filter((t) => myServerIds.has(t.serverId as string)).length;
        out.push({
          userId: id,
          displayName: profile?.displayName ?? user?.name ?? "Freecord member",
          username: user?.username ?? "",
          avatarColor: profile?.avatarColor ?? "violet",
          mutualCount,
        });
      }
    }
    return out.sort((a, b) => b.mutualCount - a.mutualCount).slice(0, 12);
  },
});

/** Owned badge grants (e.g. Community Owner) computed server-side. */
export const myBadgeGrants = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const grants: string[] = [];
    const owned = (await ctx.db.query("servers").collect()).filter((s) => s.ownerId === userId);
    if (owned.length > 0) grants.push("badge_owner");
    return grants;
  },
});
