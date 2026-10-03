import { AVATAR_BG, PRESENCE_META, colorFor, initialsOf } from "@/components/dashboard/ui";
import { DECORATIONS, FRAMES } from "@/lib/cosmetics";

/**
 * Avatar with optional Freecord frame ring and decoration overlay.
 * Cosmetics are purely visual and never affect permissions.
 */
export default function ProfileAvatar({
  name,
  color,
  url,
  presence,
  size = 40,
  frameId,
  decorationId,
  animated = true,
  showPresence = true,
}: {
  name: string;
  color?: string | null;
  url?: string | null;
  presence?: string | null;
  size?: number;
  frameId?: string | null;
  decorationId?: string | null;
  animated?: boolean;
  showPresence?: boolean;
}) {
  const key = color ?? colorFor(name);
  const frame = FRAMES.find((f) => f.id === frameId);
  const hasFrame = Boolean(frame && frame.id !== "frame_none" && frame.background);
  const dec = DECORATIONS.find((d) => d.id === decorationId);
  const meta = presence ? PRESENCE_META[presence] : undefined;

  return (
    <span className={`pf-avatar-wrap ${hasFrame ? "framed" : ""}`} style={{ width: size, height: size }}>
      {hasFrame && (
        <span
          className={`pf-frame ${frame!.animated && animated ? "animated" : ""}`}
          style={{ background: frame!.background }}
          aria-hidden="true"
        />
      )}
      <span
        className="pf-avatar"
        style={{ background: url ? "#1e1d28" : AVATAR_BG[key] ?? "#7c5cf6", fontSize: Math.max(9, size / 3.2) }}
      >
        {url ? <img src={url} alt={`${name}'s avatar`} loading="lazy" /> : initialsOf(name)}
      </span>
      {dec && (
        <span className={`pf-decoration ${dec.animated && animated ? "animated" : ""}`} aria-hidden="true" title={`${dec.name} decoration`}>
          {dec.glyph}
        </span>
      )}
      {showPresence && meta && (
        <i className="pf-presence" style={{ background: meta.color }} title={meta.label} aria-label={meta.label} />
      )}
    </span>
  );
}
