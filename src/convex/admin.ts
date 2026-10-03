import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { currentUserId, displayNameOf, audit } from "./lib";
import { ROLES } from "./schema";

/** Admin role is stored on the users table and enforced on the server only. */
async function requireAdmin(ctx: Parameters<typeof displayNameOf>[0], userId: string) {
  const user = await ctx.db.get(userId as never);
  const u = user as { role?: string } | null;
  if (!u || u.role !== ROLES.ADMIN) {
    throw new Error("Administrator access required.");
  }
}

export const amIAdmin = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return false;
    const user = await ctx.db.get(userId);
    return user?.role === ROLES.ADMIN;
  },
});

export const stats = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    if (user?.role !== ROLES.ADMIN) return null;

    const users = await ctx.db.query("users").take(1000);
    const servers = await ctx.db.query("servers").take(1000);
    const channels = await ctx.db.query("channels").take(1000);
    const messages = await ctx.db.query("messages").take(1000);
    const dms = await ctx.db.query("dmConversations").take(1000);
    const reports = await ctx.db.query("reports").take(1000);
    const bans = await ctx.db.query("bans").take(1000);
    const voice = await ctx.db.query("voiceSessions").take(1000);

    return {
      users: users.length,
      communities: servers.length,
      channels: channels.length,
      messages: messages.length,
      dmConversations: dms.length,
      openReports: reports.filter((r) => r.status === "open").length,
      bans: bans.length,
      activeVoice: voice.length,
    };
  },
});

export const listUsers = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const me = await ctx.db.get(userId);
    if (me?.role !== ROLES.ADMIN) return [];
    const users = await ctx.db.query("users").take(200);
    return Promise.all(
      users.map(async (u) => ({
        userId: u._id,
        username: u.username ?? "",
        name: await displayNameOf(ctx, u._id),
        email: u.email ?? null,
        role: u.role ?? "user",
        createdAt: u._creationTime,
        isAnonymous: u.isAnonymous ?? false,
      })),
    );
  },
});

export const listReports = query({
  args: { status: v.optional(v.union(v.literal("open"), v.literal("resolved"), v.literal("dismissed"))) },
  handler: async (ctx, { status }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const me = await ctx.db.get(userId);
    if (me?.role !== ROLES.ADMIN) return [];
    const reports = status
      ? await ctx.db.query("reports").withIndex("by_status", (q) => q.eq("status", status)).take(200)
      : await ctx.db.query("reports").take(200);
    return Promise.all(
      reports.map(async (r) => ({
        ...r,
        reporter: await displayNameOf(ctx, r.reporterId),
      })),
    );
  },
});

export const listBans = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const me = await ctx.db.get(userId);
    if (me?.role !== ROLES.ADMIN) return [];
    const bans = await ctx.db.query("bans").take(200);
    return Promise.all(
      bans.map(async (b) => {
        const server = await ctx.db.get(b.serverId);
        return { ...b, userName: await displayNameOf(ctx, b.userId), communityName: server?.name ?? "" };
      }),
    );
  },
});

export const listAuditLogs = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const me = await ctx.db.get(userId);
    if (me?.role !== ROLES.ADMIN) return [];
    const logs = await ctx.db.query("auditLogs").withIndex("by_at").order("desc").take(100);
    return Promise.all(
      logs.map(async (l) => ({ ...l, actor: l.actorId ? await displayNameOf(ctx, l.actorId) : "system" })),
    );
  },
});

export const resolveReport = mutation({
  args: { reportId: v.id("reports"), status: v.union(v.literal("resolved"), v.literal("dismissed")) },
  handler: async (ctx, { reportId, status }) => {
    const userId = await currentUserId(ctx);
    await requireAdmin(ctx, userId);
    await ctx.db.patch(reportId, { status });
    await audit(ctx, `report.${status}`, userId, `Report ${reportId} marked ${status}`, "report", reportId);
  },
});

export const setUserRole = mutation({
  args: { userId: v.id("users"), role: v.union(v.literal("admin"), v.literal("user"), v.literal("member")) },
  handler: async (ctx, { userId, role }) => {
    const me = await currentUserId(ctx);
    await requireAdmin(ctx, me);
    await ctx.db.patch(userId, { role });
    await audit(ctx, "user.role", me, `Set role ${role} for ${userId}`, "user", userId);
  },
});
