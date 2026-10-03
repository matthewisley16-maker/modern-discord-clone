import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import ProfileAvatar from "./ProfileAvatar";
import ProfileEffect from "./ProfileEffect";
import { BADGES, nameStyle, plateStyle } from "@/lib/cosmetics";
import { toast } from "sonner";
import { ArrowLeft, MessageCircle, UserPlus } from "lucide-react";

export default function FullProfile({
  userId,
  onBack,
  onMessage,
}: {
  userId: string;
  onBack: () => void;
  onMessage: (userId: string) => void;
}) {
  const profile = useQuery(api.profiles.getProfile, { userId: userId as Id<"users"> });
  const appearance = useQuery(api.profiles.getAppearance, {});
  const sendRequest = useMutation(api.social.sendFriendRequest);
  const startDirect = useMutation(api.dms.startDirect);

  if (!profile) {
    return (
      <div className="fc-scroll-view">
        <Button variant="ghost" onClick={onBack}><ArrowLeft className="mr-2 h-4 w-4" /> Back</Button>
        <p className="fc-muted mt-4">Loading profile…</p>
      </div>
    );
  }

  const badges = (profile.badges ?? []).map((id) => BADGES.find((b) => b.id === id)).filter(Boolean);
  const widgets = [...(profile.widgets ?? [])].sort((a, b) => a.position - b.position);

  function widgetBody(type: string, content?: string) {
    switch (type) {
      case "about":
        return <p className="pf-bio">{profile!.bio || "No bio yet."}</p>;
      case "activity":
        return profile!.activity
          ? <p className="pf-bio"><span className="pf-activity-label">{profile!.activity.type}</span> <strong>{profile!.activity.name}</strong></p>
          : <p className="fc-muted">No activity right now.</p>;
      case "communities":
      case "mutuals":
        return profile!.mutualCommunities.length > 0
          ? <ul className="pf-list">{profile!.mutualCommunities.map((c) => <li key={c._id}>{c.name}</li>)}</ul>
          : <p className="fc-muted">No mutual communities.</p>;
      case "friends":
        return <p className="pf-bio">{profile!.followers} followers · {profile!.following} following</p>;
      case "interests":
        return profile!.interests.length > 0
          ? <div className="pf-tags">{profile!.interests.map((i) => <span key={i} className="fc-tag">{i}</span>)}</div>
          : <p className="fc-muted">No interests listed.</p>;
      case "links":
        return profile!.socialLinks.length > 0
          ? <ul className="pf-list">{profile!.socialLinks.map((l) => <li key={l.url}><a href={l.url} target="_blank" rel="noreferrer noopener">{l.label || l.url}</a></li>)}</ul>
          : <p className="fc-muted">No links added.</p>;
      case "stats":
        return <p className="pf-bio">{badges.length} badges · {profile!.mutualCommunities.length} mutual communities</p>;
      case "custom":
        return <p className="pf-bio">{content || "Nothing here yet."}</p>;
      default:
        return null;
    }
  }

  return (
    <div className="fc-scroll-view pf-page">
      <Button variant="ghost" onClick={onBack} className="pf-back"><ArrowLeft className="mr-2 h-4 w-4" /> Back</Button>

      <div className="pf-page-banner" style={{ background: profile.themeColors ? `linear-gradient(135deg, ${profile.themeColors.primary}, ${profile.themeColors.background})` : undefined }}>
        {profile.bannerUrl && <img src={profile.bannerUrl} alt="" />}
        <ProfileEffect effectId={profile.effectId} reducedMotion={appearance?.reducedMotion} density={26} />
      </div>

      <div className="pf-page-head">
        <ProfileAvatar
          name={profile.displayName}
          color={profile.avatarColor}
          url={profile.avatarUrl}
          presence={profile.presence}
          frameId={profile.frameId}
          decorationId={profile.decorationId}
          size={108}
        />
        <div className="pf-page-actions">
          {!profile.isSelf && (
            <>
              {!profile.isFriend && (
                <Button size="sm" onClick={async () => {
                  try { await sendRequest({ toId: profile.userId as Id<"users"> }); toast.success("Friend request sent"); }
                  catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
                }}><UserPlus className="mr-1 h-4 w-4" /> Add Friend</Button>
              )}
              <Button size="sm" variant="outline" onClick={async () => {
                try { const id = await startDirect({ userId: profile.userId as Id<"users"> }); onMessage(id); }
                catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
              }}><MessageCircle className="mr-1 h-4 w-4" /> Message</Button>
            </>
          )}
        </div>
      </div>

      <div className="pf-page-names">
        <h1 className="pf-name" style={nameStyle(profile.nameFont ?? undefined, profile.nameEffect ?? undefined, profile.nameColors ?? undefined)}>
          <span className="pf-plate" style={plateStyle(profile.nameplateId)}>{profile.displayName}</span>
        </h1>
        <p className="pf-handle">@{profile.username}</p>
        {profile.customStatus && <p className="pf-status">{profile.customStatus}</p>}
        {profile.pronouns && <p className="pf-bio">{profile.pronouns}</p>}
      </div>

      {badges.length > 0 && (
        <div className="pf-badges pf-badges-lg">
          {badges.map((b) => (
            <span key={b!.id} className="pf-badge" title={b!.description}><span aria-hidden="true">{b!.glyph}</span> {b!.name}</span>
          ))}
        </div>
      )}

      {widgets.length === 0 && profile.bio && (
        <section className="pf-widget">
          <h3>About Me</h3>
          <p className="pf-bio">{profile.bio}</p>
        </section>
      )}

      <div className="pf-widget-grid">
        {widgets.map((w) => {
          const body = widgetBody(w.type, w.content);
          if (!body) return null;
          return (
            <section className="pf-widget" key={w.id}>
              <h3>{w.type.charAt(0).toUpperCase() + w.type.slice(1).replace("custom", "Custom Text")}</h3>
              {body}
            </section>
          );
        })}
      </div>

      <section className="pf-widget">
        <h3>Member Since</h3>
        <p className="pf-bio">{new Date(profile.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}</p>
      </section>
    </div>
  );
}
