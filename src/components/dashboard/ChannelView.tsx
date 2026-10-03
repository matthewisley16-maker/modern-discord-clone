import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useMessageSound } from "@/hooks/use-message-sound";
import { useTyping, typingLabel } from "@/hooks/use-typing";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Avatar, EmptyState } from "./ui";
import { toast } from "sonner";
import { CheckCheck, Copy, FileText, Flag, Hash, Link2, Paperclip, Pencil, Pin, Reply, Send, Smile, Trash2, X } from "lucide-react";

const EMOJIS = ["😀", "😂", "🙌", "❤️", "🔥", "👍", "🎉", "👋", "✨", "😮", "😢", "🙏"];
const MAX_BYTES = 10 * 1024 * 1024;

export default function ChannelView({
  channelId,
  channelName,
  channelDescription,
  myUserId,
  permissions,
  onOpenProfile,
  onJoinVoice,
  isVoice,
}: {
  channelId: Id<"channels">;
  channelName: string;
  channelDescription: string;
  myUserId: string;
  permissions: string[];
  onOpenProfile: (userId: string) => void;
  onJoinVoice: () => void;
  isVoice?: boolean;
}) {
  const messages = useQuery(api.chat.messages, { channelId });
  const typing = useQuery(api.communities.typingIn, { channelId });
  const send = useMutation(api.chat.sendMessage);
  const edit = useMutation(api.chat.editMessage);
  const react = useMutation(api.chat.toggleReaction);
  const pin = useMutation(api.chat.pinMessage);
  const report = useMutation(api.social.report);
  const deleteForEveryone = useMutation(api.deletion.deleteForEveryone);
  const deleteForMe = useMutation(api.deletion.deleteForMe);
  const canModerate = useQuery(api.deletion.canModerateHere, { channelId });
  const hiddenIds = useQuery(api.deletion.myHiddenIds, {});
  const generateUploadUrl = useMutation(api.uploads.generateUploadUrl);
  const attach = useMutation(api.uploads.attach);
  const { play: playSound } = useMessageSound();
  const [confirmDelete, setConfirmDelete] = useState<{ messageId: Id<"messages"> } | null>(null);
  const [longPressFor, setLongPressFor] = useState<string | null>(null);
  const pressTimer = useRef<number | null>(null);

  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<{ id: Id<"messages">; author: string; body: string } | null>(null);
  const [editing, setEditing] = useState<{ id: Id<"messages">; body: string } | null>(null);
  const [search, setSearch] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Typing heartbeats are throttled and cleared on send, switch, and unmount.
  const { onType, stop: stopTyping } = useTyping({ channelId });

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [messages?.length, channelId]);
  useEffect(() => { setSearch(""); setReplyTo(null); setEditing(null); setDraft(""); }, [channelId]);

  // Play the message SFX when someone else's message arrives in this channel.
  const lastCount = useRef<number | null>(null);
  useEffect(() => {
    if (!messages) return;
    if (lastCount.current !== null && messages.length > lastCount.current) {
      const newest = messages[messages.length - 1];
      if (newest && newest.userId !== myUserId) playSound();
    }
    lastCount.current = messages.length;
  }, [messages, myUserId, playSound]);

  const canSend = permissions.includes("sendMessages");
  const hidden = new Set(hiddenIds ?? []);
  const visible = messages?.filter((m) => !hidden.has(m._id as string)).filter((m) => !search || m.body.toLowerCase().includes(search.toLowerCase()));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() || busy || !canSend) return;
    setBusy(true);
    try {
      if (editing) { await edit({ messageId: editing.id, body: draft }); setEditing(null); }
      else { await send({ channelId, body: draft, replyToId: replyTo?.id }); setReplyTo(null); }
      playSound();
      stopTyping();
      setDraft("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Message failed to send.");
    } finally { setBusy(false); }
  }

  async function upload(file: File) {
    if (file.size > MAX_BYTES) { toast.error("Files must be 10 MB or smaller."); return; }
    setUploadPct(0);
    try {
      const url = await generateUploadUrl({});
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
      const messageId = await send({ channelId, body: `Shared ${file.name}` });
      await attach({ storageId, name: file.name, size: file.size, contentType: file.type || "application/octet-stream", messageId });
      toast.success("File uploaded.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed.");
    } finally { setUploadPct(null); }
  }

  return (
    <>
    {confirmDelete && (
      <div className="fc-confirm-backdrop" role="dialog" aria-modal="true" aria-label="Confirm delete">
        <div className="fc-confirm">
          <h3>Delete message?</h3>
          <p>Are you sure you want to delete this message for everyone? This action cannot be undone.</p>
          <div className="fc-confirm-actions">
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button variant="destructive" onClick={async () => {
              try { await deleteForEveryone({ messageId: confirmDelete.messageId }); toast.success("Message deleted for everyone."); }
              catch (e) { toast.error(e instanceof Error ? e.message : "Failed."); }
              finally { setConfirmDelete(null); }
            }}>Delete for everyone</Button>
          </div>
        </div>
      </div>
    )}
    <div
      className="fc-conversation"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) upload(f); }}
    >
      <header className="fc-conversation-head">
        <span className="fc-head-icon"><Hash size={20} /></span>
        <div className="fc-head-text">
          <strong>{channelName}</strong>
          <small>{channelDescription}</small>
        </div>
        <div className="fc-head-actions">
          {isVoice && <button className="fc-join-voice" onClick={onJoinVoice}><Smile size={16} /> Join voice</button>}
          <div className="fc-search">
            <input aria-label="Search messages" placeholder="Search messages" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
      </header>

      <div className="fc-messages">
        <div className="fc-channel-welcome">
          <span className="fc-welcome-hash"><Hash size={26} /></span>
          <h2>Welcome to #{channelName}</h2>
          <p>{channelDescription}</p>
        </div>

        {messages === undefined && <p className="fc-muted">Loading messages…</p>}
        {messages && messages.length === 0 && (
          <EmptyState title="A fresh start." body="Be the first to say hello. No sample users or messages here — just your community." />
        )}
        {messages && messages.length > 0 && visible?.length === 0 && <EmptyState title="No results found." body={`Nothing matches “${search}”.`} />}

        {visible?.map((m) => {
          const mine = m.userId === myUserId;
          const grouped = [...new Set(m.reactions.map((r) => r.emoji))];
          return (
            <article
              key={m._id}
              className={`fc-message ${longPressFor === m._id ? "menu-open" : ""}`}
              tabIndex={0}
              onContextMenu={(e) => { e.preventDefault(); setMenuFor(m._id); }}
              onTouchStart={() => {
                if (pressTimer.current) window.clearTimeout(pressTimer.current);
                pressTimer.current = window.setTimeout(() => setMenuFor(m._id), 450);
              }}
              onTouchEnd={() => { if (pressTimer.current) window.clearTimeout(pressTimer.current); }}
              onTouchMove={() => { if (pressTimer.current) window.clearTimeout(pressTimer.current); }}
            >
              <Avatar name={m.author} color={mine ? "violet" : undefined} size={38} url={m.authorAvatarUrl} />
              <div className="fc-message-body">
                <div className="fc-message-top">
                  <button className="fc-author" onClick={() => onOpenProfile(m.userId)}>{m.author}</button>
                  <span className="fc-time">{new Date(m._creationTime).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}{m.editedAt ? " (edited)" : ""}</span>
                  {mine && <b className="fc-badge">YOU</b>}
                  {m.pinned && <b className="fc-badge pin"><Pin size={9} /> PINNED</b>}
                </div>
                {m.reply && (
                  <div className={`fc-reply-quote ${m.reply.deleted ? "deleted" : ""}`}>
                    <Reply size={12} />
                    {m.reply.deleted ? <em>Original message deleted</em> : <><strong>{m.reply.author}</strong> {m.reply.body}</>}
                  </div>
                )}
                <p className="fc-text">{renderMentions(m.body)}</p>
                {m.attachments.length > 0 && (
                  <div className="fc-attachments">
                    {m.attachments.map((a) => (
                      <a key={a._id} href={a.url ?? "#"} target="_blank" rel="noreferrer noopener" className="fc-attachment">
                        {a.isImage && a.url ? <img src={a.url} alt={a.name} loading="lazy" /> : <span className="fc-file"><FileText size={16} /> {a.name}</span>}
                      </a>
                    ))}
                  </div>
                )}
                <div className="fc-reactions">
                  {grouped.map((emoji) => {
                    const list = m.reactions.filter((r) => r.emoji === emoji);
                    return <button key={emoji} className={list.some((r) => r.userId === myUserId) ? "active" : ""} onClick={() => react({ messageId: m._id, emoji })}>{emoji} {list.length}</button>;
                  })}
                </div>
              </div>
              <div className="fc-message-actions">
                <button title="Reply" aria-label="Reply" onClick={() => { setReplyTo({ id: m._id, author: m.author, body: m.body.slice(0, 120) }); setEditing(null); }}><Reply size={15} /></button>
                <button title="Pin" aria-label="Pin message" onClick={async () => { try { await pin({ messageId: m._id, pinned: !m.pinned }); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed."); } }}><Pin size={15} /></button>
                <button title="Copy text" aria-label="Copy message text" onClick={async () => { try { await navigator.clipboard.writeText(m.body); toast.success("Copied."); } catch { toast.error("Couldn't copy."); } }}><Copy size={15} /></button>
                <button title="More" aria-label="More actions" onClick={() => setMenuFor(menuFor === m._id ? null : m._id)}>⋯</button>
                {menuFor === m._id && (
                  <div className="fc-menu" role="menu">
                    <button onClick={() => { setReplyTo({ id: m._id, author: m.author, body: m.body.slice(0, 120) }); setEditing(null); setMenuFor(null); }}><Reply size={13} /> Reply</button>
                    <button onClick={() => { react({ messageId: m._id, emoji: "👍" }).catch(() => {}); setMenuFor(null); }}><Smile size={13} /> Add reaction</button>
                    {mine && <button onClick={() => { setEditing({ id: m._id, body: m.body }); setDraft(m.body); setReplyTo(null); setMenuFor(null); }}><Pencil size={13} /> Edit</button>}
                    <button onClick={() => { pin({ messageId: m._id, pinned: !m.pinned }).catch(() => {}); setMenuFor(null); }}><Pin size={13} /> {m.pinned ? "Unpin" : "Pin"}</button>
                    <button onClick={async () => { try { await navigator.clipboard.writeText(m.body); toast.success("Copied."); } catch { toast.error("Couldn't copy."); } setMenuFor(null); }}><Copy size={13} /> Copy text</button>
                    <button onClick={async () => { try { await navigator.clipboard.writeText(`${window.location.origin}/dashboard?channel=${m.channelId}&message=${m._id}`); toast.success("Message link copied."); } catch { toast.error("Couldn't copy."); } setMenuFor(null); }}><Link2 size={13} /> Copy message link</button>
                    <button onClick={async () => { try { await navigator.clipboard.writeText(m._id); toast.success("Message ID copied."); } catch { toast.error("Couldn't copy."); } setMenuFor(null); }}><Copy size={13} /> Copy message ID</button>
                    {/* Delete for me is always available and only affects this user. */}
                    <button onClick={async () => { try { await deleteForMe({ messageId: m._id }); toast.success("Message hidden for you only."); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed."); } setMenuFor(null); }}>
                      <Trash2 size={13} /> Delete for me
                    </button>
                    {/* Delete for everyone only appears when permitted. */}
                    {(mine || canModerate) && (
                      <button className="danger" onClick={() => { setConfirmDelete({ messageId: m._id }); setMenuFor(null); }}>
                        <Trash2 size={13} /> Delete for everyone
                      </button>
                    )}
                    <button onClick={async () => { try { await report({ targetType: "message", targetId: m._id, category: "other" }); toast.success("Report sent to moderators."); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed."); } setMenuFor(null); }}><Flag size={13} /> Report</button>
                  </div>
                )}
              </div>
            </article>
          );
        })}
        {typing && typing.length > 0 && <p className="fc-typing">{typingLabel(typing)}</p>}
        <div ref={bottom} />
      </div>

      {!canSend ? (
        <div className="fc-composer-locked">You don't have permission to send messages in this channel.</div>
      ) : (
        <div className="fc-composer-wrap">
          {replyTo && <div className="fc-reply-bar"><Reply size={13} /> Replying to <strong>{replyTo.author}</strong><button aria-label="Cancel reply" onClick={() => setReplyTo(null)}><X size={14} /></button></div>}
          {editing && <div className="fc-reply-bar edit"><Pencil size={13} /> Editing message<button aria-label="Cancel edit" onClick={() => { setEditing(null); setDraft(""); }}><X size={14} /></button></div>}
          {uploadPct !== null && <div className="fc-upload"><span style={{ width: `${uploadPct}%` }} /> Uploading… {uploadPct}%</div>}
          {emojiOpen && <div className="fc-emoji-picker">{EMOJIS.map((e) => <button key={e} onClick={() => { setDraft(draft + e); setEmojiOpen(false); }}>{e}</button>)}</div>}
          <form className="fc-composer" onSubmit={submit}>
            <input ref={fileInput} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
            <button type="button" title="Attach a file" aria-label="Attach a file" onClick={() => fileInput.current?.click()}><Paperclip size={19} /></button>
            <button type="button" title="Add emoji" aria-label="Add emoji" onClick={() => setEmojiOpen((v) => !v)}><Smile size={19} /></button>
            <input
              aria-label="Message"
              value={draft}
              disabled={busy}
              maxLength={4000}
              onChange={(e) => { setDraft(e.target.value); onType(e.target.value); }}
              onPaste={(e) => { const f = e.clipboardData.files?.[0]; if (f) { e.preventDefault(); upload(f); } }}
              placeholder={editing ? "Edit your message…" : `Message #${channelName}`}
            />
            <button type="submit" disabled={!draft.trim() || busy} aria-label="Send message"><Send size={18} /></button>
          </form>
          <div className="fc-composer-note"><span>Enter to send · Use @ to mention</span><span className="fc-receipt"><CheckCheck size={13} /> Live</span></div>
        </div>
      )}
    </div>
    </>
  );
}

/** Highlight @mentions, #channels and @role-style tokens without using innerHTML. */
function renderMentions(body: string) {
  const parts = body.split(/(\s+)/);
  return parts.map((part, i) => {
    if (/^@[a-z0-9._-]+$/i.test(part)) return <span key={i} className="fc-mention">{part}</span>;
    if (/^#[a-z0-9-]+$/i.test(part)) return <span key={i} className="fc-channel-mention">{part}</span>;
    return part;
  });
}
