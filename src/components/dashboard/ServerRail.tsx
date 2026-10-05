import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { initialsOf } from "@/components/dashboard/ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  Check, ChevronDown, FolderPlus, Hash, Plus, Search, X,
} from "lucide-react";

export type RailCommunity = { _id: string; name: string; iconUrl?: string | null };

type RailFolder = { id: string; name: string; color: string | null; collapsed: boolean; serverIds: string[] };
type RailItem = { type: "folder"; folder: RailFolder } | { type: "server"; id: string };

/** Above this many servers the rail also offers a searchable overflow switcher. */
const OVERFLOW_THRESHOLD = 10;
const FOLDER_COLORS = ["#8b5cf6", "#f0616d", "#3ba55d", "#faa61a", "#00a8fc", "#eb459e", "#5865f2", "#9b59b6"];

// ---------------------------------------------------------------------------
// Pure list helpers (operate on a clone so React state always changes).
// ---------------------------------------------------------------------------

function cloneItems(list: RailItem[]): RailItem[] {
  return list.map((it) =>
    it.type === "folder"
      ? { type: "folder" as const, folder: { ...it.folder, serverIds: [...it.folder.serverIds] } }
      : { type: "server" as const, id: it.id },
  );
}

function withoutServer(list: RailItem[], serverId: string): RailItem[] {
  const out: RailItem[] = [];
  for (const it of list) {
    if (it.type === "server") {
      if (it.id !== serverId) out.push({ type: "server", id: it.id });
    } else {
      out.push({ type: "folder", folder: { ...it.folder, serverIds: it.folder.serverIds.filter((s) => s !== serverId) } });
    }
  }
  return out;
}

function insertServerRelative(list: RailItem[], targetId: string, serverId: string, after: boolean): RailItem[] {
  const idx = list.findIndex((it) => it.type === "server" && it.id === targetId);
  const node: RailItem = { type: "server", id: serverId };
  if (idx === -1) return [...list, node];
  const at = after ? idx + 1 : idx;
  return [...list.slice(0, at), node, ...list.slice(at)];
}

function insertFolderRelative(list: RailItem[], targetFolderId: string, moving: RailFolder, after: boolean): RailItem[] {
  const stripped = list.filter((it) => !(it.type === "folder" && it.folder.id === moving.id));
  const idx = stripped.findIndex((it) => it.type === "folder" && it.folder.id === targetFolderId);
  const node: RailItem = { type: "folder", folder: { ...moving, serverIds: [...moving.serverIds] } };
  if (idx === -1) return [...stripped, node];
  const at = after ? idx + 1 : idx;
  return [...stripped.slice(0, at), node, ...stripped.slice(at)];
}

function insertFolderAtServer(list: RailItem[], targetServerId: string, moving: RailFolder, after: boolean): RailItem[] {
  const stripped = list.filter((it) => !(it.type === "folder" && it.folder.id === moving.id));
  const idx = stripped.findIndex((it) => it.type === "server" && it.id === targetServerId);
  const node: RailItem = { type: "folder", folder: { ...moving, serverIds: [...moving.serverIds] } };
  if (idx === -1) return [...stripped, node];
  const at = after ? idx + 1 : idx;
  return [...stripped.slice(0, at), node, ...stripped.slice(at)];
}

function moveIntoFolder(list: RailItem[], folderId: string, serverId: string): RailItem[] {
  return withoutServer(list, serverId).map((it) =>
    it.type === "folder" && it.folder.id === folderId
      ? { type: "folder", folder: { ...it.folder, collapsed: false, serverIds: [...it.folder.serverIds, serverId] } }
      : it,
  );
}

function reorderWithinFolder(list: RailItem[], folderId: string, serverId: string, targetServerId: string, after: boolean): RailItem[] {
  return list.map((it) => {
    if (it.type !== "folder" || it.folder.id !== folderId) return it;
    const ids = it.folder.serverIds.filter((s) => s !== serverId);
    const idx = ids.indexOf(targetServerId);
    const at = idx === -1 ? ids.length : after ? idx + 1 : idx;
    return { type: "folder", folder: { ...it.folder, serverIds: [...ids.slice(0, at), serverId, ...ids.slice(at)] } };
  });
}

function moveBy(list: RailItem[], key: string, delta: number, inFolderId?: string): RailItem[] {
  // Reorder inside a folder.
  if (inFolderId) {
    return list.map((it) => {
      if (it.type !== "folder" || it.folder.id !== inFolderId) return it;
      const ids = [...it.folder.serverIds];
      const i = ids.indexOf(key);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= ids.length) return it;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      return { type: "folder", folder: { ...it.folder, serverIds: ids } };
    });
  }
  // Reorder a top-level folder or server among the rail column.
  const isFolder = key.startsWith("folder:");
  const id = isFolder ? key.slice(7) : key;
  const idx = list.findIndex((it) => (isFolder ? it.type === "folder" && it.folder.id === id : it.type === "server" && it.id === id));
  const j = idx + delta;
  if (idx < 0 || j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[idx], next[j]] = [next[j], next[idx]];
  return next;
}

function deleteFolderFromList(list: RailItem[], folderId: string): RailItem[] {
  const released: string[] = [];
  const out: RailItem[] = [];
  for (const it of list) {
    if (it.type === "folder" && it.folder.id === folderId) released.push(...it.folder.serverIds);
    else out.push(it);
  }
  // Servers from the deleted folder are released back into the rail at the end.
  return [...out, ...released.map((id): RailItem => ({ type: "server", id }))];
}

export default function ServerRail({
  communities,
  communityId,
  onOpen,
  onCreate,
  onJoin,
}: {
  communities: RailCommunity[];
  communityId: string | null;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onJoin: () => void;
}) {
  const org = useQuery(api.serverOrg.get, {});
  const saveOrg = useMutation(api.serverOrg.save);
  const touchRecent = useMutation(api.serverOrg.touchRecent);

  const [dragging, setDragging] = useState<{ kind: "server" | "folder"; id: string; fromFolder?: string } | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ key: string; top: number; left: number } | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowQuery, setOverflowQuery] = useState("");
  const [folderDialog, setFolderDialog] = useState<null | { mode: "create" | "rename"; id?: string; name: string; color: string }>(null);

  const byId = useMemo(() => new Map(communities.map((c) => [c._id, c])), [communities]);

  /** Merge saved layout with live memberships (new servers appear, gone ones drop). */
  const items = useMemo<RailItem[]>(() => {
    const layout = org?.layout ?? [];
    const folders = (org?.folders ?? []).map((f) => ({ ...f, serverIds: f.serverIds.filter((s) => byId.has(s)) }));
    const folderById = new Map(folders.map((f) => [f.id, f]));
    const placed = new Set<string>();
    const out: RailItem[] = [];
    for (const entry of layout) {
      if (entry.startsWith("folder:")) {
        const f = folderById.get(entry.slice(7));
        if (!f || placed.has(entry)) continue;
        placed.add(entry);
        for (const s of f.serverIds) placed.add(s);
        out.push({ type: "folder", folder: f });
      } else if (byId.has(entry) && !placed.has(entry)) {
        placed.add(entry);
        out.push({ type: "server", id: entry });
      }
    }
    // Folders that existed but were missing from the layout.
    for (const f of folders) {
      if (placed.has(`folder:${f.id}`)) continue;
      placed.add(`folder:${f.id}`);
      for (const s of f.serverIds) placed.add(s);
      out.push({ type: "folder", folder: f });
    }
    // Any server not yet placed.
    for (const c of communities) {
      if (!placed.has(c._id)) {
        placed.add(c._id);
        out.push({ type: "server", id: c._id });
      }
    }
    return out;
  }, [communities, org, byId]);

  const folderList = useMemo(() => items.filter((it): it is { type: "folder"; folder: RailFolder } => it.type === "folder").map((it) => it.folder), [items]);

  function persist(next: RailItem[]) {
    const layout = next.map((it) => (it.type === "folder" ? `folder:${it.folder.id}` : it.id));
    const folders = next
      .filter((it): it is { type: "folder"; folder: RailFolder } => it.type === "folder")
      .map((it) => ({
        id: it.folder.id,
        name: it.folder.name,
        ...(it.folder.color ? { color: it.folder.color } : {}),
        collapsed: it.folder.collapsed,
        serverIds: it.folder.serverIds,
      }));
    saveOrg({ layout, folders, recent: org?.recent ?? [] }).catch((e) => {
      toast.error(e instanceof Error ? e.message : "Could not save your server layout.");
    });
  }

  function apply(next: RailItem[]) {
    persist(next);
    setMenu(null);
  }

  function handleOpen(id: string) {
    touchRecent({ serverId: id }).catch(() => {});
    onOpen(id);
  }

  /** Open a context menu anchored to the clicked control (fixed, so the
   *  scrolling rail can never clip it). */
  function openMenu(key: string, e: React.MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const left = Math.min(r.right + 8, Math.max(8, window.innerWidth - 210));
    const top = Math.max(8, Math.min(r.top, window.innerHeight - 260));
    setMenu({ key, top, left });
  }

  function renderMenuItems() {
    if (!menu) return null;
    const close = () => setMenu(null);
    if (menu.key.startsWith("folder:")) {
      const folder = folderList.find((f) => f.id === menu.key.slice(7));
      if (!folder) return null;
      return (
        <>
          <button onClick={() => apply(moveByToggle(cloneItems(items), folder.id))}>{folder.collapsed ? "Expand folder" : "Collapse folder"}</button>
          <button onClick={() => { setFolderDialog({ mode: "rename", id: folder.id, name: folder.name, color: folder.color ?? FOLDER_COLORS[0] }); close(); }}>Rename folder</button>
          <button onClick={() => apply(moveBy(cloneItems(items), menu.key, -1))}>Move folder up</button>
          <button onClick={() => apply(moveBy(cloneItems(items), menu.key, 1))}>Move folder down</button>
          <button className="danger" onClick={() => { if (window.confirm(`Delete the folder “${folder.name}”? The servers inside stay in your rail.`)) apply(deleteFolderFromList(cloneItems(items), folder.id)); }}>Delete folder (keeps servers)</button>
        </>
      );
    }
    if (menu.key.startsWith("child:")) {
      const sid = menu.key.slice(6);
      const folder = findFolder(sid);
      const server = byId.get(sid);
      return (
        <>
          <button onClick={() => { handleOpen(sid); close(); }}>Open{server ? ` ${server.name}` : ""}</button>
          {folder && <button onClick={() => apply(moveBy(cloneItems(items), sid, -1, folder.id))}>Move up in folder</button>}
          {folder && <button onClick={() => apply(moveBy(cloneItems(items), sid, 1, folder.id))}>Move down in folder</button>}
          <button onClick={() => apply([...withoutServer(cloneItems(items), sid), { type: "server", id: sid }])}>Remove from folder</button>
        </>
      );
    }
    const sid = menu.key.slice(7);
    const server = byId.get(sid);
    if (!server) return null;
    return (
      <>
        <button onClick={() => { handleOpen(sid); close(); }}>Open</button>
        <button onClick={() => apply(moveBy(cloneItems(items), sid, -1))}>Move up</button>
        <button onClick={() => apply(moveBy(cloneItems(items), sid, 1))}>Move down</button>
        {folderList.length > 0 && <div className="fc-rail-menu-label">Move to folder</div>}
        {folderList.map((f) => (
          <button key={f.id} onClick={() => apply(moveIntoFolder(cloneItems(items), f.id, sid))}>
            <span className="fc-rail-menu-dot" style={{ background: f.color ?? FOLDER_COLORS[0] }} />{f.name}
          </button>
        ))}
        <button onClick={() => { setFolderDialog({ mode: "create", name: "", color: FOLDER_COLORS[0] }); close(); }}><FolderPlus size={13} /> New folder…</button>
      </>
    );
  }

  function findFolder(serverId: string): RailFolder | undefined {
    return folderList.find((f) => f.serverIds.includes(serverId));
  }

  // ----- drag & drop -----

  function dropOnServer(targetId: string, e: React.DragEvent, targetFolderId?: string) {
    if (!dragging) return;
    const after = e.clientY > (e.currentTarget as HTMLElement).getBoundingClientRect().top + (e.currentTarget as HTMLElement).getBoundingClientRect().height / 2;
    if (dragging.kind === "folder") {
      if (targetFolderId) return;
      const folder = folderList.find((f) => f.id === dragging.id);
      if (folder) apply(insertFolderAtServer(cloneItems(items), targetId, folder, after));
      return;
    }
    // server being dragged
    if (dragging.id === targetId) return;
    if (targetFolderId) {
      apply(reorderWithinFolder(cloneItems(items), targetFolderId, dragging.id, targetId, after));
    } else {
      apply(insertServerRelative(withoutServer(cloneItems(items), dragging.id), targetId, dragging.id, after));
    }
  }

  function dropOnFolder(folderId: string, e: React.DragEvent) {
    if (!dragging) return;
    if (dragging.kind === "server") {
      if (findFolder(dragging.id)?.id === folderId) return;
      apply(moveIntoFolder(cloneItems(items), folderId, dragging.id));
      return;
    }
    if (dragging.id === folderId) return;
    const moving = folderList.find((f) => f.id === dragging.id);
    if (!moving) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    apply(insertFolderRelative(cloneItems(items), folderId, moving, after));
  }

  function dropOnEnd(e: React.DragEvent) {
    e.preventDefault();
    if (!dragging) return;
    if (dragging.kind === "folder") {
      const moving = folderList.find((f) => f.id === dragging.id);
      if (moving) apply([...cloneItems(items).filter((it) => !(it.type === "folder" && it.folder.id === moving.id)), { type: "folder", folder: moving }]);
    } else if (findFolder(dragging.id)) {
      apply([...withoutServer(cloneItems(items), dragging.id), { type: "server", id: dragging.id }]);
    }
    setDragging(null);
    setDragOver(null);
  }

  function dropOnRailBackground(e: React.DragEvent) {
    if (!dragging || dragging.kind !== "server") return;
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    if (findFolder(dragging.id)) apply([...withoutServer(cloneItems(items), dragging.id), { type: "server", id: dragging.id }]);
    setDragging(null);
    setDragOver(null);
  }

  // ----- folders -----

  function createFolder(name: string, color: string) {
    const id = `f${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    const folders = [...org?.folders?.map((f) => ({ ...f, color: f.color ?? null })) ?? [], { id, name, color, collapsed: false, serverIds: [] }];
    saveOrg({
      layout: [...(org?.layout ?? []), `folder:${id}`],
      folders: folders.map((f) => ({ id: f.id, name: f.name, ...(f.color ? { color: f.color } : {}), collapsed: f.collapsed, serverIds: f.serverIds })),
      recent: org?.recent ?? [],
    }).catch(() => toast.error("Could not create the folder."));
  }

  function renameFolder(id: string, name: string, color: string) {
    const next = items.map((it): RailItem =>
      it.type === "folder" && it.folder.id === id
        ? { type: "folder", folder: { ...it.folder, name, color } }
        : it,
    );
    apply(next);
  }

  // ----- overflow switcher data -----

  const recentIds = (org?.recent ?? []).filter((s) => byId.has(s));
  const overflowVisible = communities.length > OVERFLOW_THRESHOLD;

  const term = overflowQuery.trim().toLowerCase();
  const matches = (c: RailCommunity) => !term || c.name.toLowerCase().includes(term);

  function closeOverflow() {
    setOverflowOpen(false);
    setOverflowQuery("");
  }

  // Close menus on Escape / outside click.
  const railRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (railRef.current && !railRef.current.contains(e.target as Node)) {
        setMenu(null);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setMenu(null);
        setOverflowOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  function ServerIcon({ server }: { server: RailCommunity }) {
    return server.iconUrl
      ? <img src={server.iconUrl} alt="" className="fc-rail-img" />
      : <Fragment>{initialsOf(server.name)}</Fragment>;
  }

  return (
    <div className="fc-rail-servers" ref={railRef} onDragOver={(e) => dragging && e.preventDefault()} onDrop={dropOnRailBackground}>
      {items.map((it) => {
        if (it.type === "folder") {
          const folder = it.folder;
          const menuKey = `folder:${folder.id}`;
          return (
            <Fragment key={menuKey}>
              <div
                className={`fc-rail-item ${dragOver === menuKey ? "drag-over" : ""}`}
                draggable
                onDragStart={() => setDragging({ kind: "folder", id: folder.id })}
                onDragEnd={() => { setDragging(null); setDragOver(null); }}
                onDragOver={(e) => { e.preventDefault(); setDragOver(menuKey); }}
                onDragLeave={() => setDragOver((v) => (v === menuKey ? null : v))}
                onDrop={(e) => { e.preventDefault(); dropOnFolder(folder.id, e); setDragging(null); setDragOver(null); }}
              >
                <div
                  className={`fc-rail-folder ${folder.collapsed ? "" : "open"} ${communityId && folder.serverIds.includes(communityId) ? "contains-active" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${folder.name} folder, ${folder.collapsed ? "collapsed" : "expanded"}`}
                  aria-expanded={!folder.collapsed}
                  style={{ borderColor: folder.color ?? undefined }}
                  onClick={() => apply(moveByToggle(items, folder.id))}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); apply(moveByToggle(items, folder.id)); } }}
                >
                  <span className="fc-rail-folder-grid">
                    {folder.serverIds.slice(0, 4).map((sid) => {
                      const s = byId.get(sid);
                      return s ? (
                        <span key={sid} className="fc-rail-folder-mini" style={{ background: folder.color ?? undefined }}>
                          <ServerIcon server={s} />
                        </span>
                      ) : null;
                    })}
                    {folder.serverIds.length === 0 && <span className="fc-rail-folder-empty">＋</span>}
                  </span>
                </div>
                <button
                  type="button"
                  className="fc-rail-item-menu"
                  aria-label={`Options for folder ${folder.name}`}
                  onClick={(e) => { e.stopPropagation(); openMenu(menuKey, e); }}
                >⋯</button>
              </div>

              {!folder.collapsed && folder.serverIds.map((sid) => {
                const server = byId.get(sid);
                if (!server) return null;
                const key = `child:${sid}`;
                return (
                  <div
                    key={key}
                    className={`fc-rail-item fc-rail-item-nested ${dragOver === key ? "drag-over" : ""}`}
                    draggable
                    onDragStart={() => setDragging({ kind: "server", id: sid, fromFolder: folder.id })}
                    onDragEnd={() => { setDragging(null); setDragOver(null); }}
                    onDragOver={(e) => { e.preventDefault(); setDragOver(key); }}
                    onDragLeave={() => setDragOver((v) => (v === key ? null : v))}
                    onDrop={(e) => { e.preventDefault(); dropOnServer(sid, e, folder.id); setDragging(null); setDragOver(null); }}
                  >
                    <div
                      className={`fc-rail-server ${communityId === sid ? "selected" : ""}`}
                      role="button"
                      tabIndex={0}
                      title={server.name}
                      aria-label={server.name}
                      aria-current={communityId === sid}
                      onClick={() => handleOpen(sid)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleOpen(sid); } }}
                    >
                      <ServerIcon server={server} />
                    </div>
                    <button
                      type="button"
                      className="fc-rail-item-menu"
                      aria-label={`Options for ${server.name}`}
                      onClick={(e) => { e.stopPropagation(); openMenu(key, e); }}
                    >⋯</button>
                  </div>
                );
              })}
            </Fragment>
          );
        }

        // top-level server
        const server = byId.get(it.id);
        if (!server) return null;
        const menuKey = `server:${it.id}`;
        return (
          <div
            key={menuKey}
            className={`fc-rail-item ${dragOver === menuKey ? "drag-over" : ""}`}
            draggable
            onDragStart={() => setDragging({ kind: "server", id: it.id })}
            onDragEnd={() => { setDragging(null); setDragOver(null); }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(menuKey); }}
            onDragLeave={() => setDragOver((v) => (v === menuKey ? null : v))}
            onDrop={(e) => { e.preventDefault(); dropOnServer(it.id, e); setDragging(null); setDragOver(null); }}
          >
            <div
              className={`fc-rail-server ${communityId === it.id ? "selected" : ""}`}
              role="button"
              tabIndex={0}
              title={server.name}
              aria-label={server.name}
              aria-current={communityId === it.id}
              onClick={() => handleOpen(it.id)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleOpen(it.id); } }}
            >
              <ServerIcon server={server} />
            </div>
            <button
              type="button"
              className="fc-rail-item-menu"
              aria-label={`Options for ${server.name}`}
              onClick={(e) => { e.stopPropagation(); openMenu(menuKey, e); }}
            >⋯</button>
          </div>
        );
      })}

      {/* Drop here to take a server out of a folder / move to the end. */}
      <div
        className={`fc-rail-drop-end ${dragging ? "active" : ""}`}
        onDragOver={(e) => { if (dragging) { e.preventDefault(); setDragOver("end"); } }}
        onDragLeave={() => setDragOver((v) => (v === "end" ? null : v))}
        onDrop={dropOnEnd}
        aria-hidden="true"
      />

      <button className="fc-rail-server add" title="Create a community" aria-label="Create a community" onClick={onCreate}><Plus size={20} /></button>
      <button className="fc-rail-server add" title="Join with invite" aria-label="Join with invite" onClick={onJoin}><Hash size={18} /></button>
      <button
        className="fc-rail-server add"
        title="New folder"
        aria-label="Create a server folder"
        onClick={() => setFolderDialog({ mode: "create", name: "", color: FOLDER_COLORS[Math.floor(Math.random() * FOLDER_COLORS.length)] })}
      ><FolderPlus size={19} /></button>

      {overflowVisible && (
        <div className="fc-rail-overflow">
          <button
            className={`fc-rail-server add ${overflowOpen ? "selected" : ""}`}
            title="All servers"
            aria-label="All servers"
            aria-expanded={overflowOpen}
            onClick={() => setOverflowOpen((v) => !v)}
          >
            <span className="fc-rail-overflow-label">Servers<ChevronDown size={12} /></span>
          </button>
        </div>
      )}

      {overflowOpen && (
        <>
          <div className="fc-servers-overflow-backdrop" onClick={closeOverflow} />
          <div className="fc-servers-overflow-panel" role="dialog" aria-label="Server switcher">
            <div className="fc-servers-overflow-head">
              <strong>Servers</strong>
              <button aria-label="Close server switcher" onClick={closeOverflow}><X size={15} /></button>
            </div>
            <div className="fc-servers-overflow-search">
              <Search size={14} />
              <input
                autoFocus
                value={overflowQuery}
                onChange={(e) => setOverflowQuery(e.target.value)}
                placeholder="Search servers"
                aria-label="Search servers"
              />
            </div>

            <div className="fc-servers-overflow-body">
              {recentIds.length > 0 && !term && (
                <div className="fc-servers-overflow-section">
                  <span className="fc-servers-overflow-title">Recently visited</span>
                  {recentIds.map((sid) => {
                    const s = byId.get(sid);
                    if (!s) return null;
                    return (
                      <button key={`r-${sid}`} className={`fc-servers-overflow-row ${communityId === sid ? "current" : ""}`} onClick={() => { handleOpen(sid); closeOverflow(); }}>
                        <span className="fc-sidebar-community-icon"><ServerIcon server={s} /></span>
                        <span className="fc-servers-overflow-name">{s.name}</span>
                        {communityId === sid && <Check size={13} />}
                      </button>
                    );
                  })}
                </div>
              )}

              {items.map((it) => {
                if (it.type === "folder") {
                  const shown = it.folder.serverIds.map((sid) => byId.get(sid)).filter((s): s is RailCommunity => Boolean(s)).filter(matches);
                  if (shown.length === 0) return null;
                  return (
                    <div key={`of-${it.folder.id}`} className="fc-servers-overflow-section">
                      <span className="fc-servers-overflow-title" style={{ color: it.folder.color ?? undefined }}>{it.folder.name}</span>
                      {shown.map((s) => (
                        <button key={s._id} className={`fc-servers-overflow-row ${communityId === s._id ? "current" : ""}`} onClick={() => { handleOpen(s._id); closeOverflow(); }}>
                          <span className="fc-sidebar-community-icon"><ServerIcon server={s} /></span>
                          <span className="fc-servers-overflow-name">{s.name}</span>
                          {communityId === s._id && <Check size={13} />}
                        </button>
                      ))}
                    </div>
                  );
                }
                const server = byId.get(it.id);
                if (!server || !matches(server)) return null;
                return (
                  <div key={`os-${it.id}`} className="fc-servers-overflow-section">
                    <button className={`fc-servers-overflow-row ${communityId === it.id ? "current" : ""}`} onClick={() => { handleOpen(it.id); closeOverflow(); }}>
                      <span className="fc-sidebar-community-icon"><ServerIcon server={server} /></span>
                      <span className="fc-servers-overflow-name">{server.name}</span>
                      {communityId === it.id && <Check size={13} />}
                    </button>
                  </div>
                );
              })}
              {term && items.every((it) => it.type === "folder"
                ? it.folder.serverIds.map((sid) => byId.get(sid)).filter(Boolean).every((s) => !matches(s as RailCommunity))
                : !matches(byId.get(it.id) as RailCommunity)) && (
                <p className="fc-servers-overflow-empty">No servers match “{overflowQuery}”.</p>
              )}
            </div>
          </div>
        </>
      )}

      {/* Shared context menu (fixed so the scrolling rail can't clip it). */}
      {menu && (
        <div className="fc-menu fc-rail-menu" role="menu" style={{ position: "fixed", top: menu.top, left: menu.left, right: "auto" }}>
          {renderMenuItems()}
        </div>
      )}

      {/* Folder name / color dialog */}
      <Dialog open={folderDialog !== null} onOpenChange={(open) => { if (!open) setFolderDialog(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{folderDialog?.mode === "rename" ? "Rename folder" : "New folder"}</DialogTitle>
          </DialogHeader>
          {folderDialog && (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Folder name</label>
                <Input
                  autoFocus
                  maxLength={40}
                  value={folderDialog.name}
                  placeholder="Gaming, Friends, Coding…"
                  onChange={(e) => setFolderDialog({ ...folderDialog, name: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter" && folderDialog.name.trim()) { e.preventDefault(); commitFolderDialog(folderDialog, createFolder, renameFolder); setFolderDialog(null); } }}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Color</label>
                <div className="flex flex-wrap gap-2">
                  {FOLDER_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={`Color ${c}`}
                      className={`size-7 rounded-full ${folderDialog.color === c ? "ring-2 ring-white/80" : ""}`}
                      style={{ background: c }}
                      onClick={() => setFolderDialog({ ...folderDialog, color: c })}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setFolderDialog(null)}>Cancel</Button>
            <Button
              disabled={!folderDialog?.name.trim()}
              onClick={() => { if (folderDialog) { commitFolderDialog(folderDialog, createFolder, renameFolder); setFolderDialog(null); } }}
            >
              {folderDialog?.mode === "rename" ? "Save" : "Create folder"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function commitFolderDialog(
  dialog: { mode: "create" | "rename"; id?: string; name: string; color: string },
  create: (name: string, color: string) => void,
  rename: (id: string, name: string, color: string) => void,
) {
  const name = dialog.name.trim();
  if (!name) return;
  if (dialog.mode === "rename" && dialog.id) rename(dialog.id, name, dialog.color);
  else create(name, dialog.color);
}

/** Toggle a folder's collapsed flag inside the current item list. */
function moveByToggle(items: RailItem[], folderId: string): RailItem[] {
  return items.map((it) =>
    it.type === "folder" && it.folder.id === folderId
      ? { type: "folder" as const, folder: { ...it.folder, collapsed: !it.folder.collapsed } }
      : it,
  );
}
