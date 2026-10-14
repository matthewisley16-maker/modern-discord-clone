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

## Group chat photos (group DMs)

A group DM can have its own picture, like a Discord group chat, and it is stored as
**one authoritative field on the conversation**: `dmConversations.iconStorageId`
(`src/convex/schema.ts` already had the column). Everything that draws a group reads that
single field through the query it already subscribes to, so there is no per-member copy to
drift out of sync:

| Surface | Reads it from |
| --- | --- |
| Conversations list (active + archived) | `dms.listConversations` → `iconUrl` |
| Chat header + group details panel | `dms.groupDetails` → `iconUrl` (via the header icon, which opens the panel) |
| Secret Chats list | `conversationPrivacy.secretChats` → `avatarUrl` |

A group with no photo (or a deleted one) renders the shared default group icon
(`GroupIcon` in `src/components/dashboard/ui.tsx`) — never a member's face or presence.

- **Writing:** `dms.setGroupPhoto { conversationId, storageId }` (pass `null` to clear). It
  runs the same `requireGroupManager` guard as `renameGroup`, so only the group owner or a
  group administrator may change it, and a non-member (or someone who left) is rejected
  server-side. The uploaded object is re-validated server-side — it must exist and be a
  PNG/JPEG/WebP/AVIF/GIF image under 5 MB — and the replaced blob is deleted from file
  storage so old photos don't accumulate.
- **Uploading:** nothing is uploaded until Save is pressed. The picker only creates a local
  `blob:` URL for the preview, so Cancel leaves no orphaned file and a temp URL is never
  stored as the picture. On Save the chosen square is baked into a 512x512 image and POSTed
  to a `uploads.generateUploadUrl` URL.
- **Crop/reposition:** `src/lib/group-photo.ts` holds the cover geometry (drag + zoom) and is
  used by BOTH the preview and the saved image, so what the user positions is what gets
  uploaded. Its invariants (the crop can never leave the source bitmap; preview scale ===
  saved scale) are unit tested in `bun group-photo-test.mjs`.
- **Freshness:** a new photo is a new storage object with a new URL, so browsers cannot show
  a cached previous image; `null` clears back to the default icon.

## Admin Panel: my own messages I deleted for myself

The two retention tabs are deliberately named for what they MEAN, and they are not the same thing:

- **Hidden (only for you)** — a per-person delete (`deleteForMe` / `deleteDmForMe`): ONE
  `messageVisibility` row for the caller, the message untouched and still visible to everyone else.
  From here an administrator may moderate it for everyone (`deleteHiddenForEveryone`), which is a
  COMPLETE removal — the row, its attachments and every marker, with no "this message was deleted"
  placeholder left in anyone's history.
- **Deleted Messages** — the caller's own retained entries, where deleting means deleting for
  everyone: `permanentlyDeleteMine` / `permanentlyDeleteAllMine` also remove the message row itself.

Both tabs auto-empty after seven days (see the section below) and both have a confirmed bulk action.

"Delete for me" never deleted anything. `deletion.deleteForMe` (channels) and
`deletion.deleteDmForMe` (DMs) insert ONE `messageVisibility` row and the history queries
(`chat.messages`, `dms.messages`, `search`) filter that id out — the body, the GIF and the
attachment records all stayed in storage, unreachable by anyone. The Admin Panel now exposes
that retention and lets the original author purge it.

`messageVisibility` (`userId`, `messageId`, `channelId` | `conversationId`, `hiddenAt`) already IS the
deletion metadata, and it is indexed `by_user`, so the section reads only the caller's own rows.

| Surface | Where |
| --- | --- |
| Section (tab "Deleted Messages") | `src/pages/AdminPanel.tsx` |
| Query `adminMessages.listMineDeletedMessages` | `src/convex/adminMessages.ts` |
| Purge one `adminMessages.permanentlyDeleteMine` | `src/convex/adminMessages.ts` |
| Purge all `adminMessages.permanentlyDeleteAllMine` ("Delete All Deleted Messages") | `src/convex/adminMessages.ts` |
| Eligibility / preview / search / seven-day window rules | `src/lib/deleted-messages.ts` (`bun deleted-messages-test.mjs`) |
| Seven-day expiry sweep | `src/convex/deleteForMeRetention.ts` (cron in `src/convex/crons.ts`) |

- **Scope, enforced server-side.** Both functions call `requirePanelAccess` (rank >= admin) and
  then require the visibility row AND the message to belong to the caller. Another member's
  local delete can never appear in someone else's panel — not even an administrator's.
- **"Deleted for everyone" is excluded, never faked.** Those messages have no retained content,
  so they are not listed and the purge refuses them (removing their tombstone would change what
  other members see). A message deleted for me keeps its behaviour exactly as before; opening
  the panel never restores it into normal chat history.
- **One deletion implementation.** The purge calls the retention sweep's own
  `storage.deleteChannelMessage` / `deleteDmMessage`, which delete the attachment rows and only
  remove a storage object when no other attachment row still references it (`by_storage`
  orphan check), plus reactions and every `messageVisibility` marker for that message.
- **Efficiency.** `messageVisibility.by_user`, newest-first, paginated (<= 50 rows/page, <= 4
  index pages per request while rows are filtered out by search), and the tab query is only
  subscribed while the tab is active (`"skip"` otherwise). Display names are resolved once per
  request; no polling and no duplicate subscription.
- **Audited.** A successful purge writes `message.delete_permanent` to `auditLogs` and the
  legacy moderation feed; the bulk cleanup writes `message.delete_permanent_all` once per run.
- **"Delete all deleted messages".** The tab header has one confirmed bulk action that
  permanently removes the caller's own retained entries, newest first. It is bounded by design:
  one call purges at most 10 entries (out of the 60 newest markers it examines) and reports
  `{ deleted, remaining, hasMore }`, so the button can be pressed again while entries remain —
  never one unbounded transaction. It uses exactly the same eligibility rule as the list, so it
  can never remove something the list would not show (other people's markers, expired entries,
  messages deleted for everyone, or messages that are not the caller's).
- **Verification.** `bun deleted-messages-test.mjs` covers the eligibility/preview/search rules
  and the seven-day window offline (57 assertions, fixed clock);
  `bun deleted-messages-authz-test.mjs` calls all three functions with NO session and asserts the
  deployment refuses them with no data and no effect (it creates nothing, so it is safe against
  the real deployment).
- **Limitations.** The message row must still exist: a message already removed by the retention
  sweep (past `STORAGE_RETENTION_MS`) or by "delete for everyone" cannot be recovered, and the
  panel says so instead of pretending otherwise.

## "Delete for me" entries expire after seven days

A "Delete for me" record is a TEMPORARY recovery window for the platform, not a permanent archive:
seven days after the user deleted the message for themselves, its entry leaves
Admin Panel → My Deleted Messages on its own. This applies to that entry only — it does not mean
Freecord deletes messages after seven days.

| Piece | Where |
| --- | --- |
| The rule (`DELETED_FOR_ME_TTL_MS`, expiry/remaining helpers) | `src/lib/deleted-messages.ts` |
| Where the clock starts | `deletion.hideForMe` writes `messageVisibility.hiddenAt = Date.now()` on the server |
| Authoritative expiry in the list | `adminMessages.describeHiddenMessage` → `isRetainedHiddenMessage(..., now)` |
| Durable server-side cleanup | `deleteForMeRetention.expireRetainedEntries` — cron every 6 hours |
| Progress state (indexed, no rescans) | `retentionState` row, key `deleteForMeRetention` |
| New indexes/fields | `messageVisibility.by_hidden_at`, `messageVisibility.entryExpiredAt` |

- **The timer starts once, when the user deletes.** It is `hiddenAt`, written server-side at the
  moment of the local delete (`hideForMe` also returns early when a marker already exists, so
  repeating the action cannot restart it). Opening the tab, refreshing, re-subscribing or
  paginating back through the list never touches it — nothing in the read path writes anything.
- **Server-side, not front-end filtering.** Two layers, deliberately:
  `isDeletedForMeExpired(hiddenAt, now)` is applied inside the admin queries (with ONE `now` per
  request, so a page is judged against a single instant), which makes the behaviour exact to the
  millisecond with no dependence on any job; and the scheduled sweep records the expiry durably
  in `entryExpiredAt`, so the backend itself cleans up with no user action and no request-time
  cost.
- **What expiry does NOT do.** It never deletes the message, its body, its GIF, its attachment
  records, its files, another participant's copy, or the user's own "hidden for me" state — the
  marker row is kept, because deleting it would resurrect the message into the deleter's chat
  history, which is not what "Delete for me" means. Only the Admin Panel entry ends, and with it
  the ability to permanently purge that message from the panel (a stale page can no longer delete
  it for everyone: `deletion.deleteHiddenForEveryone` refuses an expired entry server-side).
- **Per user, always.** Every marker carries its own `userId` and `hiddenAt`, and the sweeps and
  lists only ever look at one marker at a time. One user's seven-day expiry cannot remove another
  user's visibility, markers or messages — including two users who hid the same message.
- **Cost and safety.** The sweep does ONE indexed range read (`by_hidden_at`, oldest first, only
  entries whose window has already closed), bounded to 200 rows per run (hard cap 400), and
  advances `retentionState.cursorHiddenAt` so it never re-reads the rows it has already expired.
  It is idempotent and retry-safe (already-marked rows are skipped, every change is a single
  transactional write), it runs every six hours rather than polling, and it touches nothing the
  Admin Panel reads at request time, so a failed run can never break the panel.
- **Verified live.** After deploy, the scheduled job expired all 34 closed windows of the
  deployment's 130 markers on its own (newer entries stayed), re-running it examined 0 rows and
  changed nothing, and `messages` (307) / `dmMessages` (1589) / marker counts were identical
  before and after — with a sampled expired entry whose message and body were still intact.
  `bun deleted-messages-test.mjs` pins the boundary itself with a fixed clock: 7 days minus a
  minute is still listed, exactly 7 days is not.

## Optional PIN and password locks on Freecord itself (both optional, independently)

A member can put a **PIN** and/or an **extra password** in front of Freecord, from
**Settings → Account → Login & Security**. Both are opt-in, independent, and never required: with
both off — the default for every account and every existing user — the site opens on the normal
account sign-in and behaves **exactly as it did before this feature existed**.

| Piece | Where |
| --- | --- |
| Rules (PIN length, password rule, configurations, lockout maths, recovery codes) | `src/lib/site-lock.ts` (`bun site-lock-test.mjs`) |
| Backend: status / verify / setPin / setPassword / disablePin / disablePassword / recovery / lockNow | `src/convex/siteLock.ts` |
| Storage | `siteLocks` in `src/convex/schema.ts` (`by_user`, one row per member who opts in) |
| Settings card | `src/components/dashboard/SiteLockSettings.tsx` (rendered in the Account tab) |
| Lock screen | `src/components/SiteLockGate.tsx`, applied in `src/main.tsx` (`/`, `/dashboard`, `/admin`) |

### The four configurations

| PIN lock | Password lock | What happens when a session starts |
| --- | --- | --- |
| off | off | Nothing is asked. The dashboard, chats, friends and groups render immediately — the gate is a no-op (`status.enabled === false`). |
| on | off | The PIN is asked. Nothing else. |
| off | on | The extra password is asked. Nothing else. |
| on | on | Both are required in one submit before the app renders. Verifying only one is not enough (`pendingSiteFactors` keeps the other pending). |

Nobody is ever asked to *set up* either credential: the gate only ever appears for a member who
turned a lock on, and the settings section never auto-opens a form.

### Security

- **Server-side, hashed, never plain text.** Credentials are only ever stored as one-way **Scrypt**
  hashes with a random salt (`pinHash`, `passwordHash`); they are never returned by a query, never
  logged, and never echoed in an error message. Crypto runs in **actions**, never in a query.
- **Leading zeros survive.** The PIN is 1–10 digits and is handled, transported and hashed as a
  STRING, so `0042` is a valid PIN and is a *different* credential from `42`. Both inputs sanitise
  to digits only, and nothing ever calls `Number()` on a PIN.
- **Independent.** `clearPin` touches only the PIN, `clearPassword` only the password. Enabling one
  never enables, disables or verifies the other, and **neither** touches account authentication:
  no auth session is created, revoked or modified, so changing an unrelated setting never signs
  anybody out.
- **Rate limits and progressive delay.** Every entry point is rate limited server-side
  (`enforceRateLimit`: verify 30/min, set 8/min, recovery email 3/10min) and wrong entries escalate
  through the same ladder the Admin PIN uses — the first two typos are free, then 5s, 10s, 20s …
  capped at 15 minutes, reset by a correct entry and decaying after an hour of quiet.
- **Proof of identity to change, disable or recover.** Changing a credential requires the current
  one; turning one off requires the current credential **or** the account's Freecord password
  (verified against its stored hash). Accounts with no password credential (email-code sign-in) use
  the signed-in session itself, exactly like the Admin PIN — a forgotten lock never becomes a
  lockout. Every change is written to the audit log (`site_lock.*`) with no credential in the detail.
- **Cannot be bypassed by a deep link.** `SiteLockGate` reads `api.siteLock.status` on every render
  and the dashboard is not mounted at all while a session is unsatisfied, `/dashboard` and `/admin`
  are wrapped inside `RequireAuth`, and `verify` is a server action scoped to the caller's own row
  and auth session. Refreshing the page cannot skip it, and nothing is cached in `localStorage`,
  `sessionStorage` or any other browser storage.

### Sessions

Verification is remembered **per auth session** (`verifiedPinSessionId` /
`verifiedPasswordSessionId`), not with a client flag or a timer: a credential is asked for once when
a session starts, stays satisfied for that whole session (navigating, refreshing, reconnecting a
socket or a Convex websocket never re-asks), and is required again after signing out, after the
session expires, or on any other device — because a new session is a new session id. “Lock Freecord
now” in settings revokes the current session's verification immediately, which also makes the
feature trivial to try out.

### Recovery

On the lock screen (the one place a locked-out member can reach) **Forgot PIN/password** offers a
single-use, hashed, 10-minute **email code** that can set a new credential or turn the lock off, plus
the account-password route. In Settings, the same two proofs are available without being locked out.
A code is burned as soon as it is used, allows only a few wrong entries, and is dropped if delivery
fails. The code is only ever emailed to the account's own address and is shown masked back to the
member (`a••a@example.com`).

### Verification

`bun site-lock-test.mjs` (188 assertions) covers four layers: the pure rules (PIN format and leading
zeros, the password rule with symbols allowed, all four configurations, the progressive delay, the
recovery-code rules); the server source (only hashes in the schema, Scrypt hashing and verification,
session-scoped verification, rate limits, identity checks and the audit trail); the UI wiring (which
fields appear for which configuration, both-required submit, Clear/Forgot/loading/error controls,
protected-route wrapping, no browser storage); and live read-only calls with no session — a
signed-out visitor is never asked for a lock and can never verify, create, disable or recover one.

The end-to-end click-through of a signed-in session is **not** automated here: the suite guard
(`test-support/guard.mjs`) refuses to create synthetic accounts on the shared production deployment,
so the four configurations are proven by the shared rule both the server and the gate import, the
source wiring, and the live no-session boundary. To try it by hand: sign in → Settings → Account →
Login & Security → enable a lock → **Lock Freecord now** → unlock; then toggle the other lock and
repeat.

## Optional Admin PIN (never forced, never a way in)

The Admin Panel can be protected by a PIN that an ADMINISTRATOR chooses for their own account. It
is optional in every direction: no setup is required, skipping is remembered, and turning it off
cannot change anyone's access — the server-side role checks stay the only thing that grants
administrator authority.

| Piece | Where |
| --- | --- |
| Rules (1–10 digits, leading zeros, lockout maths) | `src/lib/admin-pin.ts` (`bun admin-pin-test.mjs`) |
| Backend: status / setPin / unlock / disable / skip / lock | `src/convex/adminPin.ts` |
| Storage | `adminPinSettings` (`by_user`, one row per administrator who opts in) |
| Lock screen and Admin Settings card | `src/components/admin/admin-pin.tsx` |
| Where it is applied | `src/pages/AdminPanel.tsx` (gate + `panelOpen`) |

- **Nothing forces a PIN.** There is no row and no PIN by default, so the panel opens on the
  existing account authentication plus `requirePanelAccess` (rank >= admin) exactly as it did
  before this feature existed. The option lives in Admin Settings → "Admin PIN (optional)" with
  **Enable Admin PIN** / **Set Up PIN** and **Skip for Now**; skipping writes `skippedAt` so the
  administrator is never prompted again. Ordinary members are never asked for a PIN anywhere —
  this UI only exists inside the panel, which role checks already close to them.
- **When it is on**, the gate replaces the whole panel: no admin query is even subscribed
  (`panelOpen` is false, so statistics, tabs and both retention lists are `"skip"`ped), and a
  correct PIN grants the session 30 minutes on that device. "Lock panel now" revokes it, and the
  grant is bound to the auth session (`unlockedSessionId`), so signing out or using another device
  asks again. The choice itself (`enabled`) persists across refreshes and sign-ins.
- **A PIN never grants access.** Every public function starts with `panelAccess`, which re-checks
  the signed-in account's role on the server; `status` returns harmless defaults to anyone without
  panel access rather than hinting at an administrator's preference. A PIN alone unlocks nothing.
- **Turning it off is identity-checked, and can never weaken the role checks.** Disabling requires
  the current PIN, or the account's password verified against its stored Scrypt hash (the existing
  Freecord credential) — so a forgotten PIN is not a lockout. The single case with no stronger
  proof is an administrator whose account has NO password credential (email-code or guest
  sign-in): there the signed-in administrator session is the existing authentication, and since the
  PIN never granted authority, protection can be turned off on that basis. Both paths write
  `admin_pin.disable` to the audit log, and neither touches `users.role` or the panel's
  authorization code — `RequireAuth`, `requirePanelAccess` and every admin mutation behave exactly
  the same with the PIN on or off.
- **Storage and abuse.** The PIN is only ever a one-way Scrypt hash (`pinHash`), never returned by
  a query, never logged and never echoed in an error; crypto runs in actions, not queries. Failed
  entries are rate limited (`enforceLimit`) and the wait grows PROGRESSIVELY (`adminPinLockoutFor`):
  the first two typos are free, and from the third consecutive failure the delay doubles each time
  — 5s, 10s, 20s, 40s … capped at 15 minutes — so guessing slows down instead of running at a
  constant rate. The streak resets on a correct PIN and also decays after an hour of quiet
  (`ADMIN_PIN_LOCKOUT_DECAY_MS`), so an honest administrator is never punished for an old mistype.
  `lockedUntil` is stored server-side and the UI counts the wait down. 1–10 digits are accepted and
  kept as a STRING throughout, so leading zeros are significant (`007` differs from `7`) — the input
  field sanitises to digits only and never parses the value as a number.
- **Verification.** `bun admin-pin-test.mjs` covers the rules offline (fixed inputs, leading
  zeros, sanitising, progressive-delay maths, lockout countdown) AND the live boundary with no
  session: the status read returns safe defaults, and setPin / unlock / disable / skip / lock are
  all refused by the server-side sign-in gate (57 assertions). A real administrator clicking
  through the gate needs a live admin session, which cannot be automated against this deployment.

## Editing a community's subcategory after creation

A community's subcategory is ONE field on its existing `servers` row (`servers.category`), so it can
be changed at any time without recreating anything:

| Step | Where |
| --- | --- |
| The supported list + every rule (normalise, legacy, validate, match) | `src/lib/community-categories.ts` |
| Change it (owner / community admin) | `communities.setCategory` in `src/convex/communities.ts` |
| Change it (platform administrator) | `admin.updateCommunity { category }` in `src/convex/admin.ts` |
| Owner-facing editor ("Edit Subcategory", Save / Cancel) | `src/components/dashboard/CommunitySettings.tsx` |
| Admin Panel community dialog | `src/pages/AdminPanel.tsx` |
| Everywhere it is shown/filtered | `communities.discover`, `communities.categories`, `search.global`, `DiscoverView.tsx`, `SearchView.tsx` |

- **One field, one indexed patch.** `setCategory` patches `servers.category` and nothing else: it
  never touches members, messages, channels, roles, permissions, invites, icons or covers, so no
  data is reset and no community is duplicated. It also short-circuits when the value is unchanged
  (`{ changed: false }`), so re-saving the same subcategory is not even a write.
- **Permissions are server-side.** `requirePermission(ctx, serverId, userId, "manageCommunity")`
  runs first: the owner and community admins pass, an ordinary member is refused no matter what
  the client sends. The Admin Panel route (`admin.updateCommunity`) requires `requirePanelAccess`
  (rank >= admin). Nothing here is a client-side check.
- **Validation against the one list.** Both routes validate with `communityCategoryProblem`
  (case-insensitive, canonical spelling stored: "gaming" → "Gaming"). A value the server refuses
  is a value no picker offers, because the pickers use the same module.
- **Outdated values are handled gracefully.** A community whose stored value is no longer offered is
  still displayed, searched and filterable under that text (`communityCategoryOf`), the editor shows
  it as "no longer offered" so the owner can keep it or switch, and `communities.categories` keeps
  offering the value while any public community still uses it — an outdated community never becomes
  unreachable in Discover.
- **Immediate everywhere, no stale cache.** `discover`, `categories` and `search.global` all read
  the current stored value on every query, and the Discover card, filter row, search result and
  settings panel are reactive `useQuery` subscriptions — so a save moves the community out of its
  old filter and into its new one on the next read, with nothing cached client-side.

## Sidebar and message-row layout stability

Two layout bugs were pure CSS and are now pinned by tests instead of by memory:
`bun layout-stability-test.mjs` parses `src/index.css` and asserts the invariants below.

- **A folder opening can only change vertical height.** The far-left rail is a literal width
  (`width` + matching `min-width`/`max-width`, `flex-shrink: 0`), it clips horizontally
  (`overflow-x: hidden`) and scrolls vertically (`overflow-y: auto`), and it reserves a stable
  scrollbar gutter (`scrollbar-gutter: stable`) so becoming scrollable cannot shift anything.
  Every row inside is width-bounded (`.fc-rail-servers`/`.fc-rail-item` are `min-width: 0;
  max-width: 100%`) and nested servers are narrower than the rail at every breakpoint.
- **The community sidebar is a literal width too.** `.fc-sidebar` now pins `min-width`/`max-width`
  as well as `width`: a flex item's automatic minimum size is its CONTENT's min-content width, so a
  long channel name (or extra rows) could otherwise widen the sidebar and resize the whole layout.
  The intentional collapse (`@media (min-width: 761px) .fc-sidebar.collapsed { width: 0; min-width:
  0; max-width: 0 }`) and the mobile drawer keep their behaviour; the main panel stays
  `flex: 1; min-width: 0` so it absorbs the space instead of squeezing the panes.
- **Hovering a message lights the WHOLE tile.** The highlight is the row's own `background-color`
  (`.fc-message:hover`, full border box), not an inner element's or a partial overlay's — the avatar,
  the body and the action buttons are all covered at full width and height, in every theme
  (`fc-light`, `fc-contrast`, `fc-midnight`), and `background-color` is the only property animated so
  hovering cannot cause a layout shift. `.fc-message.menu-open` keeps its violet tint.

## Community cover art in Discover

The community image shown on a Discover card is the community's OWN uploaded cover — one
field, one upload, one URL:

| Step | Where |
| --- | --- |
| Upload | `CommunitySettings.tsx` ("Community icon") |
| Persist | `communities.updateSettings { iconStorageId }` → `servers.iconStorageId` |
| Resolve | `communities.discover` → `iconUrl` (`ctx.storage.getUrl`), same field as the rail/sidebar |
| Render | `src/components/dashboard/DiscoverView.tsx` (`CommunityCard`) |

- **The card binds that image.** The cover sits at the top of the card with `object-fit: cover`
  (`.fc-community-cover`, 16/7, no stretching) and the name, description, member count, tags and
  Join/Open actions below it. The old placeholder-only card (a hardcoded gradient with the first
  letter) ignored `iconUrl` entirely; the gradient is now used *only* as the fallback, so no
  generated or unrelated image can ever replace real cover art.
- **Fallbacks.** No cover → the gradient + community initial. A failed load (`onError`) → the same
  fallback, so a deleted file degrades instead of breaking the card. The decision lives in
  `src/lib/community-cover.ts` (`bun community-cover-test.mjs`).
- **Freshness.** A storage id is part of the Convex file URL, so replacing a cover yields a NEW
  URL — browsers cannot serve the old picture from cache. The card reads the reactive
  `communities.discover` subscription, so an owner's change appears without a refresh.
- **Upload integrity.** `updateSettings` now validates the blob server-side (exists, PNG/JPG/GIF/
  WebP/AVIF, ≤5 MB) and deletes the blob it replaces (or clears), so old covers neither linger in
  file storage nor can be referenced by a non-image upload.

## Editing a group's picture and settings

An administrator opens a group, clicks **Edit group** (the gear in the community sidebar header, or
**Edit** on the Admin Panel → Communities row) and gets the same stored group picture and the same
permission-gated writes from either surface:

| Step | Where |
| --- | --- |
| Sections (General · Appearance · Permissions · Members · Channels · Danger) | `src/components/dashboard/CommunitySettings.tsx` |
| Group picture (owner / community admin) | `communities.updateSettings { iconStorageId \| clearIcon }` → `servers.iconStorageId` |
| Group picture (platform administrator) | `admin.updateCommunity { iconStorageId \| clearIcon }` → the same column |
| The one image rule (existence, type, ≤5 MB, cleanup) | `assertUsableCover` in `src/convex/communities.ts` |
| Client picker rule (accept list, size, stored content type) | `src/lib/community-cover.ts` (`communityImageProblem`, `communityImageContentType`) |
| Roles / who may post, invite, moderate or edit info | `ServerPermissions.tsx` → `communities.createRole`/`updateRole`/`assignRole`/`kickMember`/`banMember`/`timeoutMember` |
| Group chat photo (a group DM) | `GroupPhotoEditor.tsx` → `dms.setGroupPhoto` → `dmConversations.iconStorageId` |

- **Real sections, not one long scroll.** The panel is a tabbed layout (`.fc-settings-body` +
  `.fc-settings-tabs`, the same shell as account settings, which collapses to a horizontally
  scrollable row on mobile): *General* (name, description, tags, slow mode, Discover/privacy,
  subcategory, invite code), *Appearance* (the group picture, with upload, preview, remove and its
  own Save/Cancel), *Permissions* (roles and channel overrides), *Members* (roles, timeout, kick,
  ban), *Channels* (text and voice) and *Danger* (leave). Every change still goes through the
  mutation it always did — nothing was reimplemented, only regrouped.
- **The picture is previewed before it is stored.** A picked file is only a local preview until
  **Save picture** is pressed; Cancel (or closing the dialog) revokes it and attempts no upload, so
  no orphaned blob is created and no `blob:` URL can ever become the group's saved picture. The same
  is true in the Admin Panel dialog, where the upload happens inside Save.
- **Removing restores the default avatar.** `clearIcon: true` un-sets `servers.iconStorageId` and
  deletes the blob; every surface then falls back to the community initial.
- **Permissions are enforced on the backend.** `communities.updateSettings` requires
  `manageCommunity` (owner/admins); `admin.updateCommunity` requires `requirePanelAccess`. Members
  and moderators are refused server-side even if the client is tampered with, and the panel hides
  the controls from them rather than letting them fail. Kick/Ban/Timeout keep their confirmation
  dialogs and their role-hierarchy guard (`assertCanModerateMember`).
- **Validation on both sides, one source of truth.** The picker refuses SVG/BMP/TIFF/PDF/executables
  and >5 MB, and records the stored content type from the allowed list (or the file extension when
  the browser declares none) — the server then re-inspects the STORED object, so a mislabelled
  upload cannot become a group picture. No key or secret is read in the client; uploads use
  short-lived `uploads.generateUploadUrl` URLs.
- **Persistence and real time.** The picture and settings live on the `servers` row (and the group
  chat photo on `dmConversations`), so they survive refreshes; every surface reads them through
  reactive `useQuery` subscriptions (`communities.listMine`/`details`/`discover`, `dms.*`, the
  rail, sidebar, header, search) and a storage id changes the file URL, so a replaced picture shows
  immediately and is never served from cache.
- **Verification.** `bun group-settings-test.mjs` (102 assertions) covers the picker rules, asserts
  in the real source that both editors validate with the same shared rule, persist to the database,
  delete replaced blobs, defer the upload to Save, confirm before removing a member, and render the
  four required sections. It then talks to the live deployment with NO session: the deployment's own
  refusal reproduces its argument schema, which is checked to declare
  `iconStorageId: v.optional(v.id("_storage"))` and `clearIcon: v.optional(v.boolean())` on both
  write paths, and — using a real, discoverable community id so validation passes — asserts that
  renaming, changing privacy, clearing a picture and editing as a member are all refused by the
  **authorization gate** (`Please sign in first.`), never by a validator, plus that a signed-out
  caller cannot mint an upload URL. `bun group-photo-test.mjs` covers the group-chat photo framing,
  and `bun community-cover-test.mjs` the cover fallbacks.

## Administrator message moderation (delete anyone's message for everyone)

The existing global-deletion mechanism is reused, not reimplemented: `deletion.deleteForEveryone`
and `deletion.deleteDmForEveryone` redact the row (`deletedForEveryone`, body emptied, reactions and
orphan-safe attachments removed) and every view, search, preview and reply quote already hides it.

- **Who may do it.** The author (unchanged), a community moderator with
  `manageMessages`/`deleteMessages` (unchanged), and now a **global platform administrator**
  (`rankOf(users.role) >= ROLE_RANK.admin`, read server-side — never a client flag). Community
  channels also require membership; a DM requires being a participant.
- **Surfaces.** The channel menu ("Delete for everyone" on anyone's message, gated by
  `deletion.canModerateHere`, which now includes administrators) and the DM menu (the same item on
  anyone's message when `users.me.isAdmin`). Both confirm first with a dialog naming the message and
  the conversation, and report success/error.
- **Messages an administrator already hid.** `adminMessages.listMineHiddenMessages` (Admin Panel →
  "Hidden Messages") lists every retained message the administrator hid with "Delete for me",
  whoever wrote it, and `deletion.deleteHiddenForEveryone` globally deletes one from there — no
  need to restore it to their own history first, and it stays hidden from their view.
- **Safety.** Administrator checks come first in every handler; both mutations are idempotent
  (`alreadyDeleted` instead of a second delete); the audit entry records actor, action, message id,
  conversation reference and timestamp — never the message content.
- **Tests.** `bun deleted-messages-test.mjs` (retention rules), `bun deleted-messages-authz-test.mjs`
  (live refusal of anonymous callers), and the account-creating `bun admin-authz-test.mjs`
  (phase 8b: an Admin deletes another member's channel + DM message, non-admins are refused with a
  real message id).

## Message composer: pasting, formatting and the 30,000-character limit

A Freecord message is stored as ONE plain-text string in the database. That is why formatting is
carried *inside* the text as a small Markdown subset, and why pasted rich text is converted to that
subset instead of being inserted as HTML.

- **The limit.** `MESSAGE_MAX_LENGTH = 30_000` lives in `src/lib/message-format.ts` and is imported by
  the composer, the character counter **and** the backend (`convex/chat.ts`, `convex/dms.ts`). Length
  is counted in Unicode **code points** (`messageLength`), so an emoji is one character and the
  counter and the server agree exactly. Type/paste/edit up to 30,000; over that the counter turns
  red, the send button is disabled and a notice explains how many characters to remove. Text is
  **never truncated** — not on paste, not on edit, not on send (the old `body.slice(0, 4000)` in both
  edit mutations is gone).
- **Pasting.** `src/lib/paste-html.ts` converts the clipboard's `text/html` flavour into the subset
  and falls back to `text/plain` (with its line breaks intact) when there is no rich flavour. It
  never renders or inserts HTML: scripts, styles, iframes, `onerror=`-style handlers and
  `javascript:`/`data:` links are dropped, so pasted markup cannot execute. Paragraph breaks, blank
  lines, indentation, bold, italic, underline, strikethrough, inline code, fenced code, links,
  bullet/numbered lists, headings, blockquotes, emoji and non-English text are preserved. Google
  Docs/Word boilerplate (`<b style="font-weight:normal">` wrappers) is detected and not turned into
  fake bold.
- **Rendering.** `MentionText` renders the stored body through the shared parser, so channels, DMs,
  group chats, replies and every other device show the same formatting. Reply quotes, search results
  and sidebar previews show `plainSummary(...)` — the text without markers.
- **Composers.** The message box in a channel and in a DM (and the New Message dialog) is an
  auto-growing **textarea**: a single-line `<input>` is what silently dropped every newline and
  produced the flattened pastes. `Enter` sends, `Shift+Enter` inserts a newline, `@mention`
  autocomplete still owns the arrow/Enter keys while its menu is open.
- **Tests.** `bun message-format-test.mjs` (113 assertions: limits, Unicode counting, HTML→markdown
  conversion, sanitisation, plain-text fallback, parser output, copy-out/copy-in round trip, and
  source invariants that no `4000` limit survives).

## Admin Panel → Cleanup & Maintenance

A new Admin Panel tab (between Communities/Moderation and the retention tabs) with **two
administrator-only tools**: **Message Cleanup** (delete messages by when they were sent) and
**General System Cleanup** (remove data the app regenerates, or that nothing references any more).
Everything is enforced on the backend — the tab is a UI for server functions, not a client-side
delete loop, and nothing here invents data or removes it only in the browser.

| Piece | Where |
| --- | --- |
| Rules (scopes, ranges, batching, categories, time zones) | `src/lib/cleanup.ts` (`bun cleanup-maintenance-test.mjs`) |
| Backend: authorization, previews, jobs, audit, categories | `src/convex/cleanup.ts` |
| Panel UI (two tools, cards, dialogs, progress, history) | `src/components/admin/CleanupMaintenance.tsx` |
| Tab wiring | `src/pages/AdminPanel.tsx` (`value="cleanup"`, only mounted while the panel is unlocked) |
| Job + history rows | `cleanupJobs` table in `src/convex/schema.ts` (`by_started`, `by_status`) |
| Deleting a message safely | the app's own `deleteChannelMessage` / `deleteDmMessage` in `src/convex/storage.ts` |

### Message Cleanup — by send time, and by scope

The range is always built from the message's **real `_creationTime`** (the stored send time), and the
scope optionally limits the sweep to one community, channel or direct conversation:

| Range / scope | Behaviour |
| --- | --- |
| All messages on the site | Every channel message and every DM, subject to the actor's role |
| Messages older than a date | `createdAt < before` (exclusive) |
| Messages within a range | `from <= createdAt <= to` (both ends inclusive) |
| Limited to a community / channel / conversation | The same date rules, applied only inside that target (a community means all of its channels) |

- **Date and time pickers**, and the time zone is always named (`timeZoneLabel`, e.g.
  `Europe/Berlin (UTC+2)`). The picker's local value is converted to one absolute instant
  (`fromLocalPicker`) and the LABEL that goes into history says which zone it was interpreted in, so
  "older than 2026-01-01 10:00" means the same thing to the person clicking and to the database.
- **Preview affected messages** first: `cleanup.previewMessages` counts what the current range and
  scope would delete (per channel and per DM) *without writing anything*. Counts are exact while the
  scan stays under `PREVIEW_SCAN_LIMIT` (5,000 rows / 200 targets) and are reported as a lower bound
  above that, rather than pretending to be exact.
- **Confirmation names the consequence**: the dialog reports the count and the range — *"Are you sure
  you want to delete 2,450 messages sent from … to …? This action may not be reversible."* — with
  **Cancel** (which leaves everything untouched, always) and **Delete Messages**.
- **Site-wide deletion needs two things**: an **Owner Admin** role *and* the typed phrase
  `DELETE ALL MESSAGES` (`SITE_WIDE_PHRASE`, compared case/space-insensitively by `phraseMatches`).
  Both are re-checked inside the mutation, so a crafted request that omits the phrase is refused.
- **Scoped ids are never trusted**: the client sends `{ kind, id }`; the server re-resolves the row
  and builds the history label from the real community/channel/conversation, so an audit entry cannot
  be spoofed and cannot name something the actor could not see.
- **Progress, then a report**: the panel subscribes to the running job (`cleanup.job`), so the bar,
  the per-batch counts and the final summary (`jobResultLabel`, e.g. *"Completed — 2,450 messages,
  18 files deleted"*) update live. Errors are counted and the last secret-free message is shown.

### General System Cleanup — eight categories, preview then run

Each card shows what the category IS, exactly which rows/files it may remove, the safety rule, who
may run it and — where measurable — the storage it would recover. Eight categories exist because
eight are supported by this app's actual schema:

| Category | Removes | May run |
| --- | --- | --- |
| Orphaned records | Messages whose channel/sender is gone, DMs in a conversation with no members, plus their attachments/reactions/“delete for me” rows | Owner |
| Abandoned file uploads | Stored files ≥ 24 h old that no message, profile, banner, group photo or community icon references | Owner |
| Expired sessions and codes | Auth sessions, refresh tokens and verification codes past their own expiry | Admin |
| Stale typing and call signals | “is typing” rows and call signalling payloads older than 30 min, presence rows of deleted accounts | Admin |
| Finished call records | Call invitations that ended/expired more than 7 days ago | Admin |
| Expired community invites | Invite links whose expiry passed or whose uses are used up | Admin |
| Expired unlocks and reset codes | Lapsed lock unlocks, Secret Chats PIN reset codes, site-lock recovery codes, expired lockout timers | Admin |
| Expired rate-limit counters | Abuse-protection windows that ended more than a day ago | Admin |

- **Preview Cleanup** (`cleanup.previewGeneral`) scans every selected category and reports the record
  count and recoverable bytes per card. It is read-only — it opens no write path.
- **Run Cleanup** deletes only the categories the administrator selected, in bounded batches, and
  reports progress and a final summary.
- **Nothing is deleted for "looking old".** Every category is defined by a positive rule the row
  itself carries (an expired timestamp) or by "nothing references this" — and every parent is
  resolved server-side first (`referencedStorageIds` builds the set of storage ids that live
  attachments, profiles, groups and communities still use, and a file is only unlinked when it is in
  none of them).
- **What general cleanup can never touch**: user accounts, communities, channels, memberships,
  roles, profiles, groups, live sessions, attachments a message still references, audit records,
  and anything from the active recovery windows above.

### Concurrency, authorization and audit

- **Every public function starts with `requireActor`** → `requirePanelAccess` (the panel's existing
  `rankOf(role) >= ROLE_RANK.admin` gate). Ordinary users calling the endpoints directly are refused
  with `Administrator access required.`, and the Owner-only paths are refused for a plain Admin.
- **A running job re-checks its actor before every batch**, so revoking access stops the cleanup
  with an audited `failed` status instead of letting it continue on stale authority.
- **At most one cleanup runs at a time** (`requireNoRunningJob` uses the `by_status` index); a job
  that stopped reporting progress is recovered as failed, so a crashed run cannot block the panel
  forever.
- **Locks, batches and atomicity**: each batch is one Convex mutation, so it is all-or-nothing — a
  thrown batch rolls back and records the failure rather than leaving half-deleted records. Message
  cleanup sweeps 200 rows per batch and re-schedules itself; a time window in the middle of a long
  history is reached through an **indexed** time-bounded scan, so nothing is read merely to skip it.
- **Audited**: start, completion, cancellation and failure are written through `auditAdmin` with the
  actor, action, scope label, range label (including the time zone), counts and outcome. No module
  here reads a password, PIN or token, so none can reach a log or a history row.

### History and recovery (what is actually true)

The **Cleanup History** table shows each job's date, administrator, type, scope, records affected and
result, and stays readable after the messages are gone — `cleanupJobs` rows and their audit entries
are never cleanup targets.

**Recovery, stated honestly:** this project has no backup/restore mechanism for messages, so a
message cleanup is **not** reversible — the confirmation dialog says so, and this README does not
claim otherwise. What *is* recoverable is the record of what happened (job + audit rows), and the
“Preview” step is the real safety net: run it first, check the count against the range, then delete.
Files unlinked by a cleanup are removed from Convex storage; nothing in this feature deletes a
backup, and no backup exists for it to delete.

### Verification

`bun cleanup-maintenance-test.mjs` (204 assertions) covers three layers, none of which needs an
account:

1. **The pure rules** — `rangeCovers` for each range kind, `scopeProblem`/`rangeProblem` rejections
   (an empty window is refused rather than silently deleting nothing), `isSiteWide`/`requiredPhrase`
   (the phrase is required for site-wide only), `phraseMatches` case/space handling, `batchPlan` and
   `progressPercent` bounds, `formatCount`/`formatBytes`/`formatMoment`/`timeZoneLabel`,
   `toLocalPicker`/`fromLocalPicker` round-tripping the admin's own time zone, and
   `sanitizeCategoryIds` dropping unknown/duplicate ids.
2. **The real source** — the rules are imported by both `src/convex/cleanup.ts` and
   `CleanupMaintenance.tsx`; every public backend function begins with the admin gate; the
   site-wide phrase is verified server-side; deletion goes through `deleteChannelMessage` /
   `deleteDmMessage`; the UI shows a preview, a confirmation, progress and history, never a
   `window.confirm`, never a `localStorage` flag and never a client-only delete; every category in
   `GENERAL_CATEGORIES` has an implementation and vice versa.
3. **The live deployment, with no session** — all four public entry points
   (`permissions`, `scopes`, `history`, `job`, `startMessageCleanup`, `startGeneralCleanup`,
   `cancelJob`, both previews) are called anonymously and must refuse with
   `Administrator access required.`, so nothing is written.

`bun deleted-messages-test.mjs`, `bun group-settings-test.mjs`, `bun community-category-test.mjs`,
`bun layout-stability-test.mjs`, `bun admin-pin-test.mjs` and `bun site-lock-test.mjs` were re-run
unchanged after this feature to confirm the existing retention, moderation and layout behaviour is
intact.

## Admin Panel retention tabs — the "multiple paginated queries" trap

Both retention tabs (`listMineDeletedMessages`, `listMineHiddenMessages`) share one indexed read,
`paginateHidden`. It used to LOOP over `paginate` calls (to keep filling a page while rows were
filtered out), which Convex rejects at runtime:

```
Uncaught Error: This query or mutation function ran multiple paginated queries.
    at async paginateHidden (src/convex/adminMessages.ts)
```

The client rethrows a failed paginated query, so that error took the **whole Admin Panel** down —
clicking the Deleted Messages tab (or Hidden Messages) looked like "the admin panel is broken".

- **Fix:** one `paginate` per execution, with a bounded scan window
  (`pageSize × SCAN_MULTIPLIER`, capped at `MAX_SCAN_ROWS`). Rows the filters reject are skipped;
  `continueCursor` still points past everything the call examined, so nothing is skipped or
  duplicated. Verified against the live deployment with a temporary internal diagnostic (since
  removed): the read returns real rows (e.g. 19 retained "deleted for me" messages, `isDone: false`,
  cursor present) instead of the error.
- **Isolation:** each tab's subscription now lives in its own component (`MyDeletedMessagesList`,
  `HiddenMessagesList`) inside a `FeatureBoundary`, so a failure shows a retryable error *in that
  tab* — never a false empty list and never a dead panel. `"skip"` keeps the inactive tab
  unsubscribed.
- **Malformed rows** are tolerated (defensive `body`/`preview`/`attachments`/timestamp reads), and the
  empty state only appears when the query actually answered with `Exhausted` and no rows.

## Direct Messages tab — real conversations instead of a false empty state

The DM pane is driven by `conversationId` (an explicit click). It starts `null`, so opening the tab —
including on a narrow viewport where the sidebar is collapsed — showed only "Start a conversation
with someone on Freecord" even for an account with plenty of chats (the data was always there;
`dmConversations`/`dmMembers` rows exist in the deployment, and `bun run preflight` confirms the
frontend and backend target the same deployment).

- `selectedConversationId = conversationId ?? activeConversations[0]?.conversationId ?? null` — the
  most recent conversation (the list is already sorted pinned-then-recent) opens automatically, so
  the tab shows real chats immediately. Reactive: a new conversation becomes selected with no reload.
- Three separate states in the pane: **loading** (`Loading your conversations…` while
  `dms.listConversations` is unresolved), **archived-only** (points at the Archived section), and
  **genuinely empty** (the only case that shows the “Start a conversation” CTA, with the Friends
  shortcut kept as an option). The sidebar says “Loading conversations…” until the query answers and
  only then “No conversations yet”.
- Each row shows the conversation name (group rows carry the member count as their own chip), the
  **latest message preview and its timestamp** — both already returned by `dms.listConversations`, so
  no extra query or read — plus the unread badge, lock/pin/mute flags and the other member's live
  avatar. A protected chat that has not been unlocked reads “🔒 Locked”, never its content.
- The conversation list is wrapped in a `FeatureBoundary`, so a malformed row cannot blank the
  sidebar; a failing query throws (Convex semantics) into the enclosing boundary's error + “Try
  again”, never a bogus empty state. No extra subscriptions, polling or full-table reads were added.

## Group names beside the picture (sidebar + Conversations page)

A group's name is ONE optional column (`dmConversations.name`) and ONE display rule
(`src/lib/group-name.ts`), so the sidebar list, the Conversations page, the chat header and the
Locked & Hidden Conversations screen can never print different text for the same group:

| Step | Where |
| --- | --- |
| The rule (`groupDisplayName`, `UNNAMED_GROUP`, `isUnnamedGroup`) | `src/lib/group-name.ts` |
| Name loaded from the database | `dms.listConversations`, `dms.groupDetails` (`src/convex/dms.ts`) |
| Secret Chats list | `conversationPrivacy.secretChats` |
| Sidebar row (picture, then the name) | `ConversationIcon` + `DmRowLabel` in `src/pages/Dashboard.tsx` |
| Conversations page (the same rows, full width) | `ConversationsPage` in the same file |
| Chat header | `src/components/dashboard/DmView.tsx` |
| Layout invariants | `.fc-dm`, `.fc-dm-name`, `.fc-dm-title`, `.fc-dm-count`, `.fc-convo-item` in `src/index.css` |

- **Picture first, name immediately beside it.** A row is `<ConversationIcon>` (a group's own photo
  — `dmConversations.iconStorageId` — or its default group icon) followed by `DmRowLabel` (the name,
  the member-count chip, the timestamp, the preview). `.fc-dm`/`.fc-convo-item` are `align-items:
  center`, and `.fc-dm-title-row` centers the name with that chip, so the name sits vertically
  centered against the picture at any height.
- **Names never break the layout.** `.fc-dm-name` is `flex: 1; min-width: 0` and the name itself is
  `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` with no fixed width, so a very long
  name truncates inside the row instead of widening the sidebar. The member count is its own
  `flex-shrink: 0` chip rather than “Name · 3”, so truncation never eats it and it never eats the
  name. The full name stays available as the row's `title`/`aria-label`.
- **The selected group is highlighted** in both lists (`.fc-dm.active` / `.fc-convo-item.active`) and
  announced with `aria-current`, and clicking a row opens that conversation.
- **The Conversations page.** The CONVERSATIONS heading in the sidebar opens it (and it is what the
  Direct Messages pane shows when no chat is open, e.g. when every chat is archived); it lists open
  and archived chats with the same rows. It is also what keeps names visible on a phone, where the
  sidebar is a drawer (`.fc-sidebar { display: none }` → `.fc-sidebar.open`).
- **Real names, and an honest fallback.** Names come from the database, never from a hardcoded list;
  a group with no name (empty/whitespace, or the literal placeholder older versions stored) reads
  **“Unnamed Group”**. New groups store the name as typed and store *nothing* when it is left blank,
  so a placeholder can no longer masquerade as a real name.
- **Live updates.** Every list reads the reactive `dms.listConversations` subscription, so an admin's
  rename (`dms.renameGroup`) or new picture (`dms.setGroupPhoto`) appears in the sidebar, the page,
  the header and Secret Chats without a reload, and it survives a refresh because it was stored.
- **Verification.** `bun group-name-test.mjs` (62 assertions) covers the rule offline (stored names
  preserved, whitespace trimmed, “Group Therapy” untouched, empty/legacy values → “Unnamed Group”),
  asserts in the real source that both queries and all four surfaces use it, that the row renders the
  picture then the name, that truncation/centering/no-fixed-width hold in the CSS, that the
  Conversations page renders the same rows and highlights the selected chat, and that a signed-out
  caller cannot rename a group.

## Friends list ordered by last-online activity

The friends list is ordered by real presence data — one pure rule, applied by the query AND the
view, so the two can never disagree (`src/lib/friend-sort.ts`, `bun friend-sort-test.mjs`):

| Order | What it means | Key |
| --- | --- | --- |
| 1 | `online`, then `dnd`, then `idle` | most recent activity (`lastActive`, else `lastSeen`) |
| 2 | offline friends | stored `lastSeen`, newest first |
| 3 | friends who have never been online | their name, then id |

- **Where the data comes from.** `presence.lastSeen` / `lastActive` on the existing `presence` table
  (`src/convex/schema.ts`), written by `profiles.heartbeat` (one 30s ping, only while the tab is
  visible and online), `profiles.setPresence` (manual status) and `profiles.disconnect` (on unload —
  an upsert, so a session that never heart-beated still records a last-online time). No sample users,
  no hardcoded timestamps: `social.listFriends` reads the real `friendships` table and the viewer's
  own authorization (`publicCard` resolves each friend server-side).
- **Unexpected disconnections.** `presenceInfoOf` treats a session with no heartbeat for 90s as
  offline **without erasing `lastSeen`**, so a crashed tab or lost connection keeps its real
  last-online value and sorts by it instead of dropping to “never seen”.
- **Privacy is part of the rule.** A friend who chose *invisible*, or who turned presence off
  (`presenceVisible: false`), reads as offline to everyone else AND now has `lastSeen`/`lastActive`
  withheld — “Last online 2 minutes ago” would give away exactly what hiding the status was meant to
  keep private. To others they sort with the never-seen friends; you still see your own timestamps.
- **Indicators.** The row keeps its picture, username and status dot: green `online`, yellow `idle`,
  red `dnd`, gray `offline` (`PRESENCE_META`, with `showAllStates` drawing the gray dot in lists).
  Offline rows print `formatLastSeen` — “Last online 5 minutes ago”, or “Last online unknown” for a
  friend who has never been online.
- **Real time.** `social.listFriends` is a reactive query and the client applies the same rule inside
  a `useMemo`, so a friend coming online moves up, and a friend going offline drops into the
  last-seen order, with no reload — and the order is identical after a refresh, because it is derived
  from stored timestamps rather than client state. Equal timestamps are broken deterministically
  (display name → username → user id), so the list never shuffles.
- **Responsive row.** `.fc-row-main > span` may shrink (`min-width: 0`) and the name and status line
  truncate with an ellipsis, and the row itself is never fixed-width — so a long display name or
  username cannot push a friend's status or the action buttons off a narrow screen.
- **Verification.** `bun friend-sort-test.mjs` (73 assertions): the rule offline (online > dnd >
  idle > offline by `lastSeen` > never-online, coming online moves a friend up, the input array is
  never mutated, ties are stable), the real source of the presence writes, the staleness window, the
  withheld-timestamp privacy rule, that both the query and `HomeView` use the rule, the indicator
  colours and the heartbeat/unload wiring, the responsive row rules, plus a live call proving the
  friends query answers without exposing presence to a signed-out caller.

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
