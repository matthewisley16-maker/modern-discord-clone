import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { retrieveAccount, type ConvexCredentialsConfig } from "@convex-dev/auth/server";
import { internal } from "../_generated/api";

/**
 * Email + password sign-in for accounts that added a password.
 *
 * This provider ONLY signs into an EXISTING account: it finds the user that
 * owns the (verified) email, then verifies the supplied password against that
 * user's stored password hash. It never creates a user and never links or
 * merges accounts.
 *
 * Every failure returns the same generic message so an attacker cannot use this
 * endpoint to discover whether an email address has an account.
 */
// Explicit type annotation breaks a type-inference cycle: this module imports
// the generated `internal` api, which itself references the auth config that
// imports this provider.
export const emailPassword: ConvexCredentialsConfig = ConvexCredentials({
  id: "email-password",
  authorize: async (credentials, ctx) => {
    const email = String(credentials.email ?? "").trim().toLowerCase();
    const password = String(credentials.password ?? "");
    const generic = "Incorrect email or password.";
    if (!email || !email.includes("@") || !password) throw new Error(generic);

    try {
      const account = await ctx.runQuery(internal.authHelpers.passwordAccountForEmail, { email });
      if (!account) throw new Error(generic);
      const result = await retrieveAccount(ctx, {
        provider: "password",
        account: { id: account.providerAccountId, secret: password },
      });
      if (result === null) throw new Error(generic);
      return { userId: result.user._id };
    } catch {
      throw new Error(generic);
    }
  },
});
