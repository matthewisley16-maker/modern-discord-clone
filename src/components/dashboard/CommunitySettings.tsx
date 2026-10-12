import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toSafeArray } from "@/lib/collection";
import { communityCategoryOf, communityCategoryOptions } from "@/lib/community-categories";
import { COMMUNITY_IMAGE_ACCEPT, communityImageContentType, communityImageProblem } from "@/lib/community-cover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Compass, ImagePlus, LayoutList, LogOut, Mic, Plus, Shield, Trash2, Users, Volume2, X } from "lucide-react";
import ChannelManager from "./ChannelManager";
import ServerPermissions from "./ServerPermissions";

/**
 * Group (community) settings.
 *
 * The controls are grouped into the sections administrators expect and the
 * header names them explicitly — General, Appearance, Permissions, Members,
 * Channels, Danger — so "change the group picture" and "change who may post"
 * are each one click apart instead of being somewhere in one long scroll.
 *
 * Every section talks to the same permission-gated backend
 * (`communities.updateSettings`, `communities.setCategory`, `communities.*`
 * moderation and `uploads.generateUploadUrl`); nothing here decides authority,
 * it only mirrors it. A member without `manageCommunity` sees an about/leave
 * view rather than disabled controls, and the server refuses the writes anyway.
 */

const TABS = ["General", "Appearance", "Permissions", "Members", "Channels", "Danger"] as const;
type Tab = (typeof TABS)[number];

/** The editable General fields, as the form holds them (tags are one string). */
type GeneralDraft = { name: string; description: string; isPublic: boolean; tags: string; slowMode: number };

export default function CommunitySettings({
  serverId,
  onClose,
  onLeft,
}: {
  serverId: Id<"servers">;
  onClose: () => void;
  onLeft: () => void;
}) {
  const details = useQuery(api.communities.details, { serverId });
  const update = useMutation(api.communities.updateSettings);
  const setSubcategory = useMutation(api.communities.setCategory);
  const leave = useMutation(api.communities.leave);
  const generateUploadUrl = useMutation(api.uploads.generateUploadUrl);
  const channelTree = useQuery(api.voice.channelTree, { serverId });
  const createChannelFull = useMutation(api.voice.createChannelFull);
  const updateChannelFull = useMutation(api.voice.updateChannelFull);
  const deleteChannelFull = useMutation(api.voice.deleteChannelFull);
  const [newVoiceName, setNewVoiceName] = useState("");
  const [newVoiceLimit, setNewVoiceLimit] = useState(0);

  const server = details?.server;
  // Normalized collections so a malformed payload can never crash settings.
  const detailsPermissions = toSafeArray<string>(details?.permissions, { label: "Community permissions", source: "api.communities.details" });
  const roleList = toSafeArray<NonNullable<typeof details>["roles"][number]>(details?.roles, { label: "Community roles", source: "api.communities.details" });
  const voiceChannelList = [
    ...toSafeArray<NonNullable<typeof channelTree>["uncategorized"][number]>(channelTree?.uncategorized, { label: "Uncategorized channels", source: "api.voice.channelTree" }),
    ...toSafeArray<NonNullable<typeof channelTree>["byCategory"][number]>(channelTree?.byCategory, { label: "Channel categories", source: "api.voice.channelTree" }).flatMap((g) => g.channels),
  ];
  const canManage = detailsPermissions.includes("manageCommunity");
  const isOwner = details?.isOwner ?? false;

  const [tab, setTab] = useState<Tab>("General");
  /**
   * General's drafts. `null` means "follow the stored values", so the fields show
   * what the community actually has — including when the panel mounted while
   * `communities.details` was still loading (seeding state at first render left
   * the name empty, and saving an empty name is refused). The first edit takes a
   * copy, so a later reactive refresh never overwrites what someone is typing.
   */
  const [generalDraft, setGeneralDraft] = useState<GeneralDraft | null>(null);
  const general: GeneralDraft = generalDraft ?? {
    name: server?.name ?? "",
    description: server?.description ?? "",
    isPublic: server?.isPublic ?? false,
    tags: (server?.tags ?? []).join(", "),
    slowMode: server?.slowModeSeconds ?? 0,
  };
  const editGeneral = (patch: Partial<GeneralDraft>) => setGeneralDraft({ ...general, ...patch });
  // The picture is either the stored one (server.iconUrl) or a freshly picked
  // file waiting to be saved — never a browser-only URL as the permanent value.
  const [iconStorageId, setIconStorageId] = useState<Id<"_storage"> | null>(null);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [iconBusy, setIconBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  /**
   * "Edit Subcategory" state. The draft is `null` while the editor simply
   * follows the stored value; picking a value makes it dirty, Save writes ONLY
   * the subcategory, and Cancel throws the draft away. After a successful save
   * the draft holds the value the SERVER returned, so the panel shows the new
   * subcategory immediately while the reactive query catches up.
   */
  const [subcatDraft, setSubcatDraft] = useState<string | null>(null);
  const [subcatBusy, setSubcatBusy] = useState(false);
  const [subcatError, setSubcatError] = useState("");
  const currentCategory = communityCategoryOf(server?.category);
  const subcatOptions = useMemo(() => communityCategoryOptions(server?.category), [server?.category]);
  const subcatValue = subcatDraft ?? currentCategory;
  const subcatDirty = subcatDraft !== null && subcatDraft !== currentCategory;

  async function saveSubcategory() {
    if (!subcatDraft) return;
    setSubcatBusy(true);
    setSubcatError("");
    try {
      const result = await setSubcategory({ serverId, category: subcatDraft });
      setSubcatDraft(result.category);
      toast.success(
        result.changed ? `Subcategory updated to ${result.category}.` : `This community is already filed under ${result.category}.`,
      );
    } catch (e) {
      // The chosen value is kept so a failed save can be retried with one click.
      setSubcatError(e instanceof Error ? e.message : "Could not save the subcategory. Please try again.");
    } finally {
      setSubcatBusy(false);
    }
  }

  /** Drop a pending (not-yet-saved) picture pick without touching the server. */
  function clearIconPick() {
    setIconPreview((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
    setIconStorageId(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  /**
   * Upload the picked image to storage and remember its id. Validation happens
   * here (instant feedback) AND on the server, which inspects the stored object
   * rather than trusting the browser's declared type.
   */
  async function uploadIcon(file: File) {
    const problem = communityImageProblem(file);
    // The stored type is derived from the allowed list (or the extension when the
    // browser declares nothing), so the uploaded blob is never mislabelled.
    const contentType = communityImageContentType(file);
    if (problem || !contentType) { toast.error(problem ?? "That file can't be used as a group picture."); return; }
    setUploadPct(0);
    try {
      const url = await generateUploadUrl({});
      const { storageId } = await new Promise<{ storageId: Id<"_storage"> }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", url);
        xhr.setRequestHeader("Content-Type", contentType);
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) setUploadPct(Math.round((e.loaded / e.total) * 100)); };
        xhr.onload = () => {
          if (xhr.status < 200 || xhr.status >= 300) { reject(new Error("Upload failed.")); return; }
          try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error("Upload failed.")); }
        };
        xhr.onerror = () => reject(new Error("Upload failed."));
        xhr.send(file);
      });
      clearIconPick();
      setIconStorageId(storageId);
      setIconPreview(URL.createObjectURL(file));
      toast.success("Picture ready — save to apply it.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not upload the picture.");
    } finally {
      setUploadPct(null);
    }
  }

  /** Apply the pending picture server-side, then forget the local preview. */
  async function saveIcon() {
    if (!iconStorageId) return;
    setIconBusy(true);
    try {
      await update({ serverId, iconStorageId });
      clearIconPick();
      toast.success("Group picture updated.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the group picture.");
    } finally {
      setIconBusy(false);
    }
  }

  /** Restore the default avatar (removes the stored picture). */
  async function removeIcon() {
    setIconBusy(true);
    try {
      await update({ serverId, clearIcon: true });
      clearIconPick();
      toast.success("Group picture removed — the default avatar is back.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove the group picture.");
    } finally {
      setIconBusy(false);
    }
  }

  /** General: name, description, discovery, tags and slow mode in one save. */
  async function save() {
    setBusy(true);
    try {
      await update({
        serverId,
        name: general.name,
        description: general.description,
        isPublic: general.isPublic,
        // The subcategory is deliberately NOT part of this form: it has its own
        // editor with Save/Cancel, so it can never be changed as a side effect of
        // saving the name or the picture.
        tags: general.tags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 6),
        slowModeSeconds: general.slowMode,
      });
      setGeneralDraft(null);
      toast.success(general.isPublic ? "Saved — your community is now discoverable." : "Saved — your community is private.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save settings.");
    } finally {
      setBusy(false);
    }
  }

  /** Throw away unsaved General edits and show the stored values again. */
  function cancelEdits() {
    setGeneralDraft(null);
  }

  async function leaveCommunity() {
    if (!window.confirm("Leave this community? You can rejoin later with an invite.")) return;
    setBusy(true);
    try {
      await leave({ serverId });
      toast.success("You left the community.");
      onLeft();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not leave the community.");
    } finally {
      setBusy(false);
    }
  }

  const shownIcon = iconPreview ?? server?.iconUrl ?? null;
  const iconDirty = iconStorageId !== null;

  return (
    <div className="fc-settings" role="dialog" aria-label="Community settings">
      <header className="fc-settings-head">
        <h2>Community settings</h2>
        <button aria-label="Close settings" onClick={onClose}><X size={18} /></button>
      </header>

      <div className="fc-settings-body">
        {canManage && (
          <nav className="fc-settings-tabs" aria-label="Settings sections">
            {TABS.map((t) => (
              <button key={t} type="button" className={tab === t ? "active" : ""} aria-current={tab === t ? "page" : undefined} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </nav>
        )}

        <div className="fc-settings-content">
          {!details && <p className="fc-muted">Loading…</p>}

          {details && !canManage && (
            <section className="fc-settings-section">
              <h3>About this community</h3>
              <p className="fc-muted">
                You're a member of <strong>{details.server.name}</strong>. Only owners and admins can change
                its picture, details or permissions.
              </p>
              <p className="fc-muted">
                Subcategory: <strong>{communityCategoryOf(details.server.category)}</strong>
              </p>
              <h3 className="danger-heading"><LogOut size={16} /> Leave community</h3>
              <p className="fc-muted">You'll need an invite to rejoin this community later.</p>
              <Button variant="destructive" onClick={leaveCommunity} disabled={busy}>
                <LogOut className="mr-2 h-4 w-4" /> Leave community
              </Button>
            </section>
          )}

          {/* ---------------- General ---------------- */}
          {details && canManage && tab === "General" && (
            <section className="fc-settings-section">
              <h3><Compass size={16} /> General</h3>
              <label>Community name
                <Input value={general.name} maxLength={50} onChange={(e) => editGeneral({ name: e.target.value })} />
              </label>
              <label>Description
                <Input value={general.description} maxLength={200} onChange={(e) => editGeneral({ description: e.target.value })} placeholder="What is this community about?" />
              </label>
              <label>Tags (comma separated, up to 6)
                <Input value={general.tags} onChange={(e) => editGeneral({ tags: e.target.value })} placeholder="art, design, feedback" />
              </label>
              <label>Slow mode (seconds between messages)
                <Input
                  type="number"
                  min={0}
                  max={300}
                  value={general.slowMode}
                  onChange={(e) => editGeneral({ slowMode: Math.max(0, Math.min(300, Number(e.target.value) || 0)) })}
                />
              </label>

              <h3><Compass size={16} /> Privacy</h3>
              <label className="fc-toggle-row">
                <span>
                  <strong>List in Discover</strong>
                  <small>Public communities appear in Discover and anyone can join them.</small>
                </span>
                <input type="checkbox" className="fc-switch" checked={general.isPublic} onChange={(e) => editGeneral({ isPublic: e.target.checked })} />
              </label>
              <p className={`fc-visibility-note ${general.isPublic ? "public" : "private"}`}>
                {general.isPublic
                  ? "This community is public. It shows up in Discover and can be joined without an invite."
                  : "This community is private. It is hidden from Discover and only people with an invite can join."}
              </p>

              {/* Subcategory lives in its own labelled editor with explicit cache-free
                  semantics: one field, one save, instant feedback. */}
              <h3><Compass size={16} /> Subcategory</h3>
              <p className="fc-muted">
                Where this community is listed in Discover. You can change it whenever you like — members,
                messages, channels, roles, permissions, images and invites all stay exactly as they are.
              </p>
              <div className="fc-subcat" role="group" aria-label="Edit subcategory">
                <div className="fc-subcat-current">
                  <span className="fc-subcat-label">Current subcategory</span>
                  <strong className="fc-subcat-value">{currentCategory}</strong>
                  {subcatOptions.some((o) => o.legacy) && <span className="fc-subcat-legacy">no longer offered</span>}
                </div>
                <label className="fc-subcat-picker">
                  Change to
                  <select
                    className="fc-select"
                    value={subcatValue}
                    aria-label="Community subcategory"
                    onChange={(e) => { setSubcatDraft(e.target.value); setSubcatError(""); }}
                  >
                    {subcatOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.legacy ? `${o.value} (no longer offered)` : o.value}
                      </option>
                    ))}
                  </select>
                </label>
                {subcatError && <p role="alert" className="fc-subcat-error">{subcatError}</p>}
                <div className="fc-subcat-actions">
                  <Button size="sm" disabled={subcatBusy || !subcatDirty} onClick={saveSubcategory}>
                    {subcatBusy ? "Saving…" : "Save subcategory"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={subcatBusy || !subcatDirty}
                    onClick={() => { setSubcatDraft(null); setSubcatError(""); }}
                  >
                    Cancel
                  </Button>
                </div>
                <p className="fc-subcat-hint">
                  {subcatDirty
                    ? "Not saved yet — the change appears in Discover after you save."
                    : "Saved. Discover, its category filters and its search use this value."}
                </p>
              </div>

              <div className="fc-settings-actions">
                <Button onClick={save} disabled={busy || !general.name.trim()}>{busy ? "Saving…" : "Save changes"}</Button>
                <Button variant="ghost" disabled={busy} onClick={cancelEdits}>Cancel</Button>
              </div>

              <h3>Invites</h3>
              <p className="fc-muted">Invite code: <code className="fc-inline-code">{details.inviteCode}</code></p>
              <p className="fc-muted">Private communities can still be joined by anyone holding this code.</p>
            </section>
          )}

          {/* ---------------- Appearance ---------------- */}
          {details && canManage && tab === "Appearance" && (
            <section className="fc-settings-section">
              <h3><ImagePlus size={16} /> Group picture</h3>
              <p className="fc-muted">
                This image is shown wherever the group appears — the server rail, the channel list, the chat
                header, Discover and search. Upload a new one, or restore the default avatar.
              </p>
              <div className="fc-icon-row">
                <span className="fc-icon-preview">
                  {shownIcon
                    ? <img src={shownIcon} alt="Group picture" />
                    : <span>{details.server.name.slice(0, 1).toUpperCase()}</span>}
                </span>
                <div className="fc-icon-actions">
                  <input
                    ref={fileInput}
                    type="file"
                    accept={COMMUNITY_IMAGE_ACCEPT}
                    hidden
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadIcon(f); e.target.value = ""; }}
                  />
                  <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()} disabled={uploadPct !== null || iconBusy}>
                    {uploadPct !== null ? `Uploading… ${uploadPct}%` : iconPreview ? "Choose another picture" : "Upload picture"}
                  </Button>
                  {(server?.iconUrl || iconPreview) && (
                    <Button size="sm" variant="ghost" onClick={removeIcon} disabled={iconBusy}>
                      <Trash2 className="mr-1 h-4 w-4" /> Remove picture
                    </Button>
                  )}
                </div>
              </div>
              {iconDirty && (
                <div className="fc-settings-actions">
                  <Button size="sm" onClick={saveIcon} disabled={iconBusy}>{iconBusy ? "Saving…" : "Save picture"}</Button>
                  <Button size="sm" variant="ghost" disabled={iconBusy} onClick={clearIconPick}>Cancel</Button>
                </div>
              )}
              <p className="fc-muted">PNG, JPG, GIF, WebP or AVIF · up to 5 MB.</p>
            </section>
          )}

          {/* ---------------- Permissions ---------------- */}
          {details && canManage && tab === "Permissions" && (
            <section className="fc-settings-section">
              <h3><Shield size={16} /> Roles &amp; permissions</h3>
              <p className="fc-muted">
                A role is a named set of permissions. <strong>Manage community</strong> lets someone edit this
                group and its picture, <strong>Send messages</strong> controls who can post, and{" "}
                <strong>Create invites</strong>, <strong>Kick</strong> and <strong>Ban members</strong> control
                who can add or remove people. Slow mode above throttles everyone.
              </p>
              <ServerPermissions serverId={serverId} defaultTab="roles" />
            </section>
          )}

          {/* ---------------- Members ---------------- */}
          {details && canManage && tab === "Members" && (
            <section className="fc-settings-section">
              <h3><Users size={16} /> Members</h3>
              <p className="fc-muted">
                Assign roles, time someone out, or remove them. Removing a member asks for confirmation and is
                enforced on the server.
              </p>
              <ServerPermissions serverId={serverId} defaultTab="members" />
            </section>
          )}

          {/* ---------------- Channels ---------------- */}
          {details && canManage && tab === "Channels" && (
            <section className="fc-settings-section">
              <h3><Volume2 size={16} /> Voice channels</h3>
              <p className="fc-muted">Create voice rooms, set limits, and manage privacy. Members see changes immediately.</p>
              <div className="fc-new-voice">
                <Input value={newVoiceName} maxLength={40} placeholder="e.g. General Voice" onChange={(e) => setNewVoiceName(e.target.value)} />
                <Input
                  type="number" min={0} max={100} value={newVoiceLimit}
                  aria-label="User limit"
                  onChange={(e) => setNewVoiceLimit(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                />
                <Button
                  size="sm"
                  disabled={busy || !newVoiceName.trim()}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await createChannelFull({ serverId, name: newVoiceName, type: "voice", userLimit: newVoiceLimit });
                      setNewVoiceName("");
                      setNewVoiceLimit(0);
                      toast.success("Voice channel created.");
                    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not create the channel."); }
                    finally { setBusy(false); }
                  }}
                ><Plus className="mr-1 h-4 w-4" /> Create voice channel</Button>
              </div>
              <ul className="fc-voice-manage">
                {voiceChannelList
                  .filter((c) => c.type === "voice" || c.type === "video")
                  .map((c) => (
                    <li key={c._id}>
                      <span className="fc-voice-manage-name">{c.isPrivate ? <Mic size={13} /> : <Volume2 size={14} />} {c.name}</span>
                      <label className="fc-voice-manage-limit">Limit
                        <input
                          type="number" min={0} max={100}
                          defaultValue={c.userLimit ?? 0}
                          onBlur={(e) => {
                            const n = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                            if (n !== (c.userLimit ?? 0)) updateChannelFull({ channelId: c._id, userLimit: n }).then(() => toast.success("User limit updated.")).catch((err) => toast.error(err.message));
                          }}
                        />
                      </label>
                      <label className="fc-checkbox-row">
                        <input
                          type="checkbox"
                          defaultChecked={c.isPrivate ?? false}
                          onChange={(e) => updateChannelFull({ channelId: c._id, isPrivate: e.target.checked }).then(() => toast.success(e.target.checked ? "Now private." : "Now public.")).catch((err) => toast.error(err.message))}
                        />
                        Private
                      </label>
                      {c.isPrivate && (
                        <div className="fc-radio-row">
                          {["moderator", "member"].map((r) => {
                            const allowed = (c.allowedRoleIds ?? []).includes(r);
                            return (
                              <label key={r} className={`fc-radio ${allowed ? "active" : ""}`}>
                                <input
                                  type="checkbox"
                                  checked={allowed}
                                  onChange={(e) => {
                                    const next = e.target.checked
                                      ? [...(c.allowedRoleIds ?? []), r]
                                      : (c.allowedRoleIds ?? []).filter((x) => x !== r);
                                    updateChannelFull({ channelId: c._id, allowedRoleIds: next }).then(() => toast.success("Access updated.")).catch((err) => toast.error(err.message));
                                  }}
                                />
                                {r.charAt(0).toUpperCase() + r.slice(1)}
                              </label>
                            );
                          })}
                          {roleList.filter((r) => r.name !== "owner").map((r) => {
                            const allowed = (c.allowedRoleIds ?? []).includes(r._id);
                            return (
                              <label key={r._id} className={`fc-radio ${allowed ? "active" : ""}`}>
                                <input
                                  type="checkbox"
                                  checked={allowed}
                                  onChange={(e) => {
                                    const next = e.target.checked
                                      ? [...(c.allowedRoleIds ?? []), r._id]
                                      : (c.allowedRoleIds ?? []).filter((x) => x !== r._id);
                                    updateChannelFull({ channelId: c._id, allowedRoleIds: next }).then(() => toast.success("Access updated.")).catch((err) => toast.error(err.message));
                                  }}
                                />
                                {r.name}
                              </label>
                            );
                          })}
                        </div>
                      )}
                      <button
                        className="fc-voice-manage-del"
                        aria-label={`Delete ${c.name}`}
                        onClick={() => {
                          if (!window.confirm(`Delete Voice Channel?\n\nThis will remove "${c.name}" from this community.`)) return;
                          deleteChannelFull({ channelId: c._id }).then(() => toast.success("Channel deleted.")).catch((err) => toast.error(err.message));
                        }}
                      ><Trash2 size={14} /></button>
                    </li>
                  ))}
              </ul>

              <h3><LayoutList size={16} /> Channels &amp; categories</h3>
              <ChannelManager serverId={serverId} roles={roleList.map((r) => ({ _id: r._id as string, name: r.name }))} />
            </section>
          )}

          {/* ---------------- Danger ---------------- */}
          {details && canManage && tab === "Danger" && (
            <section className="fc-settings-section">
              <h3 className="danger-heading"><LogOut size={16} /> Leave community</h3>
              {isOwner ? (
                <p className="fc-muted">
                  You own this community. To leave it, transfer ownership or delete it — owners can't leave
                  a community they own.
                </p>
              ) : (
                <>
                  <p className="fc-muted">You'll need an invite to rejoin this community later.</p>
                  <Button variant="destructive" onClick={leaveCommunity} disabled={busy}>
                    <LogOut className="mr-2 h-4 w-4" /> Leave community
                  </Button>
                </>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
