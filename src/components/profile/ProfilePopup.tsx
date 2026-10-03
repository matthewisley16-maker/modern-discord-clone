import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import ProfileAvatar from "./ProfileAvatar";
import ProfileEffect from "./ProfileEffect";
import { BADGES, nameStyle, plateStyle } from "@/lib/cosmetics";
import { toast } from "sonner";
import { BellOff, Copy, Flag, MessageCircle, MoreHorizontal, ShieldOff, UserPlus, X } from "lucide-react";

export default function ProfilePopup({
  userId,
  serverId,
  onClose,
  onMessage,
  onViewFull,
}: {
  userId: string;
  serverId?: Id<"servers">;
  onClose: () => void;
  onMessage: (userId: string) => void;
  onViewFull: (userId: string) => void;
}) {
  const profile = useQuery(api.profiles.getProfile, { userId: userId as Id<"users">, serverId });
  const appearance = useQuery(api.profiles.getAppearance, {});
  const sendRequest = useMutation(api.social.sendFriendRequest);
  const removeFriend = useMutation(api.social.removeFriend);
  const block = useMutation(api.social.blockUser);
  const report = useMutation(api.social.report);
  const startDirect = useMutation(api.dms.startDirect);
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on Escape and on outside click.
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onClick); };
  }, [onClose]);

  async function run(label: string, fn: () => Promise<unknown>) {
    try { await fn(); toast.success(label); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Action failed."); }
  }

  if (!profile) {
    return (
      <div className="pf-popup" ref={ref} role="dialog" aria-label="Profile">
        <div className="pf-popup-body"><p className="fc-muted">Loading profile…</p></div>
      </div>
    );
  }

  const themeColors = profile.themeColors;
  const badges = (profile.badges ?? []).map((id) => BADGES.find((b) => b.id === id)).filter(Boolean);
  const presenceMeta = { online: "Online", idle: "Idle", dnd: "Do Not Disturb", invisible: "Invisible", offline: "Offline" }[profile.presence] ?? "Offline";

  return (
    <div className="pf-popup" ref={ref} role="dialog" aria-label={`${profile.displayName}'s profile`}>
      <button className="pf-popup-close" aria-label="Close profile" onClick={onClose}><X size={16} /></button>

      <div className="pf-popup-banner" style={{ background: themeColors ? `linear-gradient(135deg, ${themeColors.primary}, ${themeColors.background})` : undefined }}>
        {profile.bannerUrl && <img src={profile.bannerUrl} alt="" />}
        <ProfileEffect effectId={profile.effectId} reducedMotion={appearance?.reducedMotion} density={12} />
      </div>

      <div className="pf-popup-body">
        <div className="pf-popup-avatar-row">
          <ProfileAvatar
            name={profile.displayName}
            color={profile.avatarColor}
            url={profile.avatarUrl}
            presence={profile.presence}
            frameId={profile.frameId}
            decorationId={profile.decorationId}
            size={76}
          />
          <span className={`pf-presence-label ${profile.presence}`}>{presenceMeta}</span>
        </div>

        <div className="pf-popup-names">
          <h2 className="pf-name" style={nameStyle(profile.nameFont ?? undefined, profile.nameEffect ?? undefined, profile.nameColors ?? undefined)}>
            <span className="pf-plate" style={plateStyle(profile.nameplateId)}>{profile.displayName}</span>
          </h2>
          <p className="pf-handle">@{profile.username}</p>
        </div>

        {profile.customStatus && <p className="pf-status">{profile.customStatus}</p>}

        {badges.length > 0 && (
          <div className="pf-badges">
            {badges.map((b) => (
              <span key={b!.id} className="pf-badge" title={b!.description}>
                <span aria-hidden="true">{b!.glyph}</span> {b!.name}
              </span>
            ))}
          </div>
        )}

        {profile.activity && (
          <div className="pf-activity">
            <span className="pf-activity-label">{profile.activity.type}</span>
            <strong>{profile.activity.name}</strong>
          </div>
        )}

        {profile.bio && (
          <>
            <p className="pf-section-label">ABOUT ME</p>
            <p className="pf-bio">{profile.bio}</p>
          </>
        )}

        {profile.pronouns && (
          <>
            <p className="pf-section-label">PRONOUNS</p>
            <p className="pf-bio">{profile.pronouns}</p>
          </>
        )}

        <p className="pf-section-label">MEMBER SINCE</p>
        <p className="pf-bio">{new Date(profile.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}</p>

        {profile.mutualCommunities.length > 0 && (
          <>
            <p className="pf-section-label">MUTUAL COMMUNITIES — {profile.mutualCommunities.length}</p>
            <ul className="pf-list">{profile.mutualCommunities.slice(0, 5).map((c) => <li key={c._id}>{c.name}</li>)}</ul>
          </>
        )}

        {profile.socialLinks.length > 0 && (
          <>
            <p className="pf-section-label">LINKS</p>
            <ul className="pf-list">
              {profile.socialLinks.map((l) => (
                <li key={l.url}><a href={l.url} target="_blank" rel="noreferrer noopener">{l.label || l.url}</a></li>
              ))}
            </ul>
          </>
        )}

        {!profile.isSelf && (
          <div className="pf-popup-actions">
            {profile.isFriend ? (
              <Button size="sm" variant="outline" onClick={() => run("Friend removed", () => removeFriend({ userId: profile.userId as Id<"users"> }))}>Remove friend</Button>
            ) : (
              <Button size="sm" onClick={() => run("Friend request sent", () => sendRequest({ toId: profile.userId as Id<"users"> }))}>
                <UserPlus className="mr-1 h-4 w-4" /> Add Friend
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => run("Conversation opened", async () => { const id = await startDirect({ userId: profile.userId as Id<"users"> }); onMessage(id); })}>
              <MessageCircle className="mr-1 h-4 w-4" /> Message
            </Button>
            <div className="pf-more">
              <Button size="sm" variant="ghost" aria-label="More options" onClick={() => setMenuOpen((v) => !v)}><MoreHorizontal className="h-4 w-4" /></Button>
              {menuOpen && (
                <div className="pf-more-menu">
                  <button onClick={() => { onViewFull(profile.userId); setMenuOpen(false); }}>View full profile</button>
                  <button onClick={async () => { try { await navigator.clipboard.writeText(profile.username); toast.success("Username copied."); } catch { toast.error("Couldn't copy."); } setMenuOpen(false); }}>
                    <Copy size={13} /> Copy username
                  </button>
                  <button onClick={async () => { try { await navigator.clipboard.writeText(profile.userId); toast.success("User ID copied."); } catch { toast.error("Couldn't copy."); } setMenuOpen(false); }}>
                    <Copy size={13} /> Copy user ID
                  </button>
                  <button onClick={() => run("Report sent to moderators", () => report({ targetType: "user", targetId: profile.userId, category: "other" }))}>
                    <Flag size={13} /> Report
                  </button>
                  <button className="danger" onClick={() => run("User blocked", () => block({ userId: profile.userId as Id<"users"> }))}>
                    <ShieldOff size={13} /> Block
                  </button>
                  <button onClick={() => { toast.success("Notifications muted for this user."); setMenuOpen(false); }}>
                    <BellOff size={13} /> Ignore / mute
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        {profile.isSelf && (
          <div className="pf-popup-actions">
            <Button size="sm" variant="outline" onClick={() => onViewFull(profile.userId)}>View full profile</Button>
          </div>
        )}
      </div>
    </div>
  );
}
