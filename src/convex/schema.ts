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
      // New messages in community channels. Turning this off is exactly the
      // "mentions only" mode: mentions and replies still notify (they use
      // notifyMentions), plain channel chatter stops.
      notifyServerMessages: v.optional(v.boolean()),
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
      // --- Personal conversation privacy (per member, enforced by the server) ---
      // `locked`  -> the conversation needs the member's PIN before its
      //              messages can be read, but stays visible in Chats.
      // `hidden`  -> the conversation is removed from the normal Chats list and
      //              only appears in Secret Chats. Always locked as well.
      locked: v.optional(v.boolean()),
      hidden: v.optional(v.boolean()),
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
      /**
       * Server invitations carried by this message (one row per recipient, so
       * every member of a group DM sees their OWN pending/joined state on the
       * same card). Absent on ordinary messages.
       */
      serverInviteIds: v.optional(v.array(v.id("serverInviteCards"))),
    })
      // Same implicit send-time ordering as `messages.by_channel`, for direct
      // conversations.
      .index("by_conversation", ["conversationId"]),

    dmReactions: defineTable({
      messageId: v.id("dmMessages"),
      userId: v.id("users"),
      emoji: v.string(),
    }).index("by_message", ["messageId"]),

    /**
     * One row per account holding the hashed Secret Chats PIN plus its
     * attempt/lockout bookkeeping. The PIN itself is NEVER stored, returned or
     * logged — only a one-way hash (and only the server ever sees that).
     */
    conversationPins: defineTable({
      userId: v.id("users"),
      pinHash: v.string(),
      failedAttempts: v.number(),
      lockedUntil: v.optional(v.number()), // temporary lockout after repeated failures
      mustChangePin: v.optional(v.boolean()), // true while the PIN is the temp "0000"
      defaultHidden: v.optional(v.boolean()), // where NEW protected conversations go
      autoLockMinutes: v.optional(v.number()), // how long an unlock lasts
      updatedAt: v.number(),
    }).index("by_user", ["userId"]),

    /**
     * OPTIONAL Admin PIN — one row per administrator who chooses to use it.
     *
     * Completely separate from normal Freecord sign-in and from the conversation
     * PINs above: it only gates the Admin Panel's protected pages, and it never
     * grants authority. A missing row means "no PIN protection", which is the
     * default state for every account, including administrators — nothing forces
     * a PIN to be created. Only the server reads or writes this row, and it is
     * only ever touched for the signed-in administrator themself.
     */
    adminPinSettings: defineTable({
      userId: v.id("users"),
      /** The administrator's explicit preference: false = protection off. */
      enabled: v.boolean(),
      /** One-way Scrypt hash of the 1–10 digit PIN. Never returned to a client. */
      pinHash: v.optional(v.string()),
      failedAttempts: v.number(),
      lockedUntil: v.optional(v.number()), // progressive delay after repeated failures
      /** When the last wrong PIN was entered (drives the delay escalation). */
      lastFailedAt: v.optional(v.number()),
      /**
       * Short-lived elevation for ONE auth session, granted by a correct PIN.
       * Scoped to `unlockedSessionId` so signing out or opening another device
       * asks for the PIN again.
       */
      unlockedUntil: v.optional(v.number()),
      unlockedSessionId: v.optional(v.string()),
      /** Set by "Skip for now" so a deliberate choice is never re-prompted. */
      skippedAt: v.optional(v.number()),
      updatedAt: v.number(),
    }).index("by_user", ["userId"]),

    /**
     * OPTIONAL site locks — one row per member who chooses to use them.
     *
     * Freecord can be opened behind a short numeric PIN and/or an extra
     * password, and BOTH are entirely optional and independent: no row at all
     * means "no lock", which is the default for every account. A row exists
     * only once a member deliberately turns a lock on, so nothing here is ever
     * created, prompted for or required on their behalf.
     *
     * These credentials are NOT account authentication — signing in still goes
     * through the existing auth provider. They are an extra door on an already
     * signed-in session, granting access to nothing but the member's own UI, and
     * they can never be used to reach someone else's data. Hashes are Scrypt (a
     * random salt per credential) and are never returned to any client; plain
     * values are never stored, logged or sent anywhere but the verification
     * step.
     */
    siteLocks: defineTable({
      userId: v.id("users"),
      /** Explicit preferences — absent/false means that lock is off. */
      pinEnabled: v.optional(v.boolean()),
      passwordEnabled: v.optional(v.boolean()),
      /**
       * One-way Scrypt hashes (a fresh random salt per credential). The PIN is
       * hashed as the STRING the member typed, never as a number, so leading
       * zeros such as "0042" survive hashing and stay distinct from "42".
       */
      pinHash: v.optional(v.string()),
      passwordHash: v.optional(v.string()),
      /**
       * Per-SESSION verification, with the member's own idle window on top: the
       * auth session that proved a credential stays verified while that device is
       * being used, and asks again after `autoLockMinutes` without activity —
       * while signing out or expiring that session locks the site again
       * immediately.
       *
       * Superseded by `siteLockGrants` (one row per session): these two fields can
       * only ever name ONE session, so writing a second device's id here used to
       * lock an already-unlocked first device. They are still read as a fallback
       * for a session that was verified before that table existed.
       */
      verifiedPinSessionId: v.optional(v.string()),
      verifiedPasswordSessionId: v.optional(v.string()),
      /**
       * WHEN the enabled credentials are asked for again, interpreted only by
       * `siteAutoLockMode()` in `src/lib/site-lock.ts`:
       *
       *   - absent / 0 — every page load (the default): a proof belongs to one
       *     page load, so a refresh, closing and reopening, a new tab or a new
       *     sign-in asks again,
       *   - 1–480 — an inactivity window on that device (asked again once it has
       *     sat unused that long),
       *   - -1 — never until sign-out (`SITE_AUTO_LOCK_NEVER`).
       *
       * A proof that does not qualify stops counting everywhere, on the server
       * too, so no client can stretch it.
       */
      autoLockMinutes: v.optional(v.number()),
      /** Progressive delay after consecutive wrong entries (shared ladder). */
      failedAttempts: v.number(),
      lockedUntil: v.optional(v.number()),
      lastFailedAt: v.optional(v.number()),
      /** Emailed recovery code for a forgotten PIN/password (hashed, expiring). */
      recoveryCodeHash: v.optional(v.string()),
      recoveryCodeExpiresAt: v.optional(v.number()),
      recoveryAttempts: v.optional(v.number()),
      updatedAt: v.number(),
    }).index("by_user", ["userId"]),

    /**
     * One row per (auth session, factor, page load) proving that an optional site
     * lock's credential was entered on THAT session (and, in the default mode, by
     * that page load — a second tab keeps its own row instead of evicting the
     * first one's proof).
     *
     * This is what makes the site lock per DEVICE instead of per account: every
     * device holds its own rows, so unlocking on a second device cannot re-lock
     * the first one, and "Lock now" on one device only clears that device's own
     * rows. Rows are pruned once their auth session is gone or expired, and any
     * row older than a day is dropped (`SITE_AUTO_LOCK_STALE_PROOF_MS`).
     *
     * `verifiedAt` is both the moment of the proof and the anchor of the timer
     * mode: it is moved forward while the device is used, and a row whose idle
     * window has closed is ignored (the credential is asked for again).
     *
     * `pageId` is the auto-lock's other half: in the default "every page load"
     * mode only a proof claimed by the CURRENT page load counts, so a refresh (a
     * new id) is asked again. It is a per-page-load marker, never a secret.
     */
    siteLockGrants: defineTable({
      userId: v.id("users"),
      /** The auth session this proof belongs to (a string, like the legacy field). */
      sessionId: v.string(),
      factor: v.union(v.literal("pin"), v.literal("password")),
      verifiedAt: v.number(),
      /** The page load that claimed this proof (see `src/lib/page-session.ts`). */
      pageId: v.optional(v.string()),
    })
      .index("by_user", ["userId"])
      .index("by_user_session", ["userId", "sessionId", "factor"]),

    /**
     * Short-lived unlock grants. `conversationId` is absent for a grant that
     * covers every locked conversation (issued by the Secret Chats screen); a
     * concrete id unlocks exactly one conversation (the Lock Only prompt).
     * Queries must find a live grant before returning locked messages.
     */
    conversationUnlocks: defineTable({
      userId: v.id("users"),
      conversationId: v.optional(v.id("dmConversations")),
      expiresAt: v.number(),
      /**
       * The auth session that entered the PIN. Grants are scoped to a session,
       * so signing out (or signing in on another device) locks protected
       * conversations again immediately.
       */
      sessionId: v.optional(v.id("authSessions")),
    })
      .index("by_user", ["userId"])
      .index("by_user_conversation", ["userId", "conversationId"])
      // Lets a deleted conversation purge every stale per-chat lock grant.
      .index("by_conversation", ["conversationId"]),

    /** One-time Secret Chats PIN reset codes (hashed, expiring, single use). */
    pinResets: defineTable({
      userId: v.id("users"),
      email: v.string(),
      codeHash: v.string(),
      expiresAt: v.number(),
      attempts: v.number(),
    }).index("by_user", ["userId"]),

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
      /** Per-member "mute this community" (notifications only, never messages). */
      muted: v.optional(v.boolean()),
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
    /**
     * Per-user, per-channel notification mutes. Channel-scoped so muting one
     * channel never silences the rest of the community; the message fan-out
     * reads it once per channel (indexed by channelId) instead of per user.
     */
    channelMutes: defineTable({
      userId: v.id("users"),
      channelId: v.id("channels"),
    })
      .index("by_user", ["userId"])
      .index("by_channel", ["channelId"])
      .index("by_user_channel", ["userId", "channelId"]),

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
      /**
       * When this "Delete for me" RETENTION ENTRY expired (hiddenAt + 7 days).
       * Written by the bounded sweep in `deleteForMeRetention.ts`; optional, and
       * deliberately NOT the source of truth — `hiddenAt` decides, so the panel
       * is correct even before the sweep runs. The row itself stays: it is what
       * keeps the message hidden for this user, which must never be undone by an
       * expiry (that would silently resurrect a deleted message for them).
       */
      entryExpiredAt: v.optional(v.number()),
    })
      .index("by_user", ["userId"])
      .index("by_user_message", ["userId", "messageId"])
      // Lets storage cleanup remove "hidden for me" markers whose message is gone.
      .index("by_message", ["messageId"])
      // Bounded, indexed expiry of retained "delete for me" entries: lets the
      // sweep read ONLY the markers whose seven-day window has already closed
      // (oldest first) instead of scanning the visibility table.
      .index("by_hidden_at", ["hiddenAt"]),

    /**
     * Progress of one bounded maintenance pass (the "delete for me" retention
     * sweep). It stores how far the sweep has already expired entries, so the
     * job always moves forward over the oldest unexpired rows instead of
     * re-reading the same already-expired prefix on every run.
     */
    retentionState: defineTable({
      key: v.string(),
      /** Every entry with `hiddenAt` <= this instant has been expired. */
      cursorHiddenAt: v.number(),
      updatedAt: v.number(),
    }).index("by_key", ["key"]),

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
      /**
       * Server invitations carried by this message. A channel message carries a
       * POSTED invitation (one shareable row that any member of this channel may
       * accept), so a page of history resolves its card in one indexed read
       * instead of scanning the invitations table. Absent on ordinary messages.
       */
      serverInviteIds: v.optional(v.array(v.id("serverInviteCards"))),
    })
      // `_creationTime` is appended to every index automatically, so `by_channel`
      // already yields one channel's messages in send-time order — which is what
      // Admin Panel → Cleanup & Maintenance pages through when deleting a
      // channel's messages by date.
      .index("by_channel", ["channelId"]),

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

    /**
     * A Discord-style server invitation delivered through a DM or posted into a
     * community channel.
     *
     * Deliberately separate from `invites` (the reusable share-code table): a DM
     * row is addressed to ONE recipient and is redeemed only by that recipient
     * accepting it; a channel row has no recipient and may be accepted by any
     * member who can see the message it is attached to. Nothing here can join
     * anyone automatically — membership is inserted by `serverInvites.respond`
     * after the recipient accepts, and only once.
     */
    serverInviteCards: defineTable({
      serverId: v.id("servers"),
      inviterId: v.id("users"),
      /**
       * The person this invitation is addressed to. ABSENT for an invitation
       * that was posted into a community channel instead of DM'd: such a card is
       * a shared invitation that any member who can see the message may accept,
       * and every accept still goes through `serverInvites.respond` (one
       * membership row per person, counted in `joins`).
       */
      recipientId: v.optional(v.id("users")),
      /** Secure, unguessable identifier used for preview/pending checks. */
      code: v.string(),
      /** Where the card was delivered: a DM conversation … */
      conversationId: v.optional(v.id("dmConversations")),
      messageId: v.optional(v.id("dmMessages")),
      /** … or a community channel message. */
      channelId: v.optional(v.id("channels")),
      channelMessageId: v.optional(v.id("messages")),
      /** How many people joined through a posted channel invitation. */
      joins: v.optional(v.number()),
      status: v.union(
        v.literal("pending"),
        v.literal("accepted"),
        v.literal("declined"),
        v.literal("revoked"),
      ),
      createdAt: v.number(),
      expiresAt: v.number(),
      resolvedAt: v.optional(v.number()),
    })
      .index("by_code", ["code"])
      .index("by_recipient", ["recipientId"])
      .index("by_inviter", ["inviterId"])
      .index("by_server", ["serverId"])
      .index("by_conversation", ["conversationId"])
      // Deleting a message deletes the invitations it carried.
      .index("by_message", ["messageId"])
      .index("by_channel_message", ["channelMessageId"]),

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
      .index("by_from", ["fromId"])
      // Joining an invitation always asks "is this call still running?" — and
      // that question is asked from a reactive query, so it must not scan every
      // call ever placed.
      .index("by_conversation", ["conversationId", "status"]),

    /**
     * Invitations to join an EXISTING call.
     *
     * Deliberately NOT `callInvites`: that table IS the direct-call/ringing
     * system. An invitation must never ring, auto-connect, or touch the
     * recipient's camera/microphone — it is a notification they may accept or
     * decline. It references the already-running call (a channel's voice
     * session, or a conversation's DM call) and never creates a call of its own.
     */
    callInvitations: defineTable({
      fromId: v.id("users"),
      toId: v.id("users"),
      conversationId: v.optional(v.id("dmConversations")),
      channelId: v.optional(v.id("channels")),
      media: v.union(v.literal("voice"), v.literal("video")),
      status: v.union(
        v.literal("pending"),
        v.literal("accepted"),
        v.literal("declined"),
        v.literal("expired"),
        v.literal("cancelled"),
      ),
      createdAt: v.number(),
      expiresAt: v.number(),
      resolvedAt: v.optional(v.number()),
    })
      .index("by_to", ["toId", "status"])
      .index("by_from", ["fromId"])
      .index("by_channel", ["channelId"])
      .index("by_conversation", ["conversationId"]),

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
    /**
     * Admin Panel → Cleanup & Maintenance jobs.
     *
     * One row per cleanup RUN (message deletion by time/scope, or a general
     * system cleanup). The row is the durable history entry AND the progress
     * record the UI polls: it is written only by the server, and it is what lets
     * a large cleanup run in bounded batches without ever holding one long
     * transaction or timing out.
     *
     * SAFETY: this table deliberately keeps NO message content and is never
     * deleted by cleanup, so the record of who deleted what, when and with which
     * filters survives the messages themselves. Authorization is re-checked on
     * every batch (see `runJobBatch`), not just when the job was created.
     */
    cleanupJobs: defineTable({
      /** Which tool ran. */
      kind: v.union(v.literal("messages"), v.literal("general")),
      status: v.union(
        v.literal("running"),
        v.literal("completed"),
        v.literal("failed"),
        v.literal("cancelled"),
      ),
      /** What the job is scoped to: all messages, one community, channel or conversation. */
      scopeKind: v.union(v.literal("all"), v.literal("community"), v.literal("channel"), v.literal("conversation")),
      /** The community/channel/conversation id for a scoped job (absent for `all`). */
      scopeId: v.optional(v.string()),
      /** Human-readable scope, e.g. "Community: Design Club" — kept in history. */
      scopeLabel: v.string(),
      /** Human-readable time range, including the time zone that was applied. */
      rangeLabel: v.string(),
      /** The range actually used (ms since epoch, server time). */
      from: v.optional(v.number()),
      to: v.optional(v.number()),
      /** General jobs: which categories were selected. */
      categories: v.optional(v.array(v.string())),
      /** Who ran it — never a credential, only the display identity. */
      actorId: v.id("users"),
      actorName: v.string(),
      startedAt: v.number(),
      /** Last time this job made progress (drives stale-job recovery). */
      updatedAt: v.optional(v.number()),
      finishedAt: v.optional(v.number()),
      /** Progress + outcome counters. */
      batches: v.number(),
      channelMessagesDeleted: v.number(),
      dmMessagesDeleted: v.number(),
      attachmentsDeleted: v.number(),
      recordsDeleted: v.number(),
      bytesFreed: v.number(),
      errors: v.number(),
      /** A short, secret-free sample of the last failure. */
      lastError: v.optional(v.string()),
      /**
       * Resume point for message jobs together with `doneScopes`.
       *
       * Message cleanup walks the channels and conversations one by one (each an
       * INDEXED, time-bounded scan, so a window in the middle of a long history
       * is reached without reading everything before it). `doneScopes` holds the
       * ids whose window is already fully swept, so a large job resumes exactly
       * where it stopped even when it spans many batches — and `cursorCreatedAt`
       * records how far this batch got through that list, so progress is visible.
       */
      doneScopes: v.optional(v.array(v.string())),
      cursorCreatedAt: v.optional(v.number()),
      /** True once a batch came back short (nothing left to delete). */
      drained: v.optional(v.boolean()),
      /** Short human summary lines shown in the history table. */
      summary: v.optional(v.array(v.string())),
    })
      .index("by_started", ["startedAt"])
      // Lets the panel find the active job (at most one may run) and the lock.
      .index("by_status", ["status"]),

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
      // Circuit breaker: no new sweep starts before this time, and repeated
      // failures back off exponentially (see storage.runCleanup).
      cooldownUntil: v.optional(v.number()),
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
