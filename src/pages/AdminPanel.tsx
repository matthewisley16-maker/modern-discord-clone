import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toSafeArray } from "@/lib/collection";
import { DELETED_FOR_ME_TTL_MS, deletedForMeRemainingLabel } from "@/lib/deleted-messages";
import { communityCategoryOptions } from "@/lib/community-categories";
import { COMMUNITY_IMAGE_ACCEPT, COMMUNITY_IMAGE_MAX_BYTES, communityImageContentType, communityImageProblem } from "@/lib/community-cover";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FeatureBoundary } from "@/components/ui/feature-boundary";
import { AdminPinGate, AdminPinSettings } from "@/components/admin/admin-pin";
import CleanupMaintenance from "@/components/admin/CleanupMaintenance";
import { toast } from "sonner";
import {
  ArrowLeft, Ban, Check, Crown, ImagePlus, Paperclip, Search, ShieldAlert, ShieldCheck, Trash2, UserCog, Users, Clock,
} from "lucide-react";

/** Mirrors the backend ROLE_RANK so the UI reflects — never decides — authority. */
const RANK: Record<string, number> = { member: 0, user: 0, moderator: 1, admin: 2, owner: 3, owner_admin: 3 };

/** The retention window in plain words, so the copy can never drift from the rule. */
const RETENTION_DAYS = Math.round(DELETED_FOR_ME_TTL_MS / 86_400_000);

const ROLE_LABEL: Record<string, string> = {
  owner_admin: "Owner Admin",
  owner: "Owner Admin",
  admin: "Admin",
  moderator: "Moderator",
  user: "User",
  member: "Member",
};

const ROLE_BADGE: Record<string, string> = {
  owner_admin: "border-amber-400/30 bg-amber-400/15 text-amber-300",
  owner: "border-amber-400/30 bg-amber-400/15 text-amber-300",
  admin: "border-violet-400/30 bg-violet-400/15 text-violet-200",
  moderator: "border-sky-400/30 bg-sky-400/15 text-sky-200",
  user: "border-white/10 bg-white/5 text-muted-foreground",
  member: "border-white/10 bg-white/5 text-muted-foreground",
};

/** Any role carrying Owner Admin authority (canonical value or legacy alias). */
const isOwnerRole = (role?: string | null) => (RANK[role ?? "user"] ?? 0) >= 3;

/** Reads a ConvexError's user-safe message (Batch 1 pattern). */
function friendly(err: unknown, fallback: string): string {
  const any = err as { data?: unknown; message?: string };
  if (typeof any?.data === "string" && any.data.trim()) return any.data;
  if (any?.data && typeof (any.data as { message?: string }).message === "string") {
    return (any.data as { message: string }).message;
  }
  if (typeof any?.message === "string" && any.message.trim()) {
    return any.message.replace(/^\[.*?\]\s*/, "").split("\n")[0].slice(0, 200);
  }
  return fallback;
}

function RoleBadge({ role }: { role: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${ROLE_BADGE[role] ?? ROLE_BADGE.user}`}>
      {isOwnerRole(role) && <Crown className="size-3" />}
      {ROLE_LABEL[role] ?? role}
    </span>
  );
}

/**
 * The rows of a retention list. Presentational only — it holds no query and no
 * hooks, so it can never subscribe to anything itself; malformed values are
 * tolerated instead of crashing the tab.
 */
function RetainedRows({ mode, rows, status, searching, busy, onDelete, onLoadMore }: {
  mode: "mine" | "moderation";
  rows: RetainedRow[];
  status: RetentionStatus;
  searching: boolean;
  busy: boolean;
  onDelete: (row: RetainedRow) => void;
  onLoadMore: () => void;
}) {
  const mine = mode === "mine";
  // One slow local tick per list (once a minute) keeps the retention countdown
  // truthful without polling anything: it causes no query, no network traffic and
  // no server work, and it stops when the list is unmounted.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      <p className={mine
        ? "rounded-lg border border-amber-400/25 bg-amber-400/[0.06] p-3 text-xs text-muted-foreground"
        : "rounded-lg border border-sky-400/25 bg-sky-400/[0.06] p-3 text-xs text-muted-foreground"}>
        {mine ? (
          <>
            <span className="text-amber-200">Deleting here deletes for real.</span> Each entry is one of your own
            messages that you removed from your view with “Delete for me” — its content is still in storage. Pressing
            delete removes the message <em>completely, for every participant</em> (content, attachments and files, no
            “message deleted” placeholder). Messages already deleted for everyone are not listed: there is nothing
            left to recover.
            <br />
            Each entry expires on its own <span className="text-amber-200">{RETENTION_DAYS} days</span> after you deleted
            the message for yourself and then disappears from this list without any action — expiring only drops the
            entry, so the message stays hidden for you and everyone else keeps their copy.
          </>
        ) : (
          <>
            <span className="text-sky-200">Hiding is per person; deleting is for everyone.</span> This list only contains
            messages <span className="text-sky-200">you</span> hid with “Delete for me” — hiding never changed anyone
            else&apos;s view, and the list never becomes a window into other people&apos;s private conversations. Deleting
            from here removes the message <em>completely for all participants</em> — content, attachments and files,
            with no placeholder left — and cannot be restored. Entries are listable for{" "}
            <span className="text-sky-200">{RETENTION_DAYS} days</span>; after that they expire on their own and can no
            longer be deleted from here.
          </>
        )}
      </p>

      {status === "LoadingFirstPage" && (
        <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
      )}

      {status === "Exhausted" && rows.length === 0 && (
        <div className="py-8 text-center text-sm text-muted-foreground">
          <p className="font-medium text-foreground">
            {searching ? "No messages match your search." : mine ? "No deleted messages." : "Nothing hidden right now."}
          </p>
          <p className="mt-1 text-xs">
            {searching
              ? "Try a different word, conversation or file name."
              : mine
                ? "When you remove one of your own messages with “Delete for me”, it appears here until you delete it completely or it expires."
                : "Messages you hide with “Delete for me” show up here while their content is still retained."}
          </p>
        </div>
      )}

      {rows.map((item) => {
        // Defensive reads: a legacy or partial row can never break the tab.
        const body = typeof item.body === "string" ? item.body : "";
        const preview = typeof item.preview === "string" && item.preview ? item.preview : "(no text content)";
        const attachments = toSafeArray<RetainedRow["attachments"][number]>(item.attachments, {
          label: "Retained attachments",
          source: "api.adminMessages",
        });
        const senderName = item.senderName || "Unknown sender";
        const conversationName = item.conversationName || "Unknown conversation";
        const sentAt = typeof item.sentAt === "number" ? new Date(item.sentAt).toLocaleString() : "unknown time";
        const hiddenAt = typeof item.hiddenAt === "number" ? new Date(item.hiddenAt).toLocaleString() : "unknown time";
        // Seven-day retention window for THIS entry (server-decided; this is display only).
        const remaining = typeof item.hiddenAt === "number" ? deletedForMeRemainingLabel(item.hiddenAt, now) : "expired";
        const windowClosed = remaining === "expired";
        return (
          <div key={item.visibilityId} className="rounded-lg border border-white/8 bg-white/[0.02] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={mine ? "border-amber-400/40 text-amber-300" : "border-sky-400/40 text-sky-200"}>
                {mine ? "Hidden for me — still in storage, deletable" : "Hidden by you — deletable for everyone"}
              </Badge>
              <Badge variant="secondary">
                {item.conversationType === "channel"
                  ? "Channel"
                  : item.conversationType === "group"
                    ? "Group DM"
                    : "Direct message"}
              </Badge>
              <span className="truncate text-sm font-medium">{conversationName}</span>
              {item.communityName && <span className="text-xs text-muted-foreground">in {item.communityName}</span>}
              <span className="ml-auto text-xs text-muted-foreground">{sentAt}</span>
            </div>

            <p className="mt-2 line-clamp-4 whitespace-pre-wrap break-words text-sm text-foreground/90">
              {body.trim() ? body : preview}
            </p>

            {(attachments.length > 0 || item.gifUrl) && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {attachments.map((file, index) =>
                  file.isImage && file.url ? (
                    <img
                      key={`${item.visibilityId}-att-${index}`}
                      src={file.url}
                      alt={file.name}
                      className="h-20 w-20 rounded-md border border-white/10 object-cover"
                    />
                  ) : (
                    <span
                      key={`${item.visibilityId}-att-${index}`}
                      className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-muted-foreground"
                    >
                      <Paperclip className="size-3" /> {file.name}
                    </span>
                  ),
                )}
                {item.gifUrl && (
                  <img src={item.gifUrl} alt="GIF" className="h-20 rounded-md border border-white/10 object-cover" />
                )}
              </div>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>Sent by {senderName}{mine ? "" : item.senderIsMe ? " (you)" : ""}</span>
              <span aria-hidden>·</span>
              <span>Deleted for you {hiddenAt}</span>
              <span aria-hidden>·</span>
              <span
                className={windowClosed ? "text-destructive" : "text-amber-200/90"}
                title={
                  typeof item.expiresAt === "number"
                    ? `This entry expires ${new Date(item.expiresAt).toLocaleString()} (seven days after you deleted it for yourself).`
                    : undefined
                }
              >
                {windowClosed ? "Entry expired" : `Entry expires in ${remaining}`}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto text-destructive"
                disabled={busy}
                onClick={() => onDelete(item)}
              >
                <Trash2 className="mr-1 size-4" /> {mine ? "Delete completely" : "Delete for everyone"}
              </Button>
            </div>
          </div>
        );
      })}

      {status === "CanLoadMore" && (
        <div className="flex justify-center pt-1">
          <Button variant="secondary" size="sm" onClick={onLoadMore}>
            Load older messages
          </Button>
        </div>
      )}
      {status === "LoadingMore" && <p className="py-2 text-center text-xs text-muted-foreground">Loading…</p>}
    </>
  );
}

/**
 * Deleted Messages / Hidden Messages list bodies.
 *
 * Each one owns its OWN paginated subscription and is rendered inside a
 * `FeatureBoundary`. Convex hooks THROW on failure, so keeping the subscription
 * in this child (instead of in the panel body) means a failing retention query
 * shows a retryable error inside its own tab instead of taking the whole Admin
 * Panel down. `"skip"` keeps the tab the admin is not looking at unsubscribed.
 */
function MyDeletedMessagesList({ active, search, busy, onDelete }: {
  active: boolean;
  search: string;
  busy: boolean;
  onDelete: (row: RetainedRow) => void;
}) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.adminMessages.listMineDeletedMessages,
    active ? { search: search.trim() || undefined } : "skip",
    { initialNumItems: 20 },
  );
  const rows = useMemo(
    () => toSafeArray<RetainedRow>(results, { label: "My deleted messages", source: "api.adminMessages.listMineDeletedMessages" }),
    [results],
  );
  return (
    <RetainedRows
      mode="mine"
      rows={rows}
      status={status}
      searching={Boolean(search.trim())}
      busy={busy}
      onDelete={onDelete}
      onLoadMore={() => loadMore(20)}
    />
  );
}

/** The moderation list: every retained message the administrator hid. */
function HiddenMessagesList({ active, search, busy, onDelete }: {
  active: boolean;
  search: string;
  busy: boolean;
  onDelete: (row: RetainedRow) => void;
}) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.adminMessages.listMineHiddenMessages,
    active ? { search: search.trim() || undefined } : "skip",
    { initialNumItems: 20 },
  );
  const rows = useMemo(
    () => toSafeArray<RetainedRow>(results, { label: "Hidden messages", source: "api.adminMessages.listMineHiddenMessages" }),
    [results],
  );
  return (
    <RetainedRows
      mode="moderation"
      rows={rows}
      status={status}
      searching={Boolean(search.trim())}
      busy={busy}
      onDelete={onDelete}
      onLoadMore={() => loadMore(20)}
    />
  );
}

type AdminUser = {
  userId: string;
  username: string;
  name: string;
  email: string | null;
  role: string;
  isProtectedOwner: boolean;
  isSelf: boolean;
  banned: boolean;
  banReason: string | null;
  suspendedUntil: number | null;
  suspendReason: string | null;
  isAnonymous: boolean;
  createdAt: number;
};

type PendingAction =
  | { type: "role"; user: AdminUser; role: string }
  | { type: "ban"; user: AdminUser }
  | { type: "unban"; user: AdminUser }
  | { type: "suspend"; user: AdminUser }
  | { type: "unsuspend"; user: AdminUser }
  | { type: "delete"; user: AdminUser }
  | null;

/**
 * One retained-message row. Both retention queries
 * (`listMineDeletedMessages`, `listMineHiddenMessages`) return the same shape,
 * so the two tabs share one row renderer.
 */
type RetainedRow = FunctionReturnType<typeof api.adminMessages.listMineDeletedMessages>["page"][number];

/** The status `usePaginatedQuery` reports for its current page. */
type RetentionStatus = "LoadingFirstPage" | "LoadingMore" | "CanLoadMore" | "Exhausted";

export default function AdminPanel() {
  const navigate = useNavigate();
  const access = useQuery(api.admin.panelAccess, {});
  // OPTIONAL Admin PIN: is protection on, and is THIS session open? The query
  // returns harmless defaults for anyone without panel access, so it is safe to
  // subscribe unconditionally. Hook order never changes: the value is only used
  // to decide what to render and which admin queries to subscribe to.
  const pinStatus = useQuery(api.adminPin.status, {});
  // Nothing behind the PIN gate is fetched: while protection is on and this
  // session has not entered the PIN, every admin query below is skipped, so a
  // locked panel holds no admin data at all (not even statistics).
  const panelOpen = pinStatus !== undefined && (!pinStatus.enabled || pinStatus.unlocked);
  const stats = useQuery(api.admin.stats, panelOpen ? {} : "skip");
  // Re-run the server-side identity sync on entry so a protected Owner Admin
  // who deep-links straight to /admin is recognised without a detour through
  // the Dashboard first. The role itself is still decided entirely server-side.
  const ensureIdentity = useMutation(api.users.ensureIdentity);
  const [identityChecked, setIdentityChecked] = useState(false);
  useEffect(() => {
    ensureIdentity({}).catch(() => {}).finally(() => setIdentityChecked(true));
  }, [ensureIdentity]);
  const [userQuery, setUserQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  // Only the ACTIVE tab's data is fetched.
  //
  // A Convex subscription re-executes its whole query whenever anything it read
  // changes, so a query that scans the users table (or every community's whole
  // membership list) runs again on unrelated activity — and billed reads scale
  // with `(reads per execution) x (re-executions)`. The overview cards above the
  // tabs genuinely need `stats` and the synthetic-data audit, but the tab lists
  // do not: nothing is fetched for a tab the admin is not looking at (`"skip"`).
  const [tab, setTab] = useState("users");
  // "My deleted messages": only the ACTIVE tab is subscribed (see the note above).
  const [deletedQuery, setDeletedQuery] = useState("");
  const [deletedSearch, setDeletedSearch] = useState("");
  const [pendingPurge, setPendingPurge] = useState<RetainedRow | null>(null);
  const [purgeAllOpen, setPurgeAllOpen] = useState(false);
  const [purgeAllHiddenOpen, setPurgeAllHiddenOpen] = useState(false);
  // Moderation list: messages I hid (any sender) that can still be deleted for everyone.
  const [moderationQuery, setModerationQuery] = useState("");
  const [moderationSearch, setModerationSearch] = useState("");
  const [pendingModerate, setPendingModerate] = useState<RetainedRow | null>(null);
  const users = useQuery(
    api.admin.listUsers,
    tab === "users" && panelOpen
      ? { q: userQuery.trim() || undefined, role: roleFilter === "all" ? undefined : roleFilter }
      : "skip",
  );
  // Debounced so typing in the search box does not re-run the query per key.
  useEffect(() => {
    const timer = setTimeout(() => setDeletedSearch(deletedQuery), 300);
    return () => clearTimeout(timer);
  }, [deletedQuery]);
  useEffect(() => {
    const timer = setTimeout(() => setModerationSearch(moderationQuery), 300);
    return () => clearTimeout(timer);
  }, [moderationQuery]);
  const communities = useQuery(api.admin.listCommunities, tab === "communities" && panelOpen ? {} : "skip");
  const auditLogs = useQuery(api.admin.listAuditLogs, tab === "audit" && panelOpen ? { limit: 150 } : "skip");
  const settings = useQuery(api.admin.getPlatformSettings, tab === "settings" && panelOpen ? {} : "skip");
  // Read-only diagnostic: detects synthetic/test records that have leaked into
  // production. It never deletes anything — it only reports, so a moderator can
  // decide whether to run the verified cleanup operation.
  const syntheticAudit = useQuery(api.maintenance.syntheticAudit, panelOpen ? {} : "skip");
  const syntheticCount = syntheticAudit?.syntheticCount ?? 0;
  const orphanCount = syntheticAudit?.orphanCount ?? 0;
  // TOTAL USERS must reflect legitimate production accounts only, so detected
  // synthetic records are excluded from the displayed count.
  const legitimateUsers = stats?.users === undefined ? undefined : Math.max(0, stats.users - syntheticCount);
  // Admin collections normalized so a malformed payload can never crash the panel.
  const userList = useMemo(() => toSafeArray<NonNullable<typeof users>[number]>(users, { label: "Admin users", source: "api.admin.listUsers" }), [users]);
  const communityList = useMemo(() => toSafeArray<NonNullable<typeof communities>[number]>(communities, { label: "Admin communities", source: "api.admin.listCommunities" }), [communities]);
  const auditLogList = useMemo(() => toSafeArray<NonNullable<typeof auditLogs>[number]>(auditLogs, { label: "Admin audit log", source: "api.admin.listAuditLogs" }), [auditLogs]);

  const setUserRole = useMutation(api.admin.setUserRole);
  const banUser = useMutation(api.admin.banUser);
  const unbanUser = useMutation(api.admin.unbanUser);
  const suspendUser = useMutation(api.admin.suspendUser);
  const unsuspendUser = useMutation(api.admin.unsuspendUser);
  const deleteUser = useMutation(api.admin.deleteUser);
  const deleteCommunity = useMutation(api.admin.deleteCommunity);
  const updateCommunity = useMutation(api.admin.updateCommunity);
  const generateUploadUrl = useMutation(api.uploads.generateUploadUrl);
  const updatePlatformSettings = useMutation(api.admin.updatePlatformSettings);
  const permanentlyDeleteMine = useMutation(api.adminMessages.permanentlyDeleteMine);
  const permanentlyDeleteAllMine = useMutation(api.adminMessages.permanentlyDeleteAllMine);
  const permanentlyDeleteAllHidden = useMutation(api.adminMessages.permanentlyDeleteAllHidden);
  const deleteHiddenForEveryone = useMutation(api.deletion.deleteHiddenForEveryone);

  const [pending, setPending] = useState<PendingAction>(null);
  const [reason, setReason] = useState("");
  const [durationHours, setDurationHours] = useState("24");
  const [settingsDraft, setSettingsDraft] = useState<{ announcement: string; newCommunitiesEnabled: boolean; discoveryEnabled: boolean } | null>(null);
  const [editCommunity, setEditCommunity] = useState<null | { serverId: string; name: string; description: string; isPublic: boolean; locked: boolean; category: string; iconUrl: string | null }>(null);
  // The group picture an administrator picked but has NOT saved yet. Nothing is
  // uploaded until Save, so a Cancel leaves no orphaned file in storage.
  const [communityPicture, setCommunityPicture] = useState<File | null>(null);
  const [communityPicturePreview, setCommunityPicturePreview] = useState<string | null>(null);
  const [removeCommunityPicture, setRemoveCommunityPicture] = useState(false);
  const communityPictureInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const actorRole = access?.role ?? "user";
  const actorRank = RANK[actorRole] ?? 0;
  const actorIsOwner = isOwnerRole(actorRole);

  /** Client mirror of the server authorization rules, used only to hide buttons. */
  const canManage = (u: AdminUser) =>
    !u.isProtectedOwner &&
    !u.isSelf &&
    actorRank > (RANK[u.role] ?? 0) &&
    (actorIsOwner || (RANK[u.role] ?? 0) < RANK.admin);

  /** Drop a picked-but-unsaved picture (releases the local preview URL). */
  function resetCommunityPicture() {
    setCommunityPicturePreview((current) => { if (current) URL.revokeObjectURL(current); return null; });
    setCommunityPicture(null);
    setRemoveCommunityPicture(false);
    if (communityPictureInput.current) communityPictureInput.current.value = "";
  }

  function chooseCommunityPicture(file: File | undefined) {
    if (!file) return;
    const problem = communityImageProblem(file);
    if (problem) { toast.error(problem); return; }
    setCommunityPicturePreview((current) => { if (current) URL.revokeObjectURL(current); return URL.createObjectURL(file); });
    setCommunityPicture(file);
    setRemoveCommunityPicture(false);
  }

  /** Upload the chosen image to storage; the backend re-validates the stored blob. */
  async function uploadCommunityPicture(file: File): Promise<Id<"_storage">> {
    const uploadUrl = await generateUploadUrl({});
    const response = await fetch(uploadUrl, {
      method: "POST",
      // The same type the stored image will claim — never a raw guess from the file.
      headers: { "Content-Type": communityImageContentType(file) ?? "image/png" },
      body: file,
    });
    if (!response.ok) throw new Error("The picture upload failed — please try again.");
    const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
    return storageId;
  }

  const assignableRoles = useMemo(() => {
    const base = ["user", "moderator"];
    if (actorIsOwner) base.push("admin");
    return base;
  }, [actorIsOwner]);

  if (access === undefined || !identityChecked || pinStatus === undefined) return null;

  if (!access.canAccess) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <Card className="w-full max-w-md border-white/10 bg-card/60">
          <CardHeader className="text-center">
            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-destructive/15">
              <ShieldAlert className="size-6 text-destructive" />
            </div>
            <CardTitle>Administrator access required</CardTitle>
            <CardDescription>
              The Admin Panel is limited to Owner Admins and Admins. Your account doesn&apos;t have permission to view it.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <Button variant="secondary" onClick={() => navigate("/dashboard")}>
              <ArrowLeft className="mr-2 size-4" /> Back to FreeBuff
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  // OPTIONAL Admin PIN. Only reached by an account that already has panel access:
  // the administrator chose to require their PIN, and this session has not entered
  // it yet, so the panel itself is not rendered at all.
  if (pinStatus.enabled && !pinStatus.unlocked) {
    return <AdminPinGate status={pinStatus} />;
  }

  const run = async (fn: () => Promise<unknown>, successMsg: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(successMsg);
      setPending(null);
      setReason("");
    } catch (err) {
      toast.error(friendly(err, "Action failed."));
    } finally {
      setBusy(false);
    }
  };

  /**
   * One bounded batch of a "delete everything in this tab" action. The backend
   * removes at most 10 entries per call and says what is left, so the click is
   * never an unbounded transaction: the button stays available to continue, and
   * the dialog closes as soon as nothing remains.
   */
  const runBulkPurge = async (
    purge: () => Promise<{ deleted: number; remaining: number; hasMore: boolean }>,
    close: () => void,
  ) => {
    setBusy(true);
    try {
      const result = await purge();
      if (result.deleted === 0) {
        toast.success("Nothing left to remove — the list is already empty.");
        close();
        return;
      }
      const plural = result.deleted === 1 ? "" : "s";
      if (result.remaining > 0 || result.hasMore) {
        toast.success(`Removed ${result.deleted} message${plural}, completely. More are still listed — run the action again to continue.`);
      } else {
        toast.success(`Removed ${result.deleted} message${plural} completely, for everyone.`);
        close();
      }
    } catch (err) {
      toast.error(friendly(err, "Could not delete the messages."));
    } finally {
      setBusy(false);
    }
  };

  const confirmPending = async () => {
    if (!pending) return;
    if (pending.type === "role") {
      await run(() => setUserRole({ userId: pending.user.userId as Id<"users">, role: pending.role as never }), "Role updated.");
    } else if (pending.type === "ban") {
      await run(() => banUser({ userId: pending.user.userId as Id<"users">, reason: reason.trim() || undefined }), "Account suspended.");
    } else if (pending.type === "unban") {
      await run(() => unbanUser({ userId: pending.user.userId as Id<"users"> }), "Suspension removed.");
    } else if (pending.type === "suspend") {
      const hours = Number(durationHours) || 24;
      await run(() => suspendUser({ userId: pending.user.userId as Id<"users">, reason: reason.trim() || undefined, durationMs: hours * 60 * 60 * 1000 }), "Account suspended.");
    } else if (pending.type === "unsuspend") {
      await run(() => unsuspendUser({ userId: pending.user.userId as Id<"users"> }), "Suspension cleared.");
    } else if (pending.type === "delete") {
      await run(() => deleteUser({ userId: pending.user.userId as Id<"users"> }), "Account deleted.");
    }
  };

  const draft = settingsDraft ?? {
    announcement: settings?.announcement ?? "",
    newCommunitiesEnabled: settings?.newCommunitiesEnabled ?? true,
    discoveryEnabled: settings?.discoveryEnabled ?? true,
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-white/10 bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
          <Button variant="ghost" size="icon" aria-label="Back to FreeBuff" onClick={() => navigate("/dashboard")}>
            <ArrowLeft className="size-5" />
          </Button>
          <div className="flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white shadow-lg shadow-violet-900/30">
            <ShieldCheck className="size-5" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold leading-tight">Admin Panel</h1>
            <p className="truncate text-xs text-muted-foreground">FreeBuff platform control center</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <RoleBadge role={actorRole} />
            {access.isProtectedOwner && <Badge variant="outline" className="border-amber-400/40 text-amber-300">Protected</Badge>}
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        {/* Overview stat cards */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {[
            { label: "Users", value: legitimateUsers, icon: Users },
            { label: "Owner Admins", value: stats?.owners, icon: Crown },
            { label: "Admins", value: stats?.admins, icon: ShieldCheck },
            { label: "Moderators", value: stats?.moderators, icon: UserCog },
            { label: "Escalated", value: (stats?.banned ?? 0) + (stats?.suspended ?? 0), icon: Ban },
            { label: "Communities", value: stats?.communities, icon: Users },
          ].map((s) => (
            <Card key={s.label} className="border-white/10 bg-card/50">
              <CardContent className="flex items-center gap-3 py-4">
                <s.icon className="size-4 text-muted-foreground" />
                <div>
                  <div className="text-xl font-semibold leading-none">{s.value ?? "—"}</div>
                  <div className="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground">{s.label}</div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Synthetic/test-data diagnostic (read-only) */}
        {(syntheticCount > 0 || orphanCount > 0) && (
          <Card className="mt-4 border-amber-400/30 bg-amber-400/[0.06]">
            <CardContent className="flex items-start gap-3 py-4">
              <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-300" />
              <div className="min-w-0">
                <div className="text-sm font-medium text-amber-200">
                  Synthetic records detected: {syntheticCount}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {syntheticCount} of {syntheticAudit?.totalUsers ?? 0} accounts match the test-data generator
                  pattern (a generated username with a password credential and no real email) and are
                  excluded from the user count above. Test/demo data must never be created in production.
                  This check is read-only — nothing is deleted automatically.
                </p>
                {(syntheticAudit?.sample.length ?? 0) > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {syntheticAudit?.sample.map((name) => (
                      <Badge key={name} variant="outline" className="border-amber-400/30 text-amber-200/80">
                        {name}
                      </Badge>
                    ))}
                  </div>
                )}
                {orphanCount > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {orphanCount} orphaned record{orphanCount === 1 ? "" : "s"} reference content that no
                    longer exists (leftover from deleted test data) and are unreachable by real members.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        <Tabs value={tab} onValueChange={setTab} className="mt-6">
          <TabsList className="bg-white/5">
            <TabsTrigger value="users">Users</TabsTrigger>
            <TabsTrigger value="communities">Communities</TabsTrigger>
            {/* The two lists are deliberately named for what they mean: "Hidden"
                is per-person (delete for me), "Deleted" removes the message for
                everyone. */}
            <TabsTrigger value="deleted">Deleted Messages</TabsTrigger>
            <TabsTrigger value="moderation">Hidden (only for you)</TabsTrigger>
            <TabsTrigger value="audit">Audit Log</TabsTrigger>
            {/* Destructive maintenance lives in its own category, deliberately
                away from the everyday tabs, and every action inside it is
                re-authorized server-side. */}
            <TabsTrigger value="cleanup">Cleanup &amp; Maintenance</TabsTrigger>
            <TabsTrigger value="settings">Platform Settings</TabsTrigger>
          </TabsList>

          {/* ---------------- Users ---------------- */}
          <TabsContent value="users" className="mt-4">
            <Card className="border-white/10 bg-card/40">
              <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <CardTitle className="text-base">Members &amp; roles</CardTitle>
                  <CardDescription>Promote trusted members, manage moderators and admins, and moderate accounts.</CardDescription>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={userQuery}
                      onChange={(e) => setUserQuery(e.target.value)}
                      placeholder="Search name, username, email"
                      className="w-full pl-8 sm:w-64"
                    />
                  </div>
                  <Select value={roleFilter} onValueChange={setRoleFilter}>
                    <SelectTrigger className="w-full sm:w-40"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All roles</SelectItem>
                      <SelectItem value="owner">Owner Admin</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                      <SelectItem value="moderator">Moderator</SelectItem>
                      <SelectItem value="user">User</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {users === undefined && <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>}
                {users && userList.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No accounts match.</p>}
                {userList.map((u) => {
                  const suspended = Boolean(u.suspendedUntil && u.suspendedUntil > Date.now());
                  const manage = canManage(u as AdminUser);
                  return (
                    <div key={u.userId} className="flex flex-col gap-3 rounded-lg border border-white/8 bg-white/[0.02] p-3 sm:flex-row sm:items-center">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate font-medium">{u.name}</span>
                          <RoleBadge role={u.role} />
                          {u.isProtectedOwner && (
                            <Badge variant="outline" className="border-amber-400/40 text-amber-300">
                              <Crown className="mr-1 size-3" /> Protected
                            </Badge>
                          )}
                          {u.banned && <Badge variant="destructive">Suspended</Badge>}
                          {!u.banned && suspended && (
                            <Badge variant="outline" className="border-orange-400/40 text-orange-300">
                              <Clock className="mr-1 size-3" /> Temp
                            </Badge>
                          )}
                          {u.isSelf && <Badge variant="secondary">You</Badge>}
                          {u.isAnonymous && <Badge variant="secondary">Guest</Badge>}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                          @{u.username || "—"}{u.email ? ` · ${u.email}` : ""}
                        </div>
                        {(u.banReason || u.suspendReason) && (
                          <div className="mt-1 text-xs text-muted-foreground">Reason: {u.banReason ?? u.suspendReason}</div>
                        )}
                      </div>

                      {manage ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <Select value={u.role === "member" ? "user" : u.role} onValueChange={(role) => setPending({ type: "role", user: u as AdminUser, role })}>
                            <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {assignableRoles.map((r) => <SelectItem key={r} value={r}>{ROLE_LABEL[r]}</SelectItem>)}
                            </SelectContent>
                          </Select>
                          {u.banned ? (
                            <Button size="sm" variant="secondary" onClick={() => setPending({ type: "unban", user: u as AdminUser })}>
                              <Check className="mr-1 size-4" /> Unban
                            </Button>
                          ) : (
                            <Button size="sm" variant="destructive" onClick={() => setPending({ type: "ban", user: u as AdminUser })}>
                              <Ban className="mr-1 size-4" /> Ban
                            </Button>
                          )}
                          {suspended ? (
                            <Button size="sm" variant="secondary" onClick={() => setPending({ type: "unsuspend", user: u as AdminUser })}>Clear</Button>
                          ) : (
                            <Button size="sm" variant="outline" onClick={() => setPending({ type: "suspend", user: u as AdminUser })}>Suspend</Button>
                          )}
                          <Button size="sm" variant="outline" className="text-destructive" onClick={() => setPending({ type: "delete", user: u as AdminUser })}>
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {u.isProtectedOwner ? "Protected account" : u.isSelf ? "This is you" : "Outranks you"}
                        </span>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ---------------- Communities ---------------- */}
          <TabsContent value="communities" className="mt-4">
            <Card className="border-white/10 bg-card/40">
              <CardHeader>
                <CardTitle className="text-base">Communities</CardTitle>
                <CardDescription>Review, moderate and delete communities across FreeBuff.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Owner</TableHead>
                        <TableHead>Members</TableHead>
                        <TableHead>Visibility</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {communities && communityList.length === 0 && (
                        <TableRow><TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">No communities.</TableCell></TableRow>
                      )}
                      {communityList.map((c) => (
                        <TableRow key={c.serverId}>
                          <TableCell className="max-w-[16rem]">
                            <div className="flex items-center gap-2">
                              {/* The community's OWN stored picture — the same image the
                                  rail, sidebar and Discover show. */}
                              <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-white/5">
                                {c.iconUrl
                                  ? <img src={c.iconUrl} alt="" className="size-full object-cover" />
                                  : <span className="text-xs font-semibold text-muted-foreground">{c.name.slice(0, 1).toUpperCase()}</span>}
                              </span>
                              <div className="min-w-0">
                                <div className="truncate font-medium">{c.name}</div>
                                <div className="truncate text-xs text-muted-foreground">{c.description}</div>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="text-sm">{c.ownerName}</TableCell>
                          <TableCell className="text-sm">{c.memberCount}</TableCell>
                          <TableCell>
                            <Badge variant={c.isPublic ? "secondary" : "outline"}>{c.isPublic ? "Public" : "Private"}</Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-2">
                              <Button
                                size="sm" variant="outline"
                                onClick={() => { resetCommunityPicture(); setEditCommunity({ serverId: c.serverId, name: c.name, description: c.description, isPublic: c.isPublic, locked: c.locked, category: c.category, iconUrl: c.iconUrl ?? null }); }}
                              >
                                Edit group
                              </Button>
                              {actorIsOwner ? (
                                <Button
                                  size="sm" variant="outline" className="text-destructive"
                                  disabled={busy}
                                  onClick={async () => {
                                    if (!window.confirm(`Delete “${c.name}” and all of its content? This cannot be undone.`)) return;
                                    await run(() => deleteCommunity({ serverId: c.serverId as Id<"servers"> }), "Community deleted.");
                                  }}
                                >
                                  <Trash2 className="mr-1 size-4" /> Delete
                                </Button>
                              ) : (
                                <span className="self-center text-xs text-muted-foreground">Owner Admins only</span>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ---------------- My deleted messages ---------------- */}
          <TabsContent value="deleted" className="mt-4">
            <Card className="border-white/10 bg-card/40">
              <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <CardTitle className="text-base">Deleted messages — deleting here deletes for everyone</CardTitle>
                  <CardDescription>
                    Messages you sent and then deleted for yourself. Their content is retained in storage — and listed
                    here — for {RETENTION_DAYS} days after you deleted it, then the entry expires by itself.
                  </CardDescription>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={deletedQuery}
                      onChange={(e) => setDeletedQuery(e.target.value)}
                      placeholder="Search text, conversation, file"
                      className="w-full pl-8 sm:w-64"
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-destructive"
                    disabled={busy}
                    onClick={() => setPurgeAllOpen(true)}
                  >
                    <Trash2 className="mr-1 size-4" /> Delete all deleted messages
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Its own boundary: a failing retention query shows a retryable error in THIS tab. */}
                <FeatureBoundary label="Deleted messages" block>
                  <MyDeletedMessagesList
                    active={tab === "deleted" && panelOpen}
                    search={deletedSearch}
                    busy={busy}
                    onDelete={setPendingPurge}
                  />
                </FeatureBoundary>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ---------------- Hidden messages (moderation) ---------------- */}
          <TabsContent value="moderation" className="mt-4">
            <Card className="border-white/10 bg-card/40">
              <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <CardTitle className="text-base">Hidden messages — hidden from you, deletable for everyone</CardTitle>
                  <CardDescription>
                    Messages you hid with “Delete for me”, whoever wrote them. Hiding changed nobody else&apos;s view;
                    deleting one here removes it completely for all participants, without restoring it to your own
                    history first.
                  </CardDescription>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={moderationQuery}
                      onChange={(e) => setModerationQuery(e.target.value)}
                      placeholder="Search text, conversation, file"
                      className="w-full pl-8 sm:w-64"
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-destructive"
                    disabled={busy}
                    onClick={() => setPurgeAllHiddenOpen(true)}
                  >
                    <Trash2 className="mr-1 size-4" /> Delete all hidden messages
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Its own boundary: a failing moderation query shows a retryable error in THIS tab. */}
                <FeatureBoundary label="Hidden messages" block>
                  <HiddenMessagesList
                    active={tab === "moderation" && panelOpen}
                    search={moderationSearch}
                    busy={busy}
                    onDelete={setPendingModerate}
                  />
                </FeatureBoundary>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ---------------- Audit log ---------------- */}
          <TabsContent value="audit" className="mt-4">
            <Card className="border-white/10 bg-card/40">
              <CardHeader>
                <CardTitle className="text-base">Audit log</CardTitle>
                <CardDescription>Who did what, to which account, when — and the role change involved.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="max-h-[32rem] overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>When</TableHead>
                        <TableHead>Action</TableHead>
                        <TableHead>Actor</TableHead>
                        <TableHead>Target</TableHead>
                        <TableHead>Role change</TableHead>
                        <TableHead>Detail</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {auditLogs && auditLogList.length === 0 && (
                        <TableRow><TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">No activity yet.</TableCell></TableRow>
                      )}
                      {auditLogList.map((l) => (
                        <TableRow key={l.id}>
                          <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{new Date(l.at).toLocaleString()}</TableCell>
                          <TableCell className="whitespace-nowrap text-xs font-medium">{l.action}</TableCell>
                          <TableCell className="text-sm">{l.actor ?? "system"}</TableCell>
                          <TableCell className="text-sm">{l.targetName ?? l.targetId ?? "—"}</TableCell>
                          <TableCell className="text-xs">
                            {l.previousRole || l.newRole ? (
                              <span className="inline-flex items-center gap-1">
                                <RoleBadge role={l.previousRole ?? "user"} />
                                <span className="text-muted-foreground">→</span>
                                <RoleBadge role={l.newRole ?? "user"} />
                              </span>
                            ) : "—"}
                          </TableCell>
                          <TableCell className="max-w-[22rem] text-xs text-muted-foreground"><span className="line-clamp-2">{l.detail}</span></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ---------------- Platform settings + optional Admin PIN ---------------- */}
          <TabsContent value="settings" className="mt-4">
            <div className="space-y-4">
            {/* Optional Admin PIN: per-administrator, opt-in, never forced. */}
            <AdminPinSettings status={pinStatus} />
            <Card className="border-white/10 bg-card/40">
              <CardHeader>
                <CardTitle className="text-base">Platform settings</CardTitle>
                <CardDescription>
                  {actorIsOwner
                    ? "These switches affect everyone on FreeBuff and are enforced on the server."
                    : "Only Owner Admins can change platform-wide settings."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Announcement banner</label>
                  <textarea
                    value={draft.announcement}
                    disabled={!actorIsOwner}
                    onChange={(e) => setSettingsDraft({ ...draft, announcement: e.target.value })}
                    rows={3}
                    maxLength={280}
                    placeholder="Shown at the top of the app for everyone (leave blank to hide)."
                    className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring disabled:opacity-60"
                  />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium">Allow new communities</div>
                    <div className="text-xs text-muted-foreground">When off, members can&apos;t create communities (admins still can).</div>
                  </div>
                  <Switch
                    checked={draft.newCommunitiesEnabled}
                    disabled={!actorIsOwner}
                    onCheckedChange={(v) => setSettingsDraft({ ...draft, newCommunitiesEnabled: v })}
                  />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium">Enable community discovery</div>
                    <div className="text-xs text-muted-foreground">When off, the Discover page returns no results.</div>
                  </div>
                  <Switch
                    checked={draft.discoveryEnabled}
                    disabled={!actorIsOwner}
                    onCheckedChange={(v) => setSettingsDraft({ ...draft, discoveryEnabled: v })}
                  />
                </div>
                {actorIsOwner && (
                  <Button
                    disabled={busy}
                    onClick={() => run(
                      () => updatePlatformSettings({
                        announcement: draft.announcement,
                        newCommunitiesEnabled: draft.newCommunitiesEnabled,
                        discoveryEnabled: draft.discoveryEnabled,
                      }),
                      "Platform settings saved.",
                    )}
                  >
                    Save settings
                  </Button>
                )}
              </CardContent>
            </Card>
            </div>
          </TabsContent>

          {/* ---------------- Cleanup & Maintenance ---------------- */}
          <TabsContent value="cleanup" className="mt-4">
            {/* Mounted only for this tab, and only when the optional Admin PIN has
                been entered — so a locked panel never even asks for the cleanup
                permissions. */}
            {panelOpen && <CleanupMaintenance panelOpen={panelOpen} />}
          </TabsContent>
        </Tabs>
      </div>

      {/* Community edit dialog */}
      <Dialog open={editCommunity !== null} onOpenChange={(open) => { if (!open) { resetCommunityPicture(); setEditCommunity(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit group</DialogTitle>
            <DialogDescription>Update this group&apos;s picture and settings. Changes apply immediately for all members.</DialogDescription>
          </DialogHeader>
          {editCommunity && (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Group picture</label>
                <div className="flex items-center gap-3">
                  <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-white/5">
                    {(communityPicturePreview ?? (removeCommunityPicture ? null : editCommunity.iconUrl))
                      ? <img src={communityPicturePreview ?? editCommunity.iconUrl ?? ""} alt="Group picture preview" className="size-full object-cover" />
                      : <span className="text-lg font-semibold text-muted-foreground">{editCommunity.name.slice(0, 1).toUpperCase() || "?"}</span>}
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      ref={communityPictureInput}
                      type="file"
                      accept={COMMUNITY_IMAGE_ACCEPT}
                      hidden
                      onChange={(e) => { chooseCommunityPicture(e.target.files?.[0]); e.target.value = ""; }}
                    />
                    <Button size="sm" variant="outline" type="button" disabled={busy} onClick={() => communityPictureInput.current?.click()}>
                      <ImagePlus className="mr-1 size-4" /> {communityPicturePreview ? "Choose another" : "Upload picture"}
                    </Button>
                    {(editCommunity.iconUrl || communityPicturePreview) && !removeCommunityPicture && (
                      <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={() => { resetCommunityPicture(); setRemoveCommunityPicture(true); }}>
                        <Trash2 className="mr-1 size-4" /> Remove
                      </Button>
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Shown beside this group everywhere in Freecord. PNG, JPG, GIF, WebP or AVIF · up to{" "}
                  {Math.round(COMMUNITY_IMAGE_MAX_BYTES / (1024 * 1024))} MB. Saved with “Save” — Cancel discards it.
                </p>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Name</label>
                <Input value={editCommunity.name} onChange={(e) => setEditCommunity({ ...editCommunity, name: e.target.value })} />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Description</label>
                <textarea
                  value={editCommunity.description}
                  rows={3}
                  onChange={(e) => setEditCommunity({ ...editCommunity, description: e.target.value })}
                  className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring"
                />
              </div>
              {/* Administrators may re-file a community while managing it, using
                  the same supported list the owner-facing editor offers. */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Subcategory</label>
                <Select
                  value={editCommunity.category}
                  onValueChange={(value) => setEditCommunity({ ...editCommunity, category: value })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {communityCategoryOptions(editCommunity.category).map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.legacy ? `${o.value} (no longer offered)` : o.value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm">Public (discoverable)</span>
                <Switch checked={editCommunity.isPublic} onCheckedChange={(v) => setEditCommunity({ ...editCommunity, isPublic: v })} />
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm">Locked (read-only)</span>
                <Switch checked={editCommunity.locked} onCheckedChange={(v) => setEditCommunity({ ...editCommunity, locked: v })} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditCommunity(null)}>Cancel</Button>              <Button
              disabled={busy}
              onClick={async () => {
                if (!editCommunity) return;
                const target = editCommunity;
                const picture = communityPicture;
                const clearing = removeCommunityPicture;
                await run(
                  async () => {
                    // The upload happens here (not when the file is picked), so a
                    // cancelled dialog stores nothing.
                    const iconStorageId = picture ? await uploadCommunityPicture(picture) : undefined;
                    await updateCommunity({
                      serverId: target.serverId as Id<"servers">,
                      name: target.name,
                      description: target.description,
                      isPublic: target.isPublic,
                      locked: target.locked,
                      category: target.category,
                      ...(iconStorageId ? { iconStorageId } : {}),
                      ...(clearing ? { clearIcon: true } : {}),
                    });
                  },
                  clearing ? "Group picture removed." : picture ? "Group picture updated." : "Community updated.",
                );
                resetCommunityPicture();
                setEditCommunity(null);
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete-for-everyone confirmation (Hidden Messages moderation) */}
      <Dialog open={pendingModerate !== null} onOpenChange={(open) => { if (!open) setPendingModerate(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this message completely?</DialogTitle>
            <DialogDescription>
              {pendingModerate
                ? `“${pendingModerate.preview}” — sent by ${pendingModerate.senderName} in ${pendingModerate.conversationName}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            The message is removed <strong>completely, for all participants</strong> — its content, its attachments and
            any file no other message still uses, with no “message deleted” placeholder left behind. This cannot be
            undone. It stays hidden from your own view either way.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingModerate(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                if (!pendingModerate) return;
                const target = pendingModerate;
                setBusy(true);
                try {
                  const result = await deleteHiddenForEveryone({ visibilityId: target.visibilityId });
                  toast.success(
                    result.alreadyDeleted
                      ? "That message had already been deleted for everyone."
                      : "Message deleted completely, for everyone.",
                  );
                  setPendingModerate(null);
                } catch (err) {
                  toast.error(friendly(err, "Could not delete the message."));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Delete completely
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* "Delete All Deleted Messages" — immediate bulk cleanup of the list */}
      <Dialog open={purgeAllOpen} onOpenChange={(open) => { if (!open) setPurgeAllOpen(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete all deleted messages?</DialogTitle>
            <DialogDescription>
              Completely removes every message listed under “My deleted messages” — the message itself, its content,
              its attachments and any file no other message still uses.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-destructive">
            This is permanent and cannot be undone: the messages are gone for <strong>every participant</strong>.
            Entries that have already expired are not affected (they are cleaned up automatically). Up to 10 are
            removed per action — run it again to continue while entries remain.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPurgeAllOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => runBulkPurge(() => permanentlyDeleteAllMine({}), () => setPurgeAllOpen(false))}
            >
              Delete all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* "Delete All Hidden Messages" — the moderation list's bulk cleanup */}
      <Dialog open={purgeAllHiddenOpen} onOpenChange={(open) => { if (!open) setPurgeAllHiddenOpen(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete all hidden messages?</DialogTitle>
            <DialogDescription>
              Completely removes every message listed under “Hidden Messages” — whoever wrote them — including their
              content, attachments and any file no other message still uses.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-destructive">
            This is permanent and cannot be undone: the messages disappear from <strong>everyone&apos;s</strong> history
            with no “message deleted” placeholder left behind. Only messages you had already hidden are affected. Up
            to 10 are removed per action — run it again to continue while entries remain.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPurgeAllHiddenOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => runBulkPurge(() => permanentlyDeleteAllHidden({}), () => setPurgeAllHiddenOpen(false))}
            >
              Delete all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Permanent delete confirmation (My Deleted Messages) */}
      <Dialog open={pendingPurge !== null} onOpenChange={(open) => { if (!open) setPendingPurge(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Permanently delete this message?</DialogTitle>
            <DialogDescription>
              {pendingPurge ? `“${pendingPurge.preview}” in ${pendingPurge.conversationName}` : ""}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-destructive">
            The retained message content, its attachments and any file no other message still uses will be removed
            from storage. This is permanent and cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingPurge(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                if (!pendingPurge) return;
                const target = pendingPurge;
                setBusy(true);
                try {
                  const result = await permanentlyDeleteMine({ visibilityId: target.visibilityId });
                  toast.success(
                    result.alreadyGone
                      ? "The stored message was already gone — the entry was removed."
                      : "Message and its attachments permanently deleted.",
                  );
                  setPendingPurge(null);
                } catch (err) {
                  toast.error(friendly(err, "Could not permanently delete the message."));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Action confirmation dialog */}
      <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) { setPending(null); setReason(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pending?.type === "role" && `Change role to ${ROLE_LABEL[pending.role]}`}
              {pending?.type === "ban" && "Ban account"}
              {pending?.type === "unban" && "Remove ban"}
              {pending?.type === "suspend" && "Temporarily suspend"}
              {pending?.type === "unsuspend" && "Clear suspension"}
              {pending?.type === "delete" && "Delete account"}
            </DialogTitle>
            <DialogDescription>
              {pending && `This affects ${pending.user.name} (@${pending.user.username}).`}
            </DialogDescription>
          </DialogHeader>

          {pending?.type === "suspend" && (
            <div className="space-y-2">
              <label className="text-sm font-medium">Duration (hours)</label>
              <Input type="number" min={1} value={durationHours} onChange={(e) => setDurationHours(e.target.value)} />
            </div>
          )}
          {(pending?.type === "ban" || pending?.type === "suspend") && (
            <div className="space-y-2">
              <label className="text-sm font-medium">Reason (optional)</label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Shown to the member" />
            </div>
          )}
          {pending?.type === "delete" && (
            <p className="text-sm text-destructive">
              This permanently removes the account and its data. It cannot be undone.
            </p>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => { setPending(null); setReason(""); }}>Cancel</Button>
            <Button
              variant={pending?.type === "delete" || pending?.type === "ban" ? "destructive" : "default"}
              disabled={busy}
              onClick={confirmPending}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
