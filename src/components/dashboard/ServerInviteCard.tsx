import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Avatar, initialsOf } from "./ui";
import { INVITE_STATUS_LABEL, inviteExpiryLabel, type InviteViewStatus } from "@/lib/server-invites";
import { toast } from "sonner";
import { Check, UserPlus, X } from "lucide-react";

/**
 * One server invitation rendered as a card inside a DM or a community channel.
 *
 * The card is driven by the SAME reactive message subscription the rest of the
 * conversation uses, so it shows the right status after a refresh, in old
 * history and to every member of a group (each with their own row). Accept and
 * Decline only ever call the server, which re-checks who may respond, that the
 * invitation is still pending, and that it hasn't expired.
 */
export type ServerInviteCardData = {
  inviteId: string;
  code: string;
  serverId: string;
  status: InviteViewStatus;
  serverName: string;
  serverDescription: string;
  serverIconUrl: string | null;
  serverIconColor: string;
  serverIsPublic: boolean;
  inviterName: string;
  inviterAvatarUrl: string | null;
  expiresAt: number;
  isRecipient: boolean;
  canRespond: boolean;
  /** True when the invitation was posted in a channel (a shared invite): then
   *  anybody who can see the message may accept it, so there is nothing to
   *  "decline" and the card reports how many people already joined. */
  isOpen: boolean;
  joinCount: number;
};

function ServerBadge({ name, url, color }: { name: string; url: string | null; color: string }) {
  return (
    <span className="fc-server-invite-icon" style={url ? undefined : { background: `${color}33` }}>
      {url ? <img src={url} alt="" /> : initialsOf(name)}
    </span>
  );
}

export default function ServerInviteCard({
  card,
  onOpenCommunity,
}: {
  card: ServerInviteCardData;
  onOpenCommunity?: (serverId: string) => void;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const respond = useMutation(api.serverInvites.respond);
  // Only subscribed while the preview is open, so a page of history doesn't pay
  // for a query per invitation card.
  const preview = useQuery(api.serverInvites.preview, previewOpen ? { code: card.code } : "skip");

  const label = INVITE_STATUS_LABEL[card.status];
  const status = preview?.status ?? card.status;
  const canRespond = preview ? preview.canRespond : card.canRespond;
  // A posted card is a shared invitation: no single addressee, and declining it
  // is not a thing — you either accept it or ignore it.
  const isOpen = preview?.isOpen ?? card.isOpen;
  const joinCount = preview?.joinCount ?? card.joinCount;
  const server = preview?.server ?? null;
  const expiry = inviteExpiryLabel(preview?.expiresAt ?? card.expiresAt);

  async function act(accept: boolean) {
    setBusy(true);
    try {
      const result = await respond({ inviteId: card.inviteId as Id<"serverInviteCards">, accept });
      if (accept) {
        toast.success(result.joined ? `You joined ${card.serverName}.` : `You're already a member of ${card.serverName}.`);
        setPreviewOpen(false);
        onOpenCommunity?.(result.serverId as string);
      } else {
        toast.success("Invitation declined.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not respond to the invitation.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="fc-server-invite">
        <button type="button" className="fc-server-invite-head" onClick={() => setPreviewOpen(true)} aria-label={`Open the ${card.serverName} invitation`}>
          <ServerBadge name={card.serverName} url={card.serverIconUrl} color={card.serverIconColor} />
          <span className="fc-server-invite-text">
            <strong>{card.serverName || "Community invitation"}</strong>
            <small>{isOpen ? `Shared by ${card.inviterName}` : `Invited by ${card.inviterName}`}</small>
          </span>
        </button>
        <div className="fc-server-invite-meta">
          <span className={`fc-server-invite-status ${status}`}>{label}</span>
          {expiry && status !== "expired" && <span>{expiry}</span>}
          <span>{card.serverIsPublic ? "Public community" : "Private community"}</span>
          {isOpen && joinCount > 0 && <span>{joinCount} joined</span>}
        </div>
        <div className="fc-server-invite-actions">
          {canRespond ? (
            <>
              <button type="button" className="primary" disabled={busy} onClick={() => void act(true)}>
                <Check size={13} /> Accept Invite
              </button>
              {!isOpen && (
                <button type="button" disabled={busy} onClick={() => void act(false)}>
                  <X size={13} /> Decline
                </button>
              )}
            </>
          ) : status === "joined" ? (
            <button type="button" onClick={() => onOpenCommunity?.(card.serverId as string)}>
              <UserPlus size={13} /> Open community
            </button>
          ) : (
            <button type="button" onClick={() => setPreviewOpen(true)}>View invitation</button>
          )}
        </div>
      </div>

      <Dialog open={previewOpen} onOpenChange={(next) => { if (!next) setPreviewOpen(false); }}>
        <DialogContent className="freecord-dialog">
          <DialogHeader>
            <DialogTitle>{server?.name ?? card.serverName ?? "Server invitation"}</DialogTitle>
            <DialogDescription>
              {server
                ? `${server.isPublic ? "Public" : "Private"} community · ${server.memberCount} member${server.memberCount === 1 ? "" : "s"}`
                : "This invitation is no longer available."}
            </DialogDescription>
          </DialogHeader>

          <div className="fc-invite-preview">
            <div
              className="fc-invite-preview-banner"
              style={server?.bannerUrl || server?.iconUrl
                ? { backgroundImage: `url(${server?.bannerUrl ?? server?.iconUrl})` }
                : { background: `linear-gradient(135deg, ${card.serverIconColor}55, rgba(20,20,27,.4))` }}
            />
            <div className="fc-invite-preview-row">
              <ServerBadge name={server?.name ?? card.serverName} url={server?.iconUrl ?? card.serverIconUrl} color={server?.iconColor ?? card.serverIconColor} />
              <span className="fc-server-invite-text">
                <strong>{server?.name ?? card.serverName}</strong>
                <small>
                  {server?.description || card.serverDescription || "A Freecord community."}
                </small>
              </span>
            </div>
            <div className="fc-invite-preview-row">
              <Avatar name={preview?.inviter.name ?? card.inviterName} size={26} url={preview?.inviter.avatarUrl ?? card.inviterAvatarUrl} />
              <span className="fc-server-invite-text">
                <small>{isOpen ? "Shared by" : "Invitation from"} <strong>{preview?.inviter.name ?? card.inviterName}</strong></small>
                <small>{expiry || "This invitation is no longer valid."}</small>
                {isOpen && <small>{joinCount} {joinCount === 1 ? "person has" : "people have"} joined through this invitation</small>}
              </span>
            </div>
            <div className="fc-invite-preview-actions">
              <span className={`fc-server-invite-status ${status}`}>{INVITE_STATUS_LABEL[status]}</span>
              <span style={{ marginLeft: "auto" }} />
              {canRespond && (
                <>
                  <Button size="sm" onClick={() => void act(true)} disabled={busy}>Accept Invite</Button>
                  {!isOpen && (
                    <Button size="sm" variant="outline" onClick={() => void act(false)} disabled={busy}>Decline</Button>
                  )}
                </>
              )}
              {status === "joined" && (
                <Button size="sm" onClick={() => { setPreviewOpen(false); onOpenCommunity?.(card.serverId as string); }}>Open community</Button>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setPreviewOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
