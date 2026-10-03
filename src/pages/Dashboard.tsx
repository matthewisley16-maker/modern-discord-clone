import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/hooks/use-auth";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import CallPanel from "@/components/CallPanel";
import DmView from "@/components/dashboard/DmView";
import ChannelView from "@/components/dashboard/ChannelView";
import HomeView from "@/components/dashboard/HomeView";
import DiscoverView from "@/components/dashboard/DiscoverView";
import SearchView from "@/components/dashboard/SearchView";
import ProfileDrawer from "@/components/dashboard/ProfileDrawer";
import SettingsPanel from "@/components/dashboard/SettingsPanel";
import { Avatar, colorFor, initialsOf, PRESENCE_META } from "@/components/dashboard/ui";
import { toast } from "sonner";
import {
  AtSign, Bell, Check, Compass, Hash, Headphones, Home, LogOut, Menu, Mic, Phone, Plus,
  Search, Settings, Users, Volume2, X,
} from "lucide-react";

type Section = "home" | "dms" | "discover" | "search" | "community";
type Modal = "create" | "join" | "channel" | "invite" | "createCommunity" | null;

export default function Dashboard() {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const me = useQuery(api.users.me, {});
  const communities = useQuery(api.communities.listMine, {});
  const conversations = useQuery(api.dms.listConversations, {});
  const notifications = useQuery(api.social.listNotifications, {});
  const dmUnread = useQuery(api.dms.unreadTotal, {});
  const voiceSession = useQuery(api.communities.myVoiceSession, {});
  const incomingCall = useQuery(api.calls.incomingCall, {});
  const outgoingCall = useQuery(api.calls.outgoingCall, {});

  const setStatus = useMutation(api.users.setStatus);
  const heartbeat = useMutation(api.users.heartbeat);
  const createCommunity = useMutation(api.communities.create);
  const joinByCode = useMutation(api.communities.joinByCode);
  const createChannel = useMutation(api.communities.createChannel);
  const leaveCommunity = useMutation(api.communities.leave);
  const markAllRead = useMutation(api.social.markAllNotificationsRead);
  const markRead = useMutation(api.social.markNotificationRead);
  const leaveVoice = useMutation(api.communities.leaveVoice);
  const respondCall = useMutation(api.calls.respondCall);
  const cancelCall = useMutation(api.calls.cancelCall);
  const inviteCall = useMutation(api.calls.inviteCall);
  const setMuted = useMutation(api.dms.setMuted);
  const setPinned = useMutation(api.dms.setPinned);

  const [section, setSection] = useState<Section>("home");
  const [communityId, setCommunityId] = useState<Id<"servers"> | null>(null);
  const [channelId, setChannelId] = useState<Id<"channels"> | null>(null);
  const [conversationId, setConversationId] = useState<Id<"dmConversations"> | null>(null);
  const [profileUserId, setProfileUserId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [channelType, setChannelType] = useState<"text" | "voice">("text");
  const [busy, setBusy] = useState(false);
  const [inCall, setInCall] = useState<{ channelId: Id<"channels">; name: string } | null>(null);

  const details = useQuery(api.communities.details, communityId ? { serverId: communityId } : "skip");
  const channel = details?.channels.find((c) => c._id === channelId) ?? details?.channels.find((c) => c.type !== "voice");

  // Presence heartbeat so others see us online, and resume any voice session.
  useEffect(() => {
    heartbeat({}).catch(() => {});
    const t = setInterval(() => heartbeat({}).catch(() => {}), 30_000);
    return () => clearInterval(t);
  }, [heartbeat]);
  useEffect(() => {
    if (voiceSession) setInCall({ channelId: voiceSession.channelId, name: voiceSession.channelName });
  }, [voiceSession]);

  // Keep the selected community valid.
  useEffect(() => {
    if (communityId && details && !details.channels.some((c) => c._id === channelId)) {
      setChannelId(details.channels.find((c) => c.type !== "voice")?._id ?? null);
    }
  }, [details, communityId, channelId]);

  function openCommunity(id: string) {
    setCommunityId(id as Id<"servers">);
    setChannelId(null);
    setSection("community");
    setMobileNav(false);
  }

  function openConversation(id: Id<"dmConversations">) {
    setConversationId(id);
    setSection("dms");
    setMobileNav(false);
  }

  function openModal(next: Modal) {
    setValue("");
    setDescription("");
    setChannelType("text");
    setModal(next);
  }

  async function handleModal(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (modal === "createCommunity") {
        const id = await createCommunity({ name: value, description, isPublic });
        openCommunity(id);
        setSection("discover");
      } else if (modal === "join") {
        const id = await joinByCode({ code: value });
        openCommunity(id);
      } else if (modal === "channel" && communityId) {
        const id = await createChannel({ serverId: communityId, name: value, type: channelType });
        setChannelId(id);
      }
      setModal(null);
      toast.success("All set!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function joinVoice(channelId: Id<"channels">, name: string) {
    setInCall({ channelId, name });
  }

  async function startDmCall(media: "voice" | "video") {
    if (!conversationId) return;
    const convo = conversations?.find((c) => c.conversationId === conversationId);
    const target = convo?.members[0];
    if (!target) { toast.error("There's no one else in this conversation to call."); return; }
    try {
      await inviteCall({ toId: target.userId as Id<"users">, conversationId, media });
      toast.success(`Ringing ${target.displayName}…`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start the call.");
    }
  }

  const statusMeta = PRESENCE_META[me?.presence ?? "online"] ?? PRESENCE_META.online;
  const hasUnread = (notifications?.unread ?? 0) > 0;

  return (
    <div className="fc-shell">
      {/* ---------- Server rail ---------- */}
      <aside className={`fc-rail ${mobileNav ? "hide-mobile" : ""}`} aria-label="Communities">
        <Link to="/" className="fc-rail-logo" aria-label="Freecord home">
          <svg viewBox="0 0 64 64" width="26" height="26" aria-hidden="true">
            <rect width="64" height="64" rx="18" fill="url(#fcg)" />
            <defs><linearGradient id="fcg" x1="0" y1="0" x2="64" y2="64"><stop offset="0" stopColor="#9d7bff" /><stop offset="1" stopColor="#6d3ff5" /></linearGradient></defs>
            <g stroke="#fff" strokeWidth="5" strokeLinecap="round"><path d="M16 27v10M24 18v28M32 24v16M40 14v36M48 26v12" /></g>
          </svg>
        </Link>
        <div className="fc-rail-rule" />
        <button
          className={`fc-rail-btn ${section === "home" ? "selected" : ""}`}
          title="Home" aria-label="Home"
          onClick={() => { setSection("home"); setMobileNav(false); }}
        ><Home size={20} /></button>
        <button
          className={`fc-rail-btn ${section === "dms" ? "selected" : ""}`}
          title="Direct messages" aria-label="Direct messages"
          onClick={() => { setSection("dms"); setMobileNav(false); }}
        ><AtSign size={20} />{(dmUnread ?? 0) > 0 && <i className="fc-rail-badge">{dmUnread}</i>}</button>
        <button
          className={`fc-rail-btn ${section === "discover" ? "selected" : ""}`}
          title="Discover" aria-label="Discover communities"
          onClick={() => { setSection("discover"); setMobileNav(false); }}
        ><Compass size={20} /></button>

        <div className="fc-rail-rule" />
        {communities?.map((c) => (
          <button
            key={c._id}
            className={`fc-rail-server ${communityId === c._id && section === "community" ? "selected" : ""}`}
            title={c.name} aria-label={c.name}
            onClick={() => openCommunity(c._id)}
          >{initialsOf(c.name)}</button>
        ))}
        <button className="fc-rail-server add" title="Create a community" aria-label="Create a community" onClick={() => openModal("createCommunity")}><Plus size={20} /></button>
        <button className="fc-rail-server add" title="Join with invite" aria-label="Join with invite" onClick={() => openModal("join")}><Hash size={18} /></button>

        <button className="fc-rail-btn bottom" title="Sign out" aria-label="Sign out" onClick={async () => { await signOut(); navigate("/"); }}>
          <LogOut size={19} />
        </button>
      </aside>

      {/* ---------- Secondary sidebar ---------- */}
      <aside className={`fc-sidebar ${mobileNav ? "open" : ""}`}>
        {section === "community" && details ? (
          <>
            <div className="fc-sidebar-head">
              <span className="fc-sidebar-title">{details.server.name}</span>
              <button className="fc-close-mobile" aria-label="Close menu" onClick={() => setMobileNav(false)}><X size={17} /></button>
            </div>
            <div className="fc-sidebar-banner">
              <span className="fc-sidebar-banner-star">✳</span>
              <span>{details.server.description || "A little space. A lot of possibility."}</span>
            </div>
            <div className="fc-sidebar-section">
              <span>TEXT CHANNELS</span>
              {details.permissions.includes("createChannels") && (
                <button aria-label="Create channel" onClick={() => openModal("channel")}><Plus size={15} /></button>
              )}
            </div>
            {details.channels.filter((c) => c.type !== "voice").map((c) => (
              <button key={c._id} className={`fc-channel ${channel?._id === c._id ? "active" : ""}`} onClick={() => { setChannelId(c._id); setMobileNav(false); }}>
                <Hash size={17} /> {c.name}
              </button>
            ))}
            <div className="fc-sidebar-section"><span>VOICE CHANNELS</span></div>
            {details.channels.filter((c) => c.type === "voice").map((c) => (
              <button key={c._id} className="fc-channel" onClick={() => joinVoice(c._id, c.name)}>
                <Volume2 size={17} /> {c.name}
              </button>
            ))}
            <button className="fc-invite-btn" onClick={() => openModal("invite")}>
              <Users size={16} /> Invite your people
            </button>
            {!details.isOwner && (
              <button className="fc-leave-btn" onClick={async () => {
                try { await leaveCommunity({ serverId: communityId! }); toast.success("You left the community."); setCommunityId(null); setSection("home"); }
                catch (e) { toast.error(e instanceof Error ? e.message : "Could not leave."); }
              }}>Leave community</button>
            )}
          </>
        ) : (
          <>
            <div className="fc-sidebar-head">
              <span className="fc-sidebar-title">Direct Messages</span>
              <button className="fc-close-mobile" aria-label="Close menu" onClick={() => setMobileNav(false)}><X size={17} /></button>
            </div>
            <button className="fc-sidebar-action" onClick={() => { setSection("home"); setMobileNav(false); }}><Users size={17} /> Friends</button>
            <button className="fc-sidebar-action" onClick={() => { setSection("discover"); setMobileNav(false); }}><Compass size={17} /> Discover</button>
            <button className="fc-sidebar-action" onClick={() => { setSection("search"); setMobileNav(false); }}><Search size={17} /> Search</button>

            <div className="fc-sidebar-section"><span>CONVERSATIONS</span></div>
            {conversations && conversations.length === 0 && (
              <p className="fc-sidebar-empty">No conversations yet. Start one from your friends list.</p>
            )}
            {conversations?.map((c) => (
              <div key={c.conversationId} className="fc-dm-row">
                <button
                  className={`fc-dm ${conversationId === c.conversationId && section === "dms" ? "active" : ""}`}
                  onClick={() => openConversation(c.conversationId)}
                >
                  <Avatar name={c.name} size={26} />
                  <span className="fc-dm-name">{c.name}</span>
                  {c.pinned && <span className="fc-dm-flag">📌</span>}
                  {c.muted && <span className="fc-dm-flag">🔇</span>}
                  {c.unread > 0 && <i className="fc-dm-badge">{c.unread}</i>}
                </button>
                <div className="fc-dm-tools">
                  <button title="Pin" aria-label="Pin conversation" onClick={() => setPinned({ conversationId: c.conversationId, pinned: !c.pinned })}>📌</button>
                  <button title="Mute" aria-label="Mute conversation" onClick={() => setMuted({ conversationId: c.conversationId, muted: !c.muted })}>🔇</button>
                </div>
              </div>
            ))}
          </>
        )}

        {/* User panel */}
        <div className="fc-user-panel">
          <Avatar name={me?.profile?.displayName ?? me?.username ?? "You"} presence={me?.presence} size={34} />
          <div className="fc-user-text">
            <strong>{me?.profile?.displayName ?? me?.username ?? "…"}</strong>
            <small>{me?.profile?.customStatus || statusMeta.label}</small>
          </div>
          <select
            aria-label="Set your status"
            className="fc-status-select"
            value={me?.presence ?? "online"}
            onChange={async (e) => { try { await setStatus({ status: e.target.value as never }); } catch { toast.error("Could not set status."); } }}
          >
            <option value="online">Online</option>
            <option value="idle">Idle</option>
            <option value="dnd">Do Not Disturb</option>
            <option value="invisible">Invisible</option>
          </select>
          <button aria-label="Open settings" onClick={() => setSettingsOpen(true)}><Settings size={18} /></button>
        </div>
      </aside>

      {/* ---------- Main ---------- */}
      <main className="fc-main">
        <header className="fc-topbar">
          <button className="fc-menu-btn" aria-label="Open navigation" onClick={() => setMobileNav((v) => !v)}><Menu size={20} /></button>
          <div className="fc-global-search">
            <Search size={15} />
            <input
              aria-label="Search Freecord"
              placeholder="Search people, communities, messages"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); if (e.target.value) setSection("search"); }}
              onKeyDown={(e) => { if (e.key === "Enter") setSection("search"); }}
            />
          </div>
          <div className="fc-topbar-actions">
            <button className="fc-bell" aria-label="Notifications" onClick={() => setNotifOpen((v) => !v)}>
              <Bell size={19} />
              {hasUnread && <i className="fc-bell-dot">{notifications?.unread}</i>}
            </button>
          </div>
        </header>

        {notifOpen && (
          <div className="fc-notif-panel">
            <div className="fc-notif-head">
              <strong>Notifications</strong>
              <button onClick={async () => { await markAllRead({}); toast.success("All caught up."); }}>Mark all read</button>
            </div>
            {notifications && notifications.items.length === 0 && <p className="fc-sidebar-empty">You're all caught up.</p>}
            {notifications?.items.map((n) => (
              <button key={n._id} className={`fc-notif ${n.read ? "" : "unread"}`} onClick={async () => { await markRead({ id: n._id }); }}>
                <strong>{n.title}</strong>
                {n.body && <small>{n.body}</small>}
                <small className="fc-muted">{new Date(n._creationTime).toLocaleString()}</small>
              </button>
            ))}
          </div>
        )}

        <div className="fc-main-body">
          <div className="fc-main-content">
            {section === "home" && <HomeView onOpenProfile={setProfileUserId} onMessage={openConversation} onDiscover={() => setSection("discover")} />}
            {section === "discover" && <DiscoverView onOpenCommunity={openCommunity} onCreate={() => openModal("createCommunity")} onJoinByCode={() => openModal("join")} />}
            {section === "search" && <SearchView query={searchQuery} onOpenProfile={setProfileUserId} onOpenCommunity={openCommunity} />}
            {section === "dms" && (
              conversationId ? (
                <DmView conversationId={conversationId} myUserId={me?.userId ?? ""} onOpenProfile={setProfileUserId} onStartCall={startDmCall} />
              ) : (
                <div className="fc-scroll-view">
                  <div className="fc-view-head"><AtSign size={20} /><h2>Direct Messages</h2></div>
                  <div className="fc-empty">
                    <AtSign size={30} />
                    <h3>Start a conversation with someone on Freecord.</h3>
                    <p>Open your friends list and pick someone to message.</p>
                    <Button className="mt-3" onClick={() => setSection("home")}>Go to friends</Button>
                  </div>
                </div>
              )
            )}
            {section === "community" && details && channel && (
              <ChannelView
                channelId={channel._id}
                channelName={channel.name}
                channelDescription={channel.description}
                myUserId={me?.userId ?? ""}
                permissions={details.permissions}
                onOpenProfile={setProfileUserId}
                onJoinVoice={() => joinVoice(channel._id, channel.name)}
                isVoice={channel.type === "voice"}
              />
            )}
            {section === "community" && details && !channel && (
              <div className="fc-scroll-view"><div className="fc-empty"><h3>No text channels yet.</h3><p>Create one to start talking.</p></div></div>
            )}
          </div>

          {section === "community" && details && (
            <aside className="fc-members" aria-label="Community members">
              <div className="fc-members-head">MEMBERS — {details.members.length}</div>
              {details.members.map((m) => (
                <button key={m.userId} className="fc-member" onClick={() => setProfileUserId(m.userId)}>
                  <Avatar name={m.displayName} color={m.avatarColor} presence={m.presence} size={30} />
                  <span><strong>{m.displayName}</strong><small>{m.role === "owner" ? "Owner" : m.role}</small></span>
                </button>
              ))}
            </aside>
          )}
        </div>
      </main>

      {/* ---------- Overlays ---------- */}
      {profileUserId && (
        <ProfileDrawer userId={profileUserId} onClose={() => setProfileUserId(null)} onMessage={(id) => { openConversation(id as Id<"dmConversations">); setProfileUserId(null); }} />
      )}
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}

      {inCall && (
        <div className="fc-call-overlay">
          <CallPanel
            channelId={inCall.channelId}
            channelName={inCall.name}
            myUserId={me?.userId ?? ""}
            onLeave={async () => { try { await leaveVoice({}); } catch { /* already left */ } setInCall(null); }}
          />
        </div>
      )}

      {/* ---------- Incoming / outgoing call ---------- */}
      {incomingCall && (
        <div className="fc-call-toast">
          <Avatar name={incomingCall.fromName} size={38} />
          <div>
            <strong>{incomingCall.fromName}</strong>
            <small>{incomingCall.media === "video" ? "Video call" : "Voice call"} incoming…</small>
          </div>
          <Button size="sm" onClick={async () => { await respondCall({ inviteId: incomingCall.inviteId, accept: true }); toast.success("Call accepted."); }}>
            <Phone className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="outline" onClick={async () => { await respondCall({ inviteId: incomingCall.inviteId, accept: false }); }}>Decline</Button>
        </div>
      )}
      {outgoingCall && outgoingCall.status === "ringing" && (
        <div className="fc-call-toast">
          <div><strong>Calling {outgoingCall.toName}…</strong><small>Waiting for them to answer</small></div>
          <Button size="sm" variant="outline" onClick={() => cancelCall({ inviteId: outgoingCall.inviteId })}>Cancel</Button>
        </div>
      )}

      {/* ---------- Modals ---------- */}
      <Dialog open={modal !== null} onOpenChange={(open) => { if (!open && !busy) setModal(null); }}>
        <DialogContent className="freecord-dialog">
          <DialogHeader>
            <DialogTitle>
              {modal === "createCommunity" ? "Create a community" : modal === "join" ? "Join with an invite" : modal === "channel" ? "Create a channel" : "Invite your people"}
            </DialogTitle>
            <DialogDescription>
              {modal === "createCommunity" ? "Communities are home for your people. You can make it public or private." : modal === "join" ? "Paste an invite code shared by a community." : modal === "channel" ? "Add a text or voice channel to this community." : "Share this invite code, or create a fresh one."}
            </DialogDescription>
          </DialogHeader>

          {modal === "invite" ? (
            <div className="fc-invite-modal">
              <code>{details?.inviteCode}</code>
              <Button onClick={async () => { try { await navigator.clipboard.writeText(details?.inviteCode ?? ""); toast.success("Invite code copied!"); } catch { toast.error("Couldn't copy — select the code manually."); } }}>
                Copy invite code
              </Button>
            </div>
          ) : (
            <form className="fc-modal-form" onSubmit={handleModal}>
              <label htmlFor="modal-value">{modal === "join" ? "Invite code" : modal === "channel" ? "Channel name" : "Community name"}</label>
              <Input id="modal-value" autoFocus required value={value} disabled={busy} onChange={(e) => setValue(e.target.value)} maxLength={60} placeholder={modal === "createCommunity" ? "The Creative Corner" : modal === "channel" ? "share-your-work" : "Paste your invite"} />
              {modal === "createCommunity" && (
                <>
                  <label htmlFor="modal-desc">Description</label>
                  <Input id="modal-desc" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} placeholder="For big ideas and good company." />
                  <label className="fc-checkbox-row">
                    <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
                    List in Discover so anyone can find and join
                  </label>
                </>
              )}
              {modal === "channel" && (
                <label className="fc-checkbox-row">
                  <input type="checkbox" checked={channelType === "voice"} onChange={(e) => setChannelType(e.target.checked ? "voice" : "text")} />
                  Voice channel
                </label>
              )}
              <Button type="submit" disabled={busy || !value.trim()}>{busy ? "One moment…" : "Confirm"}</Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
