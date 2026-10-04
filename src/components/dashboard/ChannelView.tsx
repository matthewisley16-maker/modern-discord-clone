import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useMessageSound } from "@/hooks/use-message-sound";
import { useTyping, typingLabel } from "@/hooks/use-typing";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { GifValue } from "@/convex/gif";
import { Avatar, EmptyState } from "./ui";
import MediaAttachment from "./MediaAttachment";
import GifMessage from "./GifMessage";
import GifPicker from "./GifPicker";
import InlineGif from "./InlineGif";
import MentionText from "./MentionText";
import { gifUrlsIn } from "@/lib/message-links";
import { useMentions } from "@/hooks/use-mentions";
import { toast } from "sonner";
import { CheckCheck, Copy, FileText, Flag, Hash, Music, Paperclip, Pencil, Pin, Reply, Send, Smile, Trash2, X } from "lucide-react";

const EMOJIS = ["😀", "😂", "🙌", "❤️", "🔥", "👍", "🎉", "👋", "✨", "😮", "😢", "🙏"];
const MAX_BYTES = 10 * 1024 * 1024;

/** A file uploaded to storage that is staged in the composer, not yet sent. */
type PendingAttachment = { storageId: Id<"_storage">; name: string; size: number; contentType: string; previewUrl?: string };

const isAudio = (contentType: string, name: string) =>
  contentType.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(name);

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export default function ChannelView({
  channelId,
  channelName,
  channelDescription,
  myUserId,
  permissions,
  onOpenProfile,
  onJoinVoice,
  isVoice,
  highlightMessageId,
  onHighlightHandled,
  serverId,
}: {
  channelId: Id<"channels">;
  serverId?: Id<"servers">;
  channelName: string;
  channelDescription: string;
  myUserId: string;
  permissions: string[];
  onOpenProfile: (userId: string) => void;
  onJoinVoice: () => void;
  isVoice?: boolean;
  highlightMessageId?: string | null;
  onHighlightHandled?: () => void;
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
  // Files are staged here, uploaded to storage, and only attached on Send.
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  // GIF picker + the selected (not yet sent) GIF.
  const [gifOpen, setGifOpen] = useState(false);
  const [pendingGif, setPendingGif] = useState<GifValue | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const msgInput = useRef<HTMLInputElement>(null);
  // Typing heartbeats are throttled and cleared on send, switch, and unmount.
  const { onType, stop: stopTyping } = useTyping({ channelId });
  // @mention autocomplete — real users, prioritized by the viewer's follows.
  const mentions = useMentions({ value: draft, setValue: setDraft, inputRef: msgInput, serverId });

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [messages?.length, channelId]);
  useEffect(() => { setSearch(""); setReplyTo(null); setEditing(null); setDraft(""); setGifOpen(false); }, [channelId]);

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
    if ((!draft.trim() && pending.length === 0 && !pendingGif) || busy || !canSend) return;
    setBusy(true);
    try {
      if (editing) {
        await edit({ messageId: editing.id, body: draft });
        setEditing(null);
      } else {
        // The message is only sent here, on explicit Send. Attachments and the
        // selected GIF ride along.
        const fallback = pending.length ? `Shared ${pending.map((p) => p.name).join(", ").slice(0, 120)}` : "";
        const messageId = await send({ channelId, body: draft.trim() || fallback, replyToId: replyTo?.id, gif: pendingGif ?? undefined });
        for (const att of pending) {
          await attach({ storageId: att.storageId, name: att.name, size: att.size, contentType: att.contentType, messageId });
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
      toast.error(err instanceof Error ? err.message : "Message failed to send.");
    } finally { setBusy(false); }
  }

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

  /**
   * Upload the bytes to storage and STAGE the file. Nothing is sent until the
   * user presses Send, so the text box stays available for a caption.
   */
  async function stageFile(file: File) {
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
      const contentType = file.type || "application/octet-stream";
      const previewUrl = contentType.startsWith("image/")
        ? URL.createObjectURL(file)
        : undefined;
      setPending((prev) => [...prev, { storageId, name: file.name, size: file.size, contentType, previewUrl }]);
      toast.success(`${file.name} is ready — press Send to post it.`);
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
      onDrop={(e) => { e.preventDefault(); setDragging(false); Array.from(e.dataTransfer.files ?? []).forEach(stageFile); }}
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
          const inlineGifs = gifUrlsIn(m.body);
          return (
            <article
              key={m._id}
              id={`msg-${m._id}`}
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
              <Avatar name={m.author} color={mine ? "violet" : undefined} size={38} url={m.authorAvatarUrl} decorationId={m.authorDecorationId} />
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
                {(!m.gif || m.body !== "Sent a GIF") && (
                  <MentionText body={m.body} mentions={m.mentionUsers} onOpenProfile={onOpenProfile} />
                )}
                {m.gif && <GifMessage gif={m.gif} />}
                {inlineGifs.length > 0 && (
                  <div className="fc-attachments">
                    {inlineGifs.map((u) => <InlineGif key={u} url={u} />)}
                  </div>
                )}
                {m.attachments.length > 0 && (
                  <div className="fc-attachments">
                    {m.attachments.map((a) => <MediaAttachment key={a._id} attachment={a} />)}
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
          {emojiOpen && <div className="fc-emoji-picker">{EMOJIS.map((e) => <button key={e} onClick={() => { setDraft(draft + e); setEmojiOpen(false); }}>{e}</button>)}</div>}
          {gifOpen && <GifPicker onSelect={(g) => { setPendingGif(g); setGifOpen(false); }} onClose={() => setGifOpen(false)} />}
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
              placeholder={editing ? "Edit your message…" : `Message #${channelName}`}
            />
            <button type="submit" disabled={(!draft.trim() && pending.length === 0 && !pendingGif) || busy} aria-label="Send message"><Send size={18} /></button>
          </form>
          <div className="fc-composer-note"><span>Enter to send · Use @ to mention</span><span className="fc-receipt"><CheckCheck size={13} /> Live</span></div>
        </div>
      )}
    </div>
    </>
  );
}


