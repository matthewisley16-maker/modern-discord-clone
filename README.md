## Overview

This project uses the following tech stack:
- Vite
- Typescript
- React Router v7 (all imports from `react-router` instead of `react-router-dom`)
- React 19 (for frontend components)
- Tailwind v4 (for styling)
- Shadcn UI (for UI components library)
- Lucide Icons (for icons)
- Convex (for backend & database)
- Convex Auth (for authentication)
- Framer Motion (for animations)
- Three js (for 3d models)

All relevant files live in the 'src' directory.

Use bun for the package manager.

## Setup

This project is set up already and running on a cloud environment, as well as a convex development in the sandbox.

## Environment Variables

The project is set up with project specific CONVEX_DEPLOYMENT and VITE_CONVEX_URL environment variables on the client side.

The convex server has a separate set of environment variables that are accessible by the convex backend.

Currently, these variables include auth-specific keys: JWKS, JWT_PRIVATE_KEY, and SITE_URL.


# Using Authentication (Important!)

You must follow these conventions when using authentication.

## Auth is already set up.

All convex authentication functions are already set up. The auth currently uses email OTP and anonymous users, but can support more.

The email OTP configuration is defined in `src/convex/auth/emailOtp.ts`. DO NOT MODIFY THIS FILE.

Also, DO NOT MODIFY THESE AUTH FILES: `src/convex/auth.config.ts` and `src/convex/auth.ts`.

## Using Convex Auth on the backend

On the `src/convex/users.ts` file, you can use the `getCurrentUser` function to get the current user's data.

## Using Convex Auth on the frontend

The `/auth` page is already set up to use auth. Navigate to `/auth` for all log in / sign up sequences.

You MUST use this hook to get user data. Never do this yourself without the hook:
```typescript
import { useAuth } from "@/hooks/use-auth";

const { isLoading, isAuthenticated, user, signIn, signOut } = useAuth();
```

## Protected Routes

The starter `/dashboard` route is protected with `RequireAuth`. Extend that page
for the product's authenticated experience, and reuse `RequireAuth` when adding
another protected route — do NOT hand-roll a redirect to `/auth`, since landing
on a bare sign-in form with no explanation of what was blocked is confusing.

`RequireAuth` states the block on the page the visitor asked for and sends them
to `/auth?returnTo=<current route>` when they choose to sign in, so they come
back to it. Pass `title` and `description` to say what the page is:

```tsx
<Route
  path="/dashboard"
  element={
    <RequireAuth
      title="Sign in to view your dashboard"
      description="Your projects and settings live here."
    >
      <Dashboard />
    </RequireAuth>
  }
/>
```

Pass `redirectImmediately` for a route where bouncing straight to `/auth` really
is better.

## Auth Page

The auth page is defined in `src/pages/Auth.tsx`. Send sign-in and sign-up actions
to `/auth`.

## Authorization

You can perform authorization checks on the frontend and backend.

On the frontend, you can use the `useAuth` hook to get the current user's data and authentication state.

You should also be protecting queries, mutations, and actions at the base level, checking for authorization securely.

## Adding a redirect after auth

The `/auth` route in `src/main.tsx` redirects to `/dashboard` by default. If the
product's main authenticated route is different, update `redirectAfterAuth` to
that route. A validated same-origin `returnTo` query parameter takes priority so
users can resume the protected page they originally requested. Never leave an
authenticated product redirecting back to the public landing page.

## Complete authenticated products

When the requested product implies accounts, a workspace, a dashboard, or other
signed-in functionality, the task is not complete with only a landing page and
auth form. Build the main authenticated experience, protect its route, and verify
that signing in reaches it.

# Frontend Conventions

You will be using the Vite frontend with React 19, Tailwind v4, and Shadcn UI.

Generally, pages should be in the `src/pages` folder, and components should be in the `src/components` folder.

Shadcn primitives are located in the `src/components/ui` folder and should be used by default.

## Page routing

Your page component should go under the `src/pages` folder.

When adding a page, update the react router configuration in `src/main.tsx` to include the new route you just added.

## Shad CN conventions

Follow these conventions when using Shad CN components, which you should use by default.
- Remember to use "cursor-pointer" to make the element clickable
- For title text, use the "tracking-tight font-bold" class to make the text more readable
- Always make apps MOBILE RESPONSIVE. This is important
- AVOID NESTED CARDS. Try and not to nest cards, borders, components, etc. Nested cards add clutter and make the app look messy.
- AVOID SHADOWS. Avoid adding any shadows to components. stick with a thin border without the shadow.
- Avoid skeletons; instead, use the loader2 component to show a spinning loading state when loading data.


## Landing Pages

You must always create good-looking designer-level styles to your application. 
- Make it well animated and fit a certain "theme", ie neo brutalist, retro, neumorphism, glass morphism, etc

Use known images and emojis from online.

If the user is logged in already, show the get started button to say "Dashboard" or "Profile" instead to take them there.

## Responsiveness and formatting

Make sure pages are wrapped in a container to prevent the width stretching out on wide screens. Always make sure they are centered aligned and not off-center.

Always make sure that your designs are mobile responsive. Verify the formatting to ensure it has correct max and min widths as well as mobile responsiveness.

- Always create sidebars for protected dashboard pages and navigate between pages
- Always create navbars for landing pages
- On these bars, the created logo should be clickable and redirect to the index page

## Animating with Framer Motion

You must add animations to components using Framer Motion. It is already installed and configured in the project.

To use it, import the `motion` component from `framer-motion` and use it to wrap the component you want to animate.


### Other Items to animate
- Fade in and Fade Out
- Slide in and Slide Out animations
- Rendering animations
- Button clicks and UI elements

Animate for all components, including on landing page and app pages.

## Three JS Graphics

Your app comes with three js by default. You can use it to create 3D graphics for landing pages, games, etc.


## Colors

You can override colors in: `src/index.css`

This uses the oklch color format for tailwind v4.

Always use these color variable names.

Make sure all ui components are set up to be mobile responsive and compatible with both light and dark mode.

Set theme using `dark` or `light` variables at the parent className.

## Styling and Theming

When changing the theme, always change the underlying theme of the shad cn components app-wide under `src/components/ui` and the colors in the index.css file.

Avoid hardcoding in colors unless necessary for a use case, and properly implement themes through the underlying shad cn ui components.

When styling, ensure buttons and clickable items have pointer-click on them (don't by default).

Always follow a set theme style and ensure it is tuned to the user's liking.

## Toasts

You should always use toasts to display results to the user, such as confirmations, results, errors, etc.

Use the shad cn Sonner component as the toaster. For example:

```
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
export function SonnerDemo() {
  return (
    <Button
      variant="outline"
      onClick={() =>
        toast("Event has been created", {
          description: "Sunday, December 03, 2023 at 9:00 AM",
          action: {
            label: "Undo",
            onClick: () => console.log("Undo"),
          },
        })
      }
    >
      Show Toast
    </Button>
  )
}
```

Remember to import { toast } from "sonner". Usage: `toast("Event has been created.")`

## Dialogs

Always ensure your larger dialogs have a scroll in its content to ensure that its content fits the screen size. Make sure that the content is not cut off from the screen.

Ideally, instead of using a new page, use a Dialog instead. 

# Using the Convex backend

You will be implementing the convex backend. Follow your knowledge of convex and the documentation to implement the backend.

## The Convex Schema

You must correctly follow the convex schema implementation.

The schema is defined in `src/convex/schema.ts`.

Do not include the `_id` and `_creationTime` fields in your queries (it is included by default for each table).
Do not index `_creationTime` as it is indexed for you. Never have duplicate indexes.


## Convex Actions: Using CRUD operations

When running anything that involves external connections, you must use a convex action with "use node" at the top of the file.

You cannot have queries or mutations in the same file as a "use node" action file. Thus, you must use pre-built queries and mutations in other files.

You can also use the pre-installed internal crud functions for the database:

```ts
// in convex/users.ts
import { crud } from "convex-helpers/server/crud";
import schema from "./schema.ts";

export const { create, read, update, destroy } = crud(schema, "users");

// in some file, in an action:
const user = await ctx.runQuery(internal.users.read, { id: userId });

await ctx.runMutation(internal.users.update, {
  id: userId,
  patch: {
    status: "inactive",
  },
});
```


## Common Convex Mistakes To Avoid

When using convex, make sure:
- Document IDs are referenced as `_id` field, not `id`.
- Document ID types are referenced as `Id<"TableName">`, not `string`.
- Document object types are referenced as `Doc<"TableName">`.
- Keep schemaValidation to false in the schema file.
- You must correctly type your code so that it passes the type checker.
- You must handle null / undefined cases of your convex queries for both frontend and backend, or else it will throw an error that your data could be null or undefined.
- Always use the `@/folder` path, with `@/convex/folder/file.ts` syntax for importing convex files.
- This includes importing generated files like `@/convex/_generated/server`, `@/convex/_generated/api`
- Remember to import functions like useQuery, useMutation, useAction, etc. from `convex/react`
- NEVER have return type validators.

## Deployment safety (read this before deploys and before debugging a black screen)

The app reads and writes ONE pinned Convex deployment (`src/main.tsx` → `CONVEX_URL`).
Everything a user does — including signing in — depends on that deployment being able to
*execute functions*.

### The failure mode that caused the last outage

The deployment had a configured monthly usage limit (`Database I/O`, 2 GB, type
`disable`). When the limit was crossed, Convex paused the deployment: every function call
returned `500 ... This deployment has been disabled because it exceeded a configured usage
limit`, including the `/.well-known/openid-configuration` route that Convex Auth serves.
Convex could not discover the auth provider, so every client's WebSocket closed with
`code 1013: AuthProviderDiscoveryFailed` in a reconnect loop. The UI only rendered `null`
while auth resolved, so users saw a black page.

**Which deployment, and why the "development" spike matters.** There is currently ONE
deployment (`academic-porcupine-929`, defined in `src/lib/deployment.ts`), used by dev, the
preview and the deployed site. So Convex's usage chart splits the same deployment's traffic
into *development* calls (the sandbox `convex dev` process and the preview app) and
*production* calls (the deployed site) — and **both count against the same limits**. In the
sampled hour the chart read 261 development calls against 6 production calls: the spike was
not the deployed site, and a development spike can pause production. Measured limits at the
time (`bunx convex deployment usage-limits list`): `Database I/O` month/disable 2 GB → **2 GB,
triggered**; `Function calls` month/disable 200K → 140.079K (70%). Measured usage
(`bunx convex deployment usage`): **0.212 GB of database I/O in one day** — roughly 6 GB/month
against a 2 GB/month cap, i.e. the limit was genuinely exceeded by *inefficiency*, not by
chat volume. If separate dev/prod deployments are ever created, change `CONVEX_URL` for the
develop environment only and re-run `bun run preflight` to prove the two are distinct.

Three lessons are baked into the code now:

0. **A failed account read is a failure, not a signed-out user.** `useAuth` reads the
   account with the NON-throwing `useQuery_experimental` instead of `useQuery` (which
   re-throws into the nearest error boundary, hiding the reason and preventing recovery).
   `users:currentUser` failing now records a service error, keeps `isLoading` true, returns no
   fabricated user, and lets `RequireAuth` show the themed status screen rather than
   redirecting to `/auth` — the sign-in loop this outage used to cause. It resolves by itself
   when the deployment answers again.

1. **Never render nothing while initializing.** `src/lib/service-status.ts` +
   `src/components/ServiceStatus.tsx` + `src/hooks/use-service-status.ts` turn offline /
   reconnecting / unavailable / paused-deployment into themed screens with an explanation and
   a cooldown-protected Retry. `RootGate`, `AuthGate` and `RequireAuth` no longer return
   `null`, and `GlobalConnectionBanner` explains a degraded connection on every route.
2. **Keep backend database I/O bounded.** A Convex subscription re-executes its whole query
   whenever anything it read changes, so the real cost of a feature is
   `(reads per execution) x (how often it re-executes)`. Three measured offenders were fixed:
   - The retention sweep used to run every 10 minutes, reading the oldest message slices plus
     three disposable tables (~2k document reads per run, ~0.2 GB/month on its own). It now
     runs hourly (`src/convex/crons.ts`).
   - `dms.listConversations` re-executes on every DM message **and on every presence
     heartbeat** (its conversation cards carry members' presence - the heartbeat runs every
     30s per open tab). It used to read each conversation's newest 100 messages to compute an
     unread count, i.e. ~100 reads per conversation per re-execution (~2,000 for a 20-chat
     inbox) even when nothing had changed. It now reads only the messages *newer than the
     member's `lastReadAt`* via an index range on the implicit `_creationTime` key
     (`unreadIn`), plus one newest row for the preview - a caught-up inbox reads ~0 rows.
   - `/admin` used to fetch every tab's data at once: `listUsers` (up to 4,000 users +
     4,000 profiles), `listCommunities` (every community's full membership list) and the audit
     log all stayed subscribed while the admin sat on another tab, so each re-execution re-scanned
     thousands of rows for data nobody was looking at. The panel now fetches only the ACTIVE
     tab's query (`"skip"` for the rest). `admin.stats` and the synthetic-data audit stay
     subscribed because the overview cards above the tabs really do show them.
   - `chat.messages` / `dms.messages` expand up to 150 messages in a single execution, and
     used to resolve each message's author card (profile + user + avatar) and each @mention
     (user lookup + membership check) per message. `lib.memoizeAuthorCards` and the
     `MentionCache` in `mentions.resolveMentions` now resolve each author/username once per
     execution (`bun author-card-cache-test.mjs`, `bun mention-cache-test.mjs`).
   Client subscriptions must never duplicate work either - the DM unread badge is derived from
   the existing `dms.listConversations` subscription instead of a second `dms.unreadTotal` scan.
3. **Record WHY the backend closed the connection.** `AuthProviderDiscoveryFailed` is
   emitted by the Convex *backend*, not by a query, so it never reached the app: the loop
   lived only in the console, the account read stayed pending, and the UI reported a generic
   connection loss instead of the real cause. `ConvexReactClient` is now constructed with
   `onServerDisconnectError` (`src/main.tsx`), which hands the close reason straight to
   `recordServiceError`. The store groups identical messages into one counted entry and makes
   no request, so a 10-minute reconnect loop becomes a single `auth-discovery` line — the
   status screen and the Diagnostics disclosure then name the true cause instead of guessing
   (`bun service-status-test.mjs` asserts this end-to-end path). One client, created once at
   module scope, is still the only client: nothing about this adds a subscription, a poll or
   a retry of its own.

### Before every deploy

```bash
bun run preflight            # read-only: deployment identity, auth env vars, usage vs limits
bun run preflight -- --typecheck
```

`scripts/preflight.mjs` fails (exit 1) if the frontend/backend deployments disagree, if
`JWKS` / `JWT_PRIVATE_KEY` are missing, or if any active `disable` usage limit is at ≥ 90%
— the exact condition that pauses the deployment. It prints the `convex deployment
usage-limits` command needed to raise a limit. It never changes anything by itself.

Note the asymmetry that makes a *warning* limit worth having: a `warn` limit tells you before
it is too late, while a `disable` limit takes the deployment offline (no sign-in, no
messages) the moment it trips. Check `bunx convex deployment usage` after a busy day.

### Diagnosing a "black screen"

Errors are grouped and counted in memory (`src/lib/diagnostics.ts`, redacted of tokens,
keys and emails) and surfaced in the status screen's Diagnostics disclosure. No error data
is ever sent over the network. If the backend is paused, the app now says so explicitly
instead of looping silently.

**Not every console warning is a bug in this app.** The preview harness injects
`@vly-ai/integrations` into `<head>` (`vlyPlugin()` in `vite.config.ts`), and that module
loads `https://cdn.jsdelivr.net/npm/html2canvas-pro@2.0.4/dist/html2canvas-pro.min.js` for
the platform's own project-thumbnail capture. It is loaded as an `async` module script, its
failure is caught and warned about, and it is only used when the parent frame asks for a
screenshot (`vly-screenshot-request`). Freecord itself has no screenshot feature and does
not reference `html2canvas` anywhere — so an Edge warning such as *"Tracking Prevention
blocked access to storage for …/html2canvas-pro.min.js"* is the platform's third-party
script touching storage that the browser denies to a cross-site origin. It is unrelated to
Freecord's own authentication and must not be "fixed" by deleting the dependency (that
would break the preview/toolbar bridge) or by weakening browser security.
