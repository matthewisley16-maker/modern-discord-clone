import { useState } from "react";
import type { GifValue } from "@/convex/gif";
import { Lightbox } from "./MediaAttachment";

/**
 * A sent GIF inside a message.
 *
 * The GIF is shown as a real animated image (never converted to a still), with
 * its animation preserved. Clicking it opens Freecord's existing in-app viewer
 * instead of navigating away, and the viewer keeps animating too.
 */
export default function GifMessage({ gif }: { gif: GifValue }) {
  const [open, setOpen] = useState(false);
  const name = gif.title || "GIF";
  return (
    <>
      <button
        type="button"
        className="fc-gif-msg"
        onClick={() => setOpen(true)}
        aria-label={`Open ${name}`}
      >
        <img
          src={gif.url}
          alt={name}
          title={gif.title || undefined}
          loading="lazy"
          width={gif.width}
          height={gif.height}
        />
      </button>
      {open && <Lightbox src={gif.url} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}
