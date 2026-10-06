import { useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toSafeArray } from "@/lib/collection";
import { Button } from "@/components/ui/button";
import { Avatar, EmptyState, SectionHeader, formatLastSeen } from "./ui";
import { toast } from "sonner";
import { Check, MessageCircle, Phone, UserPlus, Users, Video, X } from "lucide-react";

export default function HomeView({
  onOpenProfile,
  onMessage,
  onDiscover,
  onCall,
}: {
  onOpenProfile: (id: string) => void;
  onMessage: (id: Id<"dmConversations">) => void;
  onDiscover: () => void;
  onCall?: (userId: string, media: "voice" | "video") => void;
}) {
  const friends = useQuery(api.social.listFriends, {});
  const requests = useQuery(api.social.listRequests, {});
  const following = useQuery(api.social.listFollowing, {});
  const people = useQuery(api.users.searchUsers, { q: "" });
  // Collections normalized once; a malformed payload can never crash a render.
  const friendList = useMemo(() => toSafeArray<NonNullable<typeof friends>[number]>(friends, { label: "Friends", source: "api.social.listFriends" }), [friends]);
  const incomingRequests = useMemo(() => toSafeArray<NonNullable<NonNullable<typeof requests>["incoming"]>[number]>(requests?.incoming, { label: "Incoming friend requests", source: "api.social.listRequests" }), [requests]);
  const outgoingRequests = useMemo(() => toSafeArray<NonNullable<NonNullable<typeof requests>["outgoing"]>[number]>(requests?.outgoing, { label: "Outgoing friend requests", source: "api.social.listRequests" }), [requests]);
  const followingList = useMemo(() => toSafeArray<NonNullable<typeof following>[number]>(following, { label: "Following", source: "api.social.listFollowing" }), [following]);
  const peopleList = useMemo(() => toSafeArray<NonNullable<typeof people>[number]>(people, { label: "People search results", source: "api.users.searchUsers" }), [people]);
  const respond = useMutation(api.social.respondFriendRequest);
  const cancel = useMutation(api.social.cancelFriendRequest);
  const startDirect = useMutation(api.dms.startDirect);
  const sendRequest = useMutation(api.social.sendFriendRequest);

  async function run(label: string, fn: () => Promise<unknown>) {
    try { await fn(); toast.success(label); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Action failed."); }
  }

  const friendIds = new Set(friendList.map((f) => f.userId as string));
  const suggestions = peopleList.filter((p) => !friendIds.has(p.userId)).slice(0, 6);

  return (
    <div className="fc-scroll-view">
      <div className="fc-view-head">
        <Users size={20} />
        <h2>Friends</h2>
      </div>

      {incomingRequests.length > 0 && (
        <section className="fc-block">
          <SectionHeader title={`INCOMING REQUESTS — ${incomingRequests.length}`} />
          {incomingRequests.map((r) => (
            <div key={r.requestId} className="fc-row">
              <button className="fc-row-main" onClick={() => onOpenProfile(r.userId)}>
                <Avatar name={r.displayName} color={r.avatarColor} presence={r.presence} url={r.avatarUrl} decorationId={r.decorationId} dotSide="left" showAllStates />
                <span><strong>{r.displayName}</strong><small>@{r.username}</small></span>
              </button>
              <div className="fc-row-actions">
                <Button size="sm" onClick={() => run("Friend request accepted", () => respond({ requestId: r.requestId, accept: true }))}><Check className="h-4 w-4" /></Button>
                <Button size="sm" variant="outline" onClick={() => run("Request declined", () => respond({ requestId: r.requestId, accept: false }))}><X className="h-4 w-4" /></Button>
              </div>
            </div>
          ))}
        </section>
      )}

      {outgoingRequests.length > 0 && (
        <section className="fc-block">
          <SectionHeader title="OUTGOING REQUESTS" />
          {outgoingRequests.map((r) => (
            <div key={r.requestId} className="fc-row">
              <div className="fc-row-main">
                <Avatar name={r.displayName} color={r.avatarColor} presence={r.presence} url={r.avatarUrl} decorationId={r.decorationId} dotSide="left" showAllStates />
                <span><strong>{r.displayName}</strong><small>Waiting for a response</small></span>
              </div>
              <Button size="sm" variant="ghost" onClick={() => run("Request cancelled", () => cancel({ requestId: r.requestId }))}>Cancel</Button>
            </div>
          ))}
        </section>
      )}

      <section className="fc-block">
        <SectionHeader title={`ALL FRIENDS — ${friendList.length}`} />
        {friends && friendList.length === 0 ? (
          <EmptyState
            icon={<Users size={30} />}
            title="Your friends list is empty."
            body="Find people to connect with."
            action={<Button className="mt-3" onClick={onDiscover}>Discover communities</Button>}
          />
        ) : (
          friendList.map((f) => (
            <div key={f.userId} className="fc-row">
              <button className="fc-row-main" onClick={() => onOpenProfile(f.userId)}>
                <Avatar name={f.displayName} color={f.avatarColor} presence={f.presence} url={f.avatarUrl} lastSeen={f.lastSeen} decorationId={f.decorationId} dotSide="left" showAllStates />
                <span>
                  <strong>{f.displayName}</strong>
                  <small>{f.presence === "offline" ? formatLastSeen(f.lastSeen) : f.customStatus || `@${f.username}`}</small>
                </span>
              </button>
              <div className="fc-row-actions">
                <Button size="sm" variant="outline" onClick={() => run("Conversation opened", async () => { const id = await startDirect({ userId: f.userId as Id<"users"> }); onMessage(id); })}>
                  <MessageCircle className="mr-1 h-4 w-4" /> Message
                </Button>
                {onCall && (
                  <>
                    <Button size="sm" variant="outline" aria-label="Voice call" title="Voice call" onClick={() => onCall(f.userId, "voice")}><Phone className="h-4 w-4" /></Button>
                    <Button size="sm" variant="outline" aria-label="Video call" title="Video call" onClick={() => onCall(f.userId, "video")}><Video className="h-4 w-4" /></Button>
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </section>

      <section className="fc-block">
        <SectionHeader title="PEOPLE YOU MIGHT KNOW" />
        {suggestions.length === 0 ? (
          <p className="fc-muted">No suggestions right now.</p>
        ) : (
          suggestions.map((p) => (
            <div key={p.userId} className="fc-row">
              <button className="fc-row-main" onClick={() => onOpenProfile(p.userId)}>
                <Avatar name={p.displayName} color={p.avatarColor} presence={p.presence} url={p.avatarUrl} decorationId={p.decorationId} dotSide="left" showAllStates />
                <span><strong>{p.displayName}</strong><small>@{p.username}</small></span>
              </button>
              <Button size="sm" variant="outline" onClick={() => run("Friend request sent", () => sendRequest({ toId: p.userId as unknown as Id<"users"> }))}>
                <UserPlus className="mr-1 h-4 w-4" /> Add
              </Button>
            </div>
          ))
        )}
      </section>

      <section className="fc-block">
        <SectionHeader title={`FOLLOWING — ${followingList.length}`} />
        {following && followingList.length === 0 ? (
          <p className="fc-muted">You're not following anyone yet. Following is separate from friendship.</p>
        ) : (
          followingList.map((f) => (
            <div key={f.userId} className="fc-row">
              <button className="fc-row-main" onClick={() => onOpenProfile(f.userId)}>
                <Avatar name={f.displayName} color={f.avatarColor} presence={f.presence} url={f.avatarUrl} decorationId={f.decorationId} dotSide="left" showAllStates />
                <span><strong>{f.displayName}</strong><small>@{f.username}</small></span>
              </button>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
