import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { enforceRateLimit } from "./authHelpers";

/** Backend-authoritative rate limit for the outbound GIF search (per user). */
export const enforceGifRateLimit = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    await enforceRateLimit(ctx, `gif:${userId}`, 90, 60_000);
  },
});
