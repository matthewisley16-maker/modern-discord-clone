import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

/** Internal: does a username already exist? Used to enforce uniqueness. */
export const usernameExists = internalQuery({
  args: { username: v.string() },
  handler: async (ctx, { username }) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("username", (q) => q.eq("username", username))
      .unique();
    return existing !== null;
  },
});

/** Internal: create the profile row for a freshly registered account. */
export const onSignUp = internalMutation({
  args: { userId: v.id("users"), displayName: v.string() },
  handler: async (ctx, { userId, displayName }) => {
    const existing = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (existing) return;
    await ctx.db.insert("profiles", { userId, displayName });
  },
});

/**
 * Fixed-window rate limiter backed by the `rateLimits` table.
 * Backend-authoritative: abuse protection cannot be bypassed from the client.
 */
export async function enforceRateLimit(
  ctx: MutationCtx,
  key: string,
  limit: number,
  windowMs: number,
) {
  const now = Date.now();
  const existing = await ctx.db
    .query("rateLimits")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();

  if (!existing || now - existing.windowStart > windowMs) {
    if (existing) await ctx.db.patch(existing._id, { count: 1, windowStart: now });
    else await ctx.db.insert("rateLimits", { key, count: 1, windowStart: now });
    return;
  }
  if (existing.count >= limit) {
    const seconds = Math.ceil((windowMs - (now - existing.windowStart)) / 1000);
    throw new ConvexError(`Too many attempts. Please try again in ${seconds}s.`);
  }
  await ctx.db.patch(existing._id, { count: existing.count + 1 });
}

/** Append an audit log entry for sensitive administrative/account actions. */
export async function writeAuditLog(
  ctx: MutationCtx,
  action: string,
  actorId: Id<"users"> | undefined,
  detail: string,
) {
  await ctx.db.insert("moderationLogs", { action, actorId, detail });
}
