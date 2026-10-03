import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Compass, ImagePlus, LogOut, Shield, Trash2, X } from "lucide-react";

const CATEGORIES = ["General", "Gaming", "Music", "Art", "Tech", "Study", "Sports", "Community"];
const MAX_ICON_BYTES = 5 * 1024 * 1024;

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
  const leave = useMutation(api.communities.leave);
  const generateUploadUrl = useMutation(api.uploads.generateUploadUrl);

  const server = details?.server;
  const canManage = details?.permissions.includes("manageCommunity") ?? false;
  const isOwner = details?.isOwner ?? false;

  const [name, setName] = useState(server?.name ?? "");
  const [description, setDescription] = useState(server?.description ?? "");
  const [isPublic, setIsPublic] = useState(server?.isPublic ?? false);
  const [category, setCategory] = useState(server?.category ?? "General");
  const [tags, setTags] = useState((server?.tags ?? []).join(", "));
  const [slowMode, setSlowMode] = useState(server?.slowModeSeconds ?? 0);
  const [iconStorageId, setIconStorageId] = useState<Id<"_storage"> | null>(null);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  /** Upload an icon image with progress; validated server-side too. */
  async function uploadIcon(file: File) {
    if (!file.type.startsWith("image/")) { toast.error("Please choose an image file (PNG, JPG, GIF, or WebP)."); return; }
    if (file.size > MAX_ICON_BYTES) { toast.error("Icons must be 5 MB or smaller."); return; }
    setUploadPct(0);
    try {
      const url = await generateUploadUrl({});
      const { storageId } = await new Promise<{ storageId: Id<"_storage"> }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", url);
        xhr.setRequestHeader("Content-Type", file.type);
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) setUploadPct(Math.round((e.loaded / e.total) * 100)); };
        xhr.onload = () => {
          if (xhr.status < 200 || xhr.status >= 300) { reject(new Error("Upload failed.")); return; }
          try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error("Upload failed.")); }
        };
        xhr.onerror = () => reject(new Error("Upload failed."));
        xhr.send(file);
      });
      setIconStorageId(storageId);
      setIconPreview(URL.createObjectURL(file));
      toast.success("Icon ready — save to apply it.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not upload the icon.");
    } finally {
      setUploadPct(null);
    }
  }

  async function save() {
    setBusy(true);
    try {
      await update({
        serverId,
        name,
        description,
        isPublic,
        category,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 6),
        slowModeSeconds: slowMode,
        ...(iconStorageId ? { iconStorageId } : {}),
      });
      toast.success(isPublic ? "Saved — your community is now discoverable." : "Saved — your community is private.");
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save settings.");
    } finally {
      setBusy(false);
    }
  }

  async function removeIcon() {
    setBusy(true);
    try {
      await update({ serverId, clearIcon: true });
      setIconPreview(null);
      setIconStorageId(null);
      toast.success("Icon removed.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove the icon.");
    } finally {
      setBusy(false);
    }
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

  return (
    <div className="fc-settings" role="dialog" aria-label="Community settings">
      <header className="fc-settings-head">
        <h2>Community settings</h2>
        <button aria-label="Close settings" onClick={onClose}><X size={18} /></button>
      </header>
      <div className="fc-settings-content">
        {!details && <p className="fc-muted">Loading…</p>}

        {details && !canManage && (
          <section className="fc-settings-section">
            <h3>About this community</h3>
            <p className="fc-muted">
              You're a member of <strong>{details.server.name}</strong>. Only owners and admins can change
              its settings.
            </p>
            <h3><LogOut size={16} /> Leave community</h3>
            <p className="fc-muted">You'll need an invite to rejoin this community later.</p>
            <Button variant="destructive" onClick={leaveCommunity} disabled={busy}>
              <LogOut className="mr-2 h-4 w-4" /> Leave community
            </Button>
          </section>
        )}

        {details && canManage && (
          <section className="fc-settings-section">
            <h3><ImagePlus size={16} /> Community icon</h3>
            <div className="fc-icon-row">
              <span className="fc-icon-preview">
                {shownIcon ? <img src={shownIcon} alt="Community icon" /> : <span>{details.server.name.slice(0, 1).toUpperCase()}</span>}
              </span>
              <div className="fc-icon-actions">
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadIcon(f); e.target.value = ""; }}
                />
                <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()} disabled={uploadPct !== null}>
                  {uploadPct !== null ? `Uploading… ${uploadPct}%` : "Upload icon"}
                </Button>
                {(server?.iconUrl || iconPreview) && (
                  <Button size="sm" variant="ghost" onClick={removeIcon} disabled={busy}>
                    <Trash2 className="mr-1 h-4 w-4" /> Remove
                  </Button>
                )}
              </div>
            </div>

            <h3><Compass size={16} /> Discovery</h3>
            <label className="fc-toggle-row">
              <span>
                <strong>List in Discover</strong>
                <small>Public communities appear in Discover and anyone can join them.</small>
              </span>
              <input type="checkbox" className="fc-switch" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
            </label>
            <p className={`fc-visibility-note ${isPublic ? "public" : "private"}`}>
              {isPublic
                ? "This community is public. It shows up in Discover and can be joined without an invite."
                : "This community is private. It is hidden from Discover and only people with an invite can join."}
            </p>

            <label>Category
              <select className="fc-select" value={category} onChange={(e) => setCategory(e.target.value)}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label>Tags (comma separated, up to 6)
              <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="art, design, feedback" />
            </label>

            <h3><Shield size={16} /> General</h3>
            <label>Community name
              <Input value={name} maxLength={50} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>Description
              <Input value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} placeholder="What is this community about?" />
            </label>
            <label>Slow mode (seconds between messages)
              <Input
                type="number"
                min={0}
                max={300}
                value={slowMode}
                onChange={(e) => setSlowMode(Math.max(0, Math.min(300, Number(e.target.value) || 0)))}
              />
            </label>

            <div className="fc-settings-actions">
              <Button onClick={save} disabled={busy || !name.trim()}>{busy ? "Saving…" : "Save changes"}</Button>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
            </div>

            <h3>Invites</h3>
            <p className="fc-muted">Invite code: <code className="fc-inline-code">{details.inviteCode}</code></p>
            <p className="fc-muted">Private communities can still be joined by anyone holding this code.</p>

            {!isOwner && (
              <>
                <h3><LogOut size={16} /> Leave community</h3>
                <p className="fc-muted">You'll need an invite to rejoin this community later.</p>
                <Button variant="destructive" onClick={leaveCommunity} disabled={busy}>
                  <LogOut className="mr-2 h-4 w-4" /> Leave community
                </Button>
              </>
            )}
            {isOwner && (
              <p className="fc-muted">
                You own this community. To leave it, transfer ownership or delete it — owners can't leave
                a community they own.
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
