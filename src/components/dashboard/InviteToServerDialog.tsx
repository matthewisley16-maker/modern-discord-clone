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
import { Check, Search, UserPlus } from "lucide-react";

type Person = { userId: string; displayName: string; username: string; avatarUrl: string | null; presence?: string };

function ServerOptionBadge({ name, url, color }: { name: string; url: string | null; color: string }) {
  return (
    <span className="fc-server-invite-icon" style={url ? undefined : { background: `${color}33` }}>
      {url ? <img src={url} alt="" /> : initialsOf(name)}
    </span>
  );
}

/**
 * "Invite to Server" — Discord-style invitations delivered through DMs.
 *
 * Two entry points, one dialog:
 *  - From a community (`serverId`): pick friends / search people, choose one or
 *    many, and each gets their own invitation card in a DM. Pending invitations
 *    this user sent can be revoked here too.
 *  - From a conversation (`conversationId`): pick a community the user may invite
 *    to, and the card is posted into the chat that is already open.
 *
 * Everything security-relevant (membership, `createInvites`, privacy, bans,
 * duplicate joins) is enforced by `serverInvites.send` / `respond` on the server.
 */
export default function InviteToServerDialog({
  open,
  onClose,
  serverId,
  serverName,
  serverIconUrl,
  conversationId,
}: {
  open: boolean;
  onClose: () => void;
  serverId?: string | null;
  serverName?: string;
  serverIconUrl?: string | null;
  conversationId?: Id<"dmConversations"> | null;
}) {
  const inConversation = Boolean(conversationId);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [chosenServer, setChosenServer] = useState("");
  const [busy, setBusy] = useState(false);
  const debouncedQuery = useDebouncedValue(query);

  const friends = useQuery(api.social.listFriends, open && !inConversation ? {} : "skip");
  const searchResults = useQuery(
    api.users.searchUsers,
    open && !inConversation && debouncedQuery.trim() ? { q: debouncedQuery.trim() } : "skip",
  );
  const servers = useQuery(api.serverInvites.invitableServers, open && inConversation ? {} : "skip");
  const sentInvites = useQuery(
    api.serverInvites.listSent,
    open && !inConversation && serverId ? { serverId: serverId as Id<"servers"> } : "skip",
  );
  const sendInvite = useMutation(api.serverInvites.send);
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
    () => toSafeArray<{ serverId: string; name: string; iconUrl: string | null; iconColor: string }>(
      servers as { serverId: string; name: string; iconUrl: string | null; iconColor: string }[] | undefined,
      { label: "Communities", source: "api.serverInvites.invitableServers" },
    ),
    [servers],
  );
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

  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      if (inConversation) {
        if (!chosenServer) {
          toast.error("Choose a community to invite them to.");
          return;
        }
        const result = await sendInvite({
          serverId: chosenServer as Id<"servers">,
          conversationId: conversationId!,
        });
        toast.success(result.sent === 1 ? "Invitation sent." : `Invitation sent to ${result.sent} people.`);
        if (result.skipped > 0) {
          toast.info(`${result.skipped} ${result.skipped === 1 ? "person was" : "people were"} skipped — already a member.`);
        }
        onClose();
        return;
      }
      if (!serverId) return;
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

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent className="freecord-dialog">
        <DialogHeader>
          <DialogTitle>Invite to server</DialogTitle>
          <DialogDescription>
            {inConversation
              ? "Send a real invitation into this conversation. Nobody joins until they accept."
              : `Invite people to ${serverName || "this community"} through a direct message.`}
          </DialogDescription>
        </DialogHeader>

        {inConversation ? (
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
          <Button
            onClick={() => void submit()}
            disabled={busy || (inConversation ? !chosenServer : selected.length === 0)}
          >
            <UserPlus className="mr-1 size-4" />
            {busy ? "Sending…" : inConversation ? "Send invitation" : inviteSendLabel(selected.length)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
