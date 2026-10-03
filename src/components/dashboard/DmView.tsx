import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, EmptyState } from "./ui";
import { toast } from "sonner";
import { AtSign, Check, CheckCheck, Copy, Download, FileText, Flag, MessageCircle, MonitorUp, MoreVertical, Paperclip, Pencil, Phone, Pin, Reply, Search, Send, Smile, Trash2, Users, X } from "lucide-react";

const EMOJIS = ["😀", "😂", "🙌", "❤️", "🔥", "👍", "🎉", "👋", "✨", "😮", "😢", "🙏"];
const REACTIONS = ["👍", "❤️", "😂", "🔥", "🎉"];
const MAX_BYTES = 10 * 1024 * 1024;

export default function DmView({
  conversationId,
  myUserId,
  onOpenProfile,
  onStartCall,
}: {
  conversationId: Id<"dmConversations">;
  myUserId: string;
  onOpenProfile: (userId: string) => void;
  onStartCall: (media: "voice" | "video") => void;
}) {
  const conversations = useQuery(api.dms.listConversations, {});
  const convo = conversations?.find((c) => c.conversationId === conversationId);
  const [search, setSearch] = useState("");
  const messages = useQuery(api.dms.messages, { conversationId, search: search || undefined });
  const typing = useQuery(api.dms.typingIn, { conversationId });
  const send = useMutation(api.dms.sendMessage);
  const edit = useMutation(api.dms.editMessage);
  const remove = useMutation(api.dms.deleteMessage);
  const react = useMutation(api.dms.toggleReaction);
  const setTyping = useMutation(api.dms.setTyping);
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
  const [showGroupPanel, setShowGroupPanel] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const typingThrottle = useRef(0);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [messages?.length, conversationId]);
  useEffect(() => { markRead({ conversationId }).catch(() => {}); setSearch(""); setReplyTo(null); setEditing(null); }, [conversationId, markRead]);

  const title = convo?.type === "group" ? convo.name : convo?.members[0]?.displayName ?? "Conversation";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() || busy) return;
    setBusy(true);
    try {
      if (editing) {
        await edit({ messageId: editing.id, body: draft });
        setEditing(null);
      } else {
        await send({ conversationId, body: draft, replyToId: replyTo?.id });
        setReplyTo(null);
      }
      setDraft("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Message failed to send.");
    } finally {
      setBusy(false);
    }
  }

  function onDraftChange(value: string) {
    setDraft(value);
    const now = Date.now();
    if (value && now - typingThrottle.current > 2500) {
      typingThrottle.current = now;
      setTyping({ conversationId }).catch(() => {});
    }
  }

  /** Upload with progress; validates size before sending. */
  async function upload(file: File) {
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
      const messageId = await send({ conversationId, body: `Shared ${file.name}` });
      await attach({ storageId, name: file.name, size: file.size, contentType: file.type || "application/octet-stream", dmMessageId: messageId });
      toast.success("File uploaded.");
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
      onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) upload(f); }}
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
                <Avatar name={m.displayName} color={m.avatarColor} presence={m.presence} size={28} />
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
            <article key={m._id} className="fc-message" tabIndex={0}>
              <Avatar name={m.author} color={mine ? "violet" : undefined} size={38} />
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
                  <p className="fc-text">{m.body}</p>
                )}
                {m.attachments.length > 0 && (
                  <div className="fc-attachments">
                    {m.attachments.map((a) => (
                      <a key={a._id} href={a.url ?? "#"} target="_blank" rel="noreferrer noopener" className="fc-attachment">
                        {a.contentType.startsWith("image/") && a.url ? (
                          <img src={a.url} alt={a.name} loading="lazy" />
                        ) : (
                          <span className="fc-file"><FileText size={16} /> {a.name} <Download size={13} /></span>
                        )}
                      </a>
                    ))}
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
                    {mine && <button className="danger" onClick={async () => { try { await remove({ messageId: m._id }); toast.success("Message deleted."); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed."); } setOpenMenu(null); }}><Trash2 size={13} /> Delete</button>}
                    <button onClick={async () => { try { await report({ targetType: "dmMessage", targetId: m._id, category: "other", description: "Reported from DM" }); toast.success("Report sent to moderators."); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed."); } setOpenMenu(null); }}><Flag size={13} /> Report</button>
                  </div>
                )}
              </div>
            </article>
          );
        })}
        {typing && typing.length > 0 && (
          <p className="fc-typing">{typing.join(", ")} {typing.length === 1 ? "is" : "are"} typing…</p>
        )}
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
        {emojiOpen && (
          <div className="fc-emoji-picker">
            {EMOJIS.map((e) => <button key={e} onClick={() => { setDraft(draft + e); setEmojiOpen(false); }}>{e}</button>)}
          </div>
        )}
        <form className="fc-composer" onSubmit={submit}>
          <input ref={fileInput} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
          <button type="button" title="Attach a file" aria-label="Attach a file" onClick={() => fileInput.current?.click()}><Paperclip size={19} /></button>
          <button type="button" title="Add emoji" aria-label="Add emoji" onClick={() => setEmojiOpen((v) => !v)}><Smile size={19} /></button>
          <input
            aria-label="Message"
            value={draft}
            disabled={busy}
            maxLength={4000}
            onChange={(e) => onDraftChange(e.target.value)}
            onPaste={(e) => { const f = e.clipboardData.files?.[0]; if (f) { e.preventDefault(); upload(f); } }}
            placeholder={editing ? "Edit your message…" : `Message ${title}`}
          />
          <button type="submit" disabled={!draft.trim() || busy} aria-label="Send message"><Send size={18} /></button>
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
