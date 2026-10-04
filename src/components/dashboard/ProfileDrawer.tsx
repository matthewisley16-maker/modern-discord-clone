import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Avatar, PRESENCE_META } from "./ui";
import { toast } from "sonner";
import { Calendar, Flag, MessageCircle, ShieldOff, UserMinus, UserPlus, X } from "lucide-react";

export default function ProfileDrawer({
  userId,
  onClose,
  onMessage,
}: {
  userId: string;
  onClose: () => void;
  onMessage: (userId: string) => void;
}) {
  const profile = useQuery(api.users.publicProfile, { userId: userId as Id<"users"> });
  const sendRequest = useMutation(api.social.sendFriendRequest);
  const removeFriend = useMutation(api.social.removeFriend);
  const follow = useMutation(api.social.follow);
  const unfollow = useMutation(api.social.unfollow);
  const block = useMutation(api.social.blockUser);
  const report = useMutation(api.social.report);
  const startDirect = useMutation(api.dms.startDirect);

  async function run(label: string, fn: () => Promise<unknown>) {
    try { await fn(); toast.success(label); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Action failed."); }
  }

  if (!profile) {
    return (
      <aside className="fc-drawer" role="complementary" aria-label="Profile">
        <button className="fc-drawer-close" aria-label="Close profile" onClick={onClose}><X size={18} /></button>
        <div className="fc-drawer-body"><p className="fc-muted">Loading profile…</p></div>
      </aside>
    );
  }

  const presence = PRESENCE_META[profile.presence] ?? PRESENCE_META.offline;

  return (
    <aside className="fc-drawer" role="complementary" aria-label={`${profile.displayName} profile`}>
      <button className="fc-drawer-close" aria-label="Close profile" onClick={onClose}><X size={18} /></button>
      <div className="fc-drawer-banner" />
      <div className="fc-drawer-body">
        <Avatar name={profile.displayName} color={profile.avatarColor} presence={profile.presence} size={72} url={profile.avatarUrl} decorationId={profile.decorationId} />
        <h2 className="fc-drawer-name">{profile.displayName}</h2>
        {profile.username && <p className="fc-drawer-handle">@{profile.username}</p>}
        <p className="fc-drawer-presence"><span className="fc-dot" style={{ background: presence.color }} /> {presence.label}</p>
        {profile.customStatus && <p className="fc-drawer-status">{profile.customStatus}</p>}

        <div className="fc-drawer-stats">
          <div><strong>{profile.followers}</strong><span>Followers</span></div>
          <div><strong>{profile.following}</strong><span>Following</span></div>
          <div><strong>{profile.mutualCommunities.length}</strong><span>Mutual</span></div>
        </div>

        {profile.badges.length > 0 && (
          <div className="fc-drawer-badges">
            {profile.badges.map((b) => <span key={b} className="fc-badge-tag">{b}</span>)}
          </div>
        )}

        {profile.bio && (
          <>
            <p className="fc-drawer-label">ABOUT</p>
            <p className="fc-drawer-bio">{profile.bio}</p>
          </>
        )}

        {profile.createdAt && (
          <p className="fc-drawer-meta"><Calendar size={13} /> Joined {new Date(profile.createdAt).toLocaleDateString()}</p>
        )}

        {profile.mutualCommunities.length > 0 && (
          <>
            <p className="fc-drawer-label">MUTUAL COMMUNITIES</p>
            <ul className="fc-drawer-list">
              {profile.mutualCommunities.map((c) => <li key={c._id}>{c.name}</li>)}
            </ul>
          </>
        )}

        <div className="fc-drawer-actions">
          <Button size="sm" onClick={() => run("Message opened", async () => { const id = await startDirect({ userId: userId as Id<"users"> }); onMessage(id); })}>
            <MessageCircle className="mr-1 h-4 w-4" /> Message
          </Button>
          {profile.isFriend ? (
            <Button size="sm" variant="outline" onClick={() => run("Friend removed", () => removeFriend({ userId: userId as Id<"users"> }))}>
              <UserMinus className="mr-1 h-4 w-4" /> Remove friend
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => run("Friend request sent", () => sendRequest({ toId: userId as Id<"users"> }))}>
              <UserPlus className="mr-1 h-4 w-4" /> Add friend
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => run(profile.isFollowing ? "Unfollowed" : "Following", () => profile.isFollowing ? unfollow({ userId: userId as Id<"users"> }) : follow({ userId: userId as Id<"users"> }))}>
            {profile.isFollowing ? "Unfollow" : "Follow"}
          </Button>
          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => run("User blocked", () => block({ userId: userId as Id<"users"> }))}>
            <ShieldOff className="mr-1 h-4 w-4" /> Block
          </Button>
          <Button size="sm" variant="ghost" onClick={() => run("Report sent to moderators", () => report({ targetType: "user", targetId: userId, category: "other" }))}>
            <Flag className="mr-1 h-4 w-4" /> Report
          </Button>
        </div>
      </div>
    </aside>
  );
}
