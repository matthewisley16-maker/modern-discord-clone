import { useEffect, useState } from "react";
import { Download, FileText, X } from "lucide-react";
import AudioPlayer from "./AudioPlayer";

/**
 * Renders one message attachment.
 *
 * - Images: a compact, aspect-ratio-preserving preview that opens an in-app
 *   lightbox. It never navigates to another site or a new tab.
 * - Audio: the inline music player (album artwork lives inside it).
 * - Everything else: a file chip with a real download button.
 *
 * Downloads fetch the bytes and save them via a temporary object URL, so a
 * cross-origin storage URL can't turn into a navigation.
 */

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
export const isImageAttachment = (contentType: string, name: string) =>
  contentType.startsWith("image/") || IMAGE_RE.test(name);

export const isAudioAttachment = (contentType: string, name: string) =>
  contentType.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(name);

function triggerAnchorDownload(href: string, name: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = name || "download";
  a.rel = "noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function downloadFile(url: string, name: string) {
  if (!url) return false;
  try {
    // Fetch the real bytes so a cross-origin storage URL saves as a file
    // instead of navigating to it. This is the same origin Freecord already
    // streams from, so CORS is already permitted.
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    triggerAnchorDownload(objectUrl, name);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
    return true;
  } catch {
    // If the fetch is blocked, still try a direct save (no new tab for images).
    triggerAnchorDownload(url, name);
    return false;
  }
}

/** Full-screen in-app image viewer. Escape or a click outside closes it. */
export function Lightbox({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fc-lightbox" role="dialog" aria-modal="true" aria-label={`${name} preview`} onClick={onClose}>
      <button className="fc-lightbox-close" aria-label="Close preview" onClick={onClose}><X size={20} /></button>
      <img src={src} alt={name} onClick={(e) => e.stopPropagation()} />
      <div className="fc-lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span>{name}</span>
        <button onClick={() => void downloadFile(src, name)}><Download size={14} /> Download</button>
      </div>
    </div>
  );
}

type Attachment = {
  _id: string;
  name: string;
  size: number;
  contentType: string;
  url: string | null;
};

export default function MediaAttachment({ attachment }: { attachment: Attachment }) {
  const [open, setOpen] = useState(false);
  const { name, contentType, url, size } = attachment;

  if (isAudioAttachment(contentType, name) && url) {
    return <AudioPlayer url={url} name={name} size={size} contentType={contentType} />;
  }

  if (isImageAttachment(contentType, name) && url) {
    return (
      <>
        {/* Compact preview — constrained, aspect ratio preserved, never full size. */}
        <button type="button" className="fc-image-preview" onClick={() => setOpen(true)} aria-label={`Open ${name}`}>
          <img src={url} alt={name} loading="lazy" />
        </button>
        {open && <Lightbox src={url} name={name} onClose={() => setOpen(false)} />}
      </>
    );
  }

  return (
    <div className="fc-file-chip">
      <FileText size={16} />
      <span className="fc-file-name" title={name}>{name}</span>
      <button
        type="button"
        className="fc-file-download"
        aria-label={`Download ${name}`}
        onClick={() => void downloadFile(url ?? "", name)}
      >
        <Download size={14} />
      </button>
    </div>
  );
}
