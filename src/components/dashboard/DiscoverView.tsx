import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, SectionHeader } from "./ui";
import { toast } from "sonner";
import { Compass, Hash, Plus, Search, Users } from "lucide-react";

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
  const joinedIds = new Set((mine ?? []).map((s) => s._id as string));

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

      {categories && categories.length > 0 && (
        <div className="fc-filter-row">
          <button className={category === null ? "active" : ""} onClick={() => setCategory(null)}>All</button>
          {categories.map((c) => (
            <button key={c} className={category === c ? "active" : ""} onClick={() => setCategory(c)}>{c}</button>
          ))}
        </div>
      )}

      <section className="fc-block">
        <SectionHeader title={`PUBLIC COMMUNITIES — ${results?.length ?? 0}`} />
        {results === undefined && <p className="fc-muted">Loading communities…</p>}
        {results && results.length === 0 && (
          <EmptyState
            icon={<Compass size={30} />}
            title="No communities found."
            body="Try another search, or create your own community to get started."
            action={<Button className="mt-3" onClick={onCreate}><Plus className="mr-1 h-4 w-4" /> Create a community</Button>}
          />
        )}
        <div className="fc-community-grid">
          {results?.map((c) => (
            <article key={c.serverId} className="fc-community-card">
              <div className="fc-community-card-head">
                <span className="fc-community-icon" style={{ background: "linear-gradient(135deg,#7c5cf6,#4c1d95)" }}>{c.name.slice(0, 1).toUpperCase()}</span>
                <div className="min-w-0">
                  <h3>{c.name}</h3>
                  <p className="fc-muted"><Users size={12} /> {c.memberCount} members</p>
                </div>
              </div>
              <p className="fc-community-desc">{c.description || "No description yet."}</p>
              {c.tags.length > 0 && (
                <div className="fc-tag-row">{c.tags.map((t) => <span key={t} className="fc-tag">{t}</span>)}</div>
              )}
              <div className="fc-community-card-actions">
                {joinedIds.has(c.serverId) ? (
                  <Button size="sm" variant="outline" onClick={() => onOpenCommunity(c.serverId)}>Open</Button>
                ) : (
                  <Button size="sm" onClick={async () => {
                    try { await join({ serverId: c.serverId as Id<"servers"> }); toast.success(`Joined ${c.name}`); onOpenCommunity(c.serverId); }
                    catch (e) { toast.error(e instanceof Error ? e.message : "Could not join."); }
                  }}>Join</Button>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
