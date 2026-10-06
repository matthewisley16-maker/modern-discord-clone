import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Avatar, formatLastSeen, PRESENCE_META } from "@/components/dashboard/ui";
import { toSafeArray } from "@/lib/collection";
import { toast } from "sonner";
import { Search, Users, X } from "lucide-react";

type Tab = "followers" | "following" | "mutuals";

type Card = {
  userId: string;
  username: string;
  displayName: string;
  avatarColor: string;
  avatarUrl: string | null;
  decorationId: string | null;
  presence: string;
  lastSeen?: number | null;
  customStatus: string;
  isFollowing: boolean;
  followsYou: boolean;
  isMutual: boolean;
  isSelf: boolean;
};

/**
 * Browse a user's followers, following, and mutuals. Real data straight from the
 * follow graph; every row can follow/unfollow and opens the real profile.
 */
export default function FollowListModal({
  userId,
  title,
  initialTab = "followers",
  onClose,
  onOpenProfile,
}: {
  userId: string;
  title: string;
  initialTab?: Tab;
  onClose: () => void;
  onOpenProfile: (userId: string) => void;
}) {
  const data = useQuery(api.social.followLists, { userId: userId as Id<"users"> });
  const follow = useMutation(api.social.follow);
  const unfollow = useMutation(api.social.unfollow);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const rows: Card[] = useMemo(() => {
    if (!data) return [];
    const raw = tab === "followers" ? data.followers : tab === "following" ? data.following : data.mutuals;
    const list = toSafeArray<Card>(raw, { label: `Follow list (${tab})`, source: "api.social.followLists" });
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((c) => c.displayName.toLowerCase().includes(q) || c.username.toLowerCase().includes(q));
  }, [data, tab, query]);

  async function toggle(card: Card) {
    if (card.isSelf) return;
    setBusyId(card.userId);
    try {
      if (card.isFollowing) await unfollow({ userId: card.userId as Id<"users"> });
      else await follow({ userId: card.userId as Id<"users"> });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update follow.");
    } finally {
      setBusyId(null);
    }
  }

  const counts = {
    followers: toSafeArray<Card>(data?.followers, { label: "Followers", source: "api.social.followLists" }).length,
    following: toSafeArray<Card>(data?.following, { label: "Following", source: "api.social.followLists" }).length,
    mutuals: toSafeArray<Card>(data?.mutuals, { label: "Mutuals", source: "api.social.followLists" }).length,
  };

  return (
    <div className="fc-follow-overlay" onClick={onClose}>
      <div className="fc-follow-modal" role="dialog" aria-label={`${title} — followers and following`} onClick={(e) => e.stopPropagation()}>
        <div className="fc-follow-head">
          <strong>{title}</strong>
          <button className="fc-follow-close" aria-label="Close" onClick={onClose}><X size={17} /></button>
        </div>

        <div className="fc-follow-tabs" role="tablist">
          {(["followers", "following", "mutuals"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? "active" : ""}
              onClick={() => setTab(t)}
            >
              {t === "mutuals" ? "Mutuals" : t === "followers" ? "Followers" : "Following"}
              <span>{counts[t]}</span>
            </button>
          ))}
        </div>

        <div className="fc-follow-search">
          <Search size={14} />
          <input
            aria-label="Search this list"
            placeholder="Search by name or @username"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="fc-follow-body">
          {data === undefined && <p className="fc-muted">Loading…</p>}
          {data && !data.visible && (
            <div className="fc-follow-empty">
              <Users size={26} />
              <p>This user keeps their followers and following private.</p>
            </div>
          )}
          {data && data.visible && rows.length === 0 && (
            <div className="fc-follow-empty">
              <Users size={26} />
              <p>{query ? "No one here matches that search." : tab === "mutuals" ? "No mutuals yet." : `No ${tab} yet.`}</p>
            </div>
          )}
          {rows.map((card) => (
            <div key={card.userId} className="fc-follow-row">
              <button className="fc-follow-person" onClick={() => onOpenProfile(card.userId)}>
                <Avatar name={card.displayName} color={card.avatarColor} presence={card.presence} url={card.avatarUrl} size={38} lastSeen={card.lastSeen} decorationId={card.decorationId} />
                <span className="fc-follow-text">
                  <span className="fc-follow-name">
                    {card.displayName}
                    {card.isMutual && <em className="fc-follow-flag mutual">Mutual</em>}
                    {!card.isMutual && card.followsYou && <em className="fc-follow-flag follows-you">Follows you</em>}
                  </span>
                  <small className="fc-follow-sub">
                    @{card.username}
                    {card.customStatus ? ` · ${card.customStatus}` : card.presence === "offline" ? ` · ${formatLastSeen(card.lastSeen)}` : ` · ${PRESENCE_META[card.presence]?.label ?? "Offline"}`}
                  </small>
                </span>
              </button>
              {!card.isSelf && (
                <button
                  className={`fc-follow-btn ${card.isFollowing ? "following" : ""}`}
                  disabled={busyId === card.userId}
                  onClick={() => void toggle(card)}
                >
                  {card.isFollowing ? "Following" : card.followsYou ? "Follow back" : "Follow"}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
