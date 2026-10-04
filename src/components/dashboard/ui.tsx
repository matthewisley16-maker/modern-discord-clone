import type { ReactNode } from "react";
import ProfileDecoration from "@/components/profile/ProfileDecoration";

export const AVATAR_BG: Record<string, string> = {
  violet: "#7c5cf6", indigo: "#6366f1", sky: "#0ea5e9",
  emerald: "#10b981", amber: "#f59e0b", rose: "#f43f5e",
};

export const PRESENCE_META: Record<string, { color: string; label: string }> = {
  online: { color: "#3ddc97", label: "Online" },
  idle: { color: "#f5c451", label: "Idle" },
  dnd: { color: "#f0616d", label: "Do Not Disturb" },
  invisible: { color: "#8b87a0", label: "Invisible" },
  offline: { color: "#6b6880", label: "Offline" },
};

// How long ago the user was last seen — never a fake or static value.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatLastSeen(ts?: number | null, now: number = Date.now()): string {
  if (!ts) return "Last online unknown";
  const diff = Math.max(0, now - ts);
  if (diff < MINUTE) return "Last online just now";
  if (diff < HOUR) {
    const m = Math.floor(diff / MINUTE);
    return `Last online ${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (diff < DAY) {
    const h = Math.floor(diff / HOUR);
    return `Last online ${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const d = Math.floor(diff / DAY);
  if (d === 1) return "Last online yesterday";
  if (d < 7) return `Last online ${d} days ago`;
  return `Last online ${new Date(ts).toLocaleDateString()}`;
}

export function colorFor(name: string) {
  const keys = Object.keys(AVATAR_BG);
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 997;
  return keys[hash % keys.length];
}

export function initialsOf(name: string) {
  return name.split(/\s+/).filter(Boolean).map((n) => n[0]).join("").slice(0, 2).toUpperCase() || "F";
}

export function Avatar({
  name,
  color,
  presence,
  size = 36,
  url,
  lastSeen,
  decorationId,
  reducedMotion,
}: {
  name: string;
  color?: string;
  presence?: string;
  size?: number;
  url?: string | null;
  lastSeen?: number | null;
  decorationId?: string | null;
  reducedMotion?: boolean;
}) {
  const key = color ?? colorFor(name);
  // Only Online (green), Idle (amber) and Do Not Disturb (red) get a dot.
  // Invisible and Offline deliberately show NO indicator — absence of a dot
  // means "Invisible/Offline", exactly like the presence spec.
  const showDot = presence === "online" || presence === "idle" || presence === "dnd";
  const meta = presence && showDot ? PRESENCE_META[presence] : undefined;
  const title = presence === "offline" || presence === "invisible" ? formatLastSeen(lastSeen) : meta?.label;
  return (
    <span className="fc-avatar" style={{ width: size, height: size, background: url ? undefined : AVATAR_BG[key] ?? "#7c5cf6" }} title={title}>
      {url ? <img src={url} alt="" /> : initialsOf(name)}
      <ProfileDecoration decorationId={decorationId} size={size} reducedMotion={reducedMotion} />
      {meta && <i style={{ background: meta.color }} />}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="fc-empty">
      {icon}
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {action}
    </div>
  );
}

export function SectionHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="fc-section-header">
      <span>{title}</span>
      {right}
    </div>
  );
}
