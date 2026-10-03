import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { query } from "./_generated/server";
import { displayNameOf, profileOf, settingsOf } from "./lib";
import type { QueryCtx } from "./_generated/server";

async function presenceOf(ctx: QueryCtx, userId: string) {
  return null as null;
}

/**
 * Global search across people, communities, the user's channels, and the
 * messages the user is actually allowed to see. Private communities and
 * other users' DMs are never returned.
 */
export const global = query({
  args: { q: v.string(), filter: v.optional(v.union(v.literal("all"), v.literal("people"), v.literal("communities"), v.literal("messages"), v.literal("channels"))) },
  handler: async (ctx, { q, filter }) => {
    const userId = await getAuthUserId(ctx);
    const term = q.trim().toLowerCase();
    const empty = { people: [], communities: [], messages: [], channels: [] };
    if (!userId || term.length < 1) return empty;
    const want = filter ?? "all";
    const out: {
      people: { userId: string; username: string; displayName: string; avatarColor: string }[];
      communities: { serverId: string; name: string; description: string; iconColor: string; memberCount: number }[];
      messages: { messageId: string; body: string; author: string; channelName: string; communityName: string; createdAt: number }[];
      channels: { channelId: string; name: string; communityName: string }[];
    } = { people: [], communities: [], messages: [], channels: [] };

    // --- People (respects searchable privacy) ---
    if (want === "all" || want === "people") {
      const profiles = await ctx.db.query("profiles").take(400);
      for (const profile of profiles) {
        const user = await ctx.db.get(profile.userId);
        if (!user) continue;
        const settings = await settingsOf(ctx, profile.userId);
        if (settings?.searchable === false) continue;
        if (!`${profile.displayName} ${user.username ?? ""}`.toLowerCase().includes(term)) continue;
        out.people.push({
          userId: profile.userId,
          username: user.username ?? "",
          displayName: profile.displayName,
          avatarColor: profile.avatarColor ?? "violet",
        });
        if (out.people.length >= 10) break;
      }
    }

    // --- Communities: public ones + the user's own ---
    if (want === "all" || want === "communities") {
      const mine = await ctx.db.query("memberships").withIndex("by_user", (x) => x.eq("userId", userId)).collect();
      const myIds = new Set(mine.map((m) => m.serverId as string));
      const publicServers = await ctx.db.query("servers").withIndex("by_public", (x) => x.eq("isPublic", true)).take(100);
      const myServers = await Promise.all(mine.map((m) => ctx.db.get(m.serverId)));
      const pool = [...publicServers, ...myServers.filter((s) => s !== null && !publicServers.some((p) => p._id === s._id))];
      for (const server of pool) {
        if (!server) continue;
        if (!`${server.name} ${server.description} ${(server.tags ?? []).join(" ")}`.toLowerCase().includes(term)) continue;
        const members = await ctx.db.query("memberships").withIndex("by_server", (x) => x.eq("serverId", server._id)).collect();
        out.communities.push({
          serverId: server._id,
          name: server.name,
          description: server.description,
          iconColor: server.iconColor ?? "violet",
          memberCount: members.length,
        });
        if (out.communities.length >= 10) break;
      }
      void myIds;
    }

    // --- Channels the user can access ---
    if (want === "all" || want === "channels") {
      const mine = await ctx.db.query("memberships").withIndex("by_user", (x) => x.eq("userId", userId)).collect();
      for (const m of mine) {
        const channels = await ctx.db.query("channels").withIndex("by_server", (x) => x.eq("serverId", m.serverId)).collect();
        const server = await ctx.db.get(m.serverId);
        for (const channel of channels) {
          if (!channel.name.toLowerCase().includes(term)) continue;
          out.channels.push({ channelId: channel._id, name: channel.name, communityName: server?.name ?? "" });
          if (out.channels.length >= 10) break;
        }
      }
    }

    // --- Messages in channels the user belongs to ---
    if (want === "all" || want === "messages") {
      const mine = await ctx.db.query("memberships").withIndex("by_user", (x) => x.eq("userId", userId)).collect();
      for (const m of mine) {
        const channels = await ctx.db.query("channels").withIndex("by_server", (x) => x.eq("serverId", m.serverId)).collect();
        const server = await ctx.db.get(m.serverId);
        for (const channel of channels) {
          const messages = await ctx.db.query("messages").withIndex("by_channel", (x) => x.eq("channelId", channel._id)).order("desc").take(200);
          for (const message of messages) {
            if (message.deleted) continue;
            if (!message.body.toLowerCase().includes(term)) continue;
            out.messages.push({
              messageId: message._id,
              body: message.body.slice(0, 160),
              author: await displayNameOf(ctx, message.userId),
              channelName: channel.name,
              communityName: server?.name ?? "",
              createdAt: message._creationTime,
            });
            if (out.messages.length >= 12) break;
          }
          if (out.messages.length >= 12) break;
        }
        if (out.messages.length >= 12) break;
      }
    }

    void profileOf;
    void presenceOf;
    return out;
  },
});
