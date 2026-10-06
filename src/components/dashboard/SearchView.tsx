import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { toSafeArray } from "@/lib/collection";
import { Avatar, EmptyState, SectionHeader } from "./ui";
import { Hash, Search, Users } from "lucide-react";

export default function SearchView({
  query,
  onOpenProfile,
  onOpenCommunity,
}: {
  query: string;
  onOpenProfile: (id: string) => void;
  onOpenCommunity: (id: string) => void;
}) {
  const [filter, setFilter] = useState<"all" | "people" | "communities" | "messages" | "channels">("all");
  const results = useQuery(api.search.global, query.trim() ? { q: query, filter } : "skip");
  // Each result bucket is normalized so a malformed payload can never crash a render.
  const peopleList = useMemo(() => toSafeArray<NonNullable<NonNullable<typeof results>["people"]>[number]>(results?.people, { label: "Search people", source: "api.search.global" }), [results]);
  const communityResults = useMemo(() => toSafeArray<NonNullable<NonNullable<typeof results>["communities"]>[number]>(results?.communities, { label: "Search communities", source: "api.search.global" }), [results]);
  const channelResults = useMemo(() => toSafeArray<NonNullable<NonNullable<typeof results>["channels"]>[number]>(results?.channels, { label: "Search channels", source: "api.search.global" }), [results]);
  const messageResults = useMemo(() => toSafeArray<NonNullable<NonNullable<typeof results>["messages"]>[number]>(results?.messages, { label: "Search messages", source: "api.search.global" }), [results]);

  if (!query.trim()) {
    return (
      <div className="fc-scroll-view">
        <div className="fc-view-head"><Search size={20} /><h2>Search</h2></div>
        <EmptyState
          icon={<Search size={30} />}
          title="Search Freecord"
          body="Find people, communities, channels, and messages. Private communities and other people's DMs are never shown."
        />
      </div>
    );
  }

  const total = results ? peopleList.length + communityResults.length + messageResults.length + channelResults.length : 0;

  return (
    <div className="fc-scroll-view">
      <div className="fc-view-head"><Search size={20} /><h2>Results for “{query}”</h2></div>

      <div className="fc-filter-row">
        {(["all", "people", "communities", "channels", "messages"] as const).map((f) => (
          <button key={f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>
            {f[0].toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {results === undefined && <p className="fc-muted">Searching…</p>}
      {results && total === 0 && <EmptyState icon={<Search size={30} />} title="No results found." body={`Nothing matched “${query}”. Try a different search.`} />}

      {peopleList.length > 0 && (
        <section className="fc-block">
          <SectionHeader title={`PEOPLE — ${peopleList.length}`} />
          {peopleList.map((p) => (
            <button key={p.userId} className="fc-row fc-row-main" onClick={() => onOpenProfile(p.userId)}>
              <Avatar name={p.displayName} color={p.avatarColor} url={p.avatarUrl} decorationId={p.decorationId} />
              <span><strong>{p.displayName}</strong><small>@{p.username}</small></span>
            </button>
          ))}
        </section>
      )}

      {communityResults.length > 0 && (
        <section className="fc-block">
          <SectionHeader title={`COMMUNITIES — ${communityResults.length}`} />
          {communityResults.map((c) => (
            <button key={c.serverId} className="fc-row fc-row-main" onClick={() => onOpenCommunity(c.serverId)}>
              <span className="fc-community-icon" style={{ background: "linear-gradient(135deg,#7c5cf6,#4c1d95)" }}>{c.name.slice(0, 1).toUpperCase()}</span>
              <span><strong>{c.name}</strong><small>{c.description || "No description"} · {c.memberCount} members</small></span>
            </button>
          ))}
        </section>
      )}

      {channelResults.length > 0 && (
        <section className="fc-block">
          <SectionHeader title={`CHANNELS — ${channelResults.length}`} />
          {channelResults.map((c) => (
            <div key={c.channelId} className="fc-row">
              <div className="fc-row-main"><Hash size={16} /><span><strong>{c.name}</strong><small>{c.communityName}</small></span></div>
            </div>
          ))}
        </section>
      )}

      {messageResults.length > 0 && (
        <section className="fc-block">
          <SectionHeader title={`MESSAGES — ${messageResults.length}`} />
          {messageResults.map((m) => (
            <div key={m.messageId} className="fc-row">
              <div className="fc-row-main">
                <Users size={16} />
                <span>
                  <strong>{m.author}</strong>
                  <small>{m.body}</small>
                  <small className="fc-muted">#{m.channelName} · {m.communityName} · {new Date(m.createdAt).toLocaleDateString()}</small>
                </span>
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
