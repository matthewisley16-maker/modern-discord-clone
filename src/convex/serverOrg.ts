import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { currentUserId } from "./lib";

/**
 * Per-user server-rail organization.
 *
 * The whole layout is saved as one small document per user so it follows the
 * account across devices. All ids are validated against the caller's own
 * memberships on the server, so a client can never reorder or list a server the
 * user is not actually in.
 */

const MAX_FOLDERS = 100;
const MAX_SERVERS = 1000;
const MAX_RECENT = 12;

const FOLDER_COLORS = [
  "#8b5cf6", "#f0616d", "#3ba55d", "#faa61a",
  "#00a8fc", "#eb459e", "#5865f2", "#9b59b6",
];

const folderArg = v.object({
  id: v.string(),
  name: v.string(),
  color: v.optional(v.string()),
  collapsed: v.boolean(),
  serverIds: v.array(v.string()),
});

export const get = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { layout: [] as string[], folders: [], recent: [] as string[] };
    const row = await ctx.db
      .query("serverOrganization")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    return {
      layout: row?.layout ?? [],
      folders: (row?.folders ?? []).map((f) => ({
        id: f.id,
        name: f.name,
        color: f.color ?? null,
        collapsed: f.collapsed,
        serverIds: f.serverIds,
      })),
      recent: row?.recent ?? [],
      colors: FOLDER_COLORS,
    };
  },
});

/** Replace the user's saved layout (called after each drag / folder change). */
export const save = mutation({
  args: {
    layout: v.array(v.string()),
    folders: v.array(folderArg),
    recent: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await currentUserId(ctx);

    // Only servers the user is actually a member of may appear.
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const mine = new Set(memberships.map((m) => m.serverId as string));

    const placed = new Set<string>();
    const folders: {
      id: string; name: string; color?: string; collapsed: boolean; serverIds: string[];
    }[] = [];
    const folderIds = new Set<string>();

    for (const f of args.folders.slice(0, MAX_FOLDERS)) {
      const id = String(f.id).slice(0, 64);
      if (!id || folderIds.has(id)) continue;
      folderIds.add(id);
      const serverIds: string[] = [];
      for (const sid of f.serverIds) {
        if (serverIds.length >= MAX_SERVERS) break;
        if (!mine.has(sid) || placed.has(sid)) continue;
        placed.add(sid);
        serverIds.push(sid);
      }
      folders.push({
        id,
        name: (f.name.trim() || "Folder").slice(0, 40),
        ...(f.color ? { color: String(f.color).slice(0, 24) } : {}),
        collapsed: Boolean(f.collapsed),
        serverIds,
      });
    }

    const layout: string[] = [];
    const seenEntries = new Set<string>();
    for (const raw of args.layout.slice(0, MAX_SERVERS + MAX_FOLDERS)) {
      const entry = String(raw);
      if (entry.startsWith("folder:")) {
        const fid = entry.slice(7);
        if (!folderIds.has(fid) || seenEntries.has(entry)) continue;
        seenEntries.add(entry);
        layout.push(entry);
      } else if (mine.has(entry) && !placed.has(entry) && !seenEntries.has(entry)) {
        seenEntries.add(entry);
        layout.push(entry);
      }
    }
    // Any member server missing from the layout is appended so it can never be
    // lost from the rail just because a stale client omitted it.
    for (const sid of mine) {
      if (!placed.has(sid) && !seenEntries.has(sid)) {
        seenEntries.add(sid);
        layout.push(sid);
      }
    }

    const recent = (args.recent ?? []).filter((s) => mine.has(s)).slice(0, MAX_RECENT);

    const existing = await ctx.db
      .query("serverOrganization")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    const doc = { userId, layout, folders, recent };
    if (existing) await ctx.db.patch(existing._id, doc);
    else await ctx.db.insert("serverOrganization", doc);
    return { ok: true };
  },
});

/** Record a server as recently visited (for the server switcher). */
export const touchRecent = mutation({
  args: { serverId: v.string() },
  handler: async (ctx, { serverId }) => {
    const userId = await currentUserId(ctx);
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    if (!memberships.some((m) => (m.serverId as string) === serverId)) return;

    const existing = await ctx.db
      .query("serverOrganization")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    const prev = existing?.recent ?? [];
    const next = [serverId, ...prev.filter((s) => s !== serverId)].slice(0, MAX_RECENT);
    if (existing) await ctx.db.patch(existing._id, { recent: next });
    else await ctx.db.insert("serverOrganization", { userId, recent: next, layout: [], folders: [] });
  },
});
