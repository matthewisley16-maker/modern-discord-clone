// THIS FILE IS READ ONLY. Do not touch this file unless you are correctly adding a new auth provider in accordance to the vly auth documentation

import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { convexAuth, createAccount, retrieveAccount } from "@convex-dev/auth/server";
import { Scrypt } from "lucia";
import { internal } from "./_generated/api";
import { emailOtp } from "./auth/emailOtp";
import { emailPassword } from "./auth/emailPassword";

/** Usernames: 3-24 chars, letters/numbers/dot/underscore. Normalized to lowercase. */
export const USERNAME_PATTERN = /^[a-z0-9._]{3,24}$/;
const RESERVED = new Set(["freecord", "admin", "administrator", "system", "support", "moderator", "root"]);

export function normalizeUsername(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/** Throws with a user-safe message when a username is invalid. */
export function assertValidUsername(username: string): void {
  if (!USERNAME_PATTERN.test(username)) {
    throw new Error(
      "Usernames must be 3-24 characters and use only letters, numbers, dots, or underscores.",
    );
  }
  if (RESERVED.has(username)) {
    throw new Error("That username is reserved. Please choose another.");
  }
}

/** Throws with a user-safe message when a password is too weak. */
export function assertValidPassword(password: string): void {
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("Password must be at least 8 characters long.");
  }
  if (password.length > 200) {
    throw new Error("Password is too long.");
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw new Error("Password must include at least one letter and one number.");
  }
}

/**
 * Username + password accounts. Email is OPTIONAL: the account id is the
 * username, so no email is ever required to register or sign in.
 * Passwords are hashed with Scrypt and never stored in plaintext.
 */
const usernamePassword = ConvexCredentials({
  id: "password",
  authorize: async (credentials, ctx) => {
    const flow = credentials.flow;

    if (flow === "signUp") {
      const username = normalizeUsername(credentials.username);
      const password = String(credentials.password ?? "");
      assertValidUsername(username);
      assertValidPassword(password);

      const taken = await ctx.runQuery(internal.authHelpers.usernameExists, { username });
      if (taken) {
        throw new Error("That username is already taken. Please choose another.");
      }

      const rawEmail = String(credentials.email ?? "").trim().toLowerCase();
      const displayName = String(credentials.displayName ?? "").trim().slice(0, 40) || username;

      const { user } = await createAccount(ctx, {
        provider: "password",
        // The username is the account id, so no email is needed.
        account: { id: username, secret: password },
        profile: {
          name: displayName,
          username,
          ...(rawEmail ? { email: rawEmail } : {}),
        },
        shouldLinkViaEmail: false,
        shouldLinkViaPhone: false,
      });

      await ctx.runMutation(internal.authHelpers.onSignUp, {
        userId: user._id,
        displayName,
      });
      return { userId: user._id };
    }

    if (flow === "signIn") {
      const username = normalizeUsername(credentials.username);
      const password = String(credentials.password ?? "");
      // A single generic error is used for every failure (unknown username,
      // wrong password, malformed input) so usernames cannot be enumerated.
      try {
        const account = await retrieveAccount(ctx, {
          provider: "password",
          account: { id: username, secret: password },
        });
        if (account === null) {
          throw new Error("Incorrect username or password.");
        }
        return { userId: account.user._id };
      } catch {
        throw new Error("Incorrect username or password.");
      }
    }

    throw new Error("Unsupported authentication flow.");
  },
  crypto: {
    hashSecret: async (secret: string) => await new Scrypt().hash(secret),
    verifySecret: async (secret: string, hash: string) =>
      await new Scrypt().verify(hash, secret),
  },
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [usernamePassword, emailPassword, emailOtp, Anonymous],
});
