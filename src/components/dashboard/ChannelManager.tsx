import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toSafeArray } from "@/lib/collection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { GripVertical, Hash, Lock, Pencil, Plus, Trash2, Volume2 } from "lucide-react";

type Role = { _id: string; name: string };
type Cat = { _id: Id<"channelCategories">; name: string };
type Chan = {
  _id: Id<"channels">;
  name: string;
  type?: string | null;
  userLimit?: number | null;
  isPrivate?: boolean | null;
  allowedRoleIds?: string[];
  categoryId?: Id<"channelCategories"> | null;
};

/**
 * Owner/manager control over a community's categories and channels: create,
 * rename, move, reorder (drag and drop), and delete with confirmation.
 * Every change is persisted server-side through the existing voice/channel API.
 */
export default function ChannelManager({ serverId, roles }: { serverId: Id<"servers">; roles: Role[] }) {
  const tree = useQuery(api.voice.channelTree, { serverId });
  const createCategory = useMutation(api.voice.createCategory);
  const updateCategory = useMutation(api.voice.updateCategory);
  const deleteCategory = useMutation(api.voice.deleteCategory);
  const reorderCategories = useMutation(api.voice.reorderCategories);
  const createChannelFull = useMutation(api.voice.createChannelFull);
  const updateChannelFull = useMutation(api.voice.updateChannelFull);
  const deleteChannelFull = useMutation(api.voice.deleteChannelFull);
  const reorderChannels = useMutation(api.voice.reorderChannels);

  const [busy, setBusy] = useState(false);
  const [editCat, setEditCat] = useState<string | null>(null);
  const [catValue, setCatValue] = useState("");
  const [editChan, setEditChan] = useState<string | null>(null);
  const [chanValue, setChanValue] = useState("");
  const [newCat, setNewCat] = useState("");
  const [confirm, setConfirm] = useState<{ kind: "channel" | "category"; id: string; name: string } | null>(null);
  const [creating, setCreating] = useState<{ type: "text" | "voice"; categoryId: string } | null>(null);
  const [form, setForm] = useState({ name: "", description: "", limit: 0, isPrivate: false, roles: [] as string[] });
  const [dragCat, setDragCat] = useState<string | null>(null);
  const [dragChan, setDragChan] = useState<string | null>(null);

  if (!tree) return <p className="fc-muted">Loading channels…</p>;

  const categories: Cat[] = toSafeArray<Cat>(tree.categories, { label: "Channel categories", source: "api.voice.channelTree" });
  const uncategorized: Chan[] = toSafeArray<Chan>(tree.uncategorized, { label: "Uncategorized channels", source: "api.voice.channelTree" });
  const byCategory = toSafeArray<NonNullable<typeof tree>["byCategory"][number]>(tree.byCategory, { label: "Channel categories", source: "api.voice.channelTree" });
  const allChannels: Chan[] = [...uncategorized, ...byCategory.flatMap((g) => g.channels)] as Chan[];

  function openCreate(type: "text" | "voice", categoryId: string) {
    setForm({ name: "", description: "", limit: 0, isPrivate: false, roles: [] });
    setCreating({ type, categoryId });
  }

  async function submitCreate() {
    if (!creating) return;
    if (!form.name.trim()) { toast.error("Please enter a channel name."); return; }
    setBusy(true);
    try {
      await createChannelFull({
        serverId,
        name: form.name.trim(),
        type: creating.type,
        ...(creating.categoryId ? { categoryId: creating.categoryId as Id<"channelCategories"> } : {}),
        ...(creating.type === "voice"
          ? { userLimit: form.limit, isPrivate: form.isPrivate, allowedRoleIds: form.isPrivate ? form.roles : [] }
          : { description: form.description, isPrivate: form.isPrivate, allowedRoleIds: form.isPrivate ? form.roles : [] }),
      });
      toast.success(creating.type === "text" ? "Text channel created." : "Voice channel created.");
      setCreating(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create the channel.");
    } finally {
      setBusy(false);
    }
  }

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try { await fn(); toast.success(ok); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Something went wrong."); }
    finally { setBusy(false); }
  }

  async function doConfirm() {
    if (!confirm) return;
    const c = confirm;
    setConfirm(null);
    if (c.kind === "channel") await run(() => deleteChannelFull({ channelId: c.id as Id<"channels"> }), "Channel deleted.");
    else await run(() => deleteCategory({ categoryId: c.id as Id<"channelCategories"> }), "Category deleted — its channels were kept.");
  }

  async function dropCategory(targetId: string) {
    const id = dragCat;
    setDragCat(null);
    if (!id || id === targetId) return;
    const ids = categories.map((c) => c._id as string);
    const from = ids.indexOf(id);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    await run(
      () => reorderCategories({ serverId, order: ids.map((categoryId, i) => ({ categoryId: categoryId as Id<"channelCategories">, position: i })) }),
      "Categories reordered.",
    );
  }

  async function dropChannel(targetId: string) {
    const id = dragChan;
    setDragChan(null);
    if (!id || id === targetId) return;
    const from = allChannels.find((c) => c._id === id);
    const to = allChannels.find((c) => c._id === targetId);
    if (!from || !to) return;
    const group = allChannels.filter((c) => (c.categoryId ?? null) === (to.categoryId ?? null) && c._id !== id);
    const at = group.findIndex((c) => c._id === targetId);
    group.splice(at < 0 ? group.length : at, 0, from);
    await run(
      () => reorderChannels({
        serverId,
        order: group.map((c, i) => ({ channelId: c._id, position: i, categoryId: to.categoryId ?? undefined })),
      }),
      "Channels reordered.",
    );
  }

  function channelRow(c: Chan) {
    const isVoice = c.type === "voice" || c.type === "video";
    return (
      <li
        key={c._id}
        className="fc-cm-channel"
        draggable
        onDragStart={() => setDragChan(c._id)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); void dropChannel(c._id); }}
      >
        <GripVertical size={14} className="fc-cm-grip" />
        {isVoice ? (c.isPrivate ? <Lock size={14} /> : <Volume2 size={14} />) : <Hash size={14} />}
        {editChan === c._id ? (
          <form
            className="fc-cm-edit"
            onSubmit={(e) => { e.preventDefault(); if (chanValue.trim()) void run(() => updateChannelFull({ channelId: c._id, name: chanValue.trim() }), "Channel renamed."); setEditChan(null); }}
          >
            <Input autoFocus value={chanValue} maxLength={40} onChange={(e) => setChanValue(e.target.value)} />
            <Button size="sm" type="submit" disabled={busy}>Save</Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => setEditChan(null)}>Cancel</Button>
          </form>
        ) : (
          <>
            <span className="fc-cm-name">{c.name}{c.isPrivate && <em className="fc-cm-flag">private</em>}</span>
            <button className="fc-cm-icon-btn" aria-label={`Rename ${c.name}`} onClick={() => { setEditChan(c._id); setChanValue(c.name); }}><Pencil size={13} /></button>
            <button className="fc-cm-icon-btn danger" aria-label={`Delete ${c.name}`} onClick={() => setConfirm({ kind: "channel", id: c._id, name: c.name })}><Trash2 size={13} /></button>
          </>
        )}
      </li>
    );
  }

  return (
    <div className="fc-cm">
      <p className="fc-muted">
        These controls are for the community owner and managers. Drag the handles to reorder — changes save instantly.
      </p>

      {/* Create a new category */}
      <div className="fc-cm-newcat">
        <Input value={newCat} maxLength={40} placeholder="New category name" onChange={(e) => setNewCat(e.target.value)} />
        <Button
          size="sm"
          disabled={busy || !newCat.trim()}
          onClick={() => void run(async () => { await createCategory({ serverId, name: newCat.trim() }); setNewCat(""); }, "Category created.")}
        ><Plus className="mr-1 h-4 w-4" /> Create category</Button>
      </div>

      {/* Uncategorized channels */}
      <div className="fc-cm-group">
        <div className="fc-cm-head">
          <span className="fc-cm-cat">Uncategorized</span>
          <button className="fc-cm-add" onClick={() => openCreate("text", "")}><Hash size={13} /> Text</button>
          <button className="fc-cm-add" onClick={() => openCreate("voice", "")}><Volume2 size={13} /> Voice</button>
        </div>
        <ul className="fc-cm-list">{uncategorized.map((c) => channelRow(c))}</ul>
      </div>

      {/* Categories, each with its channels */}
      {categories.map((cat) => {
        const group = byCategory.find((g) => g.category._id === cat._id);
        const channels = (group?.channels ?? []) as Chan[];
        return (
          <div
            key={cat._id}
            className="fc-cm-group"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); void dropCategory(cat._id); }}
          >
            <div className="fc-cm-head">
              <span className="fc-cm-grip" draggable onDragStart={() => setDragCat(cat._id)} aria-hidden="true"><GripVertical size={14} /></span>
              {editCat === cat._id ? (
                <form
                  className="fc-cm-edit"
                  onSubmit={(e) => { e.preventDefault(); if (catValue.trim()) void run(() => updateCategory({ categoryId: cat._id, name: catValue.trim() }), "Category renamed."); setEditCat(null); }}
                >
                  <Input autoFocus value={catValue} maxLength={40} onChange={(e) => setCatValue(e.target.value)} />
                  <Button size="sm" type="submit" disabled={busy}>Save</Button>
                  <Button size="sm" type="button" variant="ghost" onClick={() => setEditCat(null)}>Cancel</Button>
                </form>
              ) : (
                <>
                  <span className="fc-cm-cat">{cat.name}</span>
                  <button className="fc-cm-icon-btn" aria-label={`Rename ${cat.name}`} onClick={() => { setEditCat(cat._id); setCatValue(cat.name); }}><Pencil size={13} /></button>
                  <button className="fc-cm-icon-btn danger" aria-label={`Delete ${cat.name}`} onClick={() => setConfirm({ kind: "category", id: cat._id, name: cat.name })}><Trash2 size={13} /></button>
                  <button className="fc-cm-add" onClick={() => openCreate("text", cat._id)}><Hash size={13} /> Text</button>
                  <button className="fc-cm-add" onClick={() => openCreate("voice", cat._id)}><Volume2 size={13} /> Voice</button>
                </>
              )}
            </div>
            <ul className="fc-cm-list">{channels.map((c) => channelRow(c))}</ul>
          </div>
        );
      })}

      {/* Confirmation dialog */}
      {confirm && (
        <div className="fc-cm-confirm-overlay" onClick={() => setConfirm(null)}>
          <div className="fc-cm-confirm" role="alertdialog" aria-label={`Delete ${confirm.name}`} onClick={(e) => e.stopPropagation()}>
            <h4>Delete &ldquo;{confirm.name}&rdquo;?</h4>
            <p>{confirm.kind === "category" ? "Its channels will be moved to Uncategorized. This cannot be undone." : "This cannot be undone."}</p>
            <div className="fc-cm-confirm-actions">
              <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button variant="destructive" onClick={() => void doConfirm()} disabled={busy}>Delete</Button>
            </div>
          </div>
        </div>
      )}

      {/* Create channel form */}
      {creating && (
        <div className="fc-cm-confirm-overlay" onClick={() => setCreating(null)}>
          <div className="fc-cm-confirm fc-cm-create" role="dialog" aria-label="Create channel" onClick={(e) => e.stopPropagation()}>
            <h4>Create {creating.type === "text" ? "text" : "voice"} channel</h4>
            <label>Name
              <Input autoFocus value={form.name} maxLength={40} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={creating.type === "text" ? "share-your-work" : "Studio"} />
            </label>
            {creating.type === "text" ? (
              <label>Topic / description
                <Input value={form.description} maxLength={200} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What's this channel for?" />
              </label>
            ) : (
              <label>User limit (0 = unlimited)
                <Input type="number" min={0} max={100} value={form.limit} onChange={(e) => setForm({ ...form, limit: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} />
              </label>
            )}
            <label className="fc-checkbox-row">
              <input type="checkbox" checked={form.isPrivate} onChange={(e) => setForm({ ...form, isPrivate: e.target.checked })} />
              Restricted — only roles you allow can see and join
            </label>
            {form.isPrivate && (
              <div className="fc-radio-row">
                {["moderator", "member"].map((r) => (
                  <label key={r} className={`fc-radio ${form.roles.includes(r) ? "active" : ""}`}>
                    <input
                      type="checkbox"
                      checked={form.roles.includes(r)}
                      onChange={(e) => setForm({ ...form, roles: e.target.checked ? [...form.roles, r] : form.roles.filter((x) => x !== r) })}
                    />
                    {r.charAt(0).toUpperCase() + r.slice(1)}
                  </label>
                ))}
                {roles.filter((r) => r.name !== "owner").map((r) => (
                  <label key={r._id} className={`fc-radio ${form.roles.includes(r._id) ? "active" : ""}`}>
                    <input
                      type="checkbox"
                      checked={form.roles.includes(r._id)}
                      onChange={(e) => setForm({ ...form, roles: e.target.checked ? [...form.roles, r._id] : form.roles.filter((x) => x !== r._id) })}
                    />
                    {r.name}
                  </label>
                ))}
              </div>
            )}
            <div className="fc-cm-confirm-actions">
              <Button variant="ghost" onClick={() => setCreating(null)}>Cancel</Button>
              <Button onClick={() => void submitCreate()} disabled={busy || !form.name.trim()}>Create</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
