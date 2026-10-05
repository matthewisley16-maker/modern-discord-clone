import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Ban, Clock, Crown, Plus, Trash2, UserMinus } from "lucide-react";

/**
 * Server-level administration UI. This is entirely separate from the FreeBuff
 * platform Admin Panel: every action here is scoped to one community and
 * enforced on the backend with that community's own memberships/roles.
 */

const ROLE_PERMISSIONS: { key: string; label: string }[] = [
  { key: "viewChannels", label: "View channels" },
  { key: "sendMessages", label: "Send messages" },
  { key: "attachFiles", label: "Attach files" },
  { key: "createThreads", label: "Create threads" },
  { key: "manageMessages", label: "Manage messages" },
  { key: "mentionEveryone", label: "Mention everyone" },
  { key: "deleteMessages", label: "Delete messages" },
  { key: "createChannels", label: "Create channels" },
  { key: "manageChannels", label: "Manage channels" },
  { key: "kickMembers", label: "Kick members" },
  { key: "banMembers", label: "Ban members" },
  { key: "manageMembers", label: "Timeout members" },
  { key: "manageRoles", label: "Manage roles" },
  { key: "manageCommunity", label: "Manage community" },
  { key: "createInvites", label: "Create invites" },
  { key: "useVoice", label: "Use voice" },
];

/** The per-request channel permissions requested for channel overrides. */
const CHANNEL_PERMISSIONS = [
  "viewChannels", "sendMessages", "attachFiles", "createThreads", "manageMessages", "mentionEveryone", "manageChannels",
] as const;

const ROLE_LABEL: Record<string, string> = { owner: "Server Owner", admin: "Server Admin", moderator: "Server Moderator", member: "Member" };
const NEW_COLORS = ["#8b5cf6", "#f0616d", "#3ba55d", "#faa61a", "#00a8fc", "#eb459e", "#5865f2", "#9b59b6"];

type Permission = (typeof CHANNEL_PERMISSIONS)[number] | string;
type Override = { target: string; allow: Permission[]; deny: Permission[] };

function friendly(err: unknown, fallback: string): string {
  const any = err as { data?: unknown; message?: string };
  if (typeof any?.data === "string" && any.data.trim()) return any.data;
  if (typeof any?.message === "string" && any.message.trim()) return any.message.replace(/^\[.*?\]\s*/, "").split("\n")[0].slice(0, 200);
  return fallback;
}

function stateFor(overrides: Override[], target: string, permission: string): "neutral" | "allow" | "deny" {
  const o = overrides.find((x) => x.target === target);
  if (!o) return "neutral";
  if (o.deny.includes(permission)) return "deny";
  if (o.allow.includes(permission)) return "allow";
  return "neutral";
}

function withOverride(overrides: Override[], target: string, permission: string, state: "neutral" | "allow" | "deny"): Override[] {
  const existing = overrides.find((o) => o.target === target) ?? { target, allow: [], deny: [] };
  const allow = existing.allow.filter((p) => p !== permission);
  const deny = existing.deny.filter((p) => p !== permission);
  if (state === "allow") allow.push(permission);
  if (state === "deny") deny.push(permission);
  const next = overrides.filter((o) => o.target !== target);
  if (allow.length || deny.length) next.push({ target, allow, deny });
  return next;
}

export default function ServerPermissions({ serverId }: { serverId: Id<"servers"> }) {
  const details = useQuery(api.communities.details, { serverId });
  const createRole = useMutation(api.communities.createRole);
  const updateRole = useMutation(api.communities.updateRole);
  const deleteRole = useMutation(api.communities.deleteRole);
  const assignRole = useMutation(api.communities.assignRole);
  const kickMember = useMutation(api.communities.kickMember);
  const banMember = useMutation(api.communities.banMember);
  const unbanMember = useMutation(api.communities.unbanMember);
  const timeoutMember = useMutation(api.communities.timeoutMember);
  const transferOwnership = useMutation(api.communities.transferOwnership);
  const updateOverrides = useMutation(api.communities.updateChannelOverrides);
  const bans = useQuery(api.communities.listBans, { serverId });

  const [tab, setTab] = useState<"roles" | "members" | "channels" | "bans">("roles");
  const [busy, setBusy] = useState(false);
  const [newRole, setNewRole] = useState<{ name: string; color: string; permissions: string[] }>({ name: "", color: NEW_COLORS[0], permissions: ["viewChannels", "sendMessages"] });
  const [editing, setEditing] = useState<null | { id: string; name: string; color: string; permissions: string[] }>(null);
  const [channelId, setChannelId] = useState<string>("");

  const perms = new Set(details?.permissions ?? []);
  const isOwner = details?.isOwner ?? false;
  const can = (p: string) => isOwner || perms.has(p);

  if (!details) return <p className="fc-muted">Loading server administration…</p>;

  const canManageRoles = can("manageRoles");
  const canManageChannels = can("manageChannels");
  const channelList = details.channels.filter((c) => (c.type ?? "text") === "text");
  const activeChannelId = channelId || (channelList[0]?._id as string | undefined) || "";

  const run = async (fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(true);
    try { await fn(); toast.success(okMsg); }
    catch (e) { toast.error(friendly(e, "Action failed.")); }
    finally { setBusy(false); }
  };

  const togglePermission = (list: string[], key: string) => list.includes(key) ? list.filter((p) => p !== key) : [...list, key];

  return (
    <div className="fc-server-perms">
      <div className="fc-perms-tabs" role="tablist">
        {([["roles", "Roles"], ["members", "Members"], ["channels", "Channel permissions"], ["bans", "Bans"]] as const).map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={`fc-perms-tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>

      {/* ---------------- Roles ---------------- */}
      {tab === "roles" && (
        <div className="fc-perms-panel">
          {!canManageRoles && <p className="fc-muted">You need the “Manage roles” permission to edit roles.</p>}
          {details.roles.length === 0 && canManageRoles && <p className="fc-muted">No custom roles yet. Create one below.</p>}
          {details.roles.map((role) => (
            <div key={role._id} className="fc-role-row">
              {editing?.id === role._id ? (
                <div className="fc-role-edit">
                  <Input value={editing.name} maxLength={30} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                  <div className="fc-color-dots">
                    {NEW_COLORS.map((c) => (
                      <button key={c} type="button" aria-label={`Color ${c}`} className={`fc-color-dot ${editing.color === c ? "active" : ""}`} style={{ background: c }} onClick={() => setEditing({ ...editing, color: c })} />
                    ))}
                  </div>
                  <div className="fc-perm-grid">
                    {ROLE_PERMISSIONS.map((p) => (
                      <label key={p.key} className="fc-perm-check">
                        <input type="checkbox" checked={editing.permissions.includes(p.key)} onChange={() => setEditing({ ...editing, permissions: togglePermission(editing.permissions, p.key) })} />
                        {p.label}
                      </label>
                    ))}
                  </div>
                  <div className="fc-role-actions">
                    <Button size="sm" disabled={busy || !editing.name.trim()} onClick={() => run(async () => { await updateRole({ roleId: role._id, name: editing.name, color: editing.color, permissions: editing.permissions as never }); setEditing(null); }, "Role updated.")}>Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <>
                  <span className="fc-role-dot" style={{ background: role.color ?? "#8b5cf6" }} />
                  <span className="fc-role-name">{role.name}</span>
                  <span className="fc-role-count">{role.permissions.length} permissions</span>
                  {canManageRoles && (
                    <div className="fc-role-actions">
                      <Button size="sm" variant="outline" onClick={() => setEditing({ id: role._id as string, name: role.name, color: role.color ?? "#8b5cf6", permissions: [...role.permissions] })}>Edit</Button>
                      <Button size="sm" variant="outline" className="text-destructive" disabled={busy} onClick={() => { if (window.confirm(`Delete the role “${role.name}”? Members keep their other roles.`)) run(() => deleteRole({ roleId: role._id }), "Role deleted."); }}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}

          {canManageRoles && (
            <div className="fc-role-new">
              <h4><Plus className="size-4" /> Create a role</h4>
              <Input placeholder="Role name (e.g. Minecraft Staff)" maxLength={30} value={newRole.name} onChange={(e) => setNewRole({ ...newRole, name: e.target.value })} />
              <div className="fc-color-dots">
                {NEW_COLORS.map((c) => (
                  <button key={c} type="button" aria-label={`Color ${c}`} className={`fc-color-dot ${newRole.color === c ? "active" : ""}`} style={{ background: c }} onClick={() => setNewRole({ ...newRole, color: c })} />
                ))}
              </div>
              <div className="fc-perm-grid">
                {ROLE_PERMISSIONS.map((p) => (
                  <label key={p.key} className="fc-perm-check">
                    <input type="checkbox" checked={newRole.permissions.includes(p.key)} onChange={() => setNewRole({ ...newRole, permissions: togglePermission(newRole.permissions, p.key) })} />
                    {p.label}
                  </label>
                ))}
              </div>
              <Button size="sm" disabled={busy || !newRole.name.trim()} onClick={() => run(async () => { await createRole({ serverId, name: newRole.name, color: newRole.color, permissions: newRole.permissions as never }); setNewRole({ name: "", color: NEW_COLORS[0], permissions: ["viewChannels", "sendMessages"] }); }, "Role created.")}>Create role</Button>
            </div>
          )}
        </div>
      )}

      {/* ---------------- Members ---------------- */}
      {tab === "members" && (
        <div className="fc-perms-panel">
          <p className="fc-muted">Roles are per community — changing someone here never affects their roles in other servers.</p>
          {details.members.map((m) => {
            const isServerOwner = details.server.ownerId === m.userId;
            return (
              <div key={m.userId} className="fc-member-row">
                <div className="fc-member-row-name">
                  <strong>{m.displayName}</strong>
                  <small>{isServerOwner ? <><Crown className="size-3" /> Server Owner</> : ROLE_LABEL[m.role] ?? m.role}</small>
                </div>
                {!isServerOwner && canManageRoles && (
                  <Select value={m.role} onValueChange={(role) => run(() => assignRole({ serverId, userId: m.userId as Id<"users">, role: role as never }), "Role updated.")}>
                    <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="member">Member</SelectItem>
                      <SelectItem value="moderator">Moderator</SelectItem>
                      {isOwner && <SelectItem value="admin">Admin</SelectItem>}
                    </SelectContent>
                  </Select>
                )}
                {!isServerOwner && (
                  <div className="fc-member-row-actions">
                    {can("manageMembers") && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => { const mins = Number(window.prompt("Timeout for how many minutes?", "10") ?? "0"); if (mins > 0) run(() => timeoutMember({ serverId, userId: m.userId as Id<"users">, minutes: mins }), "Member timed out."); }}>
                        <Clock className="mr-1 size-4" /> Timeout
                      </Button>
                    )}
                    {can("kickMembers") && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => { if (window.confirm(`Kick ${m.displayName}?`)) run(() => kickMember({ serverId, userId: m.userId as Id<"users"> }), "Member kicked."); }}>
                        <UserMinus className="mr-1 size-4" /> Kick
                      </Button>
                    )}
                    {can("banMembers") && (
                      <Button size="sm" variant="destructive" disabled={busy} onClick={() => { const reason = window.prompt(`Ban ${m.displayName}. Reason (optional):`) ?? undefined; run(() => banMember({ serverId, userId: m.userId as Id<"users">, reason }), "Member banned."); }}>
                        <Ban className="mr-1 size-4" /> Ban
                      </Button>
                    )}
                    {isOwner && (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (window.confirm(`Make ${m.displayName} the Server Owner? You will become an admin.`)) run(() => transferOwnership({ serverId, userId: m.userId as Id<"users"> }), "Ownership transferred."); }}>
                        <Crown className="mr-1 size-4" /> Make owner
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ---------------- Channel permissions ---------------- */}
      {tab === "channels" && (
        <div className="fc-perms-panel">
          {!canManageChannels && <p className="fc-muted">You need the “Manage channels” permission to edit channel permissions.</p>}
          {canManageChannels && (
            <>
              <label className="fc-perms-field">Channel
                <Select value={activeChannelId} onValueChange={setChannelId}>
                  <SelectTrigger><SelectValue placeholder="Choose a channel" /></SelectTrigger>
                  <SelectContent>
                    {channelList.map((c) => <SelectItem key={c._id} value={c._id as string}>#{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </label>
              {activeChannelId && (
                <ChannelOverrideGrid
                  channelId={activeChannelId as Id<"channels">}
                  roles={details.roles.map((r) => ({ id: r._id as string, name: r.name }))}
                  busy={busy}
                  onSave={(overrides) => run(() => updateOverrides({ channelId: activeChannelId as Id<"channels">, overrides: overrides as never }), "Channel permissions saved.")}
                />
              )}
              <p className="fc-muted">
                Click a cell to cycle: <strong>inherit → allow → deny</strong>. “Inherit” uses the role&apos;s normal permissions.
                Try #announcements = deny “Send messages” for <em>member</em>, or #staff = deny “View channel” for <em>member</em>.
              </p>
            </>
          )}
        </div>
      )}

      {/* ---------------- Bans ---------------- */}
      {tab === "bans" && (
        <div className="fc-perms-panel">
          {!can("banMembers") && <p className="fc-muted">You need the “Ban members” permission to manage bans.</p>}
          {bans && bans.length === 0 && <p className="fc-muted">No banned members.</p>}
          {bans?.map((b) => (
            <div key={b.userId} className="fc-member-row">
              <div className="fc-member-row-name"><strong>{b.name}</strong><small>{b.reason || "No reason given"}</small></div>
              {can("banMembers") && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => unbanMember({ serverId, userId: b.userId as Id<"users"> }), "Member unbanned.")}>Unban</Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Tri-state permission matrix for a single channel. */
function ChannelOverrideGrid({
  channelId,
  roles,
  busy,
  onSave,
}: {
  channelId: Id<"channels">;
  roles: { id: string; name: string }[];
  busy: boolean;
  onSave: (overrides: Override[]) => void;
}) {
  const data = useQuery(api.communities.channelPermissions, { channelId });
  if (!data) return <p className="fc-muted">Loading channel permissions…</p>;
  const overrides = data.overrides as Override[];
  const targets = [
    { key: "everyone", label: "@everyone" },
    { key: "admin", label: "Admin" },
    { key: "moderator", label: "Moderator" },
    { key: "member", label: "Member" },
    ...roles.map((r) => ({ key: r.id, label: r.name })),
  ];

  return (
    <div className="fc-override-scroll">
      <table className="fc-override-table">
        <thead>
          <tr>
            <th>Role</th>
            {CHANNEL_PERMISSIONS.map((p) => <th key={p}>{ROLE_PERMISSIONS.find((x) => x.key === p)?.label ?? p}</th>)}
          </tr>
        </thead>
        <tbody>
          {targets.map((t) => (
            <tr key={t.key}>
              <th scope="row">{t.label}</th>
              {CHANNEL_PERMISSIONS.map((p) => {
                const state = stateFor(overrides, t.key, p);
                return (
                  <td key={p}>
                    <button
                      type="button"
                      className={`fc-perm-cell ${state}`}
                      disabled={busy}
                      aria-label={`${t.label} ${p}: ${state}`}
                      onClick={() => onSave(withOverride(overrides, t.key, p, state === "neutral" ? "allow" : state === "allow" ? "deny" : "neutral"))}
                    >
                      {state === "allow" ? "✓" : state === "deny" ? "✕" : "–"}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
