import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toSafeArray } from "@/lib/collection";
import { communityCoverUrl, communityInitial } from "@/lib/community-cover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, SectionHeader } from "./ui";
import { toast } from "sonner";
import { Compass, Hash, Plus, Search, Users } from "lucide-react";

type DiscoveredCommunity = {
  serverId: string;
  name: string;
  description: string;
  iconUrl?: string | null;
  memberCount: number;
  tags: string[];
  category: string;
};

/**
 * One discovery card.
 *
 * The cover is the community's OWN uploaded art (`iconUrl`, derived server-side
 * from `servers.iconStorageId`) shown with `object-cover` so it is cropped, never
 * stretched. With no cover — or if the image fails to load — the original
 * gradient placeholder with the community's initial is shown instead, so the card
 * never collapses or shows a broken image.
 */
function CommunityCard({
  community,
  joined,
  onOpen,
  onJoin,
}: {
  community: DiscoveredCommunity;
  joined: boolean;
  onOpen: () => void;
  onJoin: () => Promise<void>;
}) {
  const [failed, setFailed] = useState(false);
  const cover = communityCoverUrl({ iconUrl: community.iconUrl, failed });
  const tags = toSafeArray<string>(community.tags);
  return (
    <article className="fc-community-card">
      <div className="fc-community-cover">
        {cover ? (
          <img
            src={cover}
            alt={`${community.name} cover`}
            loading="lazy"
            decoding="async"
            /* A replaced cover is a NEW storage object with a new URL, so this
               only ever fires for a deleted/unreachable file. */
            onError={() => setFailed(true)}
          />
        ) : (
          <span className="fc-community-cover-fallback" aria-hidden>
            {communityInitial(community.name)}
          </span>
        )}
      </div>
      <div className="fc-community-card-head">
        <div className="min-w-0">
          <h3>{community.name}</h3>
          <p className="fc-muted"><Users size={12} /> {community.memberCount} members</p>
        </div>
      </div>
      <p className="fc-community-desc">{community.description || "No description yet."}</p>
      {tags.length > 0 && (
        <div className="fc-tag-row">{tags.map((t) => <span key={t} className="fc-tag">{t}</span>)}</div>
      )}
      <div className="fc-community-card-actions">
        {joined ? (
          <Button size="sm" variant="outline" onClick={onOpen}>Open</Button>
        ) : (
          <Button size="sm" onClick={onJoin}>Join</Button>
        )}
      </div>
    </article>
  );
}

export default function DiscoverView({
  onOpenCommunity,
  onCreate,
  onJoinByCode,
}: {
  onOpenCommunity: (id: string) => void;
  onCreate: () => void;
  onJoinByCode: () => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const categories = useQuery(api.communities.categories, {});
  const results = useQuery(api.communities.discover, { q: query || undefined, category: category ?? undefined });
  const join = useMutation(api.communities.join);
  const mine = useQuery(api.communities.listMine, {});
  // Collections normalized once so a malformed payload can never crash a render.
  const categoryList = useMemo(() => toSafeArray<NonNullable<typeof categories>[number]>(categories, { label: "Community categories", source: "api.communities.categories" }), [categories]);
  const resultList = useMemo(() => toSafeArray<NonNullable<typeof results>[number]>(results, { label: "Discovered communities", source: "api.communities.discover" }), [results]);
  const joinedIds = new Set(toSafeArray<NonNullable<typeof mine>[number]>(mine, { label: "Your communities", source: "api.communities.listMine" }).map((s) => s._id as string));

  return (
    <div className="fc-scroll-view">
      <div className="fc-view-head">
        <Compass size={20} />
        <h2>Discover Communities</h2>
        <div className="fc-view-head-actions">
          <Button size="sm" variant="outline" onClick={onJoinByCode}><Hash className="mr-1 h-4 w-4" /> Join with invite</Button>
          <Button size="sm" onClick={onCreate}><Plus className="mr-1 h-4 w-4" /> Create community</Button>
        </div>
      </div>

      <div className="fc-discover-search">
        <Search size={16} />
        <Input placeholder="Search public communities" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search communities" />
      </div>

      {categoryList.length > 0 && (
        <div className="fc-filter-row">
          <button className={category === null ? "active" : ""} onClick={() => setCategory(null)}>All</button>
          {categoryList.map((c) => (
            <button key={c} className={category === c ? "active" : ""} onClick={() => setCategory(c)}>{c}</button>
          ))}
        </div>
      )}

      <section className="fc-block">
        <SectionHeader title={`PUBLIC COMMUNITIES — ${resultList.length}`} />
        {results === undefined && <p className="fc-muted">Loading communities…</p>}
        {results && resultList.length === 0 && (
          <EmptyState
            icon={<Compass size={30} />}
            title="No communities found."
            body="Try another search, or create your own community to get started."
            action={<Button className="mt-3" onClick={onCreate}><Plus className="mr-1 h-4 w-4" /> Create a community</Button>}
          />
        )}
        <div className="fc-community-grid">
          {resultList.map((c) => (
            <CommunityCard
              key={c.serverId}
              community={c as DiscoveredCommunity}
              joined={joinedIds.has(c.serverId)}
              onOpen={() => onOpenCommunity(c.serverId)}
              onJoin={async () => {
                try { await join({ serverId: c.serverId as Id<"servers"> }); toast.success(`Joined ${c.name}`); onOpenCommunity(c.serverId); }
                catch (e) { toast.error(e instanceof Error ? e.message : "Could not join."); }
              }}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
