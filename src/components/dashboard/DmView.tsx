import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, EmptyState } from "./ui";
import MediaAttachment from "./MediaAttachment";
import MentionText from "./MentionText";
import { useMentions } from "@/hooks/use-mentions";
import { useMessageSound } from "@/hooks/use-message-sound";
import { useTyping, typingLabel } from "@/hooks/use-typing";
import { toast } from "sonner";
import { AtSign, Check, CheckCheck, Copy, Download, FileText, Flag, MessageCircle, MonitorUp, MoreVertical, Music, Paperclip, Pencil, Phone, Pin, Reply, Search, Send, Smile, Trash2, Users, X } from "lucide-react";

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
  const convo = conversations?.find((c) => c.conversationId === conversationId);
  const [search, setSearch] = useState("");
  const messages = useQuery(api.dms.messages, { conversationId, search: search || undefined });
  const typing = useQuery(api.dms.typingIn, { conversationId });
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
  const addMembers = useMutation(api.dms.addGroupMembers);
  const renameGroup = useMutation(api.dms.renameGroup);
  const removeMember = useMutation(api.dms.removeGroupMember);
  const leaveGroup = useMutation(api.dms.leaveGroup);

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
  const bottom = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const msgInput = useRef<HTMLInputElement>(null);
  const { onType, stop: stopTyping } = useTyping({ conversationId });
  // @mention autocomplete scoped to this conversation's members.
  const mentions = useMentions({ value: draft, setValue: setDraft, inputRef: msgInput, conversationId });

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [messages?.length, conversationId]);
  useEffect(() => { markRead({ conversationId }).catch(() => {}); setSearch(""); setReplyTo(null); setEditing(null); }, [conversationId, markRead]);

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
    if (lastCount.current !== null && messages.length > lastCount.current) {
      const newest = messages[messages.length - 1];
      if (newest && newest.userId !== myUserId) playSound();
    }
    lastCount.current = messages.length;
  }, [messages, myUserId, playSound]);

  const title = convo?.type === "group" ? convo.name : convo?.members[0]?.displayName ?? "Conversation";

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
    if ((!draft.trim() && pending.length === 0) || busy) return;
    setBusy(true);
    try {
      if (editing) {
        await edit({ messageId: editing.id, body: draft });
        setEditing(null);
      } else {
        // Only sent here, on explicit Send; staged attachments ride along.
        const fallback = pending.length ? `Shared ${pending.map((p) => p.name).join(", ").slice(0, 120)}` : "";
        const messageId = await send({ conversationId, body: draft.trim() || fallback, replyToId: replyTo?.id });
        for (const att of pending) {
          await attach({ storageId: att.storageId, name: att.name, size: att.size, contentType: att.contentType, dmMessageId: messageId });
        }
        setReplyTo(null);
        clearPending();
      }
      playSound();
      stopTyping();
      setDraft("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Message failed to send.");
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
        <span className="fc-head-icon">{convo?.type === "group" ? <Users size={20} /> : <AtSign size={20} />}</span>
        <div className="fc-head-text">
          <strong>{title}</strong>
          <small>{convo?.type === "group" ? `${convo.memberCount} members` : convo?.members[0]?.username ? `@${convo.members[0].username}` : ""}</small>
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

      {showGroupPanel && convo?.type === "group" && (
        <div className="fc-group-panel">
          <div className="fc-group-row">
            <Input
              defaultValue={convo.name}
              maxLength={50}
              aria-label="Group name"
              onBlur={async (e) => {
                const v = e.target.value.trim();
                if (v && v !== convo.name) { try { await renameGroup({ conversationId, name: v }); toast.success("Group renamed."); } catch (err) { toast.error(err instanceof Error ? err.message : "Rename failed."); } }
              }}
            />
          </div>
          <div className="fc-group-members">
            {convo.members.map((m) => (
              <div key={m.userId} className="fc-group-member">
                <Avatar name={m.displayName} color={m.avatarColor} presence={m.presence} size={28} url={m.avatarUrl} decorationId={m.decorationId} />
                <span>{m.displayName}</span>
                <button aria-label={`Remove ${m.displayName}`} onClick={async () => {
                  try { await removeMember({ conversationId, userId: m.userId as Id<"users"> }); toast.success("Member removed."); }
                  catch (err) { toast.error(err instanceof Error ? err.message : "Could not remove."); }
                }}><X size={14} /></button>
              </div>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={async () => {
            try { await leaveGroup({ conversationId }); toast.success("You left the group."); }
            catch (err) { toast.error(err instanceof Error ? err.message : "Could not leave."); }
          }}>Leave group</Button>
        </div>
      )}

      <div className="fc-messages">
        {messages === undefined && <p className="fc-muted">Loading messages…</p>}
        {messages && messages.length === 0 && !search && (
          <EmptyState
            icon={<MessageCircle size={30} />}
            title={convo?.type === "group" ? `Welcome to ${title}` : `Start a conversation with ${title}`}
            body="Send a message, share a file, or start a call."
          />
        )}
        {messages && messages.length === 0 && search && <EmptyState title="No results found." body={`Nothing matches “${search}”.`} />}

        {messages?.map((m) => {
          const mine = m.userId === myUserId;
          const grouped = [...new Set(m.reactions.map((r) => r.emoji))];
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
                  <MentionText body={m.body} mentions={m.mentionUsers} onOpenProfile={onOpenProfile} />
                )}
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
        })}
        {typing && typing.length > 0 && <p className="fc-typing">{typingLabel(typing)}</p>}
        <div ref={bottom} />
      </div>

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
        <form className="fc-composer" onSubmit={submit}>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { Array.from(e.target.files ?? []).forEach(stageFile); e.target.value = ""; }} />
          <button type="button" title="Attach a file" aria-label="Attach a file" onClick={() => fileInput.current?.click()}><Paperclip size={19} /></button>
          <button type="button" title="Add emoji" aria-label="Add emoji" onClick={() => setEmojiOpen((v) => !v)}><Smile size={19} /></button>
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
          <button type="submit" disabled={(!draft.trim() && pending.length === 0) || busy} aria-label="Send message"><Send size={18} /></button>
        </form>
        <div className="fc-composer-note">
          <span>Enter to send · Drag and drop or paste to upload</span>
          <span className="fc-receipt">
            {(messages as unknown as { readByOthers?: number })?.readByOthers ? <><CheckCheck size={13} /> Read</> : <><Check size={13} /> Sent</>}
          </span>
        </div>
      </div>
    </div>
  );
}
