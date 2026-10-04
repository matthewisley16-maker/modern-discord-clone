import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import ProfileAvatar from "@/components/profile/ProfileAvatar";
import { toast } from "sonner";
import { Maximize, Maximize2, Mic, MicOff, Minimize2, MonitorUp, PhoneOff, Video, VideoOff, Volume2, VolumeX, X } from "lucide-react";
import { applyScreenToPeer, captureDisplay, type ScreenSenders } from "@/components/voice/screenShare";
import "@/components/voice/screenShare.css";

const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

// Remembered across the session so the window reappears where the user put it.
let savedPos: { x: number; y: number } | null = null;

function fmtDuration(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Play a media element and swallow autoplay rejections (never loops/retries). */
function safePlay(el: HTMLMediaElement | null) {
  if (!el) return;
  const p = el.play();
  if (p && typeof p.catch === "function") p.catch(() => {});
}

type View = "compact" | "float" | "full";

/**
 * A real 1:1 call inside a DM conversation, rendered as a DRAGGABLE floating
 * window for both audio and video calls, with real screen sharing.
 *
 * The media lifecycle stays deliberately stable, because rebuilding it is
 * exactly what makes video flash black:
 *  - `getUserMedia` runs once per call (guarded by `initRef`).
 *  - Exactly one `RTCPeerConnection` exists for the call; it is never recreated
 *    for mute / camera / screen share / minimize / drag / navigation.
 *  - Perfect-negotiation handles the initial offer AND every later
 *    renegotiation, so there is no offer loop and no glare.
 *  - The camera keeps its own sender; screen share gets a SEPARATE send-only
 *    transceiver, so camera + screen run together and stopping share never
 *    touches the camera.
 *  - The media elements are mounted for the whole call and only get `srcObject`
 *    assigned when the actual stream instance changes.
 */
export default function DmCallPanel({
  conversationId,
  peerId,
  peerName,
  peerUsername,
  peerAvatarUrl,
  myUserId,
  media,
  onLeave,
  minimized = false,
  onMinimize,
  onExpand,
}: {
  conversationId: Id<"dmConversations">;
  peerId: Id<"users">;
  peerName: string;
  peerUsername?: string | null;
  peerAvatarUrl?: string | null;
  myUserId: string;
  media: "voice" | "video";
  onLeave: () => void;
  minimized?: boolean;
  onMinimize?: () => void;
  onExpand?: () => void;
}) {
  const signals = useQuery(api.calls.pollDmSignals, { conversationId });
  const sendSignal = useMutation(api.calls.sendDmSignal);
  const clearSignal = useMutation(api.calls.clearDmSignal);

  const [muted, setMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(media === "video");
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [remoteScreen, setRemoteScreen] = useState<MediaStream | null>(null);
  const [screenEnlarged, setScreenEnlarged] = useState(false);
  const [connection, setConnection] = useState<"connecting" | "connected" | "lost">("connecting");
  const [remoteHasVideo, setRemoteHasVideo] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [view, setView] = useState<View>(minimized ? "compact" : "float");
  const [pos, setPos] = useState<{ x: number; y: number } | null>(savedPos);
  const [dragging, setDragging] = useState(false);
  // Flips to true once the peer connection exists, so the signaling effect
  // processes anything that arrived while we were still acquiring media.
  const [pcReady, setPcReady] = useState(false);

  // Streams are held in state so the video elements can attach in an effect —
  // the only thing that ever reassigns `srcObject`. The instances are stable
  // for the whole call.
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const cameraSenderRef = useRef<RTCRtpSender | null>(null);
  const initRef = useRef(false);
  // Perfect-negotiation bookkeeping.
  const makingOfferRef = useRef(false);
  const ignoreOfferRef = useRef(false);
  const politeRef = useRef(false);
  const processedSignals = useRef<Set<string>>(new Set());
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);
  const remoteDescSet = useRef(false);
  const restartCount = useRef(0);
  const disposedRef = useRef(false);
  // Debounces "remote video went away" so a transient mute never flickers the
  // avatar over a live frame.
  const hideRemoteTimer = useRef<number | null>(null);

  // Screen-share bookkeeping.
  const screenStreamRef = useRef<MediaStream | null>(null);
  const screenSendersRef = useRef<ScreenSenders | null>(null);
  const sharingRef = useRef(false);
  const remoteScreenStream = useRef<MediaStream | null>(null);
  const remoteScreenIds = useRef<Set<string>>(new Set());
  const remoteScreenActive = useRef(false);
  const trackStreamIds = useRef<Map<string, string>>(new Map());
  const screenStageRef = useRef<HTMLDivElement | null>(null);

  // Latest props/values in refs so the init effect never needs to rerun.
  const peerIdRef = useRef(peerId);
  const myUserIdRef = useRef(myUserId);
  const mediaRef = useRef(media);
  const sendSignalRef = useRef(sendSignal);
  useEffect(() => { peerIdRef.current = peerId; }, [peerId]);
  useEffect(() => { myUserIdRef.current = myUserId; }, [myUserId]);
  useEffect(() => { mediaRef.current = media; }, [media]);
  useEffect(() => { sendSignalRef.current = sendSignal; }, [sendSignal]);

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const localScreenRef = useRef<HTMLVideoElement | null>(null);
  const remoteScreenRef = useRef<HTMLVideoElement | null>(null);
  const audioEl = useRef<HTMLAudioElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const send = useCallback((to: Id<"users">, kind: "offer" | "answer" | "candidate" | "screen", payload: string) => {
    return sendSignalRef.current({ conversationId, toUserId: to, kind, payload }).catch(() => {});
  }, [conversationId]);

  // ---- Recompute whether the remote is actually sending live video ----
  // Showing video is immediate; hiding it is debounced so a momentary mute
  // cannot make the remote tile flash between the camera and the avatar.
  const refreshRemoteVideo = useCallback(() => {
    const rs = remoteStreamRef.current;
    const live = Boolean(rs && rs.getVideoTracks().some((t) => t.readyState === "live" && !t.muted));
    if (live) {
      if (hideRemoteTimer.current !== null) { clearTimeout(hideRemoteTimer.current); hideRemoteTimer.current = null; }
      setRemoteHasVideo((prev) => (prev ? prev : true));
      return;
    }
    if (hideRemoteTimer.current !== null) return;
    hideRemoteTimer.current = window.setTimeout(() => {
      hideRemoteTimer.current = null;
      const rs2 = remoteStreamRef.current;
      const stillLive = Boolean(rs2 && rs2.getVideoTracks().some((t) => t.readyState === "live" && !t.muted));
      if (!stillLive) setRemoteHasVideo(false);
    }, 500);
  }, []);

  /**
   * Route incoming tracks to either the participant's camera/audio stream or
   * their screen stream. A peer's screen stream id is announced over the relay,
   * so the screen is never mistaken for the camera.
   */
  const classifyRemote = useCallback(() => {
    const pc = pcRef.current;
    const main = remoteStreamRef.current;
    if (!pc || !main) return;
    let scr = remoteScreenStream.current;
    if (remoteScreenIds.current.size > 0 && !scr) { scr = new MediaStream(); remoteScreenStream.current = scr; }
    for (const r of pc.getReceivers()) {
      const t = r.track;
      if (!t) continue;
      const sid = trackStreamIds.current.get(t.id);
      const isScreen = Boolean(sid && remoteScreenIds.current.has(sid));
      const target = isScreen && scr ? scr : main;
      const other = isScreen ? main : scr;
      if (!target.getTracks().some((x) => x.id === t.id)) target.addTrack(t);
      if (other && other !== target && other.getTracks().some((x) => x.id === t.id)) other.removeTrack(t);
    }
    const active = remoteScreenActive.current && Boolean(scr?.getVideoTracks().some((t) => t.readyState === "live"));
    setRemoteScreen(active && scr ? scr : null);
    // A screen track that briefly landed on the main stream must not leave the
    // remote camera tile showing a frozen frame.
    refreshRemoteVideo();
  }, [refreshRemoteVideo]);

  // ---- Call duration once connected ----
  useEffect(() => {
    if (connection !== "connected") return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [connection]);

  // ---- Speaker mute on the always-mounted remote audio sink ----
  useEffect(() => {
    if (audioEl.current) audioEl.current.muted = speakerMuted;
    // Screen audio (if the sharer is sending it) follows the speaker control too.
    if (remoteScreenRef.current) remoteScreenRef.current.muted = speakerMuted;
  }, [speakerMuted]);

  // ---- Attach streams to the (permanent) media elements ----
  useEffect(() => {
    const el = localVideoRef.current;
    if (el && el.srcObject !== localStream) { el.srcObject = localStream; safePlay(el); }
  }, [localStream]);
  useEffect(() => {
    const el = remoteVideoRef.current;
    if (el && el.srcObject !== remoteStream) { el.srcObject = remoteStream; safePlay(el); }
    const a = audioEl.current;
    if (a && a.srcObject !== remoteStream) { a.srcObject = remoteStream; safePlay(a); }
  }, [remoteStream]);
  // Local screen preview (muted) — the sharer's single preview, no duplicates.
  useEffect(() => {
    const el = localScreenRef.current;
    if (!el) return;
    const s = screenOn ? screenStreamRef.current : null;
    if (el.srcObject !== s) { el.srcObject = s; safePlay(el); }
  }, [screenOn]);
  // Remote screen stage.
  useEffect(() => {
    const el = remoteScreenRef.current;
    if (!el) return;
    if (el.srcObject !== remoteScreen) { el.srcObject = remoteScreen; safePlay(el); }
    el.muted = speakerMuted;
  }, [remoteScreen, speakerMuted]);

  // ---- Acquire local media + build the peer connection exactly once ----
  useEffect(() => {
    if (initRef.current) return;
    if (!myUserIdRef.current) return; // wait until we know who we are
    initRef.current = true;
    disposedRef.current = false;
    const peer = peerIdRef.current;
    const wantVideo = mediaRef.current === "video";
    // The peer with the larger id is the polite one and yields on glare.
    politeRef.current = myUserIdRef.current > peer;

    // One persistent remote stream; incoming tracks are added to it in place.
    const remote = new MediaStream();
    remoteStreamRef.current = remote;
    setRemoteStream(remote);

    (async () => {
      let stream: MediaStream | null = null;
      let permissionDenied = false;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: wantVideo });
      } catch (err) {
        const name = (err as DOMException)?.name;
        permissionDenied = name === "NotAllowedError" || name === "SecurityError";
        // Audio and video are independent: fall back to audio-only when the
        // camera is unavailable but the mic is fine (and vice-versa).
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          if (wantVideo) setCameraError("Camera unavailable — you can retry from the camera button.");
        } catch {
          try {
            stream = await navigator.mediaDevices.getUserMedia({ video: wantVideo });
            setMuted(true);
          } catch { stream = null; }
        }
      }
      if (disposedRef.current) { stream?.getTracks().forEach((t) => t.stop()); return; }
      if (!stream) {
        setConnection("lost");
        setCameraError(permissionDenied ? "Microphone permission was denied." : "Could not access your microphone or camera.");
        toast.error(permissionDenied ? "Microphone permission was denied — allow access to talk." : "Could not access your device.");
        return;
      }
      localStreamRef.current = stream;
      setLocalStream(stream);
      const hasVideo = stream.getVideoTracks().length > 0;
      setCameraOn(hasVideo);
      if (wantVideo && !hasVideo) setCameraError("Camera unavailable — you can retry from the camera button.");

      const pc = new RTCPeerConnection(ICE);
      pcRef.current = pc;

      // Registered exactly once per connection.
      pc.ontrack = (e) => {
        trackStreamIds.current.set(e.track.id, e.streams[0]?.id ?? "");
        classifyRemote();
        refreshRemoteVideo();
      };
      pc.onicecandidate = (e) => {
        if (e.candidate) send(peer, "candidate", JSON.stringify(e.candidate));
      };
      // Perfect negotiation: any track/ICE change produces exactly one offer.
      pc.onnegotiationneeded = async () => {
        if (disposedRef.current) return;
        try {
          makingOfferRef.current = true;
          const offer = await pc.createOffer();
          if (disposedRef.current || pc.signalingState !== "stable") return;
          await pc.setLocalDescription(offer);
          await send(peer, "offer", JSON.stringify(pc.localDescription));
        } catch { /* a later negotiationneeded retries */ }
        finally { makingOfferRef.current = false; }
      };
      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === "connected") { restartCount.current = 0; setConnection("connected"); }
        else if (st === "failed") {
          setConnection("lost");
          if (restartCount.current < 3) {
            restartCount.current += 1;
            try { pc.restartIce?.(); } catch { /* older browsers */ }
          }
        }
        // "disconnected" is often transient — never tear anything down for it.
      };
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") setConnection("connected");
        else if (pc.iceConnectionState === "failed") {
          setConnection("lost");
          if (restartCount.current < 3) {
            restartCount.current += 1;
            try { pc.restartIce?.(); } catch { /* noop */ }
          }
        }
      };

      // Adding the tracks triggers onnegotiationneeded → exactly one offer. The
      // camera sender is captured so screen share can never get hold of it.
      for (const t of stream.getTracks()) {
        const sender = pc.addTrack(t, stream);
        if (t.kind === "video") cameraSenderRef.current = sender;
      }
      // If sharing was somehow started before the connection existed, send it.
      if (sharingRef.current && screenStreamRef.current) {
        const holders = (screenSendersRef.current ??= {});
        await applyScreenToPeer(pc, holders, screenStreamRef.current, screenStreamRef.current.getVideoTracks()[0] ?? null, screenStreamRef.current.getAudioTracks()[0] ?? null);
        send(peer, "screen", JSON.stringify({ on: true, streamId: screenStreamRef.current.id }));
      }
      setPcReady(true);
    })();

    return () => {
      disposedRef.current = true;
      initRef.current = false;
      setPcReady(false);
      try { pcRef.current?.close(); } catch { /* noop */ }
      pcRef.current = null;
      cameraSenderRef.current = null;
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      remoteStreamRef.current = null;
      // Release the screen capture as well — ending the call stops sharing.
      sharingRef.current = false;
      screenStreamRef.current?.getTracks().forEach((t) => { try { t.stop(); } catch { /* noop */ } });
      screenStreamRef.current = null;
      screenSendersRef.current = null;
      remoteScreenStream.current = null;
      remoteScreenIds.current.clear();
      remoteScreenActive.current = false;
      trackStreamIds.current.clear();
      processedSignals.current.clear();
      pendingCandidates.current = [];
      remoteDescSet.current = false;
      makingOfferRef.current = false;
      ignoreOfferRef.current = false;
      restartCount.current = 0;
      if (hideRemoteTimer.current !== null) { clearTimeout(hideRemoteTimer.current); hideRemoteTimer.current = null; }
    };
    // Intentionally stable for the whole call: deps never change mid-call.
  }, [conversationId, send, refreshRemoteVideo, classifyRemote]);

  // ---- Apply incoming signaling (each message exactly once) ----
  useEffect(() => {
    if (!signals || !pcReady) return;
    const pc = pcRef.current;
    if (!pc) return;
    (async () => {
      for (const s of signals) {
        if (processedSignals.current.has(s._id)) continue;
        processedSignals.current.add(s._id);
        try {
          const data = JSON.parse(s.payload);
          if (s.kind === "offer") {
            const offerCollision = makingOfferRef.current || pc.signalingState !== "stable";
            ignoreOfferRef.current = !politeRef.current && offerCollision;
            if (ignoreOfferRef.current) { await clearSignal({ signalId: s._id }); continue; }
            await pc.setRemoteDescription(new RTCSessionDescription(data));
            remoteDescSet.current = true;
            for (const c of pendingCandidates.current.splice(0)) {
              try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch { /* noop */ }
            }
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await send(s.fromUserId as Id<"users">, "answer", JSON.stringify(pc.localDescription));
          } else if (s.kind === "answer") {
            if (pc.signalingState === "have-local-offer") {
              await pc.setRemoteDescription(new RTCSessionDescription(data));
              remoteDescSet.current = true;
              for (const c of pendingCandidates.current.splice(0)) {
                try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch { /* noop */ }
              }
            }
          } else if (s.kind === "candidate") {
            if (remoteDescSet.current) {
              try { await pc.addIceCandidate(new RTCIceCandidate(data)); }
              catch { if (!ignoreOfferRef.current) { /* transient */ } }
            } else {
              pendingCandidates.current.push(data);
            }
          } else if (s.kind === "screen") {
            const meta = data as { on?: boolean; streamId?: string };
            if (meta.streamId) remoteScreenIds.current.add(meta.streamId);
            remoteScreenActive.current = Boolean(meta.on);
            classifyRemote();
          }
        } catch { /* ignore out-of-order signaling */ }
        try { await clearSignal({ signalId: s._id }); } catch { /* noop */ }
      }
    })();
  }, [signals, pcReady, clearSignal, send, classifyRemote]);

  // ---- Controls (operate on existing tracks; never rebuild the connection) ----
  function toggleMute() {
    const next = !muted;
    setMuted(next);
    // Only the microphone track is touched — video and the connection are untouched.
    localStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = !next));
  }

  async function toggleCamera() {
    const pc = pcRef.current;
    if (!pc) return;
    const stream = localStreamRef.current;
    const videoSender = cameraSenderRef.current;

    if (cameraOn) {
      // Turning OFF: stop sending video and release the camera (LED off). The
      // peer connection, the microphone, the screen share and remote audio are
      // untouched.
      if (videoSender) { try { await videoSender.replaceTrack(null); } catch { /* noop */ } }
      const existing = stream?.getVideoTracks()[0];
      if (existing) { try { existing.stop(); } catch { /* noop */ } stream?.removeTrack(existing); }
      setCameraOn(false);
      return;
    }

    // Turning ON: acquire a fresh camera track and swap it into the sender.
    setCameraError(null);
    try {
      const vs = await navigator.mediaDevices.getUserMedia({ video: true });
      const track = vs.getVideoTracks()[0];
      if (!track) { setCameraError("No camera was found."); return; }
      let s = stream;
      if (!s) { s = new MediaStream(); localStreamRef.current = s; setLocalStream(s); }
      s.addTrack(track);
      if (videoSender) {
        // Replace in place — no renegotiation and no flicker on the remote side.
        await videoSender.replaceTrack(track);
      } else {
        // No camera sender yet (a voice call turning on video): addTrack triggers
        // onnegotiationneeded, which perfect-negotiation answers exactly once.
        const sender = pc.addTrack(track, s);
        cameraSenderRef.current = sender;
      }
      setCameraOn(true);
    } catch (err) {
      const name = (err as DOMException)?.name;
      setCameraError(name === "NotAllowedError" ? "Camera permission is required to turn your camera on." : "Could not access your camera.");
      toast.error(name === "NotAllowedError" ? "Camera permission is required to turn your camera on." : "Could not access your camera.");
    }
  }

  /** Start or stop sharing. A cancelled picker silently does nothing. */
  async function toggleScreen() {
    const pc = pcRef.current;
    if (sharingRef.current) { await stopScreen(); return; }
    if (!pc) return;

    const result = await captureDisplay();
    if (!result.ok) {
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

    const holders = (screenSendersRef.current ??= {});
    await applyScreenToPeer(pc, holders, ss, videoTrack, audioTrack);

    sharingRef.current = true;
    setScreenOn(true);
    // The browser's own "Stop sharing" button ends the track — react to it.
    videoTrack.onended = () => { void stopScreen(); };
    send(peerIdRef.current, "screen", JSON.stringify({ on: true, streamId: ss.id }));
  }

  /** Stop sharing without touching the call, the mic, or the camera. */
  async function stopScreen() {
    const wasSharing = sharingRef.current;
    sharingRef.current = false;
    screenStreamRef.current?.getTracks().forEach((t) => { t.onended = null; });
    setScreenOn(false);
    setScreenEnlarged(false);
    if (wasSharing) {
      const holders = screenSendersRef.current;
      if (holders?.video) { try { await holders.video.replaceTrack(null); } catch { /* noop */ } }
      if (holders?.audio) { try { await holders.audio.replaceTrack(null); } catch { /* noop */ } }
      send(peerIdRef.current, "screen", JSON.stringify({ on: false }));
    }
    const ss = screenStreamRef.current;
    ss?.getTracks().forEach((t) => { try { t.stop(); } catch { /* noop */ } ss.removeTrack(t); });
  }

  function toggleFullscreen() {
    const el = screenStageRef.current;
    if (!el) return;
    if (document.fullscreenElement) { void document.exitFullscreen?.().catch(() => {}); return; }
    void el.requestFullscreen?.().catch(() => {});
  }

  // ---- Keep the view in sync with the external minimize flag (nav changes) ----
  useEffect(() => {
    setView((v) => {
      if (minimized) return "compact";
      return v === "compact" ? "float" : v;
    });
  }, [minimized]);

  // ---- Dragging (window views only), clamped to the visible area ----
  function startDrag(e: React.PointerEvent) {
    if (view === "full") return;
    if ((e.target as HTMLElement).closest("button")) return;
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    setPos({ x: rect.left, y: rect.top });
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  useEffect(() => {
    if (!dragging) return;
    function move(e: PointerEvent) {
      const el = rootRef.current;
      const d = dragRef.current;
      if (!el || !d) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const x = Math.max(8, Math.min(window.innerWidth - w - 8, e.clientX - d.dx));
      const y = Math.max(8, Math.min(window.innerHeight - h - 8, e.clientY - d.dy));
      savedPos = { x, y };
      setPos({ x, y });
    }
    function up() { dragRef.current = null; setDragging(false); }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [dragging]);

  // Bring the window back inside the viewport if the screen shrinks.
  useEffect(() => {
    function onResize() {
      if (!pos || !rootRef.current) return;
      const w = rootRef.current.offsetWidth;
      const h = rootRef.current.offsetHeight;
      setPos({ x: Math.max(8, Math.min(window.innerWidth - w - 8, pos.x)), y: Math.max(8, Math.min(window.innerHeight - h - 8, pos.y)) });
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [pos]);

  function setViewAndNotify(next: View) {
    setView(next);
    if (next === "compact") onMinimize?.();
    else if (next === "full") onExpand?.();
  }

  const label = connection === "connected" ? "Connected" : connection === "connecting" ? "Connecting…" : "Connection lost";
  const title = media === "video" ? "Video Call" : "Voice Call";
  const windowStyle = view === "full" ? undefined : pos ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto" } : undefined;

  return (
    <>
      {/* Always-mounted audio sink so remote audio keeps playing in every view,
          including the minimized window where the video stage is hidden. */}
      <audio ref={audioEl} autoPlay playsInline style={{ display: "none" }} />

      <div
        ref={rootRef}
        className={`fc-callwin ${view} ${dragging ? "dragging" : ""} ${pos || view === "full" ? "" : "default-pos"}`}
        style={windowStyle}
        role="region"
        aria-label={`Call with ${peerName}`}
      >
        <div className="fc-callwin-head" onPointerDown={startDrag} title={view === "full" ? undefined : "Drag to move"}>
          <span className="fc-callwin-title">
            <span className={`vp-mini-dot ${connection}`} />
            {view === "compact" ? peerName : `${title} · ${peerName}`}
          </span>
          <span className="fc-callwin-head-btns">
            {view === "float" && (
              <button aria-label="Minimize call window" title="Minimize" onClick={(e) => { e.stopPropagation(); setViewAndNotify("compact"); }}><Minimize2 size={14} /></button>
            )}
            {view === "compact" && (
              <button aria-label="Restore call window" title="Restore" onClick={(e) => { e.stopPropagation(); setViewAndNotify("float"); }}><Maximize2 size={14} /></button>
            )}
            {view === "full" && (
              <button aria-label="Shrink call window" title="Shrink" onClick={(e) => { e.stopPropagation(); setViewAndNotify("float"); }}><Minimize2 size={14} /></button>
            )}
            <button className="danger" aria-label="End call" title="End call" onClick={(e) => { e.stopPropagation(); onLeave(); }}><X size={14} /></button>
          </span>
        </div>

        <div className="fc-callwin-body">
          {/* Compact row — hidden (but kept mounted) via CSS in other views. */}
          <div className="fc-callwin-compact-row">
            <ProfileAvatar name={peerName} url={peerAvatarUrl} size={26} showPresence={false} />
            <span className="fc-callwin-time">
              {connection === "connected" ? fmtDuration(seconds) : label}
              {screenOn && <span className="fc-callwin-minishare"> · sharing</span>}
            </span>
          </div>

          {/* Remote screen stage — only rendered while the real remote track is live. */}
          <div className={`fc-callwin-screenshare ${screenEnlarged ? "enlarged" : ""} ${remoteScreen ? "" : "off"}`} ref={screenStageRef}>
            <video className="fc-callwin-screenvideo" autoPlay playsInline ref={remoteScreenRef} />
            <span className="fc-callwin-screen-tag">{peerName}&apos;s screen</span>
            <span className="fc-callwin-screen-tools">
              <button aria-label={screenEnlarged ? "Exit focus" : "Focus shared screen"} title={screenEnlarged ? "Exit focus" : "Focus"} onClick={() => setScreenEnlarged((v) => !v)}>
                {screenEnlarged ? <Minimize2 size={14} /> : <Maximize size={14} />}
              </button>
              <button aria-label="Fullscreen shared screen" title="Fullscreen" onClick={toggleFullscreen}><Maximize size={14} /></button>
            </span>
          </div>

          {/* Stage — always mounted so the <video> elements never unmount. */}
          <div className="fc-callwin-stage">
            <div className="fc-callwin-remote">
              <video
                className={`fc-callwin-video ${remoteHasVideo ? "" : "off"}`}
                autoPlay
                playsInline
                muted
                ref={remoteVideoRef}
              />
              {!remoteHasVideo && (
                <span className="fc-callwin-avbig"><ProfileAvatar name={peerName} url={peerAvatarUrl} size={view === "full" ? 96 : 60} showPresence={false} /></span>
              )}
              <span className="fc-callwin-tag">{peerName}{peerUsername ? ` · @${peerUsername}` : ""}</span>
              <span className="fc-callwin-timer">{connection === "connected" ? fmtDuration(seconds) : label}</span>
            </div>
            <div className="fc-callwin-local">
              {/* While sharing, this tile becomes the local screen preview (the
                  camera keeps transmitting regardless). One preview, no dupes. */}
              {screenOn ? (
                <>
                  <video className="fc-callwin-selfvideo fc-callwin-selfscreen" autoPlay playsInline muted ref={localScreenRef} />
                  <span className="fc-callwin-selfshare"><MonitorUp size={12} /> Your screen</span>
                  <button className="fc-callwin-stopshare" onClick={() => void toggleScreen()}>Stop sharing</button>
                </>
              ) : (
                <>
                  <video className={`fc-callwin-selfvideo ${cameraOn ? "" : "off"}`} autoPlay playsInline muted ref={localVideoRef} />
                  {cameraOn
                    ? <span className="fc-callwin-tag">You</span>
                    : <span className="fc-callwin-selfav"><ProfileAvatar name="You" size={28} showPresence={false} /></span>}
                </>
              )}
            </div>
            {cameraError && !screenOn && <p className="fc-callwin-camerr">{cameraError}</p>}
          </div>
        </div>

        <div className="fc-callwin-controls">
          <button className={muted ? "active" : ""} onClick={toggleMute} aria-label={muted ? "Unmute microphone" : "Mute microphone"} title={muted ? "Unmute" : "Mute"}>
            {muted ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
          <button className={speakerMuted ? "active" : ""} onClick={() => setSpeakerMuted((v) => !v)} aria-label={speakerMuted ? "Turn sound on" : "Mute sound"} title={speakerMuted ? "Sound on" : "Mute sound"}>
            {speakerMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
          <button className={cameraOn ? "active" : ""} onClick={toggleCamera} aria-label="Toggle camera" title="Camera">
            {cameraOn ? <Video size={16} /> : <VideoOff size={16} />}
          </button>
          <button className={screenOn ? "active" : ""} onClick={() => void toggleScreen()} aria-label={screenOn ? "Stop sharing screen" : "Share screen"} title={screenOn ? "Stop sharing" : "Share screen"}>
            <MonitorUp size={16} />
          </button>
          {view === "full"
            ? <button onClick={() => setViewAndNotify("float")} aria-label="Shrink call window" title="Shrink"><Minimize2 size={16} /></button>
            : <button onClick={() => setViewAndNotify("full")} aria-label="Expand call window" title="Expand"><Maximize2 size={16} /></button>}
          <button className="danger" onClick={onLeave} aria-label="End call" title="End call"><PhoneOff size={16} /></button>
        </div>
      </div>
    </>
  );
}
