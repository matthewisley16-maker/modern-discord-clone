"use node";

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import { gifValidator, normalizeGiphy, type GifValue } from "./gif";

/**
 * Real GIPHY-backed GIF search. Runs server-side so the API key never reaches
 * the browser, and every returned URL is normalized/re-validated by `gif.ts`.
 *
 * Returns a structured response instead of throwing so the picker can show a
 * proper loading / empty / error state:
 *   - `configured: false` → no `GIPHY_API_KEY` is set on the deployment.
 *   - `error`             → the provider call failed.
 */
const LIMIT = 24;
const MAX_OFFSET = 4800; // GIPHY paginates up to 4999; stay well clear.

export const search = action({
  args: { query: v.string(), offset: v.optional(v.number()) },
  returns: v.object({
    configured: v.boolean(),
    results: v.array(gifValidator),
    next: v.union(v.number(), v.null()),
    error: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { query, offset }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return { configured: false, results: [], next: null, error: "Please sign in to search GIFs." };
    }
    await ctx.runMutation(internal.gifLimits.enforceGifRateLimit, { userId });

    const key = process.env.GIPHY_API_KEY;
    if (!key) {
      return { configured: false, results: [], next: null, error: null };
    }

    const start = Math.max(0, Math.min(Math.floor(offset ?? 0), MAX_OFFSET));
    const term = query.trim().slice(0, 50);
    const params = new URLSearchParams({
      api_key: key,
      limit: String(LIMIT),
      offset: String(start),
      rating: "pg-13",
      lang: "en",
    });
    let endpoint = "https://api.giphy.com/v1/gifs/trending";
    if (term) {
      endpoint = "https://api.giphy.com/v1/gifs/search";
      params.set("q", term);
    }

    try {
      const res = await fetch(`${endpoint}?${params.toString()}`, { headers: { Accept: "application/json" } });
      if (!res.ok) {
        return {
          configured: true,
          results: [],
          next: null,
          error: res.status === 401 || res.status === 403
            ? "GIF search isn't configured correctly."
            : "Couldn't load GIFs right now. Please try again.",
        };
      }
      const json = (await res.json()) as { data?: unknown[]; pagination?: { total_count?: number } };
      const results: GifValue[] = (json.data ?? [])
        .map(normalizeGiphy)
        .filter((g): g is GifValue => g !== null);
      const total = json.pagination?.total_count ?? 0;
      const more = results.length === LIMIT && start + LIMIT < Math.min(total, MAX_OFFSET + LIMIT);
      return { configured: true, results, next: more ? start + LIMIT : null, error: null };
    } catch {
      return { configured: true, results: [], next: null, error: "Couldn't reach the GIF service." };
    }
  },
});
