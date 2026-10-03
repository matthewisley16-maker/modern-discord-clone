import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Compass, Lock, Shield, X } from "lucide-react";

const CATEGORIES = ["General", "Gaming", "Music", "Art", "Tech", "Study", "Sports", "Community"];

export default function CommunitySettings({
  serverId,
  onClose,
}: {
  serverId: Id<"servers">;
  onClose: () => void;
}) {
  const details = useQuery(api.communities.details, { serverId });
  const update = useMutation(api.communities.updateSettings);

  const server = details?.server;
  const canManage = details?.permissions.includes("manageCommunity") ?? false;

  const [name, setName] = useState(server?.name ?? "");
  const [description, setDescription] = useState(server?.description ?? "");
  const [isPublic, setIsPublic] = useState(server?.isPublic ?? false);
  const [category, setCategory] = useState(server?.category ?? "General");
  const [tags, setTags] = useState((server?.tags ?? []).join(", "));
  const [slowMode, setSlowMode] = useState(server?.slowModeSeconds ?? 0);
  const [busy, setBusy] = useState(false);

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
      });
      toast.success(isPublic ? "Saved — your community is now discoverable." : "Saved — your community is private.");
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save settings.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fc-settings" role="dialog" aria-label="Community settings">
      <header className="fc-settings-head">
        <h2>Community settings</h2>
        <button aria-label="Close settings" onClick={onClose}><X size={18} /></button>
      </header>
      <div className="fc-settings-content">
        {!details && <p className="fc-muted">Loading…</p>}
        {details && !canManage && (
          <p className="fc-muted">You need the “Manage community” permission to change these settings.</p>
        )}
        {details && canManage && (
          <section className="fc-settings-section">
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

            <h3><Lock size={16} /> Invites</h3>
            <p className="fc-muted">Invite code: <code className="fc-inline-code">{details.inviteCode}</code></p>
            <p className="fc-muted">Private communities can still be joined by anyone holding this code.</p>
          </section>
        )}
      </div>
    </div>
  );
}
