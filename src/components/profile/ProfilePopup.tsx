import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import ProfileAvatar from "./ProfileAvatar";
import ProfileEffect from "./ProfileEffect";
import FollowListModal from "./FollowListModal";
import { BADGES, nameStyle, plateStyle } from "@/lib/cosmetics";
import { toSafeArray } from "@/lib/collection";
import { formatLastSeen } from "@/components/dashboard/ui";
import FloatingMenu from "@/components/ui/floating-menu";
import { toast } from "sonner";
import { BellOff, Copy, Eye, Flag, MessageCircle, MoreHorizontal, Phone, ShieldOff, UserCheck, UserMinus, UserPlus, Video, X } from "lucide-react";

export default function ProfilePopup({
  userId,
  serverId,
  onClose,
  onMessage,
  onViewFull,
  onCall,
}: {
  userId: string;
  serverId?: Id<"servers">;
  onClose: () => void;
  onMessage: (userId: string) => void;
  onViewFull: (userId: string) => void;
  onCall?: (userId: string, media: "voice" | "video") => void;
}) {
  const profile = useQuery(api.profiles.getProfile, { userId: userId as Id<"users">, serverId });
  const appearance = useQuery(api.profiles.getAppearance, {});
  const sendRequest = useMutation(api.social.sendFriendRequest);
  const removeFriend = useMutation(api.social.removeFriend);
  const block = useMutation(api.social.blockUser);
  const report = useMutation(api.social.report);
  const startDirect = useMutation(api.dms.startDirect);
  const follow = useMutation(api.social.follow);
  const unfollow = useMutation(api.social.unfollow);
  const [menuOpen, setMenuOpen] = useState(false);
  const [followList, setFollowList] = useState<"followers" | "following" | "mutuals" | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);

  // Close on Escape and on outside click. The ⋯ menu renders through a portal
  // outside this card, so presses inside it must not dismiss the profile.
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("[data-floating-menu]")) return;
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
  // Profile sub-collections normalized so a malformed record can never crash.
  const badges = toSafeArray<NonNullable<typeof profile.badges>[number]>(profile.badges, { label: "Profile badges", source: "api.profiles.getProfile" }).map((id) => BADGES.find((b) => b.id === id)).filter(Boolean);
  const mutualCommunities = toSafeArray<NonNullable<typeof profile.mutualCommunities>[number]>(profile.mutualCommunities, { label: "Profile mutual communities", source: "api.profiles.getProfile" });
  const socialLinks = toSafeArray<NonNullable<typeof profile.socialLinks>[number]>(profile.socialLinks, { label: "Profile social links", source: "api.profiles.getProfile" });
  const presenceMeta = { online: "Online", idle: "Idle", dnd: "Do Not Disturb", invisible: "Invisible", offline: "Offline" }[profile.presence] ?? "Offline";

  return (
    <div className="pf-popup" ref={ref} role="dialog" aria-label={`${profile.displayName}'s profile`}>
      <button className="pf-popup-close" aria-label="Close profile" onClick={onClose}><X size={16} /></button>

      <div className="pf-popup-scroll">
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
            reducedMotion={appearance?.reducedMotion}
            size={76}
          />
          <span className={`pf-presence-label ${profile.presence}`}>
            {profile.presence === "offline" ? formatLastSeen(profile.lastSeen) : presenceMeta}
          </span>
        </div>

        <div className="pf-popup-names">
          <h2 className="pf-name" style={nameStyle(profile.nameFont ?? undefined, profile.nameEffect ?? undefined, profile.nameColors ?? undefined)}>
            <span className="pf-plate" style={plateStyle(profile.nameplateId)}>{profile.displayName}</span>
          </h2>
          <p className="pf-handle">@{profile.username}</p>
        </div>

        {(profile.isMutual || profile.followsYou) && (
          <p className="pf-follow-tag">{profile.isMutual ? "Mutual Following" : "Follows you"}</p>
        )}

        <div className="pf-follow-stats">
          <button onClick={() => setFollowList("followers")}><strong>{profile.followers}</strong><span>Followers</span></button>
          <button onClick={() => setFollowList("following")}><strong>{profile.following}</strong><span>Following</span></button>
          {!profile.isSelf && <button onClick={() => setFollowList("mutuals")}><strong>•</strong><span>Mutuals</span></button>}
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

        {mutualCommunities.length > 0 && (
          <>
            <p className="pf-section-label">MUTUAL COMMUNITIES — {mutualCommunities.length}</p>
            <ul className="pf-list">{mutualCommunities.slice(0, 5).map((c) => <li key={c._id}>{c.name}</li>)}</ul>
          </>
        )}

        {socialLinks.length > 0 && (
          <>
            <p className="pf-section-label">LINKS</p>
            <ul className="pf-list">
              {socialLinks.map((l) => (
                <li key={l.url}><a href={l.url} target="_blank" rel="noreferrer noopener">{l.label || l.url}</a></li>
              ))}
            </ul>
          </>
        )}

        {!profile.isSelf && (
          <div className="pf-popup-actions">
            <Button
              size="sm"
              variant={profile.isFollowing ? "outline" : "default"}
              onClick={() => run(profile.isFollowing ? "Unfollowed" : "Following", () => profile.isFollowing ? unfollow({ userId: profile.userId as Id<"users"> }) : follow({ userId: profile.userId as Id<"users"> }))}
            >
              <UserCheck className="mr-1 h-4 w-4" /> {profile.isFollowing ? "Following" : profile.followsYou ? "Follow back" : "Follow"}
            </Button>
            {profile.isFriend ? (
              <Button size="sm" variant="outline" onClick={() => run("Friend removed", () => removeFriend({ userId: profile.userId as Id<"users"> }))}>Remove friend</Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => run("Friend request sent", () => sendRequest({ toId: profile.userId as Id<"users"> }))}>
                <UserPlus className="mr-1 h-4 w-4" /> Add Friend
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => run("Conversation opened", async () => { const id = await startDirect({ userId: profile.userId as Id<"users"> }); onMessage(id); })}>
              <MessageCircle className="mr-1 h-4 w-4" /> Message
            </Button>
            {onCall && (
              <>
                <Button size="sm" variant="outline" aria-label="Voice call" title="Voice call" onClick={() => onCall(profile.userId, "voice")}>
                  <Phone className="mr-1 h-4 w-4" /> Call
                </Button>
                <Button size="sm" variant="outline" aria-label="Video call" title="Video call" onClick={() => onCall(profile.userId, "video")}>
                  <Video className="mr-1 h-4 w-4" /> Video
                </Button>
              </>
            )}
            <div className="pf-more">
              <Button
                ref={moreRef}
                size="sm"
                variant="ghost"
                aria-label="More options"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
              ><MoreHorizontal className="h-4 w-4" /></Button>
              {menuOpen && (
                <FloatingMenu
                  anchor={moreRef.current}
                  onClose={() => setMenuOpen(false)}
                  ariaLabel={`Options for ${profile.displayName}`}
                  align="end"
                >
                  <button onClick={() => { setMenuOpen(false); onViewFull(profile.userId); }}>
                    <Eye size={14} /> View full profile
                  </button>
                  {!profile.isBlocked && (
                    <button onClick={async () => {
                      setMenuOpen(false);
                      try { const id = await startDirect({ userId: profile.userId as Id<"users"> }); onMessage(id); }
                      catch (e) { toast.error(e instanceof Error ? e.message : "Action failed."); }
                    }}>
                      <MessageCircle size={14} /> Message
                    </button>
                  )}
                  {!profile.isBlocked && (profile.isFriend ? (
                    <button onClick={() => { setMenuOpen(false); run("Friend removed", () => removeFriend({ userId: profile.userId as Id<"users"> })); }}>
                      <UserMinus size={14} /> Remove Friend
                    </button>
                  ) : (
                    <button onClick={() => { setMenuOpen(false); run("Friend request sent", () => sendRequest({ toId: profile.userId as Id<"users"> })); }}>
                      <UserPlus size={14} /> Add Friend
                    </button>
                  ))}
                  <div className="fc-floating-sep" role="separator" />
                  <button onClick={async () => { setMenuOpen(false); try { await navigator.clipboard.writeText(profile.username); toast.success("Username copied."); } catch { toast.error("Couldn't copy."); } }}>
                    <Copy size={14} /> Copy username
                  </button>
                  <button onClick={async () => { setMenuOpen(false); try { await navigator.clipboard.writeText(profile.userId); toast.success("User ID copied."); } catch { toast.error("Couldn't copy."); } }}>
                    <Copy size={14} /> Copy user ID
                  </button>
                  <button onClick={() => { setMenuOpen(false); toast.success("Notifications muted for this user."); }}>
                    <BellOff size={14} /> Mute
                  </button>
                  <div className="fc-floating-sep" role="separator" />
                  <button onClick={() => { setMenuOpen(false); run("Report sent to moderators", () => report({ targetType: "user", targetId: profile.userId, category: "other" })); }}>
                    <Flag size={14} /> Report
                  </button>
                  {!profile.isBlocked && (
                    <button className="danger" onClick={() => { setMenuOpen(false); run("User blocked", () => block({ userId: profile.userId as Id<"users"> })); }}>
                      <ShieldOff size={14} /> Block
                    </button>
                  )}
                </FloatingMenu>
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

      {followList && (
        <FollowListModal
          userId={profile.userId}
          title={profile.displayName}
          initialTab={followList}
          onClose={() => setFollowList(null)}
          onOpenProfile={(id) => { setFollowList(null); onViewFull(id); }}
        />
      )}
    </div>
  );
}
