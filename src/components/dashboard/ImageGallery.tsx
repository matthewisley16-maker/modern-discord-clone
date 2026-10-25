import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, ImageOff, X, ZoomIn, ZoomOut } from "lucide-react";
import MediaAttachment, { downloadFile } from "./MediaAttachment";
import {
  clampGalleryIndex,
  galleryCounter,
  galleryLayout,
  galleryOverflowLabel,
  galleryPreviewCount,
  splitMessageAttachments,
  stepGalleryIndex,
  type GalleryAsset,
} from "@/lib/message-gallery";

/**
 * A message's image attachments, grouped.
 *
 * - One image keeps the existing single preview (unchanged).
 * - Two or more become a compact grid; with more than four the last tile carries
 *   a "+N more" overlay, so a big upload can never make the message enormous.
 * - Non-image attachments (audio, files) keep their own existing rendering.
 * - Clicking any visible tile opens the gallery at that image, with Previous /
 *   Next, a counter, keyboard arrows/Escape, zoom, swipe on touch and a download
 *   button. Thumbnails are lazy-loaded; the viewer only loads the image shown.
 */
function GalleryThumb({ image }: { image: GalleryAsset }) {
  const [failed, setFailed] = useState(false);
  if (failed || !image.url) {
    return (
      <span className="fc-gallery-broken">
        <ImageOff size={18} />
        <span>{image.name}</span>
      </span>
    );
  }
  return (
    <img
      src={image.url}
      alt={image.name}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      draggable={false}
    />
  );
}

function GalleryLightbox({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: GalleryAsset[];
  index: number;
  onIndex: (next: number) => void;
  onClose: () => void;
}) {
  const total = images.length;
  const current = images[clampGalleryIndex(index, total)];
  // Both flags are keyed to the image they apply to, so moving to another image
  // starts fitted and healthy again without a state-resetting effect.
  const [zoomId, setZoomId] = useState<string | null>(null);
  const [brokenId, setBrokenId] = useState<string | null>(null);
  const zoomed = current ? zoomId === current._id : false;
  const broken = current ? brokenId === current._id : true;
  const touchStart = useRef<number | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        onIndex(stepGalleryIndex(index, -1, total));
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        onIndex(stepGalleryIndex(index, 1, total));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, total, onIndex, onClose]);

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div
      className="fc-gallery-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`Image gallery, ${galleryCounter(index, total)}`}
      onClick={onClose}
    >
      <button type="button" className="fc-lightbox-close" aria-label="Close gallery" onClick={onClose}>
        <X size={20} />
      </button>

      {total > 1 && (
        <button
          type="button"
          className="fc-gallery-nav prev"
          aria-label="Previous image"
          onClick={(e) => { stop(e); onIndex(stepGalleryIndex(index, -1, total)); }}
        >
          <ChevronLeft size={22} />
        </button>
      )}

      <figure
        className="fc-gallery-frame"
        onClick={stop}
        onTouchStart={(e) => { touchStart.current = e.touches[0]?.clientX ?? null; }}
        onTouchEnd={(e) => {
          const start = touchStart.current;
          touchStart.current = null;
          if (start == null) return;
          const delta = (e.changedTouches[0]?.clientX ?? start) - start;
          if (Math.abs(delta) < 50) return;
          onIndex(stepGalleryIndex(index, delta < 0 ? 1 : -1, total));
        }}
      >
        {broken || !current?.url ? (
          <div className="fc-gallery-broken">
            <ImageOff size={26} />
            <span>{current?.name ?? "Image unavailable"}</span>
            <small>This image couldn&apos;t be loaded.</small>
          </div>
        ) : (
          <img
            key={current._id}
            src={current.url}
            alt={current.name}
            className={zoomed ? "zoomed" : undefined}
            onError={() => setBrokenId(current._id)}
            onClick={() => setZoomId((id) => (id === current._id ? null : current._id))}
          />
        )}
      </figure>

      {total > 1 && (
        <button
          type="button"
          className="fc-gallery-nav next"
          aria-label="Next image"
          onClick={(e) => { stop(e); onIndex(stepGalleryIndex(index, 1, total)); }}
        >
          <ChevronRight size={22} />
        </button>
      )}

      <div className="fc-gallery-bar" onClick={stop}>
        <span className="counter">{galleryCounter(index, total)}</span>
        <span className="name">{current?.name ?? ""}</span>
        <button
          type="button"
          onClick={() => current && setZoomId((id) => (id === current._id ? null : current._id))}
          aria-label={zoomed ? "Fit image" : "Zoom image"}
        >
          {zoomed ? <ZoomOut size={14} /> : <ZoomIn size={14} />} {zoomed ? "Fit" : "Zoom"}
        </button>
        <button
          type="button"
          onClick={() => void downloadFile(current?.url ?? "", current?.name ?? "image")}
          aria-label="Download image"
        >
          <Download size={14} /> Download
        </button>
      </div>
    </div>
  );
}

export default function MessageAttachments({ attachments }: { attachments: GalleryAsset[] | null | undefined }) {
  const { images, files } = useMemo(() => splitMessageAttachments(attachments), [attachments]);
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  if (images.length === 1) {
    return (
      <>
        <div className="fc-attachments"><MediaAttachment attachment={{ ...images[0], size: images[0].size ?? 0 }} /></div>
        {files.length > 0 && (
          <div className="fc-attachments">
            {files.map((file) => <MediaAttachment key={file._id} attachment={{ ...file, size: file.size ?? 0 }} />)}
          </div>
        )}
      </>
    );
  }

  return (
    <>
      {images.length > 1 && (
        <div className={`fc-gallery layout-${galleryLayout(images.length)}`}>
          {images.slice(0, galleryPreviewCount(images.length)).map((image, i, previews) => {
            // The overlay belongs to the LAST visible tile and counts the images
            // that aren't previewed, e.g. 9 images → "+5 more".
            const overflow = i === previews.length - 1 ? galleryOverflowLabel(images.length) : "";
            return (
              <button
                key={image._id}
                type="button"
                className="fc-gallery-tile"
                onClick={() => setOpenIndex(i)}
                aria-label={overflow ? `Open gallery, ${galleryCounter(i, images.length)}` : `Open ${image.name}`}
              >
                <GalleryThumb image={image} />
                {overflow && <span className="fc-gallery-more">{overflow}</span>}
              </button>
            );
          })}
        </div>
      )}
      {files.length > 0 && (
        <div className="fc-attachments">
          {files.map((file) => <MediaAttachment key={file._id} attachment={{ ...file, size: file.size ?? 0 }} />)}
        </div>
      )}
      {openIndex !== null && (
        <GalleryLightbox
          images={images}
          index={openIndex}
          onIndex={setOpenIndex}
          onClose={() => setOpenIndex(null)}
        />
      )}
    </>
  );
}
