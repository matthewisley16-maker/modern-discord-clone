import { getAuthUserId } from "@convex-dev/auth/server";
import { query } from "./_generated/server";

/**
 * GIPHY configuration for the official Web SDK.
 *
 * The key is read from the deployment environment (`GIPHY_API_KEY`) — it is
 * never committed to source. GIPHY's Web SDK (`GiphyFetch` / `Grid`) runs in
 * the browser and is designed to receive the public API key client-side, so it
 * is returned ONLY to signed-in users, and only so the SDK can fetch GIFs.
 *
 * When the variable is missing the app must keep working: `configured` is false
 * and the picker falls back to the direct `.gif` upload feature.
 */
export const giphyConfig = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { configured: false, apiKey: null as string | null };
    const key = process.env.GIPHY_API_KEY?.trim();
    return { configured: Boolean(key), apiKey: key && key.length > 0 ? key : null };
  },
});
