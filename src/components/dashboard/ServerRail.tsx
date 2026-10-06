import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { initialsOf } from "@/components/dashboard/ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  Check, ChevronDown, Folder, FolderOpen, FolderPlus, Hash, Plus, Search, X,
} from "lucide-react";
import {
  cloneItems,
  deleteFolderFromList,
  groupServersIntoFolder,
  insertFolderAtServer,
  insertFolderRelative,
  insertServerRelative,
  moveBy,
  moveByToggle,
  moveIntoFolder,
  newFolderId,
  reorderWithinFolder,
  withoutServer,
  type RailFolder,
  type RailItem,
} from "@/lib/server-rail";

export type RailCommunity = { _id: string; name: string; iconUrl?: string | null };

/** Above this many servers the rail also offers a searchable overflow switcher. */
const OVERFLOW_THRESHOLD = 10;
const FOLDER_COLORS = ["#8b5cf6", "#f0616d", "#3ba55d", "#faa61a", "#00a8fc", "#eb459e", "#5865f2", "#9b59b6"];

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

  /**
   * Pointer-based drag state. `started` flips true only after the pointer has
   * moved past a small threshold, so a plain tap still selects/opens the item.
   * The ref is the live source of truth (handlers stay stable); the state copy
   * exists purely so the UI can render ghost/highlight feedback.
   */
  type DragInfo = {
    kind: "server" | "folder";
    id: string;
    fromFolder?: string;
    pointerId: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    started: boolean;
  };
  type DropTarget = { key: string; position: "before" | "after" | "center" };

  const dragRef = useRef<DragInfo | null>(null);
  const targetRef = useRef<DropTarget | null>(null);
  const justDraggedRef = useRef(false);
  const [drag, setDrag] = useState<DragInfo | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
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

  // ----- pointer drag & drop (works with mouse, touch and pen) -----

  /**
   * Begin a possible drag. Nothing moves until the pointer travels past the
   * threshold, so ordinary taps/clicks are untouched.
   *
   * NOTE: capture is deliberately NOT taken here. `setPointerCapture` retargets
   * the follow-up `click` to the capturing rail item, which would stop the
   * community icon/name (a child element) from ever receiving its click. We
   * only capture once a real drag starts, so a plain tap still opens the
   * community while a drag keeps receiving pointer events.
   */
  function startDrag(e: React.PointerEvent, kind: "server" | "folder", id: string, fromFolder?: string) {
    if ((e.target as HTMLElement).closest(".fc-rail-item-menu")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // A fresh gesture always clears the post-drag click guard, so a tap that
    // follows an aborted drag still opens the item.
    justDraggedRef.current = false;
    dragRef.current = {
      kind, id, fromFolder,
      pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      x: e.clientX, y: e.clientY,
      started: false,
    };
  }

  /**
   * Track the pointer. Once dragging, the element under the pointer decides the
   * drop target: the middle of a server means "group into a folder", the top or
   * bottom edge means "insert before/after".
   */
  function moveDrag(e: React.PointerEvent) {
    const s = dragRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    s.x = e.clientX;
    s.y = e.clientY;
    if (!s.started) {
      if (Math.hypot(s.x - s.startX, s.y - s.startY) < 5) return;
      s.started = true;
      justDraggedRef.current = true;
      setMenu(null);
      setDrag({ ...s });
      // Capture only now that this is a genuine drag, so pointermove events
      // keep flowing to this item even when the cursor/finger leaves it.
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* capture unsupported */ }
    }
    e.preventDefault();

    const under = document.elementFromPoint(s.x, s.y) as HTMLElement | null;
    const el = under?.closest?.("[data-rail-key]") as HTMLElement | null;
    const key = el?.dataset.railKey ?? null;
    let next: DropTarget | null = null;
    if (el && key) {
      const rect = el.getBoundingClientRect();
      const rel = rect.height > 0 ? (s.y - rect.top) / rect.height : 0.5;
      let position: "before" | "after" | "center";
      if (key.startsWith("server:") && s.kind === "server") {
        position = rel < 0.3 ? "before" : rel > 0.7 ? "after" : "center";
      } else {
        position = rel > 0.5 ? "after" : "before";
      }
      next = { key, position };
    }
    const prev = targetRef.current;
    targetRef.current = next;
    if (prev?.key !== next?.key || prev?.position !== next?.position) setDropTarget(next);
  }

  /** Finish the gesture: apply the move if the pointer actually dragged. */
  function endDrag(e: React.PointerEvent) {
    const s = dragRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    dragRef.current = null;
    const target = targetRef.current;
    targetRef.current = null;
    const started = s.started;
    setDrag(null);
    setDropTarget(null);
    if (!started) return;
    // Suppress the click that follows a real drag so opening a server or
    // toggling a folder only happens on a deliberate tap. Each click guard
    // clears the flag again, and the next pointerdown clears it too, so it can
    // never swallow a genuine tap.
    justDraggedRef.current = true;
    if (target) performDrop(s, target);
  }

  function cancelDrag(e: React.PointerEvent) {
    const s = dragRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    dragRef.current = null;
    targetRef.current = null;
    setDrag(null);
    setDropTarget(null);
  }

  function performDrop(s: DragInfo, target: DropTarget) {
    const list = cloneItems(items);
    const { key, position } = target;
    const after = position === "after";

    if (s.kind === "folder") {
      const moving = folderList.find((f) => f.id === s.id);
      if (!moving) return;
      if (key.startsWith("folder:") && key.slice(7) !== s.id) {
        apply(insertFolderRelative(list, key.slice(7), moving, after));
      } else if (key.startsWith("server:")) {
        apply(insertFolderAtServer(list, key.slice(7), moving, after));
      } else if (key === "end") {
        apply([
          ...list.filter((it) => !(it.type === "folder" && it.folder.id === s.id)),
          { type: "folder", folder: moving },
        ]);
      }
      return;
    }

    // Dragging a server.
    if (key.startsWith("folder:")) {
      const folderId = key.slice(7);
      if (findFolder(s.id)?.id === folderId) return;
      apply(moveIntoFolder(list, folderId, s.id));
      return;
    }
    if (key.startsWith("child:")) {
      const targetServerId = key.slice(6);
      if (targetServerId === s.id) return;
      const folderId = findFolder(targetServerId)?.id;
      if (!folderId) return;
      if (findFolder(s.id)?.id === folderId) {
        apply(reorderWithinFolder(list, folderId, s.id, targetServerId, after));
      } else {
        apply(reorderWithinFolder(moveIntoFolder(list, folderId, s.id), folderId, s.id, targetServerId, after));
      }
      return;
    }
    if (key.startsWith("server:")) {
      const targetServerId = key.slice(7);
      if (targetServerId === s.id) return;
      if (position === "center") {
        // Drag a server directly onto another server → auto-create a folder
        // holding both, using a sensible default name the user can rename.
        apply(groupServersIntoFolder(list, s.id, targetServerId, "New Folder", FOLDER_COLORS[Math.floor(Math.random() * FOLDER_COLORS.length)]));
      } else {
        apply(insertServerRelative(withoutServer(list, s.id), targetServerId, s.id, after));
      }
      return;
    }
    if (key === "end") {
      apply([...withoutServer(list, s.id), { type: "server", id: s.id }]);
    }
  }

  // ----- folders -----

  function createFolder(name: string, color: string) {
    const id = newFolderId();
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
    <div className={`fc-rail-servers ${drag?.started ? "is-dragging" : ""}`} ref={railRef}>
      {items.map((it) => {
        if (it.type === "folder") {
          const folder = it.folder;
          const menuKey = `folder:${folder.id}`;
          return (
            <Fragment key={menuKey}>
              <div
                data-rail-key={menuKey}
                className={`fc-rail-item ${dropTarget?.key === menuKey ? "drag-over" : ""} ${drag?.started && drag.kind === "folder" && drag.id === folder.id ? "is-dragged" : ""}`}
                onPointerDown={(e) => startDrag(e, "folder", folder.id)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={cancelDrag}
              >
                <div
                  className={`fc-rail-folder ${folder.collapsed ? "" : "open"} ${communityId && folder.serverIds.includes(communityId) ? "contains-active" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${folder.name} folder, ${folder.collapsed ? "collapsed" : "expanded"}, ${folder.serverIds.length} servers`}
                  aria-expanded={!folder.collapsed}
                  title={folder.name}
                  style={{ borderColor: folder.color ?? undefined }}
                  onClick={() => { if (justDraggedRef.current) { justDraggedRef.current = false; return; } apply(moveByToggle(items, folder.id)); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); apply(moveByToggle(items, folder.id)); } }}
                >
                  {folder.collapsed
                    ? <Folder size={20} className="fc-rail-folder-glyph" style={{ color: folder.color ?? undefined }} />
                    : <FolderOpen size={20} className="fc-rail-folder-glyph" style={{ color: folder.color ?? undefined }} />}
                  {folder.serverIds.length > 0 && <span className="fc-rail-folder-count">{folder.serverIds.length}</span>}
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
                    data-rail-key={key}
                    className={`fc-rail-item fc-rail-item-nested ${dropTarget?.key === key ? "drag-over" : ""} ${drag?.started && drag.kind === "server" && drag.id === sid ? "is-dragged" : ""}`}
                    onPointerDown={(e) => startDrag(e, "server", sid, folder.id)}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={cancelDrag}
                  >
                    <div
                      className={`fc-rail-server ${communityId === sid ? "selected" : ""}`}
                      role="button"
                      tabIndex={0}
                      title={server.name}
                      aria-label={server.name}
                      aria-current={communityId === sid}
                      onClick={() => { if (justDraggedRef.current) { justDraggedRef.current = false; return; } handleOpen(sid); }}
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
        const createFolderTarget = Boolean(
          drag?.started && drag.kind === "server" &&
          dropTarget?.key === menuKey && dropTarget.position === "center",
        );
        return (
          <div
            key={menuKey}
            data-rail-key={menuKey}
            className={`fc-rail-item ${dropTarget?.key === menuKey ? "drag-over" : ""} ${createFolderTarget ? "drag-create-folder" : ""} ${drag?.started && drag.kind === "server" && drag.id === it.id ? "is-dragged" : ""}`}
            onPointerDown={(e) => startDrag(e, "server", it.id)}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={cancelDrag}
          >
            <div
              className={`fc-rail-server ${communityId === it.id ? "selected" : ""}`}
              role="button"
              tabIndex={0}
              title={server.name}
              aria-label={server.name}
              aria-current={communityId === it.id}
              onClick={() => { if (justDraggedRef.current) { justDraggedRef.current = false; return; } handleOpen(it.id); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleOpen(it.id); } }}
            >
              <ServerIcon server={server} />
            </div>
            {createFolderTarget && <span className="fc-rail-drop-hint" aria-hidden="true">Create Folder</span>}
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
        data-rail-key="end"
        className={`fc-rail-drop-end ${drag?.started ? "active" : ""} ${dropTarget?.key === "end" ? "drag-over" : ""}`}
        aria-hidden="true"
      />

      <button className="fc-rail-server add" title="Create a community" aria-label="Create a community" onClick={onCreate}><Plus size={20} /></button>
      <button className="fc-rail-server add" title="Join with invite" aria-label="Join with invite" onClick={onJoin}><Hash size={18} /></button>

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

      {/* Floating drag preview that follows the pointer. */}
      {drag?.started && (() => {
        const s = drag.kind === "server" ? byId.get(drag.id) : undefined;
        return (
          <div className="fc-rail-drag-ghost" style={{ left: drag.x, top: drag.y }} aria-hidden="true">
            {drag.kind === "folder"
              ? <Folder size={20} />
              : s?.iconUrl
                ? <img src={s.iconUrl} alt="" />
                : <span>{initialsOf(s?.name ?? "")}</span>}
          </div>
        );
      })()}

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
