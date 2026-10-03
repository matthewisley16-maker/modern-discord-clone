import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
    }).index("email", ["email"]), // index for the email. do not remove or modify

    servers: defineTable({
      name: v.string(), description: v.string(), ownerId: v.id("users"), inviteCode: v.string(),
    }).index("by_invite", ["inviteCode"]),
    memberships: defineTable({ serverId: v.id("servers"), userId: v.id("users") })
      .index("by_user", ["userId"]).index("by_server", ["serverId"])
      .index("by_server_user", ["serverId", "userId"]),
    channels: defineTable({ serverId: v.id("servers"), name: v.string(), description: v.string() })
      .index("by_server", ["serverId"]),
    messages: defineTable({ channelId: v.id("channels"), userId: v.id("users"), body: v.string() })
      .index("by_channel", ["channelId"]),
    reactions: defineTable({ messageId: v.id("messages"), userId: v.id("users"), emoji: v.string() })
      .index("by_message", ["messageId"]),
    profiles: defineTable({ userId: v.id("users"), displayName: v.string() }).index("by_user", ["userId"]),
    
  },
  {
    schemaValidation: false,
  },
);

export default schema;
