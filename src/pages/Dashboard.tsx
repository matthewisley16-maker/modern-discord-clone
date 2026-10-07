import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/hooks/use-auth";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import VoicePanel from "@/components/voice/VoicePanel";
import DmCallPanel from "@/components/dashboard/DmCallPanel";
import { useCallSound } from "@/hooks/use-call-sound";
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
import ServerRail from "@/components/dashboard/ServerRail";
import NewMessageDialog from "@/components/dashboard/NewMessageDialog";
import SecretChatsDialog, { ProtectConversationDialog } from "@/components/dashboard/SecretChats";
import { Avatar, formatLastSeen, initialsOf, PRESENCE_META } from "@/components/dashboard/ui";
import { FeatureBoundary } from "@/components/ui/feature-boundary";
import { toSafeArray, toSafeArrayField } from "@/lib/collection";
import { trackOp } from "@/lib/usage-monitor";
import { useMessageSound } from "@/hooks/use-message-sound";
import { toast } from "sonner";
import {
  AtSign, Bell, BellOff, Compass, Hash, Home, Lock, LogOut, Menu, Phone, Plus, Search, Settings, ShieldCheck, Users, Volume2, X,
} from "lucide-react";

/**
 * Admin Panel entry. Kept as its own component so the (optional) access query
 * can never affect the dashboard: if it fails, the button simply isn't shown.
 */
function AdminPanelEntry({ onOpen }: { onOpen: () => void }) {
  const access = useQuery(api.admin.panelAccess, {});
  if (!access?.canAccess) return null;
  return (
    <button aria-label="Open Admin Panel" title="Admin Panel" onClick={onOpen}><ShieldCheck size={18} /></button>
  );
}

/** Optional operator announcement — fails closed, never blocks the app. */
function AnnouncementBanner() {
  const announcement = useQuery(api.admin.platformBanner, {});
  if (!announcement?.announcement) return null;
  return (
    <div role="status" className="mx-3 mt-2 rounded-lg border border-violet-400/25 bg-violet-500/10 px-3 py-2 text-xs text-violet-100 sm:mx-4">
      <strong className="mr-1 font-semibold">Announcement:</strong>
      {announcement.announcement}
    </div>
  );
}

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

  // ---- Collection shape normalization -------------------------------------
  // Every list that feeds the sidebar / DM UI is normalized exactly once here,
  // so a null (still loading), object, string or legacy record could never
  // reach a `.map`/`.filter`/`.find` and crash the Dashboard.
  const communityList = useMemo(
    () => toSafeArray<NonNullable<typeof communities>[number]>(communities, { label: "Your communities", source: "api.communities.listMine" }),
    [communities],
  );
  const conversationList = useMemo(
    () => toSafeArray<NonNullable<typeof conversations>[number]>(conversations, { label: "DM conversations", source: "api.dms.listConversations" }),
    [conversations],
  );
  const activeConversations = useMemo(() => conversationList.filter((c) => !c.archived), [conversationList]);
  const archivedConversations = useMemo(() => conversationList.filter((c) => c.archived), [conversationList]);
  const notificationItems = useMemo(
    () => toSafeArrayField<NonNullable<NonNullable<typeof notifications>["items"]>[number]>(notifications, "items", { label: "Notifications", source: "api.social.listNotifications" }),
    [notifications],
  );

  const setStatus = useMutation(api.profiles.setPresence);
  const heartbeat = useMutation(api.profiles.heartbeat);
  // Guarantees every account has a unique username AND a display name (email-only, legacy, etc.).
  const ensureIdentity = useMutation(api.users.ensureIdentity);
  // Admin access + the operator announcement are loaded in their own
  // boundary-wrapped components below, so a failure there can't blank the app.
  const disconnect = useMutation(api.profiles.disconnect);
  const appearance = useQuery(api.profiles.getAppearance, {});
  const createChannelFull = useMutation(api.voice.createChannelFull);
  const createCategory = useMutation(api.voice.createCategory);
  const reorderChannels = useMutation(api.voice.reorderChannels);
  const updateCategory = useMutation(api.voice.updateCategory);
  const deleteCategory = useMutation(api.voice.deleteCategory);
  const reorderCategories = useMutation(api.voice.reorderCategories);
  const updateChannelFull = useMutation(api.voice.updateChannelFull);
  const deleteChannelFull = useMutation(api.voice.deleteChannelFull);
  const { play: playMessageSound } = useMessageSound();
  const createCommunity = useMutation(api.communities.create);
  const joinByCode = useMutation(api.communities.joinByCode);
  const leaveCommunity = useMutation(api.communities.leave);
  const markAllRead = useMutation(api.social.markAllNotificationsRead);
  // Pending "join my existing call" invitations addressed to me.
  const invitations = useQuery(api.calls.pendingInvitations, {});
  const invitationItems = useMemo(
    () => toSafeArray<NonNullable<typeof invitations>[number]>(invitations, {
      label: "Call invitations",
      source: "api.calls.pendingInvitations",
    }),
    [invitations],
  );
  const respondInvitation = useMutation(api.calls.respondInvitation);
  const cancelInvitation = useMutation(api.calls.cancelInvitation);
  const markRead = useMutation(api.social.markNotificationRead);
  const setNotifRead = useMutation(api.social.setNotificationRead);
  const deleteNotif = useMutation(api.social.deleteNotification);
  const clearNotifs = useMutation(api.social.clearAllNotifications);
  const leaveVoiceSession = useMutation(api.voice.leaveVoiceSession);
  const respondCall = useMutation(api.calls.respondCall);
  const cancelCall = useMutation(api.calls.cancelCall);
  const inviteCall = useMutation(api.calls.inviteCall);
  const endCall = useMutation(api.calls.endCall);
  const timeoutCall = useMutation(api.calls.timeoutCall);
  const clearConversationSignals = useMutation(api.calls.clearConversationSignals);
  const clearMyConversationSignals = useMutation(api.calls.clearMyConversationSignals);
  const startDirect = useMutation(api.dms.startDirect);
  const setMuted = useMutation(api.dms.setMuted);
  const setPinned = useMutation(api.dms.setPinned);
  const setArchived = useMutation(api.dms.setArchived);
  const deleteConversation = useMutation(api.dms.deleteConversation);
  const setServerMuted = useMutation(api.communities.setServerMuted);

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
  const [dragCategoryId, setDragCategoryId] = useState<string | null>(null);
  const [catMenuFor, setCatMenuFor] = useState<string | null>(null);
  const [channelMenuFor, setChannelMenuFor] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ kind: "category" | "channel"; id: string; name: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<{ kind: "category" | "channel"; id: string; name: string } | null>(null);
  const [categoryName, setCategoryName] = useState("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [userLimit, setUserLimit] = useState(0);
  const [isPrivateChannel, setIsPrivateChannel] = useState(false);
  const [allowedRoleIds, setAllowedRoleIds] = useState<string[]>([]);
  const [communitySettingsOpen, setCommunitySettingsOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [newMessageOpen, setNewMessageOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  // Locked & hidden conversations: which one is being protected, and whether
  // the PIN-gated Secret Chats screen is open.
  const [protectTarget, setProtectTarget] = useState<{ id: Id<"dmConversations">; name: string } | null>(null);
  const [secretOpen, setSecretOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Message to scroll to and flash after clicking a notification.
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null);
  const [notifMenuFor, setNotifMenuFor] = useState<string | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  // The upper-left icon collapses/expands the sidebar (never navigates home).
  // The choice is remembered across channel/DM/profile/settings changes and reloads.
  const [desktopCollapsed, setDesktopCollapsed] = useState(() => {
    try { return localStorage.getItem("freecord:sidebarCollapsed") === "1"; }
    catch { return false; }
  });
  const [modal, setModal] = useState<Modal>(null);
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [channelType, setChannelType] = useState<"text" | "voice" | "video">("text");
  const [busy, setBusy] = useState(false);
  const [inCall, setInCall] = useState<{ channelId: Id<"channels">; name: string } | null>(null);
  // An accepted DM/group call that is actually connected (real WebRTC audio).
  const [dmCall, setDmCall] = useState<{
    inviteId: Id<"callInvites">;
    conversationId: Id<"dmConversations">;
    peerId: Id<"users">;
    name: string;
    username?: string | null;
    media: "voice" | "video";
    /** True when this panel was opened by accepting an invitation: the user is
     *  a guest in someone else's running call, so leaving must never end that
     *  call for its owner nor wipe signaling they still need. */
    invited?: boolean;
  } | null>(null);
  // Which call UI is showing: full screen or the floating minimized window.
  // Minimizing never touches the connection — the panel stays mounted.
  const [callMinimized, setCallMinimized] = useState(false);
  // Live status of the accepted DM call, so we notice a remote hang-up.
  const callStatus = useQuery(api.calls.getCall, dmCall ? { inviteId: dmCall.inviteId } : "skip");

  // ---- Sidebar lists scroll on their own ---------------------------------
  // The DM list and the community list are separate scroll boxes, so neither a
  // long list of DMs nor a long list of communities can push the other, the
  // sidebar footer or the page itself out of view.
  const dmListRef = useRef<HTMLDivElement | null>(null);
  const communityListRef = useRef<HTMLDivElement | null>(null);

  /**
   * Bring a row inside its own scroll box back into view — and only that box.
   * Deliberately not `scrollIntoView`, which can move ancestor scrollers too.
   */
  function keepRowVisible(box: HTMLDivElement | null, selector: string) {
    if (!box) return;
    const row = box.querySelector<HTMLElement>(selector);
    if (!row) return;
    const r = row.getBoundingClientRect();
    const v = box.getBoundingClientRect();
    if (r.top < v.top) box.scrollTop -= v.top - r.top + 6;
    else if (r.bottom > v.bottom) box.scrollTop += r.bottom - v.bottom + 6;
  }

  // Opening a conversation (notification, call, deep link) scrolls the active
  // row into view. Deliberately keyed on the SELECTION only: a new DM arriving
  // must never yank the list (or the user's scroll position) around.
  useEffect(() => {
    if (section !== "dms" || !conversationId) return;
    keepRowVisible(dmListRef.current, ".fc-dm.active");
  }, [conversationId, section]);

  // Same for the selected community when navigation opens one.
  useEffect(() => {
    if (!communityId) return;
    keepRowVisible(communityListRef.current, ".fc-sidebar-action.community.active");
  }, [communityId]);
  // Which voice channels show their full participant list in the sidebar.
  const [expandedVoice, setExpandedVoice] = useState<Record<string, boolean>>({});
  const joinVoiceChecked = useMutation(api.voice.joinVoiceChecked);
  // Reactive channel tree: categories, ordering, and live voice participants.
  const channelTree = useQuery(api.voice.channelTree, communityId ? { serverId: communityId } : "skip");

  const details = useQuery(api.communities.details, communityId ? { serverId: communityId } : "skip");
  // Normalized community/channel collections (see the collection helpers).
  const detailsChannels = useMemo(
    () => toSafeArray<NonNullable<typeof details>["channels"][number]>(details?.channels, { label: "Community channels", source: "api.communities.details" }),
    [details],
  );
  const detailsMembers = useMemo(
    () => toSafeArray<NonNullable<typeof details>["members"][number]>(details?.members, { label: "Community members", source: "api.communities.details" }),
    [details],
  );
  const detailsRoles = useMemo(
    () => toSafeArray<NonNullable<typeof details>["roles"][number]>(details?.roles, { label: "Community roles", source: "api.communities.details" }),
    [details],
  );
  const detailsPermissions = useMemo(
    () => toSafeArray<string>(details?.permissions, { label: "Community permissions", source: "api.communities.details" }),
    [details],
  );
  const channelCategories = useMemo(
    () => toSafeArray<NonNullable<typeof channelTree>["byCategory"][number]>(channelTree?.byCategory, { label: "Channel categories", source: "api.voice.channelTree" }),
    [channelTree],
  );
  const channelUncategorized = useMemo(
    () => toSafeArray<NonNullable<typeof channelTree>["uncategorized"][number]>(channelTree?.uncategorized, { label: "Uncategorized channels", source: "api.voice.channelTree" }),
    [channelTree],
  );
  const channelCategoryList = useMemo(
    () => toSafeArray<NonNullable<typeof channelTree>["categories"][number]>(channelTree?.categories, { label: "Channel category list", source: "api.voice.channelTree" }),
    [channelTree],
  );
  const channel = detailsChannels.find((c) => c._id === channelId) ?? detailsChannels.find((c) => c.type !== "voice");
  // Owner (and managers with manageChannels) can reorganize the sidebar.
  const canManageChannels = detailsPermissions.includes("manageChannels");

  // Presence heartbeat so others see us online, and resume any voice session.
  //
  // Kept deliberately low-cost: a single 30s timer, and NOTHING is written while
  // the tab is hidden/backgrounded (the server-side staleness window covers us),
  // so idle or backgrounded tabs never generate presence traffic. It resumes
  // immediately when the tab becomes visible again. Never on mouse movement,
  // keystrokes, renders or navigation.
  useEffect(() => {
    ensureIdentity({}).catch(() => {});
    const beat = () => { if (document.visibilityState === "visible") { trackOp("presence.heartbeat"); heartbeat({}).catch(() => {}); } };
    beat();
    const t = setInterval(beat, 30_000);
    // Refresh the moment the user comes back, so online state is instant.
    const onVisible = () => { if (document.visibilityState === "visible") heartbeat({}).catch(() => {}); };
    document.addEventListener("visibilitychange", onVisible);
    // Soft-disconnect on unload so presence and typing clear promptly.
    const bye = () => { disconnect({}).catch(() => {}); };
    window.addEventListener("beforeunload", bye);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("beforeunload", bye);
    };
  }, [heartbeat, disconnect]);

  // Apply the user's saved appearance (theme, density, font size, accent, motion).
  const appearanceStyle = useMemo(() => {
    const colors = appearance?.customColors;
    return {
      fontSize: appearance?.fontSize ? `${appearance.fontSize}px` : undefined,
      ...(colors?.accent ? ({ ["--fc-accent" as string]: colors.accent } as Record<string, string>) : {}),
    } as React.CSSProperties;
  }, [appearance]);

  // Theme + reduced motion live on <html> so they apply to the whole app.
  useEffect(() => {
    const root = document.documentElement;
    const chosen = appearance?.theme ?? "dark";
    const resolved = chosen === "system"
      ? (window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark")
      : chosen;
    root.dataset.theme = resolved;
    root.classList.toggle("fc-light", resolved === "light");
    root.classList.toggle("fc-contrast", resolved === "contrast");
    root.classList.toggle("fc-midnight", resolved === "midnight");
    root.classList.toggle("fc-reduced-motion", appearance?.reducedMotion === true);
  }, [appearance?.theme, appearance?.reducedMotion]);
  useEffect(() => {
    if (voiceSession) setInCall({ channelId: voiceSession.channelId, name: voiceSession.channelName });
  }, [voiceSession]);

  // Keep the selected community valid.
  useEffect(() => {
    if (communityId && details && !detailsChannels.some((c) => c._id === channelId)) {
      setChannelId(detailsChannels.find((c) => c.type !== "voice")?._id ?? null);
    }
  }, [details, detailsChannels, communityId, channelId]);

  // Clear ONLY a stale/invalid selected conversation (e.g. a deep link to a
  // deleted or no-longer-shared chat). Never touches local storage, the
  // session, or any other state — and never clears while still loading.
  useEffect(() => {
    if (section !== "dms" || !conversationId || conversations === undefined) return;
    if (!conversationList.some((c) => c.conversationId === conversationId)) setConversationId(null);
  }, [section, conversationId, conversations, conversationList]);

  // ---- Invitations to join an EXISTING call --------------------------------
  // Notification-only by design: an invitation NEVER rings, never appears as an
  // incoming call, and never touches the camera/microphone. One indexed
  // subscription drives the list; nothing polls.
  async function acceptInvitation(inv: { invitationId: string }) {
    try {
      const res = await respondInvitation({ invitationId: inv.invitationId as Id<"callInvitations">, accept: true });
      setNotifOpen(false);
      if (!res.joined || !res.target) return;
      if (res.target.kind === "community") {
        // Join the SAME community call the inviter is already in.
        setCallMinimized(false);
        setMobileNav(false);
        setCommunityId(res.target.serverId);
        setSection("community");
        setChannelId(res.target.channelId);
        await joinVoice(res.target.channelId, res.target.channelName);
      } else {
        // DM / group DM: join the call that is ALREADY running in this
        // conversation. Nothing new is created — the panel attaches to the
        // existing session (same conversation, same signaling) with the person
        // who invited us, exactly like a direct call but without any ringing.
        openConversation(res.target.conversationId);
        setCallMinimized(false);
        setMobileNav(false);
        setDmCall({
          inviteId: res.target.callId,
          conversationId: res.target.conversationId,
          peerId: res.target.peerId,
          name: res.target.peerName,
          username: res.target.peerUsername,
          media: res.target.media,
          invited: true,
        });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "This call invitation is no longer available.");
    }
  }

  async function declineInvitation(inv: { invitationId: string }) {
    try {
      await respondInvitation({ invitationId: inv.invitationId as Id<"callInvitations">, accept: false });
      toast.success("Invitation declined.");
    } catch {
      toast.error("Could not decline the invitation.");
    }
  }

  async function dismissInvitation(inv: { invitationId: string }) {
    try { await cancelInvitation({ invitationId: inv.invitationId as Id<"callInvitations"> }); } catch { /* already resolved */ }
  }

  function openCommunity(id: string) {
    setCommunityId(id as Id<"servers">);
    setChannelId(null);
    setSection("community");
    setMobileNav(false);
  }

  /**
   * Remove a conversation from my own inbox.
   *
   * The chat and its lock go together: nothing about this chat can stay marked
   * as locked afterwards, and your personal PIN is untouched, so every other
   * locked chat keeps working with the same PIN.
   */
  async function removeConversation(c: { conversationId: Id<"dmConversations">; name: string; locked?: boolean }) {
    if (!window.confirm(c.locked
      ? `Delete “${c.name}” and its lock? The lock is removed with the chat.`
      : `Delete “${c.name}”? This removes the chat from your chats.`)) return;
    try {
      await deleteConversation({ conversationId: c.conversationId });
      if (conversationId === c.conversationId) setConversationId(null);
      toast.success("Chat removed.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove the chat.");
    }
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
    setAllowedRoleIds([]);
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
        // One code path for text/voice/video: category, topic, limit and privacy
        // are all validated server-side by createChannelFull.
        const id = await createChannelFull({
          serverId: communityId,
          name: value,
          type: channelType,
          ...(categoryId ? { categoryId: categoryId as Id<"channelCategories"> } : {}),
          ...(channelType === "text" ? { description } : {}),
          userLimit,
          isPrivate: isPrivateChannel,
          allowedRoleIds: isPrivateChannel ? allowedRoleIds : [],
        });
        if (channelType === "text") setChannelId(id);
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

  /**
   * Open the exact place a notification refers to, using the deep link stored on
   * the notification. Falls back to a toast when the target no longer exists.
   */
  async function openNotification(n: { _id: Id<"notifications">; link?: string; read: boolean }) {
    if (!n.read) { try { await markRead({ id: n._id }); } catch { /* ignore */ } }
    setNotifOpen(false);
    setNotifMenuFor(null);
    const raw = n.link ?? "";
    const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw.startsWith("?") ? raw.slice(1) : raw;
    const p = new URLSearchParams(query);
    const server = p.get("server");
    const channel = p.get("channel");
    const dm = p.get("dm");
    const message = p.get("message");
    const profile = p.get("profile");
    const invite = p.get("invite");
    try {
      if (profile) {
        setProfileUserId(profile);
      } else if (invite) {
        // An invitation to join an EXISTING call. Opening it only reveals the
        // Accept/Decline card — it never auto-accepts, never joins the call and
        // never touches the camera or microphone.
        setNotifOpen(true);
      } else if (dm) {
        openConversation(dm as Id<"dmConversations">);
      } else if (server) {
        openCommunity(server);
        if (channel) {
          setChannelId(channel as Id<"channels">);
          // A community call invitation deep-links straight into the call.
          if (p.get("voice") === "1") await joinVoice(channel as Id<"channels">, "Voice");
        }
      } else if (p.get("view") === "friends") {
        setSection("home");
      } else if (p.get("discover")) {
        setSection("discover");
      } else {
        // No usable target — tell the user instead of doing nothing.
        toast.info("This notification has no destination any more.");
        return;
      }
      if (message) setHighlightMessageId(message);
    } catch {
      toast.error("That conversation or channel is no longer available.");
    }
  }

  function toggleSidebar() {
    if (typeof window !== "undefined" && window.innerWidth <= 760) {
      setMobileNav((v) => !v);
      return;
    }
    setDesktopCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem("freecord:sidebarCollapsed", next ? "1" : "0"); } catch { /* storage may be unavailable */ }
      return next;
    });
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
    const all = [...channelUncategorized, ...channelCategories.flatMap((g) => g.channels)];
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

  /** Persist a category drag-and-drop reorder. */
  async function dropCategory(targetId: string) {
    const id = dragCategoryId;
    setDragCategoryId(null);
    if (!id || id === targetId || !communityId || !channelTree) return;
    const ids = channelCategoryList.map((c) => c._id as string);
    const from = ids.indexOf(id);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    try {
      await reorderCategories({ serverId: communityId, order: ids.map((categoryId, i) => ({ categoryId: categoryId as Id<"channelCategories">, position: i })) });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not reorder categories.");
    }
  }

  async function submitRename() {
    if (!renameTarget || !renameValue.trim()) return;
    const { kind, id } = renameTarget;
    try {
      if (kind === "category") await updateCategory({ categoryId: id as Id<"channelCategories">, name: renameValue.trim() });
      else await updateChannelFull({ channelId: id as Id<"channels">, name: renameValue.trim() });
      toast.success(kind === "category" ? "Category renamed." : "Channel renamed.");
      setRenameTarget(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not rename.");
    }
  }

  async function confirmDeleteNow() {
    if (!confirmDelete) return;
    const { kind, id } = confirmDelete;
    setConfirmDelete(null);
    try {
      if (kind === "category") { await deleteCategory({ categoryId: id as Id<"channelCategories"> }); toast.success("Category deleted — its channels are now uncategorized."); }
      else { await deleteChannelFull({ channelId: id as Id<"channels"> }); toast.success("Channel deleted."); }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete.");
    }
  }

  const activeCall = Boolean(inCall || dmCall);

  /** Minimize (never disconnect) the active call when navigating elsewhere. */
  function minimizeCall() {
    if (activeCall) setCallMinimized(true);
  }

  async function startDmCall(media: "voice" | "video") {
    if (!conversationId) return;
    const convo = conversationList.find((c) => c.conversationId === conversationId);
    const target = convo?.members?.[0];
    if (!target) { toast.error("There's no one else in this conversation to call."); return; }
    try {
      await inviteCall({ toId: target.userId as Id<"users">, conversationId, media });
      toast.success(`Ringing ${target.displayName}…`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start the call.");
    }
  }

  /** Start a call with any user straight from a profile, friends list or member list. */
  async function callUser(userId: string, media: "voice" | "video") {
    try {
      const convo = await startDirect({ userId: userId as Id<"users"> });
      await inviteCall({ toId: userId as Id<"users">, conversationId: convo, media });
      toast.success("Calling…");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start the call.");
    }
  }

  /** End the accepted DM call for both sides and clean up local media. */
  async function endDmCall() {
    const inviteId = dmCall?.inviteId;
    const conversationId = dmCall?.conversationId;
    const invited = dmCall?.invited === true;
    setDmCall(null);
    setCallMinimized(false);
    // A guest joined an existing call: leaving is purely local. It must not end
    // the owner's call, nor clear signaling the remaining participants still
    // use — only MY rows for this conversation, so a leftover offer cannot be
    // replayed against the next call.
    if (invited) {
      if (conversationId) { try { await clearMyConversationSignals({ conversationId }); } catch { /* noop */ } }
      return;
    }
    if (inviteId) { try { await endCall({ inviteId }); } catch { /* already ended */ } }
    // Drop any signaling left in the conversation so the next call starts clean
    // and a stale offer can never revive the connection we just closed.
    if (conversationId) { try { await clearConversationSignals({ conversationId }); } catch { /* noop */ } }
  }

  /** A single channel row, with voice participants and drag-and-drop reordering. */
  function renderChannelRow(c: { _id: Id<"channels">; name: string; type?: string | null; userLimit?: number | null; isPrivate?: boolean | null }) {
    const isVoice = c.type === "voice" || c.type === "video";
    const voiceMap = channelTree?.voiceParticipants;
    const participants = toSafeArray<NonNullable<NonNullable<typeof voiceMap>[string]>[number]>(
      voiceMap?.[c._id as string],
      { label: "Voice participants", source: "api.voice.channelTree" },
    );
    const canManage = detailsPermissions.includes("manageChannels");
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
          onClick={() => { if (isVoice) joinVoice(c._id, c.name); else { setChannelId(c._id); setMobileNav(false); minimizeCall(); } }}
        >
          {isVoice ? (c.isPrivate ? <Lock size={15} /> : <Volume2 size={17} />) : <Hash size={17} />}
          <span className="fc-channel-name">{c.name}</span>
          {isVoice && participants.length > 0 && <span className="fc-voice-count">{participants.length}</span>}
          {isVoice && (c.userLimit ?? 0) > 0 && (
            <span className={`fc-channel-limit ${participants.length >= (c.userLimit ?? 0) ? "full" : ""}`}>{participants.length}/{c.userLimit}</span>
          )}
        </button>
        {canManage && (
          <button
            className="fc-channel-tools"
            aria-label={`Manage ${c.name}`}
            onClick={(e) => { e.stopPropagation(); setChannelMenuFor(channelMenuFor === c._id ? null : c._id); }}
          >⋯</button>
        )}
        {canManage && channelMenuFor === c._id && (
          <div className="fc-menu fc-channel-menu" role="menu">
            <button onClick={() => { setRenameTarget({ kind: "channel", id: c._id, name: c.name }); setRenameValue(c.name); setChannelMenuFor(null); }}>Rename</button>
            <button className="danger" onClick={() => { setConfirmDelete({ kind: "channel", id: c._id, name: c.name }); setChannelMenuFor(null); }}>Delete channel</button>
          </div>
        )}
        {isVoice && participants.length > 0 && (
          <>
            <ul className={`fc-voice-people ${expandedVoice[c._id] ? "expanded" : ""}`}>
              {(expandedVoice[c._id] ? participants : participants.slice(0, 4)).map((p) => (
                <li key={p.userId} className={p.speaking ? "speaking" : ""}>
                  <button className="fc-voice-person" onClick={() => setProfileUserId(p.userId)}>
                    <Avatar name={p.name} presence={p.speaking ? "online" : undefined} size={22} url={p.avatarUrl} decorationId={p.decorationId} />
                    <span className={p.speaking ? "talk" : ""}>{p.name}</span>
                    {p.deafened ? <span className="fc-mute-flag" title="Deafened">🔇</span> : p.muted ? <span className="fc-mute-flag" title="Muted">🎙️</span> : null}
                    {p.video && <span className="fc-mute-flag" title="Camera on">📹</span>}
                  </button>
                </li>
              ))}
            </ul>
            {participants.length > 4 && (
              <button
                className="fc-voice-more"
                onClick={() => setExpandedVoice((v) => ({ ...v, [c._id]: !v[c._id] }))}
              >
                {expandedVoice[c._id] ? "Show less" : `+${participants.length - 4} more`}
              </button>
            )}
          </>
        )}
      </div>
    );
  }

  // Ringtone while an incoming call rings or we wait for the other side.
  const ringing = Boolean(incomingCall) || outgoingCall?.status === "ringing";
  useCallSound(ringing && !dmCall);

  // When the person we called accepts, connect the call for real.
  useEffect(() => {
    if (outgoingCall?.status === "accepted" && outgoingCall.conversationId) {
      setCallMinimized(false);
      setDmCall({
        inviteId: outgoingCall.inviteId,
        conversationId: outgoingCall.conversationId as Id<"dmConversations">,
        peerId: outgoingCall.toId as Id<"users">,
        name: outgoingCall.toName,
        username: outgoingCall.toUsername ?? null,
        media: outgoingCall.media,
      });
    }
  }, [outgoingCall]);

  // If the other side hangs up (or the call ends/is declined), tear the local
  // call down immediately — otherwise the peer connection would linger as a
  // ghost call with live audio/video.
  const endedCallRef = useRef<string>("");
  useEffect(() => {
    if (!dmCall || !callStatus) return;
    if (callStatus.status === "ringing" || callStatus.status === "accepted") return;
    const key = `${callStatus._id}:${callStatus.status}`;
    if (endedCallRef.current === key) return;
    endedCallRef.current = key;
    toast.info(callStatus.status === "declined" ? "Call declined." : "Call ended.");
    void endDmCall();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dmCall, callStatus]);

  // Surface declined/missed/ended outcomes to the caller (once per outcome).
  const callOutcomeRef = useRef<string>("");
  useEffect(() => {
    if (!outgoingCall) return;
    const key = `${outgoingCall.inviteId}:${outgoingCall.status}`;
    if (callOutcomeRef.current === key) return;
    if (outgoingCall.status === "declined") { callOutcomeRef.current = key; toast.error(`${outgoingCall.toName} declined the call.`); }
    else if (outgoingCall.status === "missed") { callOutcomeRef.current = key; toast.info("No answer. The call was missed."); }
    else if (outgoingCall.status === "ended" || outgoingCall.status === "cancelled") { callOutcomeRef.current = key; toast.info("Call ended."); }
  }, [outgoingCall]);

  // Let an unanswered outgoing call time out so it never rings forever.
  useEffect(() => {
    if (outgoingCall?.status !== "ringing") return;
    const ageMs = Date.now() - (outgoingCall.createdAt ?? Date.now());
    const timer = setTimeout(() => { timeoutCall({ inviteId: outgoingCall.inviteId }).catch(() => {}); }, Math.max(0, 55_000 - ageMs));
    return () => clearTimeout(timer);
  }, [outgoingCall, timeoutCall]);

  // Let an unanswered incoming call stop ringing too, so neither side hangs forever.
  useEffect(() => {
    if (!incomingCall) return;
    const ageMs = Date.now() - (incomingCall.createdAt ?? Date.now());
    const timer = setTimeout(() => { endCall({ inviteId: incomingCall.inviteId }).catch(() => {}); }, Math.max(0, 60_000 - ageMs));
    return () => clearTimeout(timer);
  }, [incomingCall, endCall]);

  // Keep the call connected while navigating; auto-minimize once the user moves
  // away from the call view. Joining does not minimize (the nav signature is
  // unchanged when the call starts).
  const navKey = `${section}|${communityId}|${channelId}|${conversationId}`;
  const navRef = useRef(navKey);
  useEffect(() => {
    if (navRef.current === navKey) return;
    navRef.current = navKey;
    if (activeCall) setCallMinimized(true);
  }, [navKey, activeCall]);

  const statusMeta = PRESENCE_META[me?.presence ?? "online"] ?? PRESENCE_META.online;
  const hasUnread = (notifications?.unread ?? 0) > 0;

  return (
    <div className={`fc-shell ${appearance?.density === "compact" ? "density-compact" : ""}`} style={appearanceStyle}>
      {/* ---------- Server rail ---------- */}
      <aside className={`fc-rail ${mobileNav ? "hide-mobile" : ""}`} aria-label="Communities">
        <button
          className="fc-rail-logo"
          aria-label={desktopCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!desktopCollapsed}
          title="Toggle sidebar"
          onClick={toggleSidebar}
        >
          <svg viewBox="0 0 64 64" width="26" height="26" aria-hidden="true">
            <rect width="64" height="64" rx="18" fill="url(#fcg)" />
            <defs><linearGradient id="fcg" x1="0" y1="0" x2="64" y2="64"><stop offset="0" stopColor="#9d7bff" /><stop offset="1" stopColor="#6d3ff5" /></linearGradient></defs>
            <g stroke="#fff" strokeWidth="5" strokeLinecap="round"><path d="M16 27v10M24 18v28M32 24v16M40 14v36M48 26v12" /></g>
          </svg>
        </button>
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
        {/* Server rail: drag-and-drop ordering, folders, and the overflow switcher. */}
        <FeatureBoundary label="Communities" fallback={null}>
          <ServerRail
            communities={(communityList) as { _id: string; name: string; iconUrl?: string | null }[]}
            communityId={section === "community" ? communityId : null}
            onOpen={(id) => openCommunity(id)}
            onCreate={() => openModal("createCommunity")}
            onJoin={() => openModal("join")}
          />
        </FeatureBoundary>

        <button className="fc-rail-btn bottom" title="Sign out" aria-label="Sign out" onClick={async () => { await signOut(); navigate("/"); }}>
          <LogOut size={19} />
        </button>
      </aside>

      {/* ---------- Secondary sidebar ---------- */}
      <aside className={`fc-sidebar ${mobileNav ? "open" : ""} ${desktopCollapsed ? "collapsed" : ""}`}>
        {section === "community" && details ? (
          <>
            <div className="fc-sidebar-head">
              <span className="fc-sidebar-title">{details.server.name}</span>
              {/* Per-member community mute — notifications only, never messages. */}
              <button
                aria-label={details.muted ? "Unmute community" : "Mute community"}
                title={details.muted ? "Unmute community (notifications back on)" : "Mute community (notifications off)"}
                onClick={async () => {
                  try { await setServerMuted({ serverId: communityId!, muted: !details.muted }); toast.success(details.muted ? "Community unmuted." : "Community muted. Messages still arrive."); }
                  catch (e) { toast.error(e instanceof Error ? e.message : "Could not update notifications."); }
                }}
              >
                {details.muted ? <BellOff size={16} /> : <Bell size={16} />}
              </button>
              {detailsPermissions.includes("manageCommunity") && (
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
              {detailsPermissions.includes("createChannels") && (
                <>
                  <button aria-label="Create a category" title="Create a category" onClick={() => openModal("category")}><Plus size={15} /></button>
                  <button aria-label="Create channel" title="Create channel" onClick={() => openModal("channel")}><Plus size={15} /></button>
                </>
              )}
            </div>
            <div className="fc-sidebar-scroll fc-channel-scroll">
            {channelTree && (
              <>
                {channelCategories.map(({ category, channels }) => (
                  <div
                    key={category._id}
                    className={`fc-cat-group ${dragOverId === category._id ? "drag-over" : ""}`}
                    onDragOver={(e) => { if (canManageChannels) { e.preventDefault(); } }}
                    onDrop={(e) => { if (canManageChannels) { e.preventDefault(); void dropCategory(category._id); } }}
                  >
                    <p className="fc-cat-name">
                      {canManageChannels && (
                        <span
                          className="fc-cat-grip"
                          draggable
                          onDragStart={() => setDragCategoryId(category._id)}
                          title="Drag to reorder category"
                          aria-hidden="true"
                        >⠿</span>
                      )}
                      <span className="fc-cat-label">{category.name}</span>
                      {canManageChannels && (
                        <button
                          className="fc-cat-tools"
                          aria-label={`Manage ${category.name}`}
                          onClick={() => setCatMenuFor(catMenuFor === category._id ? null : category._id)}
                        >⋯</button>
                      )}
                    </p>
                    {canManageChannels && catMenuFor === category._id && (
                      <div className="fc-menu fc-cat-menu" role="menu">
                        <button onClick={() => { setRenameTarget({ kind: "category", id: category._id, name: category.name }); setRenameValue(category.name); setCatMenuFor(null); }}>Rename category</button>
                        <button className="danger" onClick={() => { setConfirmDelete({ kind: "category", id: category._id, name: category.name }); setCatMenuFor(null); }}>Delete category</button>
                      </div>
                    )}
                    {channels.map((c) => renderChannelRow(c))}
                  </div>
                ))}
                {channelUncategorized.map((c) => renderChannelRow(c))}
              </>
            )}
            {!channelTree && detailsChannels.map((c) => (
              <button key={c._id} className={`fc-channel ${channel?._id === c._id ? "active" : ""}`} onClick={() => { setChannelId(c._id); setMobileNav(false); }}>
                <Hash size={17} /> {c.name}
              </button>
            ))}
            </div>
            <button className="fc-invite-btn" onClick={() => openModal("invite")}>
              <Users size={16} /> Invite your people
            </button>
            <button className="fc-sidebar-action" onClick={() => { setSettingsOpen(true); setMobileNav(false); }}><Settings size={17} /> Settings</button>
            {communityList.length > 0 && (
              <>
                <div className="fc-sidebar-section"><span>YOUR COMMUNITIES</span></div>
                <div className="fc-sidebar-scroll fc-community-scroll" ref={communityListRef}>
                  {communityList.map((c) => (
                    <button key={c._id} className={`fc-sidebar-action community ${communityId === c._id ? "active" : ""}`} onClick={() => openCommunity(c._id)}>
                      <span className="fc-sidebar-community-icon">
                        {(c as { iconUrl?: string | null }).iconUrl
                          ? <img src={(c as { iconUrl?: string | null }).iconUrl!} alt="" />
                          : initialsOf(c.name)}
                      </span>
                      {c.name}
                    </button>
                  ))}
                </div>
              </>
            )}
            {communities && communityList.length === 0 && (
              <div className="fc-communities-empty">
                <strong>No communities yet</strong>
                <small>Create a community or join one to get started.</small>
                <button className="fc-cm-add" onClick={() => openModal("createCommunity")}><Plus size={13} /> Create a community</button>
              </div>
            )}
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
            {/* Settings is also reachable from the expanded sidebar (in addition to the user panel). */}
            <button className="fc-sidebar-action" onClick={() => { setSettingsOpen(true); setMobileNav(false); }}><Settings size={17} /> Settings</button>

            {communityList.length > 0 && (
              <>
                <div className="fc-sidebar-section"><span>COMMUNITIES</span></div>
                <div className="fc-sidebar-scroll fc-community-scroll" ref={communityListRef}>
                  {communityList.map((c) => (
                    <button key={c._id} className="fc-sidebar-action community" onClick={() => openCommunity(c._id)}>
                      <span className="fc-sidebar-community-icon">
                        {(c as { iconUrl?: string | null }).iconUrl
                          ? <img src={(c as { iconUrl?: string | null }).iconUrl!} alt="" />
                          : initialsOf(c.name)}
                      </span>
                      {c.name}
                    </button>
                  ))}
                </div>
              </>
            )}
            {communities && communityList.length === 0 && (
              <div className="fc-communities-empty">
                <strong>No communities yet</strong>
                <small>Create a community or join one to get started.</small>
                <button className="fc-cm-add" onClick={() => openModal("createCommunity")}><Plus size={13} /> Create a community</button>
              </div>
            )}

            <div className="fc-sidebar-section">
              <span>CONVERSATIONS</span>
              <button aria-label="New message" title="New message" onClick={() => setNewMessageOpen(true)}><Plus size={13} /></button>
            </div>
            <div className="fc-sidebar-scroll fc-dm-list" ref={dmListRef}>
            {conversations && conversationList.length === 0 && (
              <p className="fc-sidebar-empty">No conversations yet. Start one with the ＋ button.</p>
            )}
            {activeConversations.map((c) => (
              <div key={c.conversationId} className="fc-dm-row">
                <button
                  className={`fc-dm ${conversationId === c.conversationId && section === "dms" ? "active" : ""}`}
                  onClick={() => openConversation(c.conversationId)}
                >
                  {/* The other person's real, live presence — the same
                      authoritative value used by profiles, member lists and
                      popouts (invisible users arrive here as "offline"). */}
                  <Avatar
                    name={c.name}
                    size={26}
                    url={c.members?.[0]?.avatarUrl}
                    decorationId={c.members?.[0]?.decorationId}
                    presence={c.type === "group" ? undefined : c.members?.[0]?.presence}
                    lastSeen={c.members?.[0]?.lastSeen}
                    dotSide="left"
                    showAllStates
                  />
                  <span className="fc-dm-name">{c.type === "group" ? `${c.name} · ${c.memberCount}` : c.name}</span>
                  {c.locked && <span className="fc-dm-lock" title="Locked — PIN required" aria-label="Locked conversation"><Lock size={12} /></span>}
                  {c.pinned && <span className="fc-dm-flag">📌</span>}
                  {c.muted && <span className="fc-dm-flag">🔇</span>}
                  {c.unread > 0 && <i className="fc-dm-badge">{c.unread}</i>}
                </button>
                <div className="fc-dm-tools">
                  <button title="Pin" aria-label="Pin conversation" onClick={() => setPinned({ conversationId: c.conversationId, pinned: !c.pinned })}>📌</button>
                  <button title="Mute" aria-label="Mute conversation" onClick={() => setMuted({ conversationId: c.conversationId, muted: !c.muted })}>🔇</button>
                  <button
                    title={c.locked ? "Manage protection" : "Protect conversation"}
                    aria-label={c.locked ? "Manage conversation protection" : "Protect conversation"}
                    onClick={() => c.locked ? setSecretOpen(true) : setProtectTarget({ id: c.conversationId, name: c.name })}
                  >{c.locked ? "🔒" : "🔓"}</button>
                  <button title="Archive" aria-label="Archive conversation" onClick={() => setArchived({ conversationId: c.conversationId, archived: true })}>📥</button>
                  <button title={c.locked ? "Delete chat and its lock" : "Delete chat"} aria-label="Delete conversation" onClick={() => void removeConversation(c)}>🗑️</button>
                </div>
              </div>
            ))}
            {archivedConversations.length > 0 && (
              <>
                <button className="fc-sidebar-action" onClick={() => setArchivedOpen((v) => !v)}>
                  📥 Archived ({archivedConversations.length})
                </button>
                {archivedOpen && archivedConversations.map((c) => (
                  <div key={c.conversationId} className="fc-dm-row">
                    <button
                      className={`fc-dm ${conversationId === c.conversationId && section === "dms" ? "active" : ""}`}
                      onClick={() => openConversation(c.conversationId)}
                    >
                      <Avatar
                        name={c.name}
                        size={26}
                        url={c.members?.[0]?.avatarUrl}
                        decorationId={c.members?.[0]?.decorationId}
                        presence={c.type === "group" ? undefined : c.members?.[0]?.presence}
                        lastSeen={c.members?.[0]?.lastSeen}
                        dotSide="left"
                        showAllStates
                      />
                      <span className="fc-dm-name">{c.name}</span>
                      {c.locked && <span className="fc-dm-lock" title="Locked — PIN required" aria-label="Locked conversation"><Lock size={12} /></span>}
                      {c.unread > 0 && <i className="fc-dm-badge">{c.unread}</i>}
                    </button>
                    <div className="fc-dm-tools">
                      <button title="Unarchive" aria-label="Unarchive conversation" onClick={() => setArchived({ conversationId: c.conversationId, archived: false })}>📤</button>
                      <button title={c.locked ? "Delete chat and its lock" : "Delete chat"} aria-label="Delete conversation" onClick={() => void removeConversation(c)}>🗑️</button>
                    </div>
                  </div>
                ))}
              </>
            )}
            </div>
          </>
        )}

        {/* User panel */}
        <div className="fc-user-panel">
          <Avatar name={me?.profile?.displayName ?? me?.username ?? "You"} presence={me?.presence} size={34} url={me?.avatarUrl} lastSeen={me?.lastSeen} decorationId={me?.profile?.decorationId ?? null} />
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
          <FeatureBoundary fallback={null}>
            <AdminPanelEntry onOpen={() => navigate("/admin")} />
          </FeatureBoundary>
          <button aria-label="Open settings" onClick={() => setSettingsOpen(true)}><Settings size={18} /></button>
        </div>
      </aside>

      {/* ---------- Main ---------- */}
      <main className="fc-main">
        <header className="fc-topbar">
          <button className="fc-menu-btn" aria-label="Toggle navigation" onClick={toggleSidebar}><Menu size={20} /></button>
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

        <FeatureBoundary fallback={null}>
          <AnnouncementBanner />
        </FeatureBoundary>

        {notifOpen && (
          <div className="fc-notif-panel">
            <div className="fc-notif-head">
              <strong>Notifications</strong>
              <div className="fc-notif-head-actions">
                <button onClick={async () => { try { await markAllRead({}); toast.success("All caught up."); } catch { toast.error("Could not update."); } }}>Mark all read</button>
                <button onClick={async () => { try { const n = await clearNotifs({}); toast.success(n ? "Notifications cleared." : "Nothing to clear."); } catch { toast.error("Could not clear notifications."); } }}>Clear all</button>
              </div>
            </div>
            {invitationItems.length > 0 && (
              <div className="fc-invite-banner">
                {invitationItems.map((inv) => (
                  <div key={inv.invitationId} className="fc-invite-card">
                    <Avatar name={inv.fromName} size={34} url={inv.fromAvatarUrl} />
                    <div className="fc-invite-info">
                      <strong>{inv.media === "video" ? "🎥 Video Call Invite" : "🔊 Voice Call Invite"}</strong>
                      <small>
                        {inv.fromName} invited you to join the {inv.media} call
                        {inv.serverName ? ` in ${inv.serverName}${inv.channelName ? ` / #${inv.channelName}` : ""}` : ""}.
                      </small>
                      <small className="fc-muted">
                        {new Date(inv.createdAt).toLocaleTimeString()}
                        {" · expires "}{new Date(inv.expiresAt).toLocaleTimeString()}
                      </small>
                    </div>
                    <div className="fc-invite-card-actions">
                      <Button size="sm" onClick={() => void acceptInvitation(inv)}>Accept</Button>
                      <Button size="sm" variant="outline" onClick={() => void declineInvitation(inv)}>Decline</Button>
                      <Button size="sm" variant="ghost" aria-label="Dismiss invitation" title="Dismiss" onClick={() => void dismissInvitation(inv)}>✕</Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {notifications && notificationItems.length === 0 && invitationItems.length === 0 && <p className="fc-sidebar-empty">You're all caught up.</p>}
            {notificationItems.map((n) => (
              <div key={n._id} className={`fc-notif-row ${n.read ? "" : "unread"}`}>
                <button className="fc-notif" onClick={() => openNotification(n)} title={n.read ? "Read" : "Unread"}>
                  <strong>{n.title}</strong>
                  {n.body && <small>{n.body}</small>}
                  <small className="fc-muted">{new Date(n._creationTime).toLocaleString()}{n.read ? "" : " · unread"}</small>
                </button>
                <button
                  className="fc-notif-menu-btn"
                  aria-label="Notification options"
                  onClick={() => setNotifMenuFor(notifMenuFor === n._id ? null : n._id)}
                >⋯</button>
                {notifMenuFor === n._id && (
                  <div className="fc-menu fc-notif-menu" role="menu">
                    <button onClick={async () => { try { await setNotifRead({ id: n._id, read: !n.read }); } catch { toast.error("Could not update."); } setNotifMenuFor(null); }}>
                      {n.read ? "Mark as unread" : "Mark as read"}
                    </button>
                    <button className="danger" onClick={async () => { try { await deleteNotif({ id: n._id }); toast.success("Notification removed."); } catch { toast.error("Could not remove."); } setNotifMenuFor(null); }}>
                      Delete notification
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="fc-main-body">
          <div className="fc-main-content">
            {/* One failing view shows its own error; the sidebar and shell stay usable. */}
            <FeatureBoundary key={navKey} label="This view" block>
            {section === "home" && <HomeView onOpenProfile={setProfileUserId} onMessage={openConversation} onDiscover={() => setSection("discover")} onCall={callUser} />}
            {section === "discover" && <DiscoverView onOpenCommunity={openCommunity} onCreate={() => openModal("createCommunity")} onJoinByCode={() => openModal("join")} />}
            {section === "search" && <SearchView query={searchQuery} onOpenProfile={setProfileUserId} onOpenCommunity={openCommunity} />}
            {section === "dms" && (
              conversationId && (conversations === undefined || conversationList.some((c) => c.conversationId === conversationId)) ? (
                // A per-conversation boundary: one malformed conversation shows
                // its own fallback; the sidebar and every other conversation keep
                // working. Keyed by id so switching conversations retries cleanly.
                <FeatureBoundary
                  key={conversationId}
                  label="This conversation"
                  block
                  fallback={
                    <div className="fc-scroll-view">
                      <div className="fc-empty">
                        <AtSign size={30} />
                        <h3>Conversation unavailable</h3>
                        <p>This conversation couldn&apos;t be shown. Your other chats are unaffected.</p>
                        <Button className="mt-3" onClick={() => setConversationId(null)}>Back to messages</Button>
                      </div>
                    </div>
                  }
                >
                  <DmView conversationId={conversationId} myUserId={me?.userId ?? ""} onOpenProfile={setProfileUserId} onStartCall={startDmCall} highlightMessageId={highlightMessageId} onHighlightHandled={() => setHighlightMessageId(null)} />
                </FeatureBoundary>
              ) : conversationId ? (
                <div className="fc-scroll-view">
                  <div className="fc-empty">
                    <AtSign size={30} />
                    <h3>Conversation unavailable</h3>
                    <p>This conversation no longer exists or isn&apos;t shared with you.</p>
                    <Button className="mt-3" onClick={() => setConversationId(null)}>Back to messages</Button>
                  </div>
                </div>
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
                serverId={communityId ?? undefined}
                channelName={channel.name}
                channelDescription={channel.description}
                myUserId={me?.userId ?? ""}
                permissions={detailsPermissions}
                onOpenProfile={setProfileUserId}
                onJoinVoice={() => joinVoice(channel._id, channel.name)}
                isVoice={channel.type === "voice"}
                highlightMessageId={highlightMessageId}
                onHighlightHandled={() => setHighlightMessageId(null)}
              />
            )}
            {section === "community" && details && !channel && (
              <div className="fc-scroll-view"><div className="fc-empty"><h3>No text channels yet.</h3><p>Create one to start talking.</p></div></div>
            )}
            </FeatureBoundary>
          </div>            {section === "community" && details && (
            <aside className="fc-members" aria-label="Community members">
              <div className="fc-members-head">MEMBERS — {detailsMembers.length}</div>
              {detailsMembers.map((m) => (
                <button key={m.userId} className="fc-member" onClick={() => setProfileUserId(m.userId)}>
                  <Avatar name={m.displayName} color={m.avatarColor} presence={m.presence} size={30} url={m.avatarUrl} lastSeen={m.lastSeen} decorationId={m.decorationId} />
                  <span>
                    <strong>{m.displayName}</strong>
                    <small>{m.presence === "offline" ? formatLastSeen(m.lastSeen) : m.role === "owner" ? "Owner" : m.role}</small>
                  </span>
                </button>
              ))}
            </aside>
          )}
        </div>
      </main>

      {/* ---------- Overlays ---------- */}
      {profileUserId && !fullProfileUserId && (
        <FeatureBoundary fallback={null}>
          <ProfilePopup
            userId={profileUserId}
            serverId={section === "community" ? communityId ?? undefined : undefined}
            onClose={() => setProfileUserId(null)}
            onMessage={(id) => { openConversation(id as Id<"dmConversations">); setProfileUserId(null); }}
            onViewFull={(id) => { setFullProfileUserId(id); setProfileUserId(null); }}
            onCall={callUser}
          />
        </FeatureBoundary>
      )}
      {fullProfileUserId && (
        <div className="fc-profile-page-overlay">
          <FeatureBoundary fallback={null}>
            <FullProfile
              userId={fullProfileUserId}
              onBack={() => setFullProfileUserId(null)}
              onMessage={(id) => { openConversation(id as Id<"dmConversations">); setFullProfileUserId(null); }}
              onOpenProfile={(id) => setFullProfileUserId(id)}
              onCall={callUser}
            />
          </FeatureBoundary>
        </div>
      )}
      {settingsOpen && (
        <FeatureBoundary label="Settings" fallback={null}>
          <SettingsPanel
            onClose={() => setSettingsOpen(false)}
            onEditProfile={() => { setSettingsOpen(false); setProfileEditorOpen(true); }}
          />
        </FeatureBoundary>
      )}
      {profileEditorOpen && (
        <FeatureBoundary label="The profile editor" fallback={null}>
          <ProfileEditor onClose={() => setProfileEditorOpen(false)} />
        </FeatureBoundary>
      )}
      <FeatureBoundary label="New message" fallback={null}>
        <NewMessageDialog open={newMessageOpen} onClose={() => setNewMessageOpen(false)} onOpenConversation={(id) => { setNewMessageOpen(false); openConversation(id); }} />
      </FeatureBoundary>

      {/* Locked & Hidden Conversations */}
      <FeatureBoundary label="Locked chats" fallback={null}>
        <ProtectConversationDialog
          open={protectTarget !== null}
          conversationId={protectTarget?.id ?? null}
          conversationName={protectTarget?.name ?? ""}
          onClose={() => setProtectTarget(null)}
        />
        <SecretChatsDialog
          open={secretOpen}
          onClose={() => setSecretOpen(false)}
          onOpenConversation={(id) => { setSecretOpen(false); openConversation(id); }}
        />
      </FeatureBoundary>
      {communitySettingsOpen && communityId && (
        <FeatureBoundary label="Community settings" fallback={null}>
          <CommunitySettings
            serverId={communityId}
            onClose={() => setCommunitySettingsOpen(false)}
            onLeft={() => { setCommunitySettingsOpen(false); setCommunityId(null); setSection("home"); }}
          />
        </FeatureBoundary>
      )}

      {dmCall && me?.userId && (
        <FeatureBoundary label="The call" fallback={null}>
          <DmCallPanel
            conversationId={dmCall.conversationId}
            peerId={dmCall.peerId}
            peerName={dmCall.name}
            peerUsername={dmCall.username}
            myUserId={me.userId}
            media={dmCall.media}
            minimized={callMinimized}
            canInvite={dmCall.invited !== true}
            onMinimize={() => setCallMinimized(true)}
            onExpand={() => setCallMinimized(false)}
            onLeave={endDmCall}
          />
        </FeatureBoundary>
      )}

      {inCall && (
        <FeatureBoundary label="The call" fallback={null}>
          <VoicePanel
            channelId={inCall.channelId}
            channelName={inCall.name}
            myUserId={me?.userId ?? ""}
            onOpenProfile={setProfileUserId}
            minimized={callMinimized}
            onMinimize={() => setCallMinimized(true)}
            onExpand={() => setCallMinimized(false)}
            onLeave={async () => { try { await leaveVoiceSession({}); } catch { /* already left */ } setInCall(null); setCallMinimized(false); }}
          />
        </FeatureBoundary>
      )}

      {/* ---------- Incoming / outgoing call ---------- */}
      {incomingCall && (
        <div className="fc-incoming-call" role="dialog" aria-label="Incoming call">
          <div className="fc-incoming-card">
            <Avatar name={incomingCall.fromName} size={84} url={incomingCall.fromAvatarUrl} />
            <strong className="fc-incoming-name">{incomingCall.fromName}</strong>
            <small className="fc-incoming-kind">
              {incomingCall.channelId
                ? `Invited to the ${incomingCall.media === "video" ? "video" : "voice"} call in ${incomingCall.community?.serverName ?? "a community"} · #${incomingCall.community?.channelName ?? ""}`
                : incomingCall.media === "video" ? "Incoming Video Call" : "Incoming Voice Call"}
            </small>
            <div className="fc-incoming-actions">
              <Button
                onClick={async () => {
                  try {
                    await respondCall({ inviteId: incomingCall.inviteId, accept: true });
                    if (incomingCall.channelId) {
                      // Accepting joins the EXISTING community call — the same
                      // voice channel the inviter is already connected to. No
                      // separate call is created.
                      const targetChannel = incomingCall.channelId as Id<"channels">;
                      setCallMinimized(false);
                      setMobileNav(false);
                      if (incomingCall.community?.serverId) setCommunityId(incomingCall.community.serverId);
                      setSection("community");
                      setChannelId(targetChannel);
                      await joinVoice(targetChannel, incomingCall.community?.channelName ?? "Voice");
                    } else if (incomingCall.conversationId) {
                      setCallMinimized(false);
                      setDmCall({
                        inviteId: incomingCall.inviteId,
                        conversationId: incomingCall.conversationId as Id<"dmConversations">,
                        peerId: incomingCall.fromId as Id<"users">,
                        name: incomingCall.fromName,
                        username: incomingCall.fromUsername ?? null,
                        media: incomingCall.media,
                      });
                    } else {
                      toast.error("This call has no conversation to connect to.");
                    }
                  } catch (err) {
                    // Surfaces the server's permission/lock/ban refusal verbatim.
                    toast.error(err instanceof Error ? err.message : "Could not join the call.");
                  }
                }}
              >
                <Phone className="mr-1 h-4 w-4" /> Accept
              </Button>
              <Button variant="destructive" onClick={async () => { await respondCall({ inviteId: incomingCall.inviteId, accept: false }); }}>Decline</Button>
            </div>
          </div>
        </div>
      )}
      {outgoingCall && outgoingCall.status === "ringing" && !dmCall && (
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
                  {channelType === "text" && (
                    <>
                      <label htmlFor="modal-topic">Topic / description</label>
                      <Input id="modal-topic" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} placeholder="What's this channel for?" />
                    </>
                  )}
                  <label htmlFor="modal-category">Category</label>
                  <select id="modal-category" className="fc-select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                    <option value="">No category</option>
                    {channelCategoryList.map((cat) => <option key={cat._id} value={cat._id}>{cat.name}</option>)}
                  </select>
                  {channelType !== "text" && (
                    <>
                      <label htmlFor="modal-limit">User limit (0 = unlimited)</label>
                      <Input id="modal-limit" type="number" min={0} max={100} value={userLimit} onChange={(e) => setUserLimit(Number(e.target.value) || 0)} />
                      <label className="fc-checkbox-row">
                        <input type="checkbox" checked={isPrivateChannel} onChange={(e) => setIsPrivateChannel(e.target.checked)} />
                        Private — only roles you allow can see and join it
                      </label>
                      {isPrivateChannel && (
                        <>
                          <span className="fc-field-label">Roles that can see this channel</span>
                          <div className="fc-radio-row">
                            {["moderator", "member"].map((r) => (
                              <label key={r} className={`fc-radio ${allowedRoleIds.includes(r) ? "active" : ""}`}>
                                <input
                                  type="checkbox"
                                  checked={allowedRoleIds.includes(r)}
                                  onChange={(e) => setAllowedRoleIds(e.target.checked ? [...allowedRoleIds, r] : allowedRoleIds.filter((x) => x !== r))}
                                />
                                {r.charAt(0).toUpperCase() + r.slice(1)}
                              </label>
                            ))}
                            {detailsRoles.filter((r) => r.name !== "owner").map((r) => (
                              <label key={r._id} className={`fc-radio ${allowedRoleIds.includes(r._id) ? "active" : ""}`}>
                                <input
                                  type="checkbox"
                                  checked={allowedRoleIds.includes(r._id)}
                                  onChange={(e) => setAllowedRoleIds(e.target.checked ? [...allowedRoleIds, r._id] : allowedRoleIds.filter((x) => x !== r._id))}
                                />
                                {r.name}
                              </label>
                            ))}
                          </div>
                          <p className="fc-muted">Owners and admins can always see every channel.</p>
                        </>
                      )}
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

      {/* ---------- Rename category / channel ---------- */}
      {renameTarget && (
        <div className="fc-cm-confirm-overlay" onClick={() => setRenameTarget(null)}>
          <div className="fc-cm-confirm" role="dialog" aria-label="Rename" onClick={(e) => e.stopPropagation()}>
            <h4>Rename {renameTarget.kind === "category" ? "category" : "channel"}</h4>
            <label>New name
              <Input autoFocus value={renameValue} maxLength={40} onChange={(e) => setRenameValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void submitRename(); }} />
            </label>
            <div className="fc-cm-confirm-actions">
              <Button variant="ghost" onClick={() => setRenameTarget(null)}>Cancel</Button>
              <Button onClick={() => void submitRename()} disabled={!renameValue.trim()}>Save</Button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- Delete category / channel confirmation ---------- */}
      {confirmDelete && (
        <div className="fc-cm-confirm-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="fc-cm-confirm" role="alertdialog" aria-label={`Delete ${confirmDelete.name}`} onClick={(e) => e.stopPropagation()}>
            <h4>Delete &ldquo;{confirmDelete.name}&rdquo;?</h4>
            <p>{confirmDelete.kind === "category" ? "Its channels will move to Uncategorized. This cannot be undone." : "This cannot be undone."}</p>
            <div className="fc-cm-confirm-actions">
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
              <Button variant="destructive" onClick={() => void confirmDeleteNow()}>Delete</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
