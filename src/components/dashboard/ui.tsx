import type { ReactNode } from "react";

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
}: {
  name: string;
  color?: string;
  presence?: string;
  size?: number;
  url?: string | null;
}) {
  const key = color ?? colorFor(name);
  const meta = presence ? PRESENCE_META[presence] : undefined;
  return (
    <span className="fc-avatar" style={{ width: size, height: size, background: url ? undefined : AVATAR_BG[key] ?? "#7c5cf6" }} title={meta?.label}>
      {url ? <img src={url} alt="" /> : initialsOf(name)}
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
