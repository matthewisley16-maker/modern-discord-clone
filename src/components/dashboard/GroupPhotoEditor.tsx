import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { ImagePlus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Avatar, GroupIcon } from "./ui";
import {
  GROUP_PHOTO_ACCEPT,
  GROUP_PHOTO_MAX_ZOOM,
  GROUP_PHOTO_MIN_ZOOM,
  clampOffset,
  coverGeometry,
  decodeImage,
  groupPhotoErrorMessage,
  photoValidationError,
  renderGroupPhoto,
  type DecodedImage,
} from "@/lib/group-photo";

/** Side of the square crop stage, in CSS pixels. */
const STAGE = 176;

/**
 * Group chat photo editor (Discord-style group icon).
 *
 * The uploaded file is stored in Convex file storage and referenced from the
 * conversation itself (`dmConversations.iconStorageId`) by `dms.setGroupPhoto`,
 * which enforces the group-manager permission on the server. Nothing is
 * uploaded until Save is pressed: while the user is framing the crop, only a
 * local `blob:` URL exists — so a Cancel leaves no orphaned file behind, and no
 * temporary browser URL is ever stored as the group's picture.
 *
 * The framing comes from `@/lib/group-photo`, which the same preview and the
 * saved 512x512 square both use; the drag/zoom geometry can therefore never
 * disagree with the uploaded image.
 */
export default function GroupPhotoEditor({
  conversationId,
  name,
  iconUrl,
  canEdit,
}: {
  conversationId: Id<"dmConversations">;
  name: string;
  iconUrl?: string | null;
  canEdit: boolean;
}) {
  const setGroupPhoto = useMutation(api.dms.setGroupPhoto);
  const generateUploadUrl = useMutation(api.uploads.generateUploadUrl);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragOrigin = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const [picked, setPicked] = useState<DecodedImage | null>(null);
  const [zoom, setZoom] = useState(GROUP_PHOTO_MIN_ZOOM);
  const [offset, setOffset] = useState({ dx: 0, dy: 0 });
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  // The geometry of the picked image at the current zoom: how big it is drawn
  // and how far it may be dragged before an edge would show.
  const geometry = useMemo(
    () => (picked ? coverGeometry(picked.width, picked.height, STAGE, zoom) : null),
    [picked, zoom],
  );
  // Always render the CLAMPED offset, so an image can never be dragged past its
  // own edge (which would show an empty corner).
  const shown = geometry ? clampOffset(offset, geometry) : offset;

  // Only one object URL exists at a time; release it as soon as it is replaced
  // or the panel closes.
  const pickedUrl = picked?.url;
  useEffect(() => {
    if (!pickedUrl) return;
    return () => URL.revokeObjectURL(pickedUrl);
  }, [pickedUrl]);

  /** Reset everything the editor holds in memory (no backend call). */
  function clearPicked() {
    setPicked(null);
    setZoom(GROUP_PHOTO_MIN_ZOOM);
    setOffset({ dx: 0, dy: 0 });
    dragOrigin.current = null;
    setDragging(false);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function chooseFile(file: File | undefined) {
    if (!file) return;
    const problem = photoValidationError(file);
    if (problem) {
      toast.error(problem);
      return;
    }
    const url = URL.createObjectURL(file);
    try {
      // Decoding here (rather than on Save) is what lets the stage know the
      // image's real aspect ratio before the user starts framing it.
      const decoded = await decodeImage(url);
      setPicked(decoded);
      setZoom(GROUP_PHOTO_MIN_ZOOM);
      setOffset({ dx: 0, dy: 0 });
    } catch (err) {
      URL.revokeObjectURL(url);
      toast.error(groupPhotoErrorMessage(err, "That image couldn't be opened."));
    }
  }

  async function save() {
    if (!picked || busy) return;
    setBusy(true);
    try {
      // 1. Bake the chosen square into a 512px image.
      const blob = await renderGroupPhoto(picked, { zoom, offset: shown });
      // 2. Upload the bytes to storage.
      const uploadUrl = await generateUploadUrl({});
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": blob.type || "image/webp" },
        body: blob,
      });
      if (!response.ok) throw new Error("The upload failed — please try again.");
      const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
      // 3. Point the conversation at it. `dms.setGroupPhoto` re-checks the
      //    permission and the image server-side before anything is stored.
      await setGroupPhoto({ conversationId, storageId });
      clearPicked();
      toast.success("Group photo updated.");
    } catch (err) {
      toast.error(groupPhotoErrorMessage(err, "Could not save the group photo."));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    try {
      await setGroupPhoto({ conversationId, storageId: null });
      clearPicked();
      toast.success("Group photo removed.");
    } catch (err) {
      toast.error(groupPhotoErrorMessage(err, "Could not remove the group photo."));
    } finally {
      setBusy(false);
    }
  }

  // --- drag to reposition -------------------------------------------------
  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!geometry) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragOrigin.current = { x: event.clientX, y: event.clientY, dx: shown.dx, dy: shown.dy };
    setDragging(true);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const origin = dragOrigin.current;
    if (!origin || !geometry) return;
    setOffset(
      clampOffset(
        { dx: origin.dx + (event.clientX - origin.x), dy: origin.dy + (event.clientY - origin.y) },
        geometry,
      ),
    );
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (dragOrigin.current) {
      dragOrigin.current = null;
      setDragging(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }

  return (
    <div className="fc-group-photo">
      <div className="fc-group-photo-current">
        {picked && geometry ? (
          <div
            className={`fc-group-photo-stage ${dragging ? "dragging" : ""}`}
            style={{ width: STAGE, height: STAGE }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            role="img"
            aria-label={`Reposition the new photo for ${name}`}
          >
            <img
              src={picked.url}
              alt=""
              draggable={false}
              style={{
                width: geometry.width,
                height: geometry.height,
                left: "50%",
                top: "50%",
                transform: `translate(-50%, -50%) translate(${shown.dx}px, ${shown.dy}px)`,
              }}
            />
          </div>
        ) : (
          // The stored photo (or the default group icon) — the same image the
          // conversation list and the chat header show.
          <Avatar
            name={name}
            size={72}
            color="violet"
            url={iconUrl}
            fallback={<GroupIcon avatarSize={72} />}
          />
        )}
        <div className="fc-group-photo-meta">
          <strong>{name}</strong>
          <small>
            {picked
              ? "Drag the image to reposition it, then save."
              : canEdit
                ? "This is the photo shown beside this group everywhere in Freecord."
                : "Only the group owner or an admin can change this photo."}
          </small>
        </div>
      </div>

      {picked && (
        <label className="fc-group-photo-zoom">
          <span>Zoom</span>
          <input
            type="range"
            min={GROUP_PHOTO_MIN_ZOOM}
            max={GROUP_PHOTO_MAX_ZOOM}
            step={0.05}
            value={zoom}
            disabled={busy}
            aria-label="Zoom the group photo"
            onChange={(event) => {
              const next = Number(event.target.value);
              setZoom(next);
              // Re-clamp immediately: zooming out shrinks how far the image may
              // be dragged, and a stale offset would push it off-centre.
              if (picked) {
                const nextGeometry = coverGeometry(picked.width, picked.height, STAGE, next);
                setOffset((current) => clampOffset(current, nextGeometry));
              }
            }}
          />
        </label>
      )}

      {canEdit && (
        <div className="fc-group-photo-actions">
          <input
            ref={fileInput}
            type="file"
            accept={GROUP_PHOTO_ACCEPT}
            hidden
            onChange={(event) => {
              void chooseFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          {!picked ? (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>
                <ImagePlus size={14} /> Edit Group Photo
              </Button>
              {iconUrl && (
                <Button variant="ghost" size="sm" disabled={busy} onClick={remove}>
                  <Trash2 size={14} /> Remove photo
                </Button>
              )}
            </>
          ) : (
            <>
              <Button size="sm" disabled={busy} onClick={save}>
                {busy ? "Saving…" : "Save"}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={clearPicked}>
                Cancel
              </Button>
            </>
          )}
          <span className="fc-group-photo-hint">PNG, JPG, JPEG or WebP · up to 5 MB</span>
        </div>
      )}
    </div>
  );
}
