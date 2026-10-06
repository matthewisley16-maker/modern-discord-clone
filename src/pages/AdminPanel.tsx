import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toSafeArray } from "@/lib/collection";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import {
  ArrowLeft, Ban, Check, Crown, Search, ShieldAlert, ShieldCheck, Trash2, UserCog, Users, Clock,
} from "lucide-react";

/** Mirrors the backend ROLE_RANK so the UI reflects — never decides — authority. */
const RANK: Record<string, number> = { member: 0, user: 0, moderator: 1, admin: 2, owner: 3, owner_admin: 3 };

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

export default function AdminPanel() {
  const navigate = useNavigate();
  const access = useQuery(api.admin.panelAccess, {});
  const stats = useQuery(api.admin.stats, {});
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
  const users = useQuery(api.admin.listUsers, {
    q: userQuery.trim() || undefined,
    role: roleFilter === "all" ? undefined : roleFilter,
  });
  const communities = useQuery(api.admin.listCommunities, {});
  const auditLogs = useQuery(api.admin.listAuditLogs, { limit: 150 });
  const settings = useQuery(api.admin.getPlatformSettings, {});
  // Read-only diagnostic: detects synthetic/test records that have leaked into
  // production. It never deletes anything — it only reports, so a moderator can
  // decide whether to run the verified cleanup operation.
  const syntheticAudit = useQuery(api.maintenance.syntheticAudit, {});
  const syntheticCount = syntheticAudit?.syntheticCount ?? 0;
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
  const updatePlatformSettings = useMutation(api.admin.updatePlatformSettings);

  const [pending, setPending] = useState<PendingAction>(null);
  const [reason, setReason] = useState("");
  const [durationHours, setDurationHours] = useState("24");
  const [settingsDraft, setSettingsDraft] = useState<{ announcement: string; newCommunitiesEnabled: boolean; discoveryEnabled: boolean } | null>(null);
  const [editCommunity, setEditCommunity] = useState<null | { serverId: string; name: string; description: string; isPublic: boolean; locked: boolean }>(null);
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

  const assignableRoles = useMemo(() => {
    const base = ["user", "moderator"];
    if (actorIsOwner) base.push("admin");
    return base;
  }, [actorIsOwner]);

  if (access === undefined || !identityChecked) return null;

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
        {syntheticCount > 0 && (
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
              </div>
            </CardContent>
          </Card>
        )}

        <Tabs defaultValue="users" className="mt-6">
          <TabsList className="bg-white/5">
            <TabsTrigger value="users">Users</TabsTrigger>
            <TabsTrigger value="communities">Communities</TabsTrigger>
            <TabsTrigger value="audit">Audit Log</TabsTrigger>
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
                            <div className="truncate font-medium">{c.name}</div>
                            <div className="truncate text-xs text-muted-foreground">{c.description}</div>
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
                                onClick={() => setEditCommunity({ serverId: c.serverId, name: c.name, description: c.description, isPublic: c.isPublic, locked: c.locked })}
                              >
                                Edit
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

          {/* ---------------- Platform settings ---------------- */}
          <TabsContent value="settings" className="mt-4">
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
          </TabsContent>
        </Tabs>
      </div>

      {/* Community edit dialog */}
      <Dialog open={editCommunity !== null} onOpenChange={(open) => { if (!open) setEditCommunity(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit community</DialogTitle>
            <DialogDescription>Update this community&apos;s settings. Changes apply immediately for all members.</DialogDescription>
          </DialogHeader>
          {editCommunity && (
            <div className="space-y-4">
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
            <Button variant="ghost" onClick={() => setEditCommunity(null)}>Cancel</Button>
            <Button
              disabled={busy}
              onClick={async () => {
                if (!editCommunity) return;
                const target = editCommunity;
                await run(
                  () => updateCommunity({
                    serverId: target.serverId as Id<"servers">,
                    name: target.name,
                    description: target.description,
                    isPublic: target.isPublic,
                    locked: target.locked,
                  }),
                  "Community updated.",
                );
                setEditCommunity(null);
              }}
            >
              Save
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
