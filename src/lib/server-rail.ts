/**
 * Pure helpers for the per-user server rail (left icon column).
 *
 * They operate on plain data so the drag-and-drop math — reordering, grouping
 * servers into folders, moving in/out of folders — is unit-testable without a
 * browser. `ServerRail.tsx` owns the pointer gesture and persistence; every
 * mutation goes through one of these functions and is then saved server-side.
 */

export type RailFolder = {
  id: string;
  name: string;
  color: string | null;
  collapsed: boolean;
  serverIds: string[];
};

export type RailItem =
  | { type: "folder"; folder: RailFolder }
  | { type: "server"; id: string };

/** Unique folder id (time + randomness, so two drags in the same ms differ). */
export function newFolderId(): string {
  return `f${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Deep-ish clone so React always sees a new array/objects after a change. */
export function cloneItems(list: RailItem[]): RailItem[] {
  return list.map((it) =>
    it.type === "folder"
      ? { type: "folder" as const, folder: { ...it.folder, serverIds: [...it.folder.serverIds] } }
      : { type: "server" as const, id: it.id },
  );
}

/** Remove a server from the rail entirely (top level or out of a folder). */
export function withoutServer(list: RailItem[], serverId: string): RailItem[] {
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

export function insertServerRelative(list: RailItem[], targetId: string, serverId: string, after: boolean): RailItem[] {
  const idx = list.findIndex((it) => it.type === "server" && it.id === targetId);
  const node: RailItem = { type: "server", id: serverId };
  if (idx === -1) return [...list, node];
  const at = after ? idx + 1 : idx;
  return [...list.slice(0, at), node, ...list.slice(at)];
}

export function insertFolderRelative(list: RailItem[], targetFolderId: string, moving: RailFolder, after: boolean): RailItem[] {
  const stripped = list.filter((it) => !(it.type === "folder" && it.folder.id === moving.id));
  const idx = stripped.findIndex((it) => it.type === "folder" && it.folder.id === targetFolderId);
  const node: RailItem = { type: "folder", folder: { ...moving, serverIds: [...moving.serverIds] } };
  if (idx === -1) return [...stripped, node];
  const at = after ? idx + 1 : idx;
  return [...stripped.slice(0, at), node, ...stripped.slice(at)];
}

export function insertFolderAtServer(list: RailItem[], targetServerId: string, moving: RailFolder, after: boolean): RailItem[] {
  const stripped = list.filter((it) => !(it.type === "folder" && it.folder.id === moving.id));
  const idx = stripped.findIndex((it) => it.type === "server" && it.id === targetServerId);
  const node: RailItem = { type: "folder", folder: { ...moving, serverIds: [...moving.serverIds] } };
  if (idx === -1) return [...stripped, node];
  const at = after ? idx + 1 : idx;
  return [...stripped.slice(0, at), node, ...stripped.slice(at)];
}

/** Append a server to a folder (and expand it so the drop is visible). */
export function moveIntoFolder(list: RailItem[], folderId: string, serverId: string): RailItem[] {
  return withoutServer(list, serverId).map((it) =>
    it.type === "folder" && it.folder.id === folderId
      ? { type: "folder", folder: { ...it.folder, collapsed: false, serverIds: [...it.folder.serverIds, serverId] } }
      : it,
  );
}

/** Insert a server at a precise position inside a folder. */
export function reorderWithinFolder(
  list: RailItem[],
  folderId: string,
  serverId: string,
  targetServerId: string,
  after: boolean,
): RailItem[] {
  return list.map((it) => {
    if (it.type !== "folder" || it.folder.id !== folderId) return it;
    const ids = it.folder.serverIds.filter((s) => s !== serverId);
    const idx = ids.indexOf(targetServerId);
    const at = idx === -1 ? ids.length : after ? idx + 1 : idx;
    return { type: "folder", folder: { ...it.folder, serverIds: [...ids.slice(0, at), serverId, ...ids.slice(at)] } };
  });
}

/**
 * The headline gesture: drag one server directly onto another server and a new
 * folder appears holding BOTH of them. The folder takes the target server's
 * place in the rail, so the layout stays where the user was looking.
 */
export function groupServersIntoFolder(
  list: RailItem[],
  draggedId: string,
  targetId: string,
  name: string,
  color: string | null,
): RailItem[] {
  const node: RailItem = {
    type: "folder",
    folder: { id: newFolderId(), name, color, collapsed: false, serverIds: [draggedId, targetId] },
  };
  const out: RailItem[] = [];
  let inserted = false;
  for (const it of list) {
    if (!inserted && it.type === "server" && it.id === targetId) {
      out.push(node);
      inserted = true;
      continue;
    }
    if (it.type === "server") {
      // Neither server may survive as a loose rail entry.
      if (it.id === draggedId || it.id === targetId) continue;
      out.push(it);
      continue;
    }
    // Nor may either be left behind inside another folder.
    out.push({
      type: "folder",
      folder: { ...it.folder, serverIds: it.folder.serverIds.filter((s) => s !== draggedId && s !== targetId) },
    });
  }
  if (!inserted) out.push(node);
  return out;
}

/** Move a top-level item (folder or server) up/down the rail. */
export function moveBy(list: RailItem[], key: string, delta: number, inFolderId?: string): RailItem[] {
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
  const isFolder = key.startsWith("folder:");
  const id = isFolder ? key.slice(7) : key;
  const idx = list.findIndex((it) => (isFolder ? it.type === "folder" && it.folder.id === id : it.type === "server" && it.id === id));
  const j = idx + delta;
  if (idx < 0 || j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[idx], next[j]] = [next[j], next[idx]];
  return next;
}

/** Delete a folder, releasing its servers back into the rail (never deleted). */
export function deleteFolderFromList(list: RailItem[], folderId: string): RailItem[] {
  const released: string[] = [];
  const out: RailItem[] = [];
  for (const it of list) {
    if (it.type === "folder" && it.folder.id === folderId) released.push(...it.folder.serverIds);
    else out.push(it);
  }
  return [...out, ...released.map((id): RailItem => ({ type: "server", id }))];
}

/** Toggle a folder's collapsed flag inside the current item list. */
export function moveByToggle(items: RailItem[], folderId: string): RailItem[] {
  return items.map((it) =>
    it.type === "folder" && it.folder.id === folderId
      ? { type: "folder" as const, folder: { ...it.folder, collapsed: !it.folder.collapsed } }
      : it,
  );
}
