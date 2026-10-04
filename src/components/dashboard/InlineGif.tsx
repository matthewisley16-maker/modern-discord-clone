import { useState } from "react";
import { Lightbox } from "./MediaAttachment";

/**
 * A direct `.gif` link from a message body, rendered as a real animated GIF.
 *
 * No provider or API key is needed — the link itself is the image. Clicking
 * opens Freecord's in-app viewer (animation preserved); it never navigates to
 * the source site. If the link is not actually a loadable image it disappears
 * and the original link stays as normal clickable text.
 */
export default function InlineGif({ url }: { url: string }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <>
      <button type="button" className="fc-gif-msg" onClick={() => setOpen(true)} aria-label="Open GIF">
        <img
          src={url}
          alt="GIF"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      </button>
      {open && <Lightbox src={url} name="GIF" onClose={() => setOpen(false)} />}
    </>
  );
}
