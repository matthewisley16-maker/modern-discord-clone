import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Avatar, initialsOf } from "./ui";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { inviteSendLabel } from "@/lib/server-invites";
import { toSafeArray } from "@/lib/collection";
import { toast } from "sonner";
import { Check, Hash, MessageSquare, Search, UserPlus } from "lucide-react";

type Person = { userId: string; displayName: string; username: string; avatarUrl: string | null; presence?: string };
type ServerOption = { serverId: string; name: string; iconUrl: string | null; iconColor: string };
type ChannelOption = {
  channelId: string;
  channelName: string;
  serverId: string;
  serverName: string;
  iconUrl: string | null;
  iconColor: string;
};

/** The community's icon, or its initials when it has none. */
function ServerOptionBadge({ name, url, color }: { name: string; url: string | null; color: string }) {
  return (
    <span className="fc-server-invite-icon" style={url ? undefined : { background: `${color}33` }}>
      {url ? <img src={url} alt="" /> : initialsOf(name)}
    </span>
  );
}

/**
 * "Invite to Server" — Discord-style invitations, delivered either through DMs
 * or posted into a community channel.
 *
 * Three entry points, one dialog:
 *  - From a community (`serverId`): pick friends / search people and DM each one
 *    their own invitation card, or switch the destination to "Post in a channel"
 *    and share the invitation into one of the user's own channels. Pending
 *    invitations this user sent can be revoked here too.
 *  - From a DM conversation (`conversationId`): pick a community the user may
 *    invite to and the card is posted into the chat that is already open.
 *  - From a community channel (`channelId`): pick which community to invite
 *    people to and the card is posted into the channel that is already open.
 *
 * Everything security-relevant (membership, `createInvites`, send permission in
 * the host channel, privacy, bans, duplicate joins) is enforced on the server by
 * `serverInvites.send` / `postToChannel` / `respond` — never by hiding a button.
 */
export default function InviteToServerDialog({
  open,
  onClose,
  serverId,
  serverName,
  serverIconUrl,
  conversationId,
  channelId,
}: {
  open: boolean;
  onClose: () => void;
  serverId?: string | null;
  serverName?: string;
  serverIconUrl?: string | null;
  conversationId?: Id<"dmConversations"> | null;
  channelId?: Id<"channels"> | null;
}) {
  /** Delivering into an existing chat (DM conversation or community channel). */
  const inChat = Boolean(conversationId || channelId);
  const [destination, setDestination] = useState<"dm" | "channel">("dm");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [chosenServer, setChosenServer] = useState("");
  const [chosenChannel, setChosenChannel] = useState("");
  const [busy, setBusy] = useState(false);
  const debouncedQuery = useDebouncedValue(query);

  // Which channel to post into: the one already open, or (from a community) a
  // channel the user may send in.
  const postingChannelId = channelId ?? (destination === "channel" ? chosenChannel || null : null);

  const friends = useQuery(
    api.social.listFriends,
    open && !inChat && destination === "dm" ? {} : "skip",
  );
  const searchResults = useQuery(
    api.users.searchUsers,
    open && !inChat && destination === "dm" && debouncedQuery.trim() ? { q: debouncedQuery.trim() } : "skip",
  );
  const servers = useQuery(api.serverInvites.invitableServers, open && (inChat || Boolean(serverId)) ? {} : "skip");
  const channels = useQuery(
    api.serverInvites.postableChannels,
    open && Boolean(serverId) && destination === "channel" ? {} : "skip",
  );
  const sentInvites = useQuery(
    api.serverInvites.listSent,
    open && !inChat && serverId ? { serverId: serverId as Id<"servers"> } : "skip",
  );
  const sendInvite = useMutation(api.serverInvites.send);
  const postInvite = useMutation(api.serverInvites.postToChannel);
  const revokeInvite = useMutation(api.serverInvites.revoke);

  const friendList = useMemo(
    () => toSafeArray<Person>(friends as Person[] | undefined, { label: "Friends", source: "api.social.listFriends" }),
    [friends],
  );
  const resultList = useMemo(
    () => toSafeArray<Person>(searchResults as Person[] | undefined, { label: "People", source: "api.users.searchUsers" }),
    [searchResults],
  );
  const serverList = useMemo(
    () => toSafeArray<ServerOption>(servers as ServerOption[] | undefined, {
      label: "Communities",
      source: "api.serverInvites.invitableServers",
    }),
    [servers],
  );
  const channelList = useMemo(
    () => toSafeArray<ChannelOption>(channels as ChannelOption[] | undefined, {
      label: "Channels",
      source: "api.serverInvites.postableChannels",
    }),
    [channels],
  );
  /** Postable channels grouped per community, so one community's channels stay together. */
  const channelGroups = useMemo(() => {
    const groups = new Map<string, ChannelOption[]>();
    for (const channel of channelList) {
      const list = groups.get(channel.serverId) ?? [];
      list.push(channel);
      groups.set(channel.serverId, list);
    }
    return [...groups.values()];
  }, [channelList]);
  const pendingSent = useMemo(
    () => toSafeArray<{ inviteId: string; recipientName: string; status: string; canRevoke: boolean }>(
      sentInvites as { inviteId: string; recipientName: string; status: string; canRevoke: boolean }[] | undefined,
      { label: "Sent invitations", source: "api.serverInvites.listSent" },
    ).filter((row) => row.status === "pending"),
    [sentInvites],
  );

  // Friends first, then people found by search who aren't already listed.
  const people = useMemo(() => {
    const seen = new Set(friendList.map((p) => p.userId));
    return [...friendList, ...resultList.filter((p) => !seen.has(p.userId))];
  }, [friendList, resultList]);

  function toggle(userId: string) {
    setSelected((prev) => (prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]));
  }

  /** Share the invitation into the channel this dialog is posting to. */
  async function post(server: string) {
    if (!postingChannelId) {
      toast.error("Choose a channel to post the invitation in.");
      return;
    }
    const result = await postInvite({
      serverId: server as Id<"servers">,
      channelId: postingChannelId as Id<"channels">,
    });
    toast.success(result.posted ? "Invitation posted in the channel." : "Invitation posted.");
    onClose();
  }

  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      // Into a community channel: pick which community to invite people to.
      if (channelId) {
        if (!chosenServer) {
          toast.error("Choose a community to invite them to.");
          return;
        }
        await post(chosenServer);
        return;
      }
      // Into an open DM conversation.
      if (conversationId) {
        if (!chosenServer) {
          toast.error("Choose a community to invite them to.");
          return;
        }
        const result = await sendInvite({
          serverId: chosenServer as Id<"servers">,
          conversationId,
        });
        toast.success(result.sent === 1 ? "Invitation sent." : `Invitation sent to ${result.sent} people.`);
        if (result.skipped > 0) {
          toast.info(`${result.skipped} ${result.skipped === 1 ? "person was" : "people were"} skipped — already a member.`);
        }
        onClose();
        return;
      }
      if (!serverId) return;
      // From a community, posted into one of the user's own channels.
      if (destination === "channel") {
        await post(serverId);
        return;
      }
      if (selected.length === 0) {
        toast.error("Choose at least one person to invite.");
        return;
      }
      const result = await sendInvite({
        serverId: serverId as Id<"servers">,
        recipientIds: selected.map((id) => id as Id<"users">),
      });
      toast.success(result.sent === 1 ? "Invitation sent." : `Invitations sent to ${result.sent} people.`);
      if (result.skipped > 0) {
        toast.info(`${result.skipped} ${result.skipped === 1 ? "person was" : "people were"} skipped — already a member or unavailable.`);
      }
      setSelected([]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send the invitation.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(inviteId: string) {
    try {
      const result = await revokeInvite({ inviteId: inviteId as Id<"serverInviteCards"> });
      toast.success(result.revoked ? "Invitation revoked." : "That invitation was already resolved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not revoke the invitation.");
    }
  }

  const activeServer = destination === "channel"
    ? channelGroups.flat().find((c) => c.channelId === postingChannelId)
    : undefined;
  const canSubmit = channelId
    ? Boolean(chosenServer)
    : conversationId
      ? Boolean(chosenServer)
      : destination === "channel"
        ? Boolean(postingChannelId)
        : selected.length > 0;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent className="freecord-dialog">
        <DialogHeader>
          <DialogTitle>{channelId ? "Share an invite here" : "Invite to server"}</DialogTitle>
          <DialogDescription>
            {channelId
              ? "Post a real invitation into this channel. Anyone who can see it can accept it — nobody joins until they do."
              : conversationId
                ? "Send a real invitation into this conversation. Nobody joins until they accept."
                : `Invite people to ${serverName || "this community"} by direct message, or post the invitation in one of your channels.`}
          </DialogDescription>
        </DialogHeader>

        {/* From a community: choose where the invitation goes. Both destinations
            use the same permission-checked backend, so a posted card is a real
            invitation, not a link nobody can redeem. */}
        {!inChat && serverId && (
          <div className="fc-invite-destination" role="tablist" aria-label="Where to send the invitation">
            <button
              type="button"
              role="tab"
              aria-selected={destination === "dm"}
              className={destination === "dm" ? "active" : ""}
              onClick={() => setDestination("dm")}
            >
              <MessageSquare size={14} /> Direct messages
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={destination === "channel"}
              className={destination === "channel" ? "active" : ""}
              onClick={() => setDestination("channel")}
            >
              <Hash size={14} /> Post in a channel
            </button>
          </div>
        )}

        {channelId ? (
          <div className="fc-invite-picker">
            <span className="fc-field-label">Community</span>
            {servers === undefined && <p className="fc-muted">Loading your communities…</p>}
            {servers !== undefined && serverList.length === 0 && (
              <p className="fc-muted">You can&apos;t invite people to any community yet.</p>
            )}
            <div className="fc-invite-picker-list" role="radiogroup" aria-label="Community">
              {serverList.map((server) => (
                <button
                  key={server.serverId}
                  type="button"
                  role="radio"
                  aria-checked={chosenServer === server.serverId}
                  className={`fc-invite-person ${chosenServer === server.serverId ? "selected" : ""}`}
                  onClick={() => setChosenServer(server.serverId)}
                >
                  <ServerOptionBadge name={server.name} url={server.iconUrl} color={server.iconColor} />
                  <span>{server.name}</span>
                  {chosenServer === server.serverId && <Check size={15} style={{ marginLeft: "auto" }} />}
                </button>
              ))}
            </div>
            <p className="fc-muted">The invitation appears as a card in this channel, with an Accept Invite button.</p>
          </div>
        ) : inChat ? (
          <div className="fc-invite-picker">
            <span className="fc-field-label">Community</span>
            {servers === undefined && <p className="fc-muted">Loading your communities…</p>}
            {servers !== undefined && serverList.length === 0 && (
              <p className="fc-muted">You can&apos;t invite people to any community yet.</p>
            )}
            <div className="fc-invite-picker-list" role="radiogroup" aria-label="Community">
              {serverList.map((server) => (
                <button
                  key={server.serverId}
                  type="button"
                  role="radio"
                  aria-checked={chosenServer === server.serverId}
                  className={`fc-invite-person ${chosenServer === server.serverId ? "selected" : ""}`}
                  onClick={() => setChosenServer(server.serverId)}
                >
                  <ServerOptionBadge name={server.name} url={server.iconUrl} color={server.iconColor} />
                  <span>{server.name}</span>
                  {chosenServer === server.serverId && <Check size={15} style={{ marginLeft: "auto" }} />}
                </button>
              ))}
            </div>
            <p className="fc-muted">Everyone else in this conversation gets their own invitation card.</p>
          </div>
        ) : destination === "channel" ? (
          <div className="fc-invite-picker">
            <span className="fc-field-label">Channel</span>
            {channels === undefined && <p className="fc-muted">Loading your channels…</p>}
            {channels !== undefined && channelGroups.length === 0 && (
              <p className="fc-muted">You can&apos;t post in any channel yet.</p>
            )}
            <div className="fc-invite-picker-list" role="radiogroup" aria-label="Channel">
              {channelGroups.map((group) => (
                <div key={group[0].serverId} className="fc-invite-channel-group">
                  <span className="fc-field-label">{group[0].serverName}</span>
                  {group.map((channel) => (
                    <button
                      key={channel.channelId}
                      type="button"
                      role="radio"
                      aria-checked={chosenChannel === channel.channelId}
                      className={`fc-invite-person ${chosenChannel === channel.channelId ? "selected" : ""}`}
                      onClick={() => setChosenChannel(channel.channelId)}
                    >
                      <span className="fc-server-invite-icon" style={channel.iconUrl ? undefined : { background: `${channel.iconColor}33` }}>
                        {channel.iconUrl ? <img src={channel.iconUrl} alt="" /> : <Hash size={14} />}
                      </span>
                      <span>
                        <strong>#{channel.channelName}</strong>
                        <br />
                        <small>{channel.serverName}</small>
                      </span>
                      {chosenChannel === channel.channelId && <Check size={15} style={{ marginLeft: "auto" }} />}
                    </button>
                  ))}
                </div>
              ))}
            </div>
            {activeServer && (
              <p className="fc-muted">
                The invitation to {serverName || "this community"} appears as a card in #{activeServer.channelName}.
              </p>
            )}
          </div>
        ) : (
          <div className="fc-invite-picker">
            <div className="fc-invite-preview-row">
              <ServerOptionBadge name={serverName || "Community"} url={serverIconUrl ?? null} color="violet" />
              <span className="fc-server-invite-text">
                <strong>{serverName || "This community"}</strong>
                <small>Members aren&apos;t shown here — they&apos;re already in.</small>
              </span>
            </div>
            <div className="fc-search" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Search size={14} />
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search friends by name or username"
                aria-label="Search people to invite"
              />
            </div>
            {friends === undefined && <p className="fc-muted">Loading your friends…</p>}
            {friends !== undefined && people.length === 0 && (
              <p className="fc-muted">
                {query.trim() ? `Nobody matches “${query.trim()}”.` : "Add some friends first, or search for people by name."}
              </p>
            )}
            <div className="fc-invite-picker-list" role="listbox" aria-label="People">
              {people.map((person) => {
                const isSelected = selected.includes(person.userId);
                return (
                  <button
                    key={person.userId}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`fc-invite-person ${isSelected ? "selected" : ""}`}
                    onClick={() => toggle(person.userId)}
                  >
                    <Avatar name={person.displayName} size={28} url={person.avatarUrl} presence={person.presence} />
                    <span>
                      {person.displayName}
                      {person.username && <><br /><small>@{person.username}</small></>}
                    </span>
                    {isSelected ? <Check size={15} style={{ marginLeft: "auto" }} /> : <span className="tag">Invite</span>}
                  </button>
                );
              })}
            </div>

            {pendingSent.length > 0 && (
              <div className="fc-invite-sent-list">
                <span className="fc-field-label">Pending invitations</span>
                {pendingSent.slice(0, 6).map((row) => (
                  <div key={row.inviteId} className="fc-invite-sent">
                    <span>{row.recipientName}</span>
                    <small>· waiting</small>
                    {row.canRevoke && (
                      <button type="button" className="revoke" onClick={() => void revoke(row.inviteId)}>
                        Revoke
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy || !canSubmit}>
            {channelId || destination === "channel" ? <Hash className="mr-1 size-4" /> : <UserPlus className="mr-1 size-4" />}
            {busy
              ? "Sending…"
              : channelId || destination === "channel"
                ? "Post invitation"
                : inChat
                  ? "Send invitation"
                  : inviteSendLabel(selected.length)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
