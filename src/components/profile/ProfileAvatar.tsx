import { AVATAR_BG, PRESENCE_META, colorFor, initialsOf } from "@/components/dashboard/ui";
import { FRAMES } from "@/lib/cosmetics";
import ProfileDecoration from "./ProfileDecoration";

/**
 * Avatar with optional Freecord frame ring and animated decoration overlay.
 *
 * Layer order (scoped, not global z-index):
 *   frame ring → avatar → decoration → presence.
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
  reducedMotion,
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
  reducedMotion?: boolean;
  showPresence?: boolean;
}) {
  const key = color ?? colorFor(name);
  const frame = FRAMES.find((f) => f.id === frameId);
  const hasFrame = Boolean(frame && frame.id !== "frame_none" && frame.background);
  const meta = presence ? PRESENCE_META[presence] : undefined;

  return (
    <span className={`pf-avatar-wrap ${hasFrame ? "framed" : ""}`} style={{ width: size, height: size }}>
      {hasFrame && (
        <span
          className={`pf-frame pf-layer-frame ${frame!.animated && animated ? "animated" : ""}`}
          style={{ background: frame!.background }}
          aria-hidden="true"
        />
      )}
      <span
        className="pf-avatar pf-layer-avatar"
        style={{ background: url ? "#1e1d28" : AVATAR_BG[key] ?? "#7c5cf6", fontSize: Math.max(9, size / 3.2) }}
      >
        {url ? <img src={url} alt={`${name}'s avatar`} loading="lazy" /> : initialsOf(name)}
      </span>
      <ProfileDecoration
        decorationId={decorationId}
        size={size}
        reducedMotion={reducedMotion || !animated}
      />
      {showPresence && meta && (
        <i className="pf-presence pf-layer-presence" style={{ background: meta.color }} title={meta.label} aria-label={meta.label} />
      )}
    </span>
  );
}
