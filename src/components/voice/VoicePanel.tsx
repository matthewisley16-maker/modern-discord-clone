import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import ProfileAvatar from "@/components/profile/ProfileAvatar";
import { toSafeArray } from "@/lib/collection";
import { toast } from "sonner";
import { Maximize, Maximize2, Mic, MicOff, Minimize2, MonitorUp, PhoneOff, Search, UserPlus, Video, VideoOff, VolumeX, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PRESENCE_META } from "@/components/dashboard/ui";
import { applyScreenToPeer, captureDisplay, type ScreenSenders } from "./screenShare";
import { useDraggableWindow } from "@/hooks/use-draggable";
import "./screenShare.css";

const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const SPEAK_THRESHOLD = 0.045; // RMS above this counts as speech
const SPEAK_HOLD_MS = 350; // keep the ring on briefly after speech stops

type ScreenEntry = { id: string; local: boolean; stream: MediaStream; name: string };

/**
 * Voice channel panel with real screen sharing.
 *
 * Screen share is captured with the browser's `getDisplayMedia()` and sent over
 * the SAME peer connections as voice/camera, using a dedicated send-only video
 * transceiver. The camera is never replaced, so voice + camera + screen can all
 * run together; stopping a share just clears that transceiver.
 *
 * Audio is transmitted peer-to-peer over WebRTC; signalling is relayed through
 * Convex. The component stays mounted across navigation, so `minimized` only
 * changes what is drawn — the call and any screen share keep running.
 */
export default function VoicePanel({
  channelId,
  channelName,
  myUserId,
  onLeave,
  onOpenProfile,
  minimized = false,
  onMinimize,
  onExpand,
}: {
  channelId: Id<"channels">;
  channelName: string;
  myUserId: string;
  onLeave: () => void;
  onOpenProfile: (userId: string) => void;
  minimized?: boolean;
  onMinimize?: () => void;
  onExpand?: () => void;
}) {
  const details = useQuery(api.voice.voiceChannelDetails, { channelId });
  // Normalized once so a malformed participant list can never crash the call UI.
  const participants = useMemo(
    () => toSafeArray<NonNullable<NonNullable<typeof details>["participants"]>[number]>(details?.participants, { label: "Voice participants", source: "api.voice.voiceChannelDetails" }),
    [details],
  );
  const signals = useQuery(api.communities.pollSignals, { channelId });
  const sendSignal = useMutation(api.communities.sendSignal);
  const clearSignal = useMutation(api.communities.clearSignal);
  const setVoiceFlags = useMutation(api.voice.setVoiceFlags);
  const setSpeaking = useMutation(api.voice.setSpeaking);
  const endCommunityCall = useMutation(api.voice.endCommunityCall);

  /** Authorized community members can end the call for everyone. */
  async function endForEveryone() {
    if (!window.confirm("End the call for everyone?")) return;
    try {
      await endCommunityCall({ channelId });
      toast.success("Call ended for everyone.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not end the call.");
    }
  }

  // ---- Community call invitations ----
  // Inviting someone into THIS call: the invite points at the channel the user
  // is already connected to, so accepting joins the very same call — no second
  // call, no duplicate session.
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteSearch, setInviteSearch] = useState("");
  const [invited, setInvited] = useState<Record<string, boolean>>({});
  const [inviteBusy, setInviteBusy] = useState<string | null>(null);
  // Subscribes ONLY while the picker is open, so an idle call creates no extra
  // presence traffic (Freecord has had Convex usage problems before).
  const inviteCandidates = useQuery(api.calls.communityInviteCandidates, inviteOpen ? { channelId } : "skip");
  const candidateList = useMemo(
    () => toSafeArray<NonNullable<NonNullable<typeof inviteCandidates>>[number]>(inviteCandidates, {
      label: "Community invite candidates",
      source: "api.calls.communityInviteCandidates",
    }),
    [inviteCandidates],
  );
  const filteredCandidates = useMemo(() => {
    const term = inviteSearch.trim().toLowerCase();
    if (!term) return candidateList;
    return candidateList.filter((c) => c.name.toLowerCase().includes(term) || c.username.toLowerCase().includes(term));
  }, [candidateList, inviteSearch]);
  const inviteToCall = useMutation(api.calls.inviteToCommunityCall);

  /** Invite a community member into this call (never a new, separate call). */
  async function inviteMember(userId: string) {
    setInviteBusy(userId);
    try {
      await inviteToCall({ channelId, toUserId: userId as Id<"users">, media: videoOn ? "video" : "voice" });
      setInvited((prev) => ({ ...prev, [userId]: true }));
      toast.success("Invitation sent.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send the invitation.");
    } finally {
      setInviteBusy(null);
    }
  }

  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [videoOn, setVideoOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [connection, setConnection] = useState<"connecting" | "connected" | "lost">("connecting");
  const [level, setLevel] = useState(0);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [remoteScreens, setRemoteScreens] = useState<Record<string, MediaStream>>({});
  const [screenFocus, setScreenFocus] = useState<string | null>(null);
  const [enlarged, setEnlarged] = useState(false);
  // True once the mic attempt has finished (granted or denied), so peer
  // connections can still form for camera-only / listen-only participants.
  const [mediaReady, setMediaReady] = useState(false);
  // The minimized floating window is draggable; the call itself is untouched.
  const miniDrag = useDraggableWindow(`vp-mini:${channelId}`);

  const localStream = useRef<MediaStream | null>(null);
  const peers = useRef<Map<string, RTCPeerConnection>>(new Map());
  const analyser = useRef<AnalyserNode | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const rafId = useRef<number | null>(null);
  const speakingRef = useRef(false);
  const lastSpokeRef = useRef(0);
  const audioEls = useRef<Map<string, HTMLAudioElement>>(new Map());
  const videoEls = useRef<Map<string, HTMLVideoElement>>(new Map());
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  // Throttles the mic-level meter so it does not re-render the whole grid 60×/s.
  const lastLevelRef = useRef(0);
  const lastLevelAtRef = useRef(0);

  // ---- Screen-share bookkeeping (all per-peer, never global) ----
  const screenStreamRef = useRef<MediaStream | null>(null); // persistent local preview + send source
  const screenSendersRef = useRef<Map<string, ScreenSenders>>(new Map());
  const sharingRef = useRef(false);
  // Which peers we initiated the offer for (only they auto-negotiate).
  const initiatorsRef = useRef<Set<string>>(new Set());
  // Every screen stream id a peer has ever announced (a peer's screen stream
  // stays the same object across start/stop, so tracks stay classified even
  // while sharing is paused).
  const remoteScreenIds = useRef<Map<string, Set<string>>>(new Map());
  const remoteScreenActive = useRef<Map<string, boolean>>(new Map());
  const remoteScreenStreams = useRef<Map<string, MediaStream>>(new Map());
  const mainStreams = useRef<Map<string, MediaStream>>(new Map());
  const trackStreamIds = useRef<Map<string, string>>(new Map());

  async function getMic(withVideo: boolean) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
    } catch (err) {
      const name = (err as DOMException)?.name;
      if (name === "NotAllowedError") {
        toast.error(withVideo ? "Camera or microphone permission was denied." : "Microphone permission was denied. Allow access to talk.");
      } else if (name === "NotFoundError") {
        toast.error("No microphone found on this device.");
      } else {
        toast.error("Could not access your microphone.");
      }
      return null;
    }
  }

  // ---- Real voice activity detection on the local microphone ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stream = await getMic(false);
      if (cancelled) { stream?.getTracks().forEach((t) => t.stop()); return; }
      setMediaReady(true);
      if (!stream) { setConnection("lost"); return; }
      localStream.current = stream;
      setConnection("connected");

      try {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Ctx) {
          const ctx = new Ctx();
          audioCtx.current = ctx;
          const source = ctx.createMediaStreamSource(stream);
          const node = ctx.createAnalyser();
          node.fftSize = 512;
          node.smoothingTimeConstant = 0.6;
          source.connect(node);
          analyser.current = node;

          const buffer = new Uint8Array(node.fftSize);
          const tick = () => {
            if (!analyser.current) return;
            analyser.current.getByteTimeDomainData(buffer);
            let sum = 0;
            for (let i = 0; i < buffer.length; i++) {
              const v = (buffer[i] - 128) / 128;
              sum += v * v;
            }
            const rms = Math.sqrt(sum / buffer.length);
            const micMuted = localStream.current?.getAudioTracks().every((t) => !t.enabled) ?? false;
            const talking = !micMuted && rms > SPEAK_THRESHOLD;
            const now = Date.now();
            const nextLevel = Math.min(1, rms * 8);
            if (now - lastLevelAtRef.current > 100 || Math.abs(nextLevel - lastLevelRef.current) > 0.08) {
              lastLevelAtRef.current = now;
              lastLevelRef.current = nextLevel;
              setLevel(nextLevel);
            }

            if (talking) lastSpokeRef.current = now;
            const shouldSpeak = talking || now - lastSpokeRef.current < SPEAK_HOLD_MS;

            // Only write to the backend on transitions — no per-frame traffic.
            if (shouldSpeak !== speakingRef.current) {
              speakingRef.current = shouldSpeak;
              setSpeaking({ speaking: shouldSpeak }).catch(() => {});
            }
            rafId.current = requestAnimationFrame(tick);
          };
          rafId.current = requestAnimationFrame(tick);
        }
      } catch {
        // Analysis is optional; audio still works without it.
      }
    })();

    return () => {
      cancelled = true;
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
      analyser.current = null;
      void audioCtx.current?.close().catch(() => {});
      audioCtx.current = null;
      if (speakingRef.current) { speakingRef.current = false; setSpeaking({ speaking: false }).catch(() => {}); }
      peers.current.forEach((pc) => pc.close());
      peers.current.clear();
      videoEls.current.clear();
      audioEls.current.clear();
      // Release the screen capture too — leaving the call must stop sharing.
      sharingRef.current = false;
      screenStreamRef.current?.getTracks().forEach((t) => { try { t.stop(); } catch { /* noop */ } });
      screenStreamRef.current = null;
      screenSendersRef.current.clear();
      initiatorsRef.current.clear();
      mainStreams.current.clear();
      remoteScreenStreams.current.clear();
      remoteScreenIds.current.clear();
      remoteScreenActive.current.clear();
      trackStreamIds.current.clear();
      localStream.current?.getTracks().forEach((t) => t.stop());
      localStream.current = null;
    };
  }, [setSpeaking]);

  // ---- Screen-share signalling helpers ----
  const notifyScreen = (remoteId: string, on: boolean) => {
    const streamId = on ? screenStreamRef.current?.id ?? "" : "";
    sendSignal({ channelId, toUserId: remoteId as Id<"users">, kind: "screen", payload: JSON.stringify({ on, streamId }) }).catch(() => {});
  };

  /** Push the current screen track to one peer (idempotent — safe to call twice). */
  async function pushScreenToPeer(remoteId: string) {
    const pc = peers.current.get(remoteId);
    const ss = screenStreamRef.current;
    if (!pc || !ss || !sharingRef.current) return;
    let holders = screenSendersRef.current.get(remoteId);
    if (!holders) { holders = {}; screenSendersRef.current.set(remoteId, holders); }
    const firstTime = !holders.video && !holders.audio;
    await applyScreenToPeer(pc, holders, ss, ss.getVideoTracks()[0] ?? null, ss.getAudioTracks()[0] ?? null);
    // Adding the screen transceiver needs a renegotiation. The offer-initiating
    // peer gets it automatically from `onnegotiationneeded`; the other peer must
    // send the offer explicitly (same pattern the camera toggle already uses) so
    // the remote actually receives the new track.
    if (firstTime && !initiatorsRef.current.has(remoteId)) {
      try {
        const offer = await pc.createOffer();
        if (pc.signalingState === "stable") {
          await pc.setLocalDescription(offer);
          await sendSignal({ channelId, toUserId: remoteId as Id<"users">, kind: "offer", payload: JSON.stringify(pc.localDescription) });
        }
      } catch { /* retried on the next negotiationneeded */ }
    }
    notifyScreen(remoteId, true);
  }

  /**
   * Route every incoming track to either the participant's camera/audio stream
   * or their screen stream. The screen stream id is announced over the relay,
   * so a screen track is never mistaken for the camera.
   */
  function classifyPeer(remoteId: string) {
    const pc = peers.current.get(remoteId);
    const main = mainStreams.current.get(remoteId);
    if (!pc || !main) return;
    const screenIds = remoteScreenIds.current.get(remoteId);
    let scr = remoteScreenStreams.current.get(remoteId);
    if (screenIds && screenIds.size > 0 && !scr) { scr = new MediaStream(); remoteScreenStreams.current.set(remoteId, scr); }
    for (const r of pc.getReceivers()) {
      const t = r.track;
      if (!t) continue;
      const sid = trackStreamIds.current.get(t.id);
      const isScreen = Boolean(screenIds && sid && screenIds.has(sid));
      const target = isScreen && scr ? scr : main;
      const other = isScreen ? main : scr;
      if (!target.getTracks().some((x) => x.id === t.id)) target.addTrack(t);
      if (other && other !== target && other.getTracks().some((x) => x.id === t.id)) other.removeTrack(t);
    }
    // Main stream feeds the participant tile + audio sink.
    setRemoteStreams((prev) => (prev[remoteId] === main ? prev : { ...prev, [remoteId]: main }));
    // Only show the screen stage once the real remote track has arrived and the
    // peer has announced that sharing is on — never a placeholder.
    const active = (remoteScreenActive.current.get(remoteId) ?? false)
      && Boolean(scr?.getVideoTracks().some((t) => t.readyState === "live"));
    setRemoteScreens((prev) => {
      if (active && scr) return prev[remoteId] === scr ? prev : { ...prev, [remoteId]: scr };
      if (prev[remoteId]) { const next = { ...prev }; delete next[remoteId]; return next; }
      return prev;
    });
  }

  // ---- WebRTC peer connections ----
  function attachRemote(userId: string, stream: MediaStream) {
    setRemoteStreams((prev) => ({ ...prev, [userId]: stream }));
    const el = audioEls.current.get(userId);
    if (el) { el.srcObject = stream; void el.play().catch(() => {}); }
    const vel = videoEls.current.get(userId);
    if (vel) { vel.srcObject = stream; void vel.play().catch(() => {}); }
  }

  function createPeer(remoteId: string, initiator: boolean) {
    const existing = peers.current.get(remoteId);
    if (existing) return existing;
    const pc = new RTCPeerConnection(ICE);
    peers.current.set(remoteId, pc);
    localStream.current?.getTracks().forEach((t) => pc.addTrack(t, localStream.current!));

    const remote = new MediaStream();
    mainStreams.current.set(remoteId, remote);
    pc.ontrack = (e) => {
      trackStreamIds.current.set(e.track.id, e.streams[0]?.id ?? "");
      classifyPeer(remoteId);
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) sendSignal({ channelId, toUserId: remoteId as Id<"users">, kind: "candidate", payload: JSON.stringify(e.candidate) }).catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        attachRemote(remoteId, remote);
        setConnection("connected");
      } else if (pc.connectionState === "failed") {
        // Only a REAL failure triggers recovery. `disconnected` is routinely
        // transient during ICE, and acting on it (recreating the peer) is what
        // made the video repeatedly flash video → black → video.
        setConnection("lost");
        try { pc.restartIce?.(); } catch { /* older browsers */ }
      }
      // `disconnected` is deliberately ignored — a healthy connection recovers.
    };
    if (initiator) {
      pc.onnegotiationneeded = async () => {
        if (pc.signalingState !== "stable") return;
        try {
          const offer = await pc.createOffer();
          if (pc.signalingState !== "stable") return;
          await pc.setLocalDescription(offer);
          await sendSignal({ channelId, toUserId: remoteId as Id<"users">, kind: "offer", payload: JSON.stringify(pc.localDescription) });
        } catch { /* retried on the next negotiationneeded */ }
      };
    }
    if (initiator) initiatorsRef.current.add(remoteId);
    // If we are already sharing, the new peer must receive the screen too.
    if (sharingRef.current) void pushScreenToPeer(remoteId);
    return pc;
  }

  useEffect(() => {
    if (!details || !mediaReady) return;
    for (const p of participants) {
      if (p.userId === myUserId) continue;
      if (!peers.current.has(p.userId)) createPeer(p.userId, myUserId < p.userId);
    }
    // Drop peer connections for people who left (no ghost streams/tiles).
    const present = new Set(participants.map((p) => p.userId as string));
    for (const [id, pc] of peers.current) {
      if (!present.has(id)) {
        pc.close();
        peers.current.delete(id);
        videoEls.current.delete(id);
        audioEls.current.delete(id);
        mainStreams.current.delete(id);
        remoteScreenStreams.current.delete(id);
        remoteScreenIds.current.delete(id);
        remoteScreenActive.current.delete(id);
        screenSendersRef.current.delete(id);
        initiatorsRef.current.delete(id);
        setRemoteStreams((prev) => { if (!prev[id]) return prev; const next = { ...prev }; delete next[id]; return next; });
        setRemoteScreens((prev) => { if (!prev[id]) return prev; const next = { ...prev }; delete next[id]; return next; });
      }
    }
  }, [details, myUserId, mediaReady]);

  // Deafen silences every remote participant without changing their streams.
  useEffect(() => {
    audioEls.current.forEach((el) => { el.muted = deafened; });
  }, [deafened]);

  useEffect(() => {
    if (!signals) return;
    (async () => {
      for (const s of signals) {
        try {
          const pc = createPeer(s.fromUserId, myUserId < s.fromUserId);
          const data = JSON.parse(s.payload);
          if (s.kind === "offer") {
            await pc.setRemoteDescription(new RTCSessionDescription(data));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await sendSignal({ channelId, toUserId: s.fromUserId as Id<"users">, kind: "answer", payload: JSON.stringify(pc.localDescription) });
          } else if (s.kind === "answer") {
            if (pc.signalingState !== "stable") await pc.setRemoteDescription(new RTCSessionDescription(data));
          } else if (s.kind === "candidate") {
            await pc.addIceCandidate(new RTCIceCandidate(data));
          } else if (s.kind === "screen") {
            const meta = data as { on?: boolean; streamId?: string };
            if (meta.streamId) {
              let set = remoteScreenIds.current.get(s.fromUserId);
              if (!set) { set = new Set<string>(); remoteScreenIds.current.set(s.fromUserId, set); }
              set.add(meta.streamId);
            }
            remoteScreenActive.current.set(s.fromUserId, Boolean(meta.on));
            classifyPeer(s.fromUserId);
          }
        } catch { /* ignore out-of-order signalling */ }
        await clearSignal({ signalId: s._id });
      }
    })();
  }, [signals, channelId, clearSignal, sendSignal]);

  async function toggleMute() {
    const next = !muted;
    setMuted(next);
    localStream.current?.getAudioTracks().forEach((t) => (t.enabled = !next));
    if (next && speakingRef.current) { speakingRef.current = false; setSpeaking({ speaking: false }).catch(() => {}); }
    await setVoiceFlags({ muted: next }).catch(() => {});
  }

  async function toggleDeafen() {
    const next = !deafened;
    setDeafened(next);
    await setVoiceFlags({ deafened: next }).catch(() => {});
  }

  /**
   * Turn the camera on/off without disturbing the microphone, the screen share
   * or the call.
   */
  async function toggleVideo() {
    if (videoOn) {
      for (const track of localStream.current?.getVideoTracks() ?? []) {
        for (const pc of peers.current.values()) {
          const sender = pc.getSenders().find((s) => s.track === track);
          if (sender) pc.removeTrack(sender);
        }
        track.stop();
        localStream.current?.removeTrack(track);
      }
      if (localVideoRef.current) localVideoRef.current.srcObject = null;
      setVideoOn(false);
      await setVoiceFlags({ video: false }).catch(() => {});
      return;
    }

    let videoStream: MediaStream | null = null;
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
    } catch (err) {
      const name = (err as DOMException)?.name;
      toast.error(name === "NotAllowedError"
        ? "Camera permission is required to turn your camera on."
        : name === "NotFoundError"
          ? "No camera was found on this device."
          : "Could not access your camera.");
      return;
    }
    const track = videoStream.getVideoTracks()[0];
    if (!track) return;

    // Make sure we have a local stream to piggyback on, and show our preview.
    // If mic access was denied earlier, acquire it here so audio flows too.
    if (!localStream.current) {
      const mic = await getMic(false);
      if (mic) {
        localStream.current = mic;
        const micTrack = mic.getAudioTracks()[0];
        if (micTrack) for (const pc of peers.current.values()) pc.addTrack(micTrack, mic);
        setMediaReady(true);
      }
    }
    localStream.current?.addTrack(track);
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStream.current ?? videoStream;
      void localVideoRef.current.play().catch(() => {});
    }

    for (const [remoteId, pc] of peers.current) {
      const sender = pc.getSenders().find((s) => s.track?.kind === "video");
      if (sender) await sender.replaceTrack(track);
      else pc.addTrack(track, localStream.current!);
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await sendSignal({ channelId, toUserId: remoteId as Id<"users">, kind: "offer", payload: JSON.stringify(offer) });
      } catch { /* retried on reconnect */ }
    }
    setVideoOn(true);
    await setVoiceFlags({ video: true }).catch(() => {});
  }

  /** Start or stop sharing. A cancelled picker silently does nothing at all. */
  async function toggleScreen() {
    if (sharingRef.current) { await stopScreen(); return; }

    const result = await captureDisplay();
    if (!result.ok) {
      // Cancelling the browser picker must never look like a call failure.
      if (!result.cancelled && result.message) toast.error(result.message);
      return;
    }
    const display = result.stream;
    const videoTrack = display.getVideoTracks()[0];
    if (!videoTrack) { display.getTracks().forEach((t) => t.stop()); toast.error("No screen was selected."); return; }
    const audioTrack = display.getAudioTracks()[0] ?? null;

    let ss = screenStreamRef.current;
    if (!ss) { ss = new MediaStream(); screenStreamRef.current = ss; }
    ss.addTrack(videoTrack);
    if (audioTrack) ss.addTrack(audioTrack);

    sharingRef.current = true;
    setScreenOn(true);
    setScreenFocus("self");
    // The browser's own "Stop sharing" button ends the track — react to it.
    videoTrack.onended = () => { void stopScreen(); };

    await setVoiceFlags({ screen: true }).catch(() => {});
    for (const remoteId of peers.current.keys()) await pushScreenToPeer(remoteId);
  }

  /** Stop sharing without touching the call, the mic, or the camera. */
  async function stopScreen() {
    const wasSharing = sharingRef.current;
    sharingRef.current = false;
    screenStreamRef.current?.getTracks().forEach((t) => { t.onended = null; });
    setScreenOn(false);
    setScreenFocus((f) => (f === "self" ? null : f));
    if (wasSharing) {
      for (const [remoteId, holders] of screenSendersRef.current) {
        if (holders.video) { try { await holders.video.replaceTrack(null); } catch { /* noop */ } }
        if (holders.audio) { try { await holders.audio.replaceTrack(null); } catch { /* noop */ } }
        notifyScreen(remoteId, false);
      }
    }
    const ss = screenStreamRef.current;
    ss?.getTracks().forEach((t) => { try { t.stop(); } catch { /* noop */ } ss.removeTrack(t); });
    if (wasSharing) await setVoiceFlags({ screen: false }).catch(() => {});
  }

  function toggleFullscreen() {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) { void document.exitFullscreen?.().catch(() => {}); return; }
    void el.requestFullscreen?.().catch(() => {});
  }

  const statusLabel = connection === "connected" ? "Voice Connected" : connection === "connecting" ? "Connecting…" : "Connection Lost";

  const screenEntries = useMemo<ScreenEntry[]>(() => {
    const list: ScreenEntry[] = [];
    if (screenOn && screenStreamRef.current) list.push({ id: "self", local: true, stream: screenStreamRef.current, name: "You" });
    for (const p of participants) {
      if (p.userId === myUserId) continue;
      const s = remoteScreens[p.userId];
      if (s) list.push({ id: p.userId, local: false, stream: s, name: p.name });
    }
    return list;
  }, [screenOn, remoteScreens, participants, myUserId]);
  const activeFocus = screenFocus && screenEntries.some((e) => e.id === screenFocus)
    ? screenFocus
    : screenEntries[0]?.id ?? null;

  return (
    <>
      {/* Always-mounted remote audio sinks so the call keeps playing even while
          the full interface is minimized. */}
      <div className="vp-sinks" aria-hidden="true">
        {participants.filter((p) => p.userId !== myUserId).map((p) => (
          <audio
            key={p.userId}
            autoPlay
            playsInline
            ref={(el) => {
              if (!el) { audioEls.current.delete(p.userId); return; }
              audioEls.current.set(p.userId, el);
              const s = remoteStreams[p.userId];
              if (s && el.srcObject !== s) el.srcObject = s;
              el.muted = deafened;
            }}
          />
        ))}
      </div>

      {minimized ? (
        <div
          className={`vp-mini ${miniDrag.dragging ? "dragging" : ""}`}
          role="region"
          aria-label={`${channelName} call`}
          ref={miniDrag.ref}
          style={miniDrag.style}
          onPointerDown={miniDrag.startDrag}
          onClick={() => { if (!miniDrag.wasDragged()) onExpand?.(); }}
          title="Drag to move · click to open"
        >
          <div className="vp-mini-head">
            <span className="vp-mini-title"><span className={`vp-mini-dot ${connection}`} /> {channelName}</span>
            <button className="vp-mini-x" aria-label="Leave call" onClick={(e) => { e.stopPropagation(); onLeave(); }}><X size={14} /></button>
          </div>
          <div className="vp-mini-avs">
            {participants.slice(0, 5).map((p) => (
              <span key={p.userId} className={`vp-mini-av ${p.speaking ? "speaking" : ""}`}>
                <ProfileAvatar name={p.name} url={p.avatarUrl} size={26} showPresence={false} />
              </span>
            ))}
            {participants.length > 5 && <span className="vp-mini-more">+{participants.length - 5}</span>}
            <span className="vp-mini-count">{participants.length}</span>
          </div>
          {screenOn && <span className="vp-mini-sharing"><MonitorUp size={12} /> sharing</span>}
          {videoOn && (
            <video
              className="vp-mini-cam"
              autoPlay
              playsInline
              muted
              ref={(el) => {
                if (!el) return;
                const s = localStream.current;
                if (s && el.srcObject !== s) { el.srcObject = s; void el.play().catch(() => {}); }
              }}
            />
          )}
          <div className="vp-mini-controls" onClick={(e) => e.stopPropagation()}>
            <button className={muted ? "active" : ""} onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute" : "Mute"}>
              {muted ? <MicOff size={16} /> : <Mic size={16} />}
            </button>
            <button className={videoOn ? "active" : ""} onClick={toggleVideo} aria-label="Toggle camera" title="Toggle camera">
              {videoOn ? <Video size={16} /> : <VideoOff size={16} />}
            </button>
            <button className={screenOn ? "active" : ""} onClick={toggleScreen} aria-label="Share screen" title="Share screen">
              <MonitorUp size={16} />
            </button>
            <button className={deafened ? "active" : ""} onClick={toggleDeafen} aria-label="Toggle deafen" title="Deafen">
              <VolumeX size={16} />
            </button>
            <button onClick={() => setInviteOpen(true)} aria-label="Invite people" title="Invite people"><UserPlus size={16} /></button>
            <button onClick={onExpand} aria-label="Open the call" title="Open the call"><Maximize2 size={16} /></button>
            <button className="danger" onClick={onLeave} aria-label="Leave the call" title="Leave the call"><PhoneOff size={16} /></button>
          </div>
        </div>
      ) : (
        <div className="fc-call-overlay" role="dialog" aria-label={`${channelName} voice`}>
          <div className="vp-panel">
            <header className="vp-head">
              <div>
                <p className="vp-title">{channelName}</p>
                <p className={`vp-status ${connection}`}>
                  <span className="vp-dot" /> {statusLabel} · {participants.length}{details?.userLimit ? `/${details.userLimit}` : ""}
                </p>
              </div>
              <div className="vp-head-actions">
                <Button size="sm" variant="outline" onClick={() => setInviteOpen(true)} title="Invite people to this call">
                  <UserPlus className="mr-1 h-4 w-4" /> Invite
                </Button>
                {details?.canEndCall && (
                  <Button size="sm" variant="outline" className="text-destructive" onClick={() => void endForEveryone()} title="End the call for everyone">
                    End for all
                  </Button>
                )}
                {onMinimize && (
                  <Button size="sm" variant="outline" onClick={onMinimize} title="Minimize — stay connected while you use Freecord">
                    <Minimize2 className="mr-1 h-4 w-4" /> Minimize
                  </Button>
                )}
                <Button size="sm" variant="destructive" onClick={onLeave}><PhoneOff className="mr-1 h-4 w-4" /> Disconnect</Button>
              </div>
            </header>

            {screenEntries.length > 0 && (
              <div className={`vp-screenstage ${enlarged ? "enlarged" : ""}`} ref={stageRef}>
                <div className="vp-screen-tabs">
                  {screenEntries.map((e) => (
                    <button
                      key={e.id}
                      className={`vp-screen-tab ${e.id === activeFocus ? "active" : ""}`}
                      onClick={() => setScreenFocus(e.id)}
                    >
                      <span className="vp-screen-tab-dot" /> {e.local ? "Your screen" : `${e.name}'s screen`}
                    </button>
                  ))}
                  <span className="vp-screen-tools">
                    <button onClick={() => setEnlarged((v) => !v)} title={enlarged ? "Exit focus" : "Focus shared screen"} aria-label={enlarged ? "Exit focus" : "Focus shared screen"}>
                      {enlarged ? <Minimize2 size={14} /> : <Maximize size={14} />}
                    </button>
                    <button onClick={toggleFullscreen} title="Fullscreen" aria-label="Fullscreen"><Maximize size={14} /></button>
                  </span>
                </div>
                <div className="vp-screen-main">
                  {screenEntries.map((e) => (
                    <video
                      key={e.id}
                      className={`vp-screen-video ${e.id === activeFocus ? "focus" : ""}`}
                      autoPlay
                      playsInline
                      muted={e.local || deafened}
                      ref={(el) => {
                        if (!el) return;
                        if (el.srcObject !== e.stream) { el.srcObject = e.stream; void el.play().catch(() => {}); }
                      }}
                    />
                  ))}
                  {screenOn && (
                    <div className="vp-screen-badge">
                      <MonitorUp size={13} /> You&apos;re sharing
                      <button onClick={() => void toggleScreen()}>Stop sharing</button>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="vp-grid">
              {participants.map((p) => {
                const isSelf = p.userId === myUserId;
                const stream = remoteStreams[p.userId];
                const showVideo = isSelf ? videoOn : p.video;
                return (
                  <div key={p.userId} className={`vp-tile ${p.speaking ? "speaking" : ""} ${isSelf ? "self" : ""}`}>
                    <div className="vp-media">
                      {/* Kept mounted for the whole call; visibility is CSS-only,
                          so toggling a camera never remounts the element. */}
                      <video
                        className={`vp-video ${showVideo ? "" : "off"}`}
                        autoPlay
                        playsInline
                        muted
                        ref={(el) => {
                          if (!el) return;
                          if (isSelf) {
                            localVideoRef.current = el;
                            const s = localStream.current;
                            if (s && el.srcObject !== s) el.srcObject = s;
                          } else {
                            videoEls.current.set(p.userId, el);
                            const s = stream ?? null;
                            if (el.srcObject !== s) el.srcObject = s;
                          }
                        }}
                      />
                      {!showVideo && (
                        <span className="vp-avatar-holder">
                          <ProfileAvatar name={p.name} url={p.avatarUrl} size={64} showPresence={false} />
                          {p.speaking && <span className="vp-speaking-ring" aria-hidden="true" />}
                        </span>
                      )}
                    </div>
                    <button className="vp-name-btn" onClick={() => onOpenProfile(p.userId)}>
                      <span className="vp-name">{p.name}{isSelf ? " (you)" : ""}</span>
                    </button>
                    <span className="vp-flags">
                      {p.deafened ? <VolumeX size={13} aria-label="Deafened" /> : p.muted ? <MicOff size={13} aria-label="Muted" /> : null}
                      {p.video && <Video size={13} aria-label="Camera on" />}
                      {isSelf ? (screenOn && <MonitorUp size={13} aria-label="Sharing screen" />) : (remoteScreens[p.userId] && <MonitorUp size={13} aria-label="Sharing screen" />)}
                      {p.speaking && <em className="vp-speaking-text">speaking</em>}
                    </span>
                  </div>
                );
              })}
              {participants.length === 0 && <p className="fc-muted">Connecting to the channel…</p>}
            </div>

            {/* Local mic level meter — proves the speaking detection is live. */}
            <div className="vp-meter" aria-hidden="true">
              <span style={{ width: `${Math.round(level * 100)}%` }} className={speakingRef.current ? "on" : ""} />
            </div>

            <footer className="vp-controls">
              <button className={muted ? "active" : ""} onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute" : "Mute"}>
                {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
              </button>
              <button className={deafened ? "active" : ""} onClick={toggleDeafen} aria-label={deafened ? "Undeafen" : "Deafen"} title={deafened ? "Undeafen" : "Deafen"}>
                <VolumeX className="h-5 w-5" />
              </button>
              <button className={videoOn ? "active" : ""} onClick={toggleVideo} aria-label="Toggle camera" title="Toggle camera">
                {videoOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
              </button>
              <button className={screenOn ? "active" : ""} onClick={() => void toggleScreen()} aria-label={screenOn ? "Stop sharing screen" : "Share screen"} title={screenOn ? "Stop sharing" : "Share screen"}>
                <MonitorUp className="h-5 w-5" />
              </button>
              <button onClick={() => setInviteOpen(true)} aria-label="Invite people to this call" title="Invite people">
                <UserPlus className="h-5 w-5" />
              </button>
            </footer>
          </div>
        </div>
      )}

      {/* Invite picker — community members who can join THIS call. */}
      {inviteOpen && (
        <Dialog open onOpenChange={(open) => { if (!open) { setInviteOpen(false); setInviteSearch(""); } }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Invite to {channelName}</DialogTitle>
              <DialogDescription>
                Everyone you invite joins this same call — the one you&apos;re already in.
              </DialogDescription>
            </DialogHeader>
            <div className="fc-invite-search">
              <Search size={14} />
              <Input
                value={inviteSearch}
                onChange={(e) => setInviteSearch(e.target.value)}
                placeholder="Search name or username"
                aria-label="Search community members"
              />
            </div>
            <ul className="fc-invite-list">
              {inviteCandidates === undefined && <li className="fc-invite-empty">Loading people…</li>}
              {inviteCandidates !== undefined && filteredCandidates.length === 0 && (
                <li className="fc-invite-empty">No one else can be invited to this call right now.</li>
              )}
              {filteredCandidates.map((c) => (
                <li key={c.userId} className="fc-invite-row">
                  <ProfileAvatar name={c.name} url={c.avatarUrl} presence={c.presence} size={32} />
                  <span className="fc-invite-who">
                    <strong>{c.name}</strong>
                    <small>
                      @{c.username}{c.friend ? " · Friend" : ""}
                      {" · "}{PRESENCE_META[c.presence]?.label ?? "Offline"}
                    </small>
                  </span>
                  {c.inCall ? (
                    <span className="fc-invite-note">Already in call</span>
                  ) : invited[c.userId] ? (
                    <span className="fc-invite-note sent">Invited</span>
                  ) : (
                    <Button size="sm" disabled={inviteBusy === c.userId} onClick={() => void inviteMember(c.userId)}>
                      Invite
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
