import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/hooks/use-auth";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import VoicePanel from "@/components/voice/VoicePanel";
import DmView from "@/components/dashboard/DmView";
import ChannelView from "@/components/dashboard/ChannelView";
import HomeView from "@/components/dashboard/HomeView";
import DiscoverView from "@/components/dashboard/DiscoverView";
import SearchView from "@/components/dashboard/SearchView";
import ProfilePopup from "@/components/profile/ProfilePopup";
import FullProfile from "@/components/profile/FullProfile";
import ProfileEditor from "@/components/profile/ProfileEditor";
import SettingsPanel from "@/components/dashboard/SettingsPanel";
import CommunitySettings from "@/components/dashboard/CommunitySettings";
import { Avatar, initialsOf, PRESENCE_META } from "@/components/dashboard/ui";
import { useMessageSound } from "@/hooks/use-message-sound";
import { toast } from "sonner";
import {
  AtSign, Bell, Compass, Hash, Home, Lock, LogOut, Menu, Phone, Plus, Search, Settings, Users, Volume2, X,
} from "lucide-react";

type Section = "home" | "dms" | "discover" | "search" | "community";
type Modal = "create" | "join" | "channel" | "category" | "invite" | "createCommunity" | null;

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

  const setStatus = useMutation(api.profiles.setPresence);
  const heartbeat = useMutation(api.profiles.heartbeat);
  const disconnect = useMutation(api.profiles.disconnect);
  const appearance = useQuery(api.profiles.getAppearance, {});
  const createChannelFull = useMutation(api.voice.createChannelFull);
  const createCategory = useMutation(api.voice.createCategory);
  const reorderChannels = useMutation(api.voice.reorderChannels);
  const { play: playMessageSound } = useMessageSound();
  const createCommunity = useMutation(api.communities.create);
  const joinByCode = useMutation(api.communities.joinByCode);
  const createChannel = useMutation(api.communities.createChannel);
  const leaveCommunity = useMutation(api.communities.leave);
  const markAllRead = useMutation(api.social.markAllNotificationsRead);
  const markRead = useMutation(api.social.markNotificationRead);
  const leaveVoiceSession = useMutation(api.voice.leaveVoiceSession);
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
  const [fullProfileUserId, setFullProfileUserId] = useState<string | null>(null);
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [categoryName, setCategoryName] = useState("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [userLimit, setUserLimit] = useState(0);
  const [isPrivateChannel, setIsPrivateChannel] = useState(false);
  const [communitySettingsOpen, setCommunitySettingsOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [channelType, setChannelType] = useState<"text" | "voice" | "video">("text");
  const [busy, setBusy] = useState(false);
  const [inCall, setInCall] = useState<{ channelId: Id<"channels">; name: string } | null>(null);
  const joinVoiceChecked = useMutation(api.voice.joinVoiceChecked);
  // Reactive channel tree: categories, ordering, and live voice participants.
  const channelTree = useQuery(api.voice.channelTree, communityId ? { serverId: communityId } : "skip");

  const details = useQuery(api.communities.details, communityId ? { serverId: communityId } : "skip");
  const channel = details?.channels.find((c) => c._id === channelId) ?? details?.channels.find((c) => c.type !== "voice");

  // Presence heartbeat so others see us online, and resume any voice session.
  useEffect(() => {
    heartbeat({}).catch(() => {});
    const t = setInterval(() => heartbeat({}).catch(() => {}), 30_000);
    // Soft-disconnect on unload so presence and typing clear promptly.
    const bye = () => { disconnect({}).catch(() => {}); };
    window.addEventListener("beforeunload", bye);
    return () => { clearInterval(t); window.removeEventListener("beforeunload", bye); };
  }, [heartbeat, disconnect]);

  // Apply the user's saved appearance (density, font size, accent) to the shell.
  const appearanceStyle = useMemo(() => {
    const colors = appearance?.customColors;
    return {
      fontSize: appearance?.fontSize ? `${appearance.fontSize}px` : undefined,
      ...(colors?.accent ? ({ ["--fc-accent" as string]: colors.accent } as Record<string, string>) : {}),
    } as React.CSSProperties;
  }, [appearance]);
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
    setCategoryId("");
    setUserLimit(0);
    setIsPrivateChannel(false);
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
        if (channelType === "text") {
          const id = await createChannel({ serverId: communityId, name: value, type: "text" });
          setChannelId(id);
        } else {
          // Full voice/video channel: category, user limit and privacy are all
          // validated server-side by createChannelFull.
          await createChannelFull({
            serverId: communityId,
            name: value,
            type: channelType,
            ...(categoryId ? { categoryId: categoryId as Id<"channelCategories"> } : {}),
            userLimit,
            isPrivate: isPrivateChannel,
          });
        }
      } else if (modal === "category" && communityId) {
        await createCategory({ serverId: communityId, name: value });
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
    try {
      await joinVoiceChecked({ channelId });
      setInCall({ channelId, name });
    } catch (e) {
      // Surfaces "Voice channel is full.", permission, and privacy errors.
      toast.error(e instanceof Error ? e.message : "Could not join the voice channel.");
    }
  }

  /** Persist a drag-and-drop reorder: drop `dragId` onto `targetId`. */
  async function handleDrop(targetId: string) {
    const id = dragId;
    setDragId(null);
    setDragOverId(null);
    if (!id || id === targetId || !communityId || !channelTree) return;
    const all = [...channelTree.uncategorized, ...channelTree.byCategory.flatMap((g) => g.channels)];
    const from = all.find((c) => c._id === id);
    const to = all.find((c) => c._id === targetId);
    if (!from || !to) return;
    // Adopt the target's category so dragging also moves a channel between groups.
    const group = all.filter((c) => (c.categoryId ?? null) === (to.categoryId ?? null) && c._id !== id);
    const at = group.findIndex((c) => c._id === targetId);
    group.splice(at < 0 ? group.length : at, 0, from);
    try {
      await reorderChannels({
        serverId: communityId,
        order: group.map((c, i) => ({ channelId: c._id, position: i, categoryId: to.categoryId ?? undefined })),
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not reorder channels.");
    }
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

  /** A single channel row, with voice participants and drag-and-drop reordering. */
  function renderChannelRow(c: { _id: Id<"channels">; name: string; type?: string | null; userLimit?: number | null; isPrivate?: boolean | null }) {
    const isVoice = c.type === "voice" || c.type === "video";
    const participants = channelTree?.voiceParticipants[c._id as string] ?? [];
    const canManage = Boolean(details?.permissions.includes("manageChannels"));
    return (
      <div
        key={c._id}
        className={`fc-channel-block ${dragOverId === c._id ? "drag-over" : ""}`}
        draggable={canManage}
        onDragStart={() => setDragId(c._id)}
        onDragOver={(e) => { if (canManage) { e.preventDefault(); setDragOverId(c._id); } }}
        onDragLeave={() => setDragOverId((v) => (v === c._id ? null : v))}
        onDrop={(e) => { e.preventDefault(); handleDrop(c._id); }}
      >
        <button
          className={`fc-channel ${!isVoice && channel?._id === c._id ? "active" : ""} ${isVoice && inCall?.channelId === c._id ? "in-voice" : ""}`}
          onClick={() => { if (isVoice) joinVoice(c._id, c.name); else { setChannelId(c._id); setMobileNav(false); } }}
        >
          {isVoice ? (c.isPrivate ? <Lock size={15} /> : <Volume2 size={17} />) : <Hash size={17} />}
          <span className="fc-channel-name">{c.name}</span>
          {isVoice && (c.userLimit ?? 0) > 0 && (
            <span className={`fc-channel-limit ${participants.length >= (c.userLimit ?? 0) ? "full" : ""}`}>{participants.length}/{c.userLimit}</span>
          )}
        </button>
        {isVoice && participants.length > 0 && (
          <ul className="fc-voice-people">
            {participants.map((p) => (
              <li key={p.userId} className={p.speaking ? "speaking" : ""}>
                <button className="fc-voice-person" onClick={() => setProfileUserId(p.userId)}>
                  <Avatar name={p.name} presence={p.speaking ? "online" : undefined} size={22} />
                  <span className={p.speaking ? "talk" : ""}>{p.name}</span>
                  {p.deafened ? <span className="fc-mute-flag">🔇</span> : p.muted ? <span className="fc-mute-flag">🎙️</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  const statusMeta = PRESENCE_META[me?.presence ?? "online"] ?? PRESENCE_META.online;
  const hasUnread = (notifications?.unread ?? 0) > 0;

  return (
    <div className={`fc-shell ${appearance?.density === "compact" ? "density-compact" : ""}`} style={appearanceStyle}>
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
          >{(c as { iconUrl?: string | null }).iconUrl
            ? <img src={(c as { iconUrl?: string | null }).iconUrl!} alt="" className="fc-rail-img" />
            : initialsOf(c.name)}</button>
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
              {details.permissions.includes("manageCommunity") && (
                <button aria-label="Community settings" title="Community settings" onClick={() => setCommunitySettingsOpen(true)}><Settings size={16} /></button>
              )}
              <button className="fc-close-mobile" aria-label="Close menu" onClick={() => setMobileNav(false)}><X size={17} /></button>
            </div>
            <div className="fc-sidebar-banner">
              {details.server.bannerUrl
                ? <img src={details.server.bannerUrl} alt="" className="fc-sidebar-banner-img" />
                : <span className="fc-sidebar-banner-star">✳</span>}
              <span>{details.server.description || "A little space. A lot of possibility."}</span>
            </div>
            <div className="fc-sidebar-section">
              <span>TEXT CHANNELS</span>
              {details.permissions.includes("createChannels") && (
                <>
                  <button aria-label="Create a category" title="Create a category" onClick={() => openModal("category")}><Plus size={15} /></button>
                  <button aria-label="Create channel" title="Create channel" onClick={() => openModal("channel")}><Plus size={15} /></button>
                </>
              )}
            </div>
            {channelTree && (
              <>
                {channelTree.byCategory.map(({ category, channels }) => (
                  <div key={category._id} className="fc-cat-group">
                    <p className="fc-cat-name">{category.name}</p>
                    {channels.map((c) => renderChannelRow(c))}
                  </div>
                ))}
                {channelTree.uncategorized.map((c) => renderChannelRow(c))}
              </>
            )}
            {!channelTree && details.channels.map((c) => (
              <button key={c._id} className={`fc-channel ${channel?._id === c._id ? "active" : ""}`} onClick={() => { setChannelId(c._id); setMobileNav(false); }}>
                <Hash size={17} /> {c.name}
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
            {details.isOwner && (
              <p className="fc-owner-note">You own this community. Transfer or delete it instead of leaving.</p>
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
            onChange={async (e) => { try { await setStatus({ status: e.target.value as never, manual: true }); } catch { toast.error("Could not set status."); } }}
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
          </div>            {section === "community" && details && (
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
      {profileUserId && !fullProfileUserId && (
        <ProfilePopup
          userId={profileUserId}
          serverId={section === "community" ? communityId ?? undefined : undefined}
          onClose={() => setProfileUserId(null)}
          onMessage={(id) => { openConversation(id as Id<"dmConversations">); setProfileUserId(null); }}
          onViewFull={(id) => { setFullProfileUserId(id); setProfileUserId(null); }}
        />
      )}
      {fullProfileUserId && (
        <div className="fc-profile-page-overlay">
          <FullProfile
            userId={fullProfileUserId}
            onBack={() => setFullProfileUserId(null)}
            onMessage={(id) => { openConversation(id as Id<"dmConversations">); setFullProfileUserId(null); }}
          />
        </div>
      )}
      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          onEditProfile={() => { setSettingsOpen(false); setProfileEditorOpen(true); }}
        />
      )}
      {profileEditorOpen && <ProfileEditor onClose={() => setProfileEditorOpen(false)} />}
      {communitySettingsOpen && communityId && (
        <CommunitySettings
          serverId={communityId}
          onClose={() => setCommunitySettingsOpen(false)}
          onLeft={() => { setCommunitySettingsOpen(false); setCommunityId(null); setSection("home"); }}
        />
      )}

      {inCall && (
        <div className="fc-call-overlay">
          <VoicePanel
            channelId={inCall.channelId}
            channelName={inCall.name}
            myUserId={me?.userId ?? ""}
            onOpenProfile={setProfileUserId}
            onLeave={async () => { try { await leaveVoiceSession({}); } catch { /* already left */ } setInCall(null); }}
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
              {modal === "createCommunity" ? "Create a community" : modal === "join" ? "Join with an invite" : modal === "channel" ? "Create a channel" : modal === "category" ? "Create a category" : "Invite your people"}
            </DialogTitle>
            <DialogDescription>
              {modal === "createCommunity" ? "Communities are home for your people. You can make it public or private." : modal === "join" ? "Paste an invite code shared by a community." : modal === "channel" ? "Add a text, voice, or video channel to this community." : modal === "category" ? "Group channels together in the sidebar." : "Share this invite code, or create a fresh one."}
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
              <label htmlFor="modal-value">{modal === "join" ? "Invite code" : modal === "category" ? "Category name" : modal === "channel" ? "Channel name" : "Community name"}</label>
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
                <>
                  <span className="fc-field-label">Channel type</span>
                  <div className="fc-radio-row">
                    {([["text", "Text channel"], ["voice", "Voice channel"], ["video", "Video channel"]] as const).map(([t, label]) => (
                      <label key={t} className={`fc-radio ${channelType === t ? "active" : ""}`}>
                        <input type="radio" name="channel-type" checked={channelType === t} onChange={() => setChannelType(t)} />
                        {label}
                      </label>
                    ))}
                  </div>
                  <label htmlFor="modal-category">Category</label>
                  <select id="modal-category" className="fc-select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                    <option value="">No category</option>
                    {channelTree?.categories.map((cat) => <option key={cat._id} value={cat._id}>{cat.name}</option>)}
                  </select>
                  {channelType !== "text" && (
                    <>
                      <label htmlFor="modal-limit">User limit (0 = unlimited)</label>
                      <Input id="modal-limit" type="number" min={0} max={100} value={userLimit} onChange={(e) => setUserLimit(Number(e.target.value) || 0)} />
                      <label className="fc-checkbox-row">
                        <input type="checkbox" checked={isPrivateChannel} onChange={(e) => setIsPrivateChannel(e.target.checked)} />
                        Private — only roles you allow can see and join it
                      </label>
                    </>
                  )}
                </>
              )}
              <Button type="submit" disabled={busy || !value.trim()}>
                {busy ? "One moment…" : modal === "channel" ? "Create channel" : modal === "category" ? "Create category" : "Confirm"}
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
