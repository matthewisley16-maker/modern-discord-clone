import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";
import { gifValidator } from "./gif";

// Account-level roles, ordered from highest to lowest:
//   owner_admin -> "Owner Admin". Reserved ONLY for the protected owner accounts.
//   owner       -> legacy alias of owner_admin (pre-rename rows), same rank.
//   admin       -> platform administrator (can manage users + moderators).
//   moderator   -> can moderate, cannot manage administrators.
//   user        -> normal account.
//   member      -> legacy alias kept for backwards compatibility (= user level).
// Only the three protected owner emails may ever hold an owner role; the
// server enforces this (see lib.syncOwnerRole / admin.setUserRole).
export const ROLES = {
  OWNER_ADMIN: "owner_admin",
  OWNER: "owner",
  ADMIN: "admin",
  MODERATOR: "moderator",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.OWNER_ADMIN),
  v.literal(ROLES.OWNER),
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.MODERATOR),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

// ---- Community (server) permission model ----
export const PERMISSIONS = [
  "viewChannels",
  "sendMessages",
  "attachFiles",
  "createThreads",
  "deleteMessages",
  "manageMessages",
  "mentionEveryone",
  "createChannels",
  "manageChannels",
  "kickMembers",
  "banMembers",
  "manageRoles",
  "manageCommunity",
  "createInvites",
  "useVoice",
  "manageMembers",
] as const;
export const permissionValidator = v.union(
  ...PERMISSIONS.map((p) => v.literal(p)),
);
export type Permission = (typeof PERMISSIONS)[number];

export const communityRoleValidator = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("moderator"),
  v.literal("member"),
);

export const presenceValidator = v.union(
  v.literal("online"),
  v.literal("idle"),
  v.literal("dnd"),
  v.literal("invisible"),
  v.literal("offline"),
);

export const channelTypeValidator = v.union(
  v.literal("text"),
  v.literal("voice"),
  v.literal("video"),
);

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // OPTIONAL contact/recovery email. do not remove
      username: v.optional(v.string()), // unique login handle (lowercase)
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // account role. do not remove

      // --- moderation state (all server-enforced, never trusted from client) ---
      banned: v.optional(v.boolean()),
      bannedAt: v.optional(v.number()),
      bannedBy: v.optional(v.id("users")),
      banReason: v.optional(v.string()),
      suspendedUntil: v.optional(v.number()),
      suspendedBy: v.optional(v.id("users")),
      suspendReason: v.optional(v.string()),
    })
      .index("email", ["email"])
      .index("username", ["username"]), // indexes for email + username. do not remove or modify

    // ---------- Profiles & presence ----------
    profiles: defineTable({
      userId: v.id("users"),
      displayName: v.string(),
      bio: v.optional(v.string()),
      avatarColor: v.optional(v.string()),
      bannerColor: v.optional(v.string()),
      avatarStorageId: v.optional(v.id("_storage")),
      bannerStorageId: v.optional(v.id("_storage")),
      status: v.optional(presenceValidator),
      customStatus: v.optional(v.string()),
      badges: v.optional(v.array(v.string())),
      // --- profile customization (all free) ---
      pronouns: v.optional(v.string()),
      interests: v.optional(v.array(v.string())),
      socialLinks: v.optional(v.array(v.object({ label: v.string(), url: v.string() }))),
      theme: v.optional(v.string()), // preset id or "custom"
      themeColors: v.optional(v.object({ primary: v.string(), accent: v.string(), background: v.string(), text: v.optional(v.string()) })),
      decorationId: v.optional(v.string()),
      frameId: v.optional(v.string()),
      effectId: v.optional(v.string()),
      nameplateId: v.optional(v.string()),
      nameFont: v.optional(v.string()),
      nameEffect: v.optional(v.string()),
      nameColors: v.optional(v.array(v.string())),
      badgeOrder: v.optional(v.array(v.string())),
      avatarHistory: v.optional(v.array(v.id("_storage"))),
      widgets: v.optional(v.array(v.object({
        id: v.string(), type: v.string(), enabled: v.boolean(), position: v.number(), content: v.optional(v.string()),
      }))),
      activityType: v.optional(v.string()), // playing | listening | watching | streaming | custom
      activityName: v.optional(v.string()),
      activitySince: v.optional(v.number()),
      // per-field visibility: everyone | friends | mutual | none
      privacy: v.optional(v.object({
        bio: v.optional(v.string()), pronouns: v.optional(v.string()), badges: v.optional(v.string()),
        activity: v.optional(v.string()), socialLinks: v.optional(v.string()), widgets: v.optional(v.string()),
        friendsList: v.optional(v.string()), mutuals: v.optional(v.string()), customStatus: v.optional(v.string()),
      })),
      favorites: v.optional(v.array(v.string())),
    }).index("by_user", ["userId"]),

    /** Per-community profile overrides (nickname, avatar, bio, etc.). */
    memberProfiles: defineTable({
      serverId: v.id("servers"),
      userId: v.id("users"),
      nickname: v.optional(v.string()),
      bio: v.optional(v.string()),
      pronouns: v.optional(v.string()),
      avatarStorageId: v.optional(v.id("_storage")),
      bannerStorageId: v.optional(v.id("_storage")),
      nameFont: v.optional(v.string()),
      nameEffect: v.optional(v.string()),
      nameColors: v.optional(v.array(v.string())),
      statusText: v.optional(v.string()),
    })
      .index("by_server_user", ["serverId", "userId"])
      .index("by_user", ["userId"]),

    presence: defineTable({
      userId: v.id("users"),
      status: presenceValidator,
      manualStatus: v.optional(presenceValidator), // what the user explicitly chose
      lastSeen: v.number(),
      lastActive: v.optional(v.number()),
      connected: v.optional(v.boolean()),
    }).index("by_user", ["userId"]),

    /** Appearance + accessibility settings (per account, persisted). */
    appearance: defineTable({
      userId: v.id("users"),
      theme: v.optional(v.string()), // dark | light | midnight | contrast
      density: v.optional(v.string()), // comfortable | compact
      fontSize: v.optional(v.number()),
      messageSpacing: v.optional(v.number()),
      reducedMotion: v.optional(v.boolean()),
      customColors: v.optional(v.object({
        sidebar: v.optional(v.string()), background: v.optional(v.string()),
        channel: v.optional(v.string()), accent: v.optional(v.string()),
      })),
    }).index("by_user", ["userId"]),

    /** Server-side custom emoji and stickers. */
    emojis: defineTable({
      serverId: v.id("servers"),
      name: v.string(),
      storageId: v.id("_storage"),
      createdBy: v.id("users"),
    }).index("by_server", ["serverId"]),

    stickers: defineTable({
      serverId: v.id("servers"),
      name: v.string(),
      description: v.optional(v.string()),
      tags: v.optional(v.array(v.string())),
      storageId: v.id("_storage"),
      createdBy: v.id("users"),
    }).index("by_server", ["serverId"]),

    userSettings: defineTable({
      userId: v.id("users"),
      // privacy
      dmPrivacy: v.optional(v.string()), // everyone | friends | none
      friendRequestPrivacy: v.optional(v.string()), // everyone | mutual | none
      followPrivacy: v.optional(v.string()), // everyone | none
      searchable: v.optional(v.boolean()),
      publicProfile: v.optional(v.boolean()),
      presenceVisible: v.optional(v.boolean()),
      readReceipts: v.optional(v.boolean()),
      activityVisible: v.optional(v.boolean()),
      // notification prefs
      notifyFriendRequests: v.optional(v.boolean()),
      notifyDMs: v.optional(v.boolean()),
      notifyMentions: v.optional(v.boolean()),
      notifyInvites: v.optional(v.boolean()),
      notifyFollows: v.optional(v.boolean()),
      notifyCalls: v.optional(v.boolean()),
      // voice & video
      voiceEchoCancellation: v.optional(v.boolean()),
      voiceNoiseSuppression: v.optional(v.boolean()),
      voiceAutoMute: v.optional(v.boolean()),
      voiceInputVolume: v.optional(v.number()),
    }).index("by_user", ["userId"]),

    // ---------- Social graph ----------
    friendRequests: defineTable({
      fromId: v.id("users"),
      toId: v.id("users"),
      status: v.union(v.literal("pending"), v.literal("accepted"), v.literal("declined"), v.literal("cancelled")),
    })
      .index("by_to", ["toId", "status"])
      .index("by_from", ["fromId", "status"])
      .index("by_pair", ["fromId", "toId"]),

    friendships: defineTable({ userA: v.id("users"), userB: v.id("users") })
      .index("by_a", ["userA"])
      .index("by_b", ["userB"])
      .index("by_pair", ["userA", "userB"]),

    follows: defineTable({ followerId: v.id("users"), followingId: v.id("users") })
      .index("by_follower", ["followerId"])
      .index("by_following", ["followingId"])
      .index("by_pair", ["followerId", "followingId"]),

    blocks: defineTable({ blockerId: v.id("users"), blockedId: v.id("users") })
      .index("by_blocker", ["blockerId"])
      .index("by_blocked", ["blockedId"])
      .index("by_pair", ["blockerId", "blockedId"]),

    // ---------- Direct messages ----------
    dmConversations: defineTable({
      type: v.union(v.literal("direct"), v.literal("group")),
      name: v.optional(v.string()),
      iconColor: v.optional(v.string()),
      iconStorageId: v.optional(v.id("_storage")),
      ownerId: v.id("users"),
      lastMessageAt: v.number(),
    }).index("by_lastMessage", ["lastMessageAt"]),

    dmMembers: defineTable({
      conversationId: v.id("dmConversations"),
      userId: v.id("users"),
      pinned: v.optional(v.boolean()),
      muted: v.optional(v.boolean()),
      lastReadAt: v.optional(v.number()),
      // Group-chat administrator (scoped to this conversation only — never
      // related to platform or server administration).
      isAdmin: v.optional(v.boolean()),
      // Archived from the owner's own inbox (per member).
      archived: v.optional(v.boolean()),
    })
      .index("by_conversation", ["conversationId"])
      .index("by_user", ["userId"])
      .index("by_pair", ["conversationId", "userId"]),

    dmMessages: defineTable({
      conversationId: v.id("dmConversations"),
      userId: v.id("users"),
      body: v.string(),
      /** Optional GIF (validated provider record; no bytes are stored). */
      gif: v.optional(gifValidator),
      replyToId: v.optional(v.id("dmMessages")),
      editedAt: v.optional(v.number()),
      deleted: v.optional(v.boolean()),
      pinned: v.optional(v.boolean()),
      // --- deletion ---
      deletedForEveryone: v.optional(v.boolean()),
      deletedAt: v.optional(v.number()),
      deletedBy: v.optional(v.id("users")),
    }).index("by_conversation", ["conversationId"]),

    dmReactions: defineTable({
      messageId: v.id("dmMessages"),
      userId: v.id("users"),
      emoji: v.string(),
    }).index("by_message", ["messageId"]),

    typing: defineTable({
      scope: v.string(), // "dm:<id>" or "channel:<id>"
      userId: v.id("users"),
      at: v.number(),
      sessionId: v.optional(v.string()),
    }).index("by_scope", ["scope"]).index("by_user", ["userId"]),

    // ---------- Communities (servers) ----------
    servers: defineTable({
      name: v.string(),
      description: v.string(),
      ownerId: v.id("users"),
      inviteCode: v.string(),
      iconColor: v.optional(v.string()),
      iconStorageId: v.optional(v.id("_storage")),
      bannerColor: v.optional(v.string()),
      bannerStorageId: v.optional(v.id("_storage")),
      isPublic: v.optional(v.boolean()),
      tags: v.optional(v.array(v.string())),
      category: v.optional(v.string()),
      slowModeSeconds: v.optional(v.number()),
      locked: v.optional(v.boolean()),
    })
      .index("by_invite", ["inviteCode"])
      .index("by_public", ["isPublic"]),

    memberships: defineTable({
      serverId: v.id("servers"),
      userId: v.id("users"),
      role: v.optional(communityRoleValidator),
      timeoutUntil: v.optional(v.number()),
      customRoleId: v.optional(v.id("communityRoles")),
    })
      .index("by_user", ["userId"])
      .index("by_server", ["serverId"])
      .index("by_server_user", ["serverId", "userId"]),

    /**
     * Per-user server-rail organization: drag-and-drop order, folders/groups and
     * recently-visited servers. Stored per account so the user's personal layout
     * follows them to any device.
     *
     *  - `layout` is the top-level column order. Each entry is either a server id
     *    or `folder:<folderId>`.
     *  - `folders[].serverIds` holds the servers grouped inside a folder.
     *  - `recent` is a most-recent-first list for the server switcher.
     */
    serverOrganization: defineTable({
      userId: v.id("users"),
      layout: v.optional(v.array(v.string())),
      folders: v.optional(v.array(v.object({
        id: v.string(),
        name: v.string(),
        color: v.optional(v.string()),
        collapsed: v.boolean(),
        serverIds: v.array(v.string()),
      }))),
      recent: v.optional(v.array(v.string())),
    }).index("by_user", ["userId"]),

    communityRoles: defineTable({
      serverId: v.id("servers"),
      name: v.string(),
      color: v.optional(v.string()),
      permissions: v.array(permissionValidator),
      position: v.number(),
    }).index("by_server", ["serverId"]),

    channels: defineTable({
      serverId: v.id("servers"),
      name: v.string(),
      description: v.string(),
      type: v.optional(channelTypeValidator),
      locked: v.optional(v.boolean()),
      slowModeSeconds: v.optional(v.number()),
      // --- voice + organisation ---
      categoryId: v.optional(v.id("channelCategories")),
      position: v.optional(v.number()),
      userLimit: v.optional(v.number()), // 0 / undefined = unlimited
      isPrivate: v.optional(v.boolean()),
      allowedRoleIds: v.optional(v.array(v.string())),
      /**
       * Channel-level permission overrides, applied on top of the member's
       * server roles. Each entry targets `@everyone` ("everyone"), a built-in
       * server role ("owner" | "admin" | "moderator" | "member") or a custom
       * role id. `deny` always wins over `allow` within the same entry.
       */
      overrides: v.optional(v.array(v.object({
        target: v.string(),
        allow: v.array(permissionValidator),
        deny: v.array(permissionValidator),
      }))),
    }).index("by_server", ["serverId"]),

    /** Channel categories (folders) used to group text and voice channels. */
    channelCategories: defineTable({
      serverId: v.id("servers"),
      name: v.string(),
      position: v.number(),
    }).index("by_server", ["serverId"]),

    /**
     * Per-user "delete for me" visibility. Kept separate from the message so
     * hiding a message for one user never affects anyone else.
     */
    messageVisibility: defineTable({
      userId: v.id("users"),
      messageId: v.string(), // channel or DM message id
      channelId: v.optional(v.id("channels")),
      conversationId: v.optional(v.id("dmConversations")),
      hiddenAt: v.number(),
    })
      .index("by_user", ["userId"])
      .index("by_user_message", ["userId", "messageId"])
      // Lets storage cleanup remove "hidden for me" markers whose message is gone.
      .index("by_message", ["messageId"]),

    messages: defineTable({
      channelId: v.id("channels"),
      userId: v.id("users"),
      body: v.string(),
      /** Optional GIF (validated provider record; no bytes are stored). */
      gif: v.optional(gifValidator),
      replyToId: v.optional(v.id("messages")),
      editedAt: v.optional(v.number()),
      deleted: v.optional(v.boolean()),
      pinned: v.optional(v.boolean()),
      mentions: v.optional(v.array(v.id("users"))),
      // --- deletion ---
      deletedForEveryone: v.optional(v.boolean()),
      deletedAt: v.optional(v.number()),
      deletedBy: v.optional(v.id("users")),
      deletedByModerator: v.optional(v.boolean()),
    }).index("by_channel", ["channelId"]),

    reactions: defineTable({
      messageId: v.id("messages"),
      userId: v.id("users"),
      emoji: v.string(),
    }).index("by_message", ["messageId"]),

    attachments: defineTable({
      storageId: v.id("_storage"),
      uploaderId: v.id("users"),
      name: v.string(),
      size: v.number(),
      contentType: v.string(),
      // exactly one target
      messageId: v.optional(v.id("messages")),
      dmMessageId: v.optional(v.id("dmMessages")),
    })
      .index("by_message", ["messageId"])
      .index("by_dm_message", ["dmMessageId"])
      // Used by storage cleanup to detect a storage object that is still
      // referenced by another message before deleting it (orphan check).
      .index("by_storage", ["storageId"]),

    invites: defineTable({
      serverId: v.id("servers"),
      code: v.string(),
      createdBy: v.id("users"),
      expiresAt: v.optional(v.number()),
      maxUses: v.optional(v.number()),
      uses: v.number(),
    })
      .index("by_code", ["code"])
      .index("by_server", ["serverId"]),

    bans: defineTable({
      serverId: v.id("servers"),
      userId: v.id("users"),
      reason: v.optional(v.string()),
      byId: v.id("users"),
    })
      .index("by_server", ["serverId"])
      .index("by_server_user", ["serverId", "userId"]),

    reports: defineTable({
      targetType: v.union(v.literal("user"), v.literal("message"), v.literal("community"), v.literal("dmMessage")),
      targetId: v.string(),
      reporterId: v.id("users"),
      category: v.string(),
      description: v.optional(v.string()),
      status: v.union(v.literal("open"), v.literal("resolved"), v.literal("dismissed")),
    }).index("by_status", ["status"]),

    // ---------- Notifications ----------
    notifications: defineTable({
      userId: v.id("users"),
      type: v.string(),
      title: v.string(),
      body: v.optional(v.string()),
      link: v.optional(v.string()),
      actorId: v.optional(v.id("users")),
      read: v.boolean(),
    })
      .index("by_user", ["userId"])
      .index("by_user_read", ["userId", "read"]),

    // ---------- Voice / video ----------
    voiceSessions: defineTable({
      channelId: v.id("channels"),
      userId: v.id("users"),
      joinedAt: v.number(),
      muted: v.boolean(),
      deafened: v.boolean(),
      video: v.boolean(),
      screen: v.boolean(),
      /** Real voice-activity state driven by the client's mic analyser. */
      speaking: v.optional(v.boolean()),
      lastSpokeAt: v.optional(v.number()),
    })
      .index("by_channel", ["channelId"])
      .index("by_user", ["userId"]),

    voiceSignals: defineTable({
      channelId: v.id("channels"),
      fromUserId: v.id("users"),
      toUserId: v.id("users"),
      // "screen" announces the screen-share stream id / on-off state alongside
      // the normal SDP offer/answer and ICE candidate relay.
      kind: v.union(v.literal("offer"), v.literal("answer"), v.literal("candidate"), v.literal("screen")),
      payload: v.string(),
    }).index("by_to", ["toUserId"]),

    callInvites: defineTable({
      fromId: v.id("users"),
      toId: v.id("users"),
      conversationId: v.optional(v.id("dmConversations")),
      channelId: v.optional(v.id("channels")),
      media: v.union(v.literal("voice"), v.literal("video")),
      status: v.union(
        v.literal("ringing"),
        v.literal("accepted"),
        v.literal("declined"),
        v.literal("missed"),
        v.literal("cancelled"),
        v.literal("ended"),
        v.literal("failed"),
      ),
      startedAt: v.optional(v.number()),
      endedAt: v.optional(v.number()),
    })
      .index("by_to", ["toId", "status"])
      .index("by_from", ["fromId"]),

    /** WebRTC signaling for a DM/group call, scoped to the conversation. */
    dmCallSignals: defineTable({
      conversationId: v.id("dmConversations"),
      fromUserId: v.id("users"),
      toUserId: v.id("users"),
      // "screen" announces the screen-share stream id / on-off state alongside
      // the normal SDP offer/answer and ICE candidate relay.
      kind: v.union(v.literal("offer"), v.literal("answer"), v.literal("candidate"), v.literal("screen")),
      payload: v.string(),
    }).index("by_to", ["toUserId"]).index("by_conversation", ["conversationId"]),

    // ---------- Ops ----------
    rateLimits: defineTable({ key: v.string(), count: v.number(), windowStart: v.number() })
      .index("by_key", ["key"]),
    moderationLogs: defineTable({ action: v.string(), actorId: v.optional(v.id("users")), detail: v.string() }),

    // ---------- Storage / retention maintenance ----------
    //
    // Configurable retention + thresholds for the automatic message-history
    // cleanup. Values are optional overrides on top of the code defaults and
    // the STORAGE_* environment variables, so they can be tuned later without
    // changing (or rewriting) the application.
    storageConfig: defineTable({
      key: v.string(), // singleton: "config"
      retentionMs: v.optional(v.number()), // recent messages protected this long
      batchSize: v.optional(v.number()),
      batchSizeCritical: v.optional(v.number()),
      maxBatchesPerRun: v.optional(v.number()),
      maxBatchesCritical: v.optional(v.number()),
      warningRatio: v.optional(v.number()),
      cleanupRatio: v.optional(v.number()),
      criticalRatio: v.optional(v.number()),
      safeRatio: v.optional(v.number()),
      budgetBytes: v.optional(v.number()), // storage budget this app manages to
      budgetRows: v.optional(v.number()), // message-row budget this app manages to
      protectPinned: v.optional(v.boolean()), // pinned messages are never auto-pruned
      staleTypingMs: v.optional(v.number()),
      staleSignalMs: v.optional(v.number()),
    }).index("by_key", ["key"]),

    // Single-row operational state + lock for the cleanup job. The lock stops
    // multiple cron ticks and multiple browser clients from running cleanup at
    // the same time.
    storageState: defineTable({
      key: v.string(), // "global" or "scope:<serverId>"
      lockedUntil: v.optional(v.number()),
      lockedBy: v.optional(v.string()),
      lastRunAt: v.optional(v.number()),
      lastStatus: v.optional(v.string()),
      lastRatio: v.optional(v.number()),
      lastDeleted: v.optional(v.number()),
      totalDeleted: v.optional(v.number()),
      batchesRun: v.optional(v.number()),
      lastError: v.optional(v.string()),
      lastErrorAt: v.optional(v.number()),
      consecutiveErrors: v.optional(v.number()),
      truncated: v.optional(v.boolean()),
    }).index("by_key", ["key"]),
    auditLogs: defineTable({
      action: v.string(),
      actorId: v.optional(v.id("users")),
      targetType: v.optional(v.string()),
      targetId: v.optional(v.string()),
      detail: v.string(),
      at: v.number(),
      // Richer context for administrative actions (who / what / which user /
      // previous role / new role / timestamp). Populated by the Admin Panel.
      actorName: v.optional(v.string()),
      targetUserId: v.optional(v.id("users")),
      targetName: v.optional(v.string()),
      previousRole: v.optional(v.string()),
      newRole: v.optional(v.string()),
      previousValue: v.optional(v.string()),
      newValue: v.optional(v.string()),
    }).index("by_at", ["at"]),

    // Platform-wide settings (singleton row, key = "global"). Managed from the
    // Admin Panel and enforced server-side where they matter.
    platformSettings: defineTable({
      key: v.string(),
      announcement: v.optional(v.string()),
      newCommunitiesEnabled: v.optional(v.boolean()),
      discoveryEnabled: v.optional(v.boolean()),
      updatedAt: v.optional(v.number()),
      updatedBy: v.optional(v.id("users")),
    }).index("by_key", ["key"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
