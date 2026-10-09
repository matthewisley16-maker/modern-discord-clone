import { useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { GifValue } from "@/convex/gif";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, EmptyState, GroupIcon, PRESENCE_META, formatLastSeen } from "./ui";
import GroupPhotoEditor from "./GroupPhotoEditor";
import MediaAttachment from "./MediaAttachment";
import GifMessage from "./GifMessage";
import GifPicker from "./GifPicker";
import InlineGif from "./InlineGif";
import MentionText from "./MentionText";
import YouTubeEmbeds from "./YouTubeEmbed";
import { useMessageScroll } from "@/hooks/use-message-scroll";
import { gifUrlsIn } from "@/lib/message-links";
import { handleStorageError } from "@/lib/maintenance";
import { useMentions } from "@/hooks/use-mentions";
import { useMessageSound } from "@/hooks/use-message-sound";
import { useTyping, typingLabel } from "@/hooks/use-typing";
import { normalizeDmMessages } from "@/lib/dm-messages";
import { toSafeArray } from "@/lib/collection";
import { toast } from "sonner";
import { Check, CheckCheck, Copy, FileText, Flag, Lock, MessageCircle, MonitorUp, MoreVertical, Music, Paperclip, Pencil, Phone, Pin, Reply, Search, Send, Smile, Trash2, Users, X } from "lucide-react";

const EMOJIS = ["😀", "😂", "🙌", "❤️", "🔥", "👍", "🎉", "👋", "✨", "😮", "😢", "🙏"];
const REACTIONS = ["👍", "❤️", "😂", "🔥", "🎉"];
const MAX_BYTES = 10 * 1024 * 1024;

type PendingAttachment = { storageId: Id<"_storage">; name: string; size: number; contentType: string; previewUrl?: string };

const isAudio = (contentType: string, name: string) =>
  contentType.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(name);

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export default function DmView({
  conversationId,
  myUserId,
  onOpenProfile,
  onStartCall,
  highlightMessageId,
  onHighlightHandled,
}: {
  conversationId: Id<"dmConversations">;
  myUserId: string;
  onOpenProfile: (userId: string) => void;
  onStartCall: (media: "voice" | "video") => void;
  highlightMessageId?: string | null;
  onHighlightHandled?: () => void;
}) {
  const conversations = useQuery(api.dms.listConversations, {});
  // Normalized once so the conversation list can never be a non-array (null
  // while loading, a legacy {} record, an object, …) and `.find`/`.map` below
  // are always safe.
  const conversationList = useMemo(
    () => toSafeArray<NonNullable<typeof conversations>[number]>(conversations, {
      label: "DM conversations",
      source: "api.dms.listConversations",
    }),
    [conversations],
  );
  const convo = conversationList.find((c) => c.conversationId === conversationId);
  const [search, setSearch] = useState("");
  const messages = useQuery(api.dms.messages, { conversationId, search: search || undefined });
  // The server withholds every message while a locked conversation is locked,
  // so an empty `messageList` here is authoritative — not a UI decision.
  // Accept both the current `{ messages, ... }` shape and a legacy bare array
  // so a build/backend mismatch can never crash the list with `x?.map`.
  const messageList = useMemo(
    () =>
      normalizeDmMessages<NonNullable<typeof messages>["messages"][number]>(messages, {
        conversationId: conversationId as string,
      }),
    [messages, conversationId],
  );
  const unlockConversation = useAction(api.conversationPrivacy.unlockConversation);
  const finishPinReset = useAction(api.conversationPrivacy.finishPinReset);
  const pinState = useQuery(api.conversationPrivacy.pinState, {});
  const [pin, setPinDraft] = useState("");
  const [newPin, setNewPinDraft] = useState("");
  const [confirmPin, setConfirmPinDraft] = useState("");
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState("");
  const [forceNewPin, setForceNewPin] = useState(false);
  // A reset leaves the PIN as the temporary 0000; the server grants nothing in
  // that state, so the gate asks for a real PIN before anything is revealed.
  const needsNewPin = forceNewPin || pinState?.mustChangePin === true;
  const typing = useQuery(api.dms.typingIn, { conversationId });
  const typingList = useMemo(
    () => toSafeArray<NonNullable<typeof typing>[number]>(typing, {
      label: "DM typing indicators",
      source: "api.dms.typingIn",
    }),
    [typing],
  );
  const send = useMutation(api.dms.sendMessage);
  const edit = useMutation(api.dms.editMessage);
  const deleteDmForEveryone = useMutation(api.deletion.deleteDmForEveryone);
  const deleteDmForMe = useMutation(api.deletion.deleteDmForMe);
  const react = useMutation(api.dms.toggleReaction);
  const markRead = useMutation(api.dms.markRead);
  const setPinned = useMutation(api.dms.setPinnedMessage);
  const report = useMutation(api.social.report);
  const generateUploadUrl = useMutation(api.uploads.generateUploadUrl);
  const attach = useMutation(api.uploads.attach);
  const requestCleanup = useMutation(api.storage.requestCleanup);
  const addMembers = useMutation(api.dms.addGroupMembers);
  const renameGroup = useMutation(api.dms.renameGroup);
  const removeMember = useMutation(api.dms.removeGroupMember);
  const leaveGroup = useMutation(api.dms.leaveGroup);
  const setGroupAdmin = useMutation(api.dms.setGroupAdmin);
  const group = useQuery(api.dms.groupDetails, { conversationId });
  const groupMembers = useMemo(
    () => toSafeArray<NonNullable<NonNullable<typeof group>["members"]>[number]>(group?.members, {
      label: "DM group members",
      source: "api.dms.groupDetails",
    }),
    [group],
  );
  const [memberQuery, setMemberQuery] = useState("");
  const memberResults = useQuery(api.users.searchUsers, { q: memberQuery });
  const memberResultList = useMemo(
    () => toSafeArray<NonNullable<typeof memberResults>[number]>(memberResults, {
      label: "DM member search results",
      source: "api.users.searchUsers",
    }),
    [memberResults],
  );

  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<{ id: Id<"dmMessages">; author: string; body: string } | null>(null);
  const [editing, setEditing] = useState<{ id: Id<"dmMessages">; body: string } | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [showGroupPanel, setShowGroupPanel] = useState(false);
  // GIF picker + the selected (not yet sent) GIF.
  const [gifOpen, setGifOpen] = useState(false);
  const [pendingGif, setPendingGif] = useState<GifValue | null>(null);
  const { scrollRef, atBottom, newCount, scrollToBottom, onScroll } = useMessageScroll(conversationId, messageList.length);
  const fileInput = useRef<HTMLInputElement>(null);
  const msgInput = useRef<HTMLInputElement>(null);
  const { onType, stop: stopTyping } = useTyping({ conversationId });
  // @mention autocomplete scoped to this conversation's members.
  const mentions = useMentions({ value: draft, setValue: setDraft, inputRef: msgInput, conversationId });

  useEffect(() => { markRead({ conversationId }).catch(() => {}); setSearch(""); setReplyTo(null); setEditing(null); setGifOpen(false); }, [conversationId, markRead]);

  // Scroll to and flash a message opened from a notification.
  useEffect(() => {
    if (!highlightMessageId || !messages) return;
    const el = document.getElementById(`msg-${highlightMessageId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("fc-message-flash");
    const t = window.setTimeout(() => { el.classList.remove("fc-message-flash"); onHighlightHandled?.(); }, 2400);
    return () => window.clearTimeout(t);
  }, [highlightMessageId, messages, onHighlightHandled]);

  // Play the message SFX on send and when the other person's message arrives.
  const { play: playSound } = useMessageSound();
  const lastCount = useRef<number | null>(null);
  useEffect(() => {
    if (!messages) return;
    if (lastCount.current !== null && messageList.length > lastCount.current) {
      const newest = messageList[messageList.length - 1];
      if (newest && newest.userId !== myUserId) playSound();
    }
    lastCount.current = messageList.length;
  }, [messages, messageList, myUserId, playSound]);

  /**
   * Ask the server to unlock this conversation. The PIN is only ever sent to
   * the backend, which verifies it and grants time-limited access to this
   * session; the returned `mustChangePin` forces the temp-PIN follow-up.
   */
  async function submitPin(e: React.FormEvent) {
    e.preventDefault();
    setPinBusy(true);
    setPinError("");
    try {
      const res = await unlockConversation({ conversationId, pin });
      if (res.granted) {
        setPinDraft("");
        setForceNewPin(false);
      } else if (res.mustChangePin) {
        // Keep the temp PIN in memory: it is the "current PIN" the follow-up
        // new-PIN step must verify.
        setForceNewPin(true);
      }
    } catch (err) {
      setPinError(err instanceof Error ? err.message.replace(/^\[.*?\]\s*/, "").split("\n")[0] : "Could not unlock.");
    } finally {
      setPinBusy(false);
    }
  }

  async function submitNewPin(e: React.FormEvent) {
    e.preventDefault();
    if (newPin !== confirmPin) { setPinError("Those PINs don't match."); return; }
    setPinBusy(true);
    setPinError("");
    try {
      // Replacing the temporary PIN also opens this conversation for the session.
      await finishPinReset({ currentPin: pin, pin: newPin, confirmPin });
      setForceNewPin(false);
      setNewPinDraft("");
      setConfirmPinDraft("");
      setPinDraft("");
      toast.success("New PIN saved.");
    } catch (err) {
      setPinError(err instanceof Error ? err.message.replace(/^\[.*?\]\s*/, "").split("\n")[0] : "Could not save the PIN.");
    } finally {
      setPinBusy(false);
    }
  }

  // The conversation's other participants, normalized: a legacy/malformed
  // `members` value must never break the title or header.
  const convoMembers = useMemo(
    () => toSafeArray<NonNullable<typeof convo>["members"][number]>(convo?.members, {
      label: "DM conversation members",
      source: "api.dms.listConversations",
    }),
    [convo],
  );
  const title = convo?.type === "group" ? convo.name : convoMembers[0]?.displayName ?? "Conversation";
  // The other person's live presence, straight from the same authoritative
  // presence data the DM list and every other surface use. An invisible user
  // arrives here as "offline", so nothing is leaked.
  const other = convoMembers[0];
  const headerStatus = convo?.type === "group"
    ? `${convo.memberCount} members`
    : other
      ? other.presence && other.presence !== "offline" && other.presence !== "invisible"
        ? PRESENCE_META[other.presence]?.label ?? "Offline"
        : formatLastSeen(other.lastSeen)
      : "";

  function clearPending() {
    setPending((prev) => { prev.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl)); return []; });
  }

  function removePending(index: number) {
    setPending((prev) => {
      const next = [...prev];
      const [gone] = next.splice(index, 1);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if ((!draft.trim() && pending.length === 0 && !pendingGif) || busy) return;
    setBusy(true);
    try {
      if (editing) {
        await edit({ messageId: editing.id, body: draft });
        setEditing(null);
      } else {
        // Only sent here, on explicit Send; staged attachments + GIF ride along.
        const fallback = pending.length ? `Shared ${pending.map((p) => p.name).join(", ").slice(0, 120)}` : "";
        const messageId = await send({ conversationId, body: draft.trim() || fallback, replyToId: replyTo?.id, gif: pendingGif ?? undefined });
        for (const att of pending) {
          await attach({ storageId: att.storageId, name: att.name, size: att.size, contentType: att.contentType, dmMessageId: messageId });
        }
        setReplyTo(null);
        setPendingGif(null);
        setGifOpen(false);
        clearPending();
      }
      playSound();
      stopTyping();
      setDraft("");
    } catch (err) {
      // Recoverable storage/usage-limit failure: detached cleanup runs in the
      // background; only this send shows a short retry notice.
      if (!handleStorageError(err, requestCleanup, (m) => toast.error(m))) {
        toast.error(err instanceof Error ? err.message : "Message failed to send.");
      }
    } finally {
      setBusy(false);
    }
  }

  /** Upload the bytes to storage and STAGE the file — nothing is sent yet. */
  async function stageFile(file: File) {
    if (file.size > MAX_BYTES) { toast.error("Files must be 10 MB or smaller."); return; }
    setUploadPct(0);
    try {
      const url = await generateUploadUrl({});
      // Single POST of the file, with progress. The response body holds the storage id.
      const { storageId } = await new Promise<{ storageId: Id<"_storage"> }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", url);
        xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) setUploadPct(Math.round((e.loaded / e.total) * 100)); };
        xhr.onload = () => {
          if (xhr.status < 200 || xhr.status >= 300) { reject(new Error("Upload failed.")); return; }
          try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error("Upload failed.")); }
        };
        xhr.onerror = () => reject(new Error("Upload failed."));
        xhr.send(file);
      });
      const contentType = file.type || "application/octet-stream";
      const previewUrl = contentType.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      setPending((prev) => [...prev, { storageId, name: file.name, size: file.size, contentType, previewUrl }]);
      toast.success(`${file.name} is ready — press Send to post it.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploadPct(null);
    }
  }

  return (
    <div
      className="fc-conversation"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); Array.from(e.dataTransfer.files ?? []).forEach(stageFile); }}
    >
      <header className="fc-conversation-head">
        {/* Direct chats show the person's avatar WITH their live status dot.
            A group shows its OWN photo (or the default group icon) — never a
            member's face — and clicking it opens the group details. */}
        {convo?.type === "group" ? (
          <button
            type="button"
            className="fc-head-icon-button"
            title="Group details"
            aria-label="Open group details"
            aria-expanded={showGroupPanel}
            onClick={() => setShowGroupPanel((v) => !v)}
          >
            <Avatar
              name={title}
              size={28}
              color="violet"
              url={convo.iconUrl ?? group?.iconUrl}
              fallback={<GroupIcon avatarSize={28} />}
            />
          </button>
        ) : (
          <Avatar
            name={title}
            size={28}
            url={other?.avatarUrl}
            decorationId={other?.decorationId}
            presence={other?.presence}
            lastSeen={other?.lastSeen}
          />
        )}
        <div className="fc-head-text">
          <strong>{title}</strong>
          <small>{headerStatus || (other?.username ? `@${other.username}` : "")}</small>
        </div>
        <div className="fc-head-actions">
          <button title="Start voice call" aria-label="Start voice call" onClick={() => onStartCall("voice")}><Phone size={18} /></button>
          <button title="Start video call" aria-label="Start video call" onClick={() => onStartCall("video")}><MonitorUp size={18} /></button>
          {convo?.type === "group" && <button title="Group members" aria-label="Group members" onClick={() => setShowGroupPanel((v) => !v)}><Users size={18} /></button>}
          <div className="fc-search">
            <Search size={14} />
            <input aria-label="Search this conversation" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
      </header>

      {showGroupPanel && convo?.type === "group" && group && (
        <div className="fc-group-panel">
          {/* The group's own photo: shown here, in the header, in the
              Conversations list and in Secret Chats — one server field. */}
          <GroupPhotoEditor
            conversationId={conversationId}
            name={group.name}
            iconUrl={group.iconUrl ?? convo.iconUrl}
            canEdit={group.isOwner || group.isAdmin}
          />
          <div className="fc-group-row">
            {(group.isOwner || group.isAdmin) ? (
              <Input
                defaultValue={group.name}
                maxLength={50}
                aria-label="Group name"
                onBlur={async (e) => {
                  const v = e.target.value.trim();
                  if (v && v !== group.name) { try { await renameGroup({ conversationId, name: v }); toast.success("Group renamed."); } catch (err) { toast.error(err instanceof Error ? err.message : "Rename failed."); } }
                }}
              />
            ) : (
              <strong className="fc-group-title">{group.name}</strong>
            )}
          </div>
          <div className="fc-group-members">
            {groupMembers.map((m) => {
              const canRemove = (group.isOwner || group.isAdmin) && !m.isOwner && m.userId !== myUserId;
              return (
                <div key={m.userId} className="fc-group-member">
                  <Avatar name={m.displayName} color={m.avatarColor} presence={m.presence} size={28} url={m.avatarUrl} decorationId={m.decorationId} />
                  <span>{m.displayName}{m.isOwner ? " · Owner" : m.isAdmin ? " · Admin" : ""}</span>
                  {group.isOwner && !m.isOwner && (
                    <button
                      className="fc-group-promote"
                      onClick={async () => {
                        try { await setGroupAdmin({ conversationId, userId: m.userId as Id<"users">, admin: !m.isAdmin }); toast.success(m.isAdmin ? "Admin removed." : "Promoted to admin."); }
                        catch (err) { toast.error(err instanceof Error ? err.message : "Could not update."); }
                      }}
                    >{m.isAdmin ? "Demote" : "Make admin"}</button>
                  )}
                  {canRemove && (
                    <button aria-label={`Remove ${m.displayName}`} onClick={async () => {
                      try { await removeMember({ conversationId, userId: m.userId as Id<"users"> }); toast.success("Member removed."); }
                      catch (err) { toast.error(err instanceof Error ? err.message : "Could not remove."); }
                    }}><X size={14} /></button>
                  )}
                </div>
              );
            })}
          </div>
          <div className="fc-group-add">
            <Input value={memberQuery} onChange={(e) => setMemberQuery(e.target.value)} placeholder="Add people to this group" />
            {memberQuery.trim() && (
              <div className="fc-group-add-results">
                {memberResultList.filter((r) => !groupMembers.some((m) => m.userId === r.userId)).slice(0, 6).map((r) => (
                  <button
                    key={r.userId}
                    onClick={async () => {
                      try { await addMembers({ conversationId, memberIds: [r.userId as Id<"users">] }); toast.success("Member added."); setMemberQuery(""); }
                      catch (err) { toast.error(err instanceof Error ? err.message : "Could not add."); }
                    }}
                  >{r.displayName} <span className="fc-muted">@{r.username}</span></button>
                ))}
              </div>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={async () => {
            try { await leaveGroup({ conversationId }); toast.success("You left the group."); }
            catch (err) { toast.error(err instanceof Error ? err.message : "Could not leave."); }
          }}>Leave group</Button>
        </div>
      )}

      <div className="fc-messages" ref={scrollRef} onScroll={onScroll}>
        {messages === undefined && <p className="fc-muted">Loading messages…</p>}
        {messages && messages.locked && (
          <div className="fc-lock-gate" role="form" aria-label="Unlock conversation">
            <span className="fc-lock-gate-icon"><Lock size={26} /></span>
            <h3>{needsNewPin ? "Choose a new PIN" : `${title} is locked`}</h3>
            <p className="fc-muted">
              {needsNewPin
                ? "Your PIN was reset to the temporary 0000. Create your own PIN to finish unlocking — nothing is shown until you do."
                : "Enter your PIN to see this conversation. Its messages stay on the server until you do."}
            </p>
            {!needsNewPin ? (
              <form onSubmit={submitPin} className="fc-lock-gate-form">
                <input
                  autoFocus
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={8}
                  value={pin}
                  disabled={pinBusy}
                  aria-label="PIN"
                  placeholder="Enter PIN"
                  onChange={(e) => setPinDraft(e.target.value.replace(/\D/g, ""))}
                />
                <Button type="submit" disabled={pinBusy || pin.length < 4}>{pinBusy ? "Checking…" : "Unlock"}</Button>
              </form>
            ) : (
              <form onSubmit={submitNewPin} className="fc-lock-gate-form">
                <input
                  type="password" inputMode="numeric" pattern="[0-9]*" maxLength={8}
                  value={pin} disabled={pinBusy} aria-label="Current PIN" placeholder="Current PIN (0000)"
                  onChange={(e) => setPinDraft(e.target.value.replace(/\D/g, ""))}
                />
                <input
                  autoFocus type="password" inputMode="numeric" pattern="[0-9]*" maxLength={8}
                  value={newPin} disabled={pinBusy} aria-label="New PIN" placeholder="New PIN (4–8 digits)"
                  onChange={(e) => setNewPinDraft(e.target.value.replace(/\D/g, ""))}
                />
                <input
                  type="password" inputMode="numeric" pattern="[0-9]*" maxLength={8}
                  value={confirmPin} disabled={pinBusy} aria-label="Confirm new PIN" placeholder="Confirm new PIN"
                  onChange={(e) => setConfirmPinDraft(e.target.value.replace(/\D/g, ""))}
                />
                <Button type="submit" disabled={pinBusy || newPin.length < 4 || newPin !== confirmPin}>Save new PIN</Button>
              </form>
            )}
            {pinError && <p className="fc-lock-gate-error">{pinError}</p>}
          </div>
        )}
        {messages && !messages.locked && messageList.length === 0 && !search && (
          <EmptyState
            icon={<MessageCircle size={30} />}
            title={convo?.type === "group" ? `Welcome to ${title}` : `Start a conversation with ${title}`}
            body="Send a message, share a file, or start a call."
          />
        )}
        {messages && !messages.locked && messageList.length === 0 && search && <EmptyState title="No results found." body={`Nothing matches “${search}”.`} />}

        {/* Memoized so typing in the composer does not re-render every message. */}
        {useMemo(() => messageList.map((m) => {
          const mine = m.userId === myUserId;
          const grouped = [...new Set(m.reactions.map((r) => r.emoji))];
          const inlineGifs = gifUrlsIn(m.body);
          return (
            <article key={m._id} id={`msg-${m._id}`} className="fc-message" tabIndex={0}>
              <Avatar name={m.author} color={mine ? "violet" : undefined} size={38} url={m.authorAvatarUrl} decorationId={m.authorDecorationId} />
              <div className="fc-message-body">
                <div className="fc-message-top">
                  <button className="fc-author" onClick={() => onOpenProfile(m.userId)}>{m.author}</button>
                  <span className="fc-time">
                    {new Date(m._creationTime).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    {m.editedAt ? " (edited)" : ""}
                  </span>
                  {mine && <b className="fc-badge">YOU</b>}
                  {m.pinned && <b className="fc-badge pin"><Pin size={9} /> PINNED</b>}
                </div>
                {m.reply && (
                  <div className="fc-reply-quote">
                    <Reply size={12} /> <strong>{m.reply.author}</strong> {m.reply.body}
                  </div>
                )}
                {m.deleted ? (
                  <p className="fc-deleted">This message was deleted.</p>
                ) : (
                  (!m.gif || m.body !== "Sent a GIF") && (
                    <MentionText body={m.body} mentions={m.mentionUsers} onOpenProfile={onOpenProfile} />
                  )
                )}
                {m.gif && <GifMessage gif={m.gif} />}
                {inlineGifs.length > 0 && (
                  <div className="fc-attachments">
                    {inlineGifs.map((u) => <InlineGif key={u} url={u} />)}
                  </div>
                )}
                {/* YouTube links become lazy embeds; the video itself is never copied. */}
                <YouTubeEmbeds body={m.body} />
                {m.attachments.length > 0 && (
                  <div className="fc-attachments">
                    {m.attachments.map((a) => <MediaAttachment key={a._id} attachment={a} />)}
                  </div>
                )}
                <div className="fc-reactions">
                  {grouped.map((emoji) => {
                    const list = m.reactions.filter((r) => r.emoji === emoji);
                    const active = list.some((r) => r.userId === myUserId);
                    return (
                      <button key={emoji} className={active ? "active" : ""} onClick={() => react({ messageId: m._id, emoji })}>
                        {emoji} {list.length}
                      </button>
                    );
                  })}
                  {REACTIONS.slice(0, 3).map((emoji) => (
                    <button key={`add-${emoji}`} className="fc-react-add" aria-label={`React ${emoji}`} onClick={() => react({ messageId: m._id, emoji })}>{emoji}</button>
                  ))}
                </div>
              </div>
              <div className="fc-message-actions">
                <button title="Reply" aria-label="Reply" onClick={() => { setReplyTo({ id: m._id, author: m.author, body: m.body.slice(0, 120) }); setEditing(null); }}><Reply size={15} /></button>
                <button title="Pin" aria-label="Pin message" onClick={async () => { try { await setPinned({ messageId: m._id, pinned: !m.pinned }); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed."); } }}><Pin size={15} /></button>
                <button title="Copy text" aria-label="Copy message text" onClick={async () => { try { await navigator.clipboard.writeText(m.body); toast.success("Copied."); } catch { toast.error("Couldn't copy."); } }}><Copy size={15} /></button>
                <button title="More" aria-label="More actions" onClick={() => setOpenMenu(openMenu === m._id ? null : m._id)}><MoreVertical size={15} /></button>
                {openMenu === m._id && (
                  <div className="fc-menu">
                    {mine && <button onClick={() => { setEditing({ id: m._id, body: m.body }); setDraft(m.body); setReplyTo(null); setOpenMenu(null); }}><Pencil size={13} /> Edit</button>}
                    {/* Delete for me only hides the message for this user. */}
                    <button onClick={async () => { try { await deleteDmForMe({ messageId: m._id }); toast.success("Message hidden for you only."); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed."); } setOpenMenu(null); }}><Trash2 size={13} /> Delete for me</button>
                    {mine && <button className="danger" onClick={async () => { try { await deleteDmForEveryone({ messageId: m._id }); toast.success("Message deleted for everyone."); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed."); } setOpenMenu(null); }}><Trash2 size={13} /> Delete for everyone</button>}
                    <button onClick={async () => { try { await report({ targetType: "dmMessage", targetId: m._id, category: "other", description: "Reported from DM" }); toast.success("Report sent to moderators."); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed."); } setOpenMenu(null); }}><Flag size={13} /> Report</button>
                  </div>
                )}
              </div>
            </article>
          );
        }), [messages, myUserId, openMenu, onOpenProfile, react, setPinned, deleteDmForMe, deleteDmForEveryone, report])}
        {typingList.length > 0 && <p className="fc-typing">{typingLabel(typingList)}</p>}
      </div>

      {!atBottom && newCount > 0 && (
        <button className="fc-new-messages" onClick={() => scrollToBottom(true)}>
          ↓ {newCount} new message{newCount === 1 ? "" : "s"}
        </button>
      )}

      <div className="fc-composer-wrap">
        {replyTo && (
          <div className="fc-reply-bar">
            <Reply size={13} /> Replying to <strong>{replyTo.author}</strong>
            <button aria-label="Cancel reply" onClick={() => setReplyTo(null)}><X size={14} /></button>
          </div>
        )}
        {editing && (
          <div className="fc-reply-bar edit">
            <Pencil size={13} /> Editing message
            <button aria-label="Cancel edit" onClick={() => { setEditing(null); setDraft(""); }}><X size={14} /></button>
          </div>
        )}
        {uploadPct !== null && (
          <div className="fc-upload"><span style={{ width: `${uploadPct}%` }} /> Uploading… {uploadPct}%</div>
        )}
        {/* A staged GIF sits ABOVE the input so the text box stays usable. */}
        {pendingGif && (
          <div className="fc-pending fc-pending-gif" role="list" aria-label="Pending GIF">
            <div className="fc-pending-item" role="listitem">
              <img className="fc-pending-thumb" src={pendingGif.previewUrl} alt="" />
              <span className="fc-pending-text">
                <strong>{pendingGif.title || "GIF"}</strong>
                <small>GIF · not sent yet</small>
              </span>
              <button type="button" aria-label="Remove GIF" onClick={() => setPendingGif(null)}><X size={14} /></button>
            </div>
          </div>
        )}
        {/* Pending attachments sit ABOVE the input so the text box stays usable. */}
        {pending.length > 0 && (
          <div className="fc-pending" role="list" aria-label="Pending attachments">
            {pending.map((p, i) => (
              <div className="fc-pending-item" role="listitem" key={`${p.storageId}-${i}`}>
                {p.previewUrl
                  ? <img className="fc-pending-thumb" src={p.previewUrl} alt="" />
                  : <span className="fc-pending-icon">{isAudio(p.contentType, p.name) ? <Music size={16} /> : <FileText size={16} />}</span>}
                <span className="fc-pending-text">
                  <strong>{p.name}</strong>
                  <small>{fileSize(p.size)} · not sent yet</small>
                </span>
                <button type="button" aria-label={`Remove ${p.name}`} onClick={() => removePending(i)}><X size={14} /></button>
              </div>
            ))}
          </div>
        )}
        {emojiOpen && (
          <div className="fc-emoji-picker">
            {EMOJIS.map((e) => <button key={e} onClick={() => { setDraft(draft + e); setEmojiOpen(false); }}>{e}</button>)}
          </div>
        )}
        {gifOpen && <GifPicker onSelect={(g) => { setPendingGif(g); setGifOpen(false); }} onUploadGif={stageFile} onClose={() => setGifOpen(false)} />}
        {mentions.open && (
          <div className="fc-mention-menu" role="listbox" aria-label="Mention suggestions">
            {mentions.suggestions.map((s, i) => (
              <button
                key={s.userId}
                type="button"
                role="option"
                aria-selected={i === mentions.index}
                className={`fc-mention-item ${i === mentions.index ? "active" : ""}`}
                onMouseEnter={() => mentions.setIndex(i)}
                onMouseDown={(e) => { e.preventDefault(); mentions.choose(s); }}
              >
                <Avatar name={s.displayName} size={26} url={s.avatarUrl} presence={s.presence} decorationId={s.decorationId} />
                <span className="fc-mention-name"><strong>{s.displayName}</strong><small>@{s.username}</small></span>
                {s.isMutual ? <em className="fc-mention-flag mutual">Mutual</em>
                  : s.isFollowing ? <em className="fc-mention-flag following">Following</em>
                    : s.followsYou ? <em className="fc-mention-flag follows-you">Follows you</em> : null}
              </button>
            ))}
          </div>
        )}
        <form className="fc-composer" onSubmit={submit} style={messages?.locked ? { display: "none" } : undefined}>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { Array.from(e.target.files ?? []).forEach(stageFile); e.target.value = ""; }} />
          <button type="button" title="Attach a file" aria-label="Attach a file" onClick={() => fileInput.current?.click()}><Paperclip size={19} /></button>
          <button type="button" title="Add emoji" aria-label="Add emoji" onClick={() => { setEmojiOpen((v) => !v); setGifOpen(false); }}><Smile size={19} /></button>
          <button
            type="button"
            className={`fc-gif-toggle ${gifOpen ? "active" : ""}`}
            title="Add a GIF"
            aria-label="Add a GIF"
            aria-expanded={gifOpen}
            disabled={editing !== null}
            onClick={() => { setGifOpen((v) => !v); setEmojiOpen(false); }}
          >
            <span className="fc-gif-glyph">GIF</span>
          </button>
          <input
            ref={msgInput}
            aria-label="Message"
            value={draft}
            disabled={busy}
            maxLength={4000}
            onChange={(e) => { mentions.onValueChange(e.target.value, e.target.selectionStart); onType(e.target.value); }}
            onKeyDown={mentions.onKeyDown}
            onBlur={() => window.setTimeout(mentions.close, 120)}
            onPaste={(e) => { const files = Array.from(e.clipboardData.files ?? []); if (files.length) { e.preventDefault(); files.forEach(stageFile); } }}
            placeholder={editing ? "Edit your message…" : `Message ${title}`}
          />
          <button type="submit" disabled={(!draft.trim() && pending.length === 0 && !pendingGif) || busy} aria-label="Send message"><Send size={18} /></button>
        </form>
        <div className="fc-composer-note">
          <span>Enter to send · Drag and drop or paste to upload</span>
          <span className="fc-receipt">
            {messages?.readByOthers ? <><CheckCheck size={13} /> Read</> : <><Check size={13} /> Sent</>}
          </span>
        </div>
      </div>
    </div>
  );
}
