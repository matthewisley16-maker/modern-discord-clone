import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toast } from "sonner";
import ProfileAvatar from "@/components/profile/ProfileAvatar";
import { ChevronDown, Hash, Lock, MicOff, Plus, Settings2, Volume2, VolumeX } from "lucide-react";

export default function VoiceChannelSidebar({
  serverId,
  activeChannelId,
  onJoinVoice,
  onOpenProfile,
  canManage,
}: {
  serverId: Id<"servers">;
  activeChannelId?: string | null;
  onJoinVoice: (channelId: Id<"channels">, name: string) => void;
  onOpenProfile: (userId: string) => void;
  canManage: boolean;
}) {
  const tree = useQuery(api.voice.channelTree, { serverId });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const updateChannel = useMutation(api.voice.updateChannelFull);
  const deleteChannel = useMutation(api.voice.deleteChannelFull);
  const moderate = useMutation(api.voice.moderateUser);

  if (!tree) return <p className="fc-sidebar-empty">Loading channels…</p>;

  const toggle = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));

  function ChannelRow({ channel }: { channel: { _id: Id<"channels">; name: string; type?: string | null; userLimit?: number | null; isPrivate?: boolean | null } }) {
    const isVoice = channel.type === "voice" || channel.type === "video";
    const participants = tree!.voiceParticipants[channel._id as string] ?? [];
    const isActive = activeChannelId === channel._id;
    const atLimit = (channel.userLimit ?? 0) > 0 && participants.length >= (channel.userLimit ?? 0);

    return (
      <div className="vc-row">
        <div className="vc-line">
          <button
            className={`fc-channel ${isActive ? "active" : ""}`}
            onClick={() => (isVoice ? onJoinVoice(channel._id, channel.name) : undefined)}
            disabled={!isVoice}
          >
            {isVoice ? (channel.isPrivate ? <Lock size={16} /> : <Volume2 size={17} />) : <Hash size={17} />}
            <span className="vc-name">{channel.name}</span>
            {isVoice && (channel.userLimit ?? 0) > 0 && (
              <span className={`vc-limit ${atLimit ? "full" : ""}`}>{participants.length}/{channel.userLimit}</span>
            )}
          </button>
          {canManage && (
            <button className="vc-manage" aria-label={`Manage ${channel.name}`} onClick={() => setEditing(editing === channel._id ? null : channel._id)}>
              <Settings2 size={14} />
            </button>
          )}
        </div>

        {isVoice && participants.length > 0 && (
          <ul className="vc-participants">
            {participants.map((p) => (
              <li key={p.userId} className={p.speaking ? "speaking" : ""}>
                <button className="vc-participant" onClick={() => onOpenProfile(p.userId)}>
                  <span className={`vc-ring ${p.speaking ? "on" : ""}`}>
                    <ProfileAvatar name={p.name} size={22} showPresence={false} />
                  </span>
                  <span className="vc-participant-name">{p.name}</span>
                  {p.deafened ? <VolumeX size={12} /> : p.muted ? <MicOff size={12} /> : null}
                </button>
                {canManage && (
                  <div className="vc-participant-tools">
                    <button title="Mute" aria-label={`Mute ${p.name}`} onClick={() => moderate({ action: "mute", userId: p.userId as Id<"users"> }).catch((e) => toast.error(e.message))}><MicOff size={12} /></button>
                    <button title="Disconnect" aria-label={`Disconnect ${p.name}`} onClick={() => moderate({ action: "disconnect", userId: p.userId as Id<"users"> }).catch((e) => toast.error(e.message))}>✕</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {editing === channel._id && canManage && (
          <div className="vc-editor">
            <label>Name
              <input
                defaultValue={channel.name}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== channel.name) updateChannel({ channelId: channel._id, name: v }).then(() => toast.success("Renamed.")).catch((err) => toast.error(err.message));
                }}
              />
            </label>
            <label>User limit (0 = unlimited)
              <input
                type="number"
                min={0}
                max={100}
                defaultValue={channel.userLimit ?? 0}
                onBlur={(e) => updateChannel({ channelId: channel._id, userLimit: Number(e.target.value) || 0 }).then(() => toast.success("Limit updated.")).catch((err) => toast.error(err.message))}
              />
            </label>
            <label className="fc-checkbox-row">
              <input
                type="checkbox"
                defaultChecked={channel.isPrivate ?? false}
                onChange={(e) => updateChannel({ channelId: channel._id, isPrivate: e.target.checked }).then(() => toast.success(e.target.checked ? "Channel is now private." : "Channel is now public.")).catch((err) => toast.error(err.message))}
              />
              Private channel
            </label>
            <button
              className="vc-delete"
              onClick={() => {
                if (!window.confirm(`Delete Voice Channel?\n\nThis will remove "${channel.name}" from this community.`)) return;
                deleteChannel({ channelId: channel._id }).then(() => toast.success("Channel deleted.")).catch((err) => toast.error(err.message));
              }}
            >
              Delete channel
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="vc-sidebar">
      <div className="fc-sidebar-section">
        <span>VOICE CHANNELS</span>
        <button aria-label="Create channel" onClick={() => window.dispatchEvent(new CustomEvent("freecord:create-channel"))}>
          <Plus size={15} />
        </button>
      </div>

      {tree.byCategory.map(({ category, channels }) => (
        <div key={category._id} className="vc-group">
          <button className="vc-category" onClick={() => toggle(category._id)}>
            <ChevronDown size={13} className={collapsed[category._id] ? "rot" : ""} /> {category.name}
          </button>
          {!collapsed[category._id] && channels.map((c) => <ChannelRow key={c._id} channel={c} />)}
        </div>
      ))}

      {tree.uncategorized.map((c) => <ChannelRow key={c._id} channel={c} />)}
    </div>
  );
}
