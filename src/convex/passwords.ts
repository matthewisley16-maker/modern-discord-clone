import { v } from "convex/values";
import { getAuthUserId, modifyAccountCredentials, retrieveAccount } from "@convex-dev/auth/server";
import { Scrypt } from "lucia";
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { assertValidPassword } from "./auth";
import { enforceRateLimit } from "./authHelpers";

/**
 * Password management for EXISTING accounts.
 *
 * Freecord accounts can be created three ways: username+password, an email
 * one-time code (email-only), or anonymously. This module lets ANY signed-in
 * user attach a password to their current account — it never creates a second
 * user and never touches the account's id, username, profile or data.
 *
 * Security:
 *  - Passwords are validated with Freecord's existing rule (>= 8 chars, a
 *    letter and a number) and hashed with the same Scrypt used by the password
 *    provider. Plaintext is never stored, logged or returned.
 *  - The password account id is the user's username, so `setUsername` keeps
 *    working and username+password sign-in stays consistent.
 *  - Setting a password is refused when the account already has one; changing
 *    it requires the current password; resetting is only possible while already
 *    signed in (e.g. after proving email ownership with a one-time code).
 */

/** Internal: does this user already have a password, and what is their username? */
export const passwordInfo = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    const account = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", userId).eq("provider", "password"))
      .unique();
    return { hasPassword: account !== null, username: user?.username ?? null };
  },
});

/** Internal: create the password auth account for an existing user. */
export const insertPassword = internalMutation({
  args: { userId: v.id("users"), username: v.string(), secret: v.string() },
  handler: async (ctx, { userId, username, secret }) => {
    await enforceRateLimit(ctx, `password:${userId}`, 5, 60_000);
    const existing = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", userId).eq("provider", "password"))
      .unique();
    if (existing) throw new Error("A password is already set for this account.");
    // The username is unique, so a clash here can only mean a stale row.
    const clash = await ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) => q.eq("provider", "password").eq("providerAccountId", username))
      .unique();
    if (clash && clash.userId !== userId) {
      throw new Error("That username is already linked to a password.");
    }
    await ctx.db.insert("authAccounts", {
      userId,
      provider: "password",
      providerAccountId: username,
      secret,
    });
  },
});

/**
 * Account password state for the signed-in user (Settings → Account).
 * `hasPassword` drives "Set Password" vs "Password is set → Change Password".
 * Only ever exposes the current user's own state.
 */
export const passwordState = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    const account = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", userId).eq("provider", "password"))
      .unique();
    return {
      hasPassword: account !== null,
      email: user?.email ?? null,
      emailVerified: Boolean(user?.emailVerificationTime),
      username: user?.username ?? null,
    };
  },
});

/** Add a password to an account that does not have one yet. */
export const setPassword = action({
  args: { password: v.string() },
  handler: async (ctx, { password }): Promise<{ ok: true }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Please sign in first.");
    const info = await ctx.runQuery(internal.passwords.passwordInfo, { userId });
    if (info.hasPassword) throw new Error("A password is already set. Use Change Password instead.");
    assertValidPassword(password);
    if (!info.username) throw new Error("Your account is still being set up. Please try again.");
    const secret = await new Scrypt().hash(password);
    await ctx.runMutation(internal.passwords.insertPassword, {
      userId,
      username: info.username,
      secret,
    });
    return { ok: true };
  },
});

/** Change an existing password. Requires the current password. */
export const changePassword = action({
  args: { currentPassword: v.string(), newPassword: v.string() },
  handler: async (ctx, { currentPassword, newPassword }): Promise<{ ok: true }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Please sign in first.");
    const info = await ctx.runQuery(internal.passwords.passwordInfo, { userId });
    if (!info.hasPassword || !info.username) {
      throw new Error("This account doesn't have a password yet.");
    }
    assertValidPassword(newPassword);
    let valid = false;
    try {
      const account = await retrieveAccount(ctx, {
        provider: "password",
        account: { id: info.username, secret: currentPassword },
      });
      valid = account !== null && account.user._id === userId;
    } catch {
      valid = false;
    }
    if (!valid) throw new Error("Your current password is incorrect.");
    await modifyAccountCredentials(ctx, {
      provider: "password",
      account: { id: info.username, secret: newPassword },
    });
    return { ok: true };
  },
});

/**
 * Reset/overwrite the password while already signed in — used after proving
 * email ownership with the one-time code flow. Stays on the SAME account.
 */
export const resetPassword = action({
  args: { newPassword: v.string() },
  handler: async (ctx, { newPassword }): Promise<{ ok: true }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Please sign in first.");
    assertValidPassword(newPassword);
    const info = await ctx.runQuery(internal.passwords.passwordInfo, { userId });
    if (!info.username) throw new Error("Your account is still being set up. Please try again.");
    if (info.hasPassword) {
      await modifyAccountCredentials(ctx, {
        provider: "password",
        account: { id: info.username, secret: newPassword },
      });
    } else {
      const secret = await new Scrypt().hash(newPassword);
      await ctx.runMutation(internal.passwords.insertPassword, {
        userId,
        username: info.username,
        secret,
      });
    }
    return { ok: true };
  },
});
