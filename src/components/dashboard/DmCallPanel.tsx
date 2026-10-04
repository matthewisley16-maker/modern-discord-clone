import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import ProfileAvatar from "@/components/profile/ProfileAvatar";
import { toast } from "sonner";
import { Maximize2, Mic, MicOff, Minimize2, PhoneOff, Video, VideoOff, Volume2, VolumeX, X } from "lucide-react";

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
 * window for both audio and video calls.
 *
 * Media lifecycle is deliberately stable:
 *  - `getUserMedia` runs exactly once (guarded by `initRef`).
 *  - One `RTCPeerConnection` per call; `ontrack` is registered once.
 *  - The `<video>` elements are mounted for the whole call and only ever have
 *    `srcObject` assigned when the actual stream instance changes.
 *  - Camera/mic toggles operate on the existing tracks' `enabled` flag.
 *  - Cleanup only happens when the component actually unmounts (call ended).
 * Because of this, navigating, minimizing, dragging or muting never restarts
 * video.
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
  const [connection, setConnection] = useState<"connecting" | "connected" | "lost">("connecting");
  const [remoteHasVideo, setRemoteHasVideo] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [view, setView] = useState<View>(minimized ? "compact" : "float");
  const [pos, setPos] = useState<{ x: number; y: number } | null>(savedPos);
  const [dragging, setDragging] = useState(false);

  // Streams are held in state so the video elements can attach in an effect —
  // the only thing that ever reassigns `srcObject`.
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const initRef = useRef(false);
  const processedSignals = useRef<Set<string>>(new Set());
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);
  const remoteDescSet = useRef(false);
  const restartCount = useRef(0);

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const audioEl = useRef<HTMLAudioElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  // Keep the latest mutation in a ref so it never forces the init effect to rerun.
  const sendSignalRef = useRef(sendSignal);
  useEffect(() => { sendSignalRef.current = sendSignal; }, [sendSignal]);

  const send = useCallback((to: Id<"users">, kind: "offer" | "answer" | "candidate", payload: string) => {
    return sendSignalRef.current({ conversationId, toUserId: to, kind, payload }).catch(() => {});
  }, [conversationId]);

  const refreshRemoteVideo = useCallback(() => {
    const rs = remoteStreamRef.current;
    setRemoteHasVideo(Boolean(rs && rs.getVideoTracks().some((t) => t.readyState === "live")));
  }, []);

  // ---- Call duration once connected ----
  useEffect(() => {
    if (connection !== "connected") return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [connection]);

  // ---- Speaker mute on the always-mounted remote audio sink ----
  useEffect(() => { if (audioEl.current) audioEl.current.muted = speakerMuted; }, [speakerMuted]);

  // ---- Attach streams to the (permanent) video elements ----
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

  // ---- Acquire local media + build the peer connection exactly once ----
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    let disposed = false;
    const wantVideo = media === "video";

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
      if (disposed) { stream?.getTracks().forEach((t) => t.stop()); return; }
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
      stream.getTracks().forEach((t) => pc.addTrack(t, stream!));

      // Registered exactly once.
      pc.ontrack = (e) => {
        const rs = remoteStreamRef.current;
        if (!rs) return;
        const incoming = e.streams[0]?.getTracks() ?? (e.track ? [e.track] : []);
        for (const track of incoming) {
          if (!rs.getTracks().some((x) => x.id === track.id)) rs.addTrack(track);
          track.onmute = refreshRemoteVideo;
          track.onunmute = refreshRemoteVideo;
          track.onended = refreshRemoteVideo;
        }
        refreshRemoteVideo();
      };
      pc.onicecandidate = (e) => {
        if (e.candidate) send(peerId, "candidate", JSON.stringify(e.candidate));
      };
      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === "connected") setConnection("connected");
        else if (st === "failed") {
          setConnection("lost");
          if (restartCount.current < 3) { restartCount.current += 1; try { pc.restartIce?.(); } catch { /* older browsers */ } }
        }
        // "disconnected" is often transient — do not tear anything down for it.
      };
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") setConnection("connected");
        else if (pc.iceConnectionState === "failed") {
          setConnection("lost");
          if (restartCount.current < 3) { restartCount.current += 1; try { pc.restartIce?.(); } catch { /* noop */ } }
        }
      };

      // The user with the smaller id initiates, so both sides agree on who offers.
      if (myUserId < peerId) {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await send(peerId, "offer", JSON.stringify(offer));
        } catch { /* retried when the other side signals */ }
      }
    })();

    return () => {
      disposed = true;
      initRef.current = false;
      try { pcRef.current?.close(); } catch { /* noop */ }
      pcRef.current = null;
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      remoteStreamRef.current = null;
      processedSignals.current.clear();
      pendingCandidates.current = [];
      remoteDescSet.current = false;
      restartCount.current = 0;
    };
    // Intentionally stable: a call's identity never changes while it is mounted.
  }, [conversationId, peerId, myUserId, media, send, refreshRemoteVideo]);

  // ---- Apply incoming signaling (each message exactly once) ----
  useEffect(() => {
    if (!signals || !pcRef.current) return;
    const pc = pcRef.current;
    const polite = myUserId > peerId;
    (async () => {
      for (const s of signals) {
        if (processedSignals.current.has(s._id)) continue;
        processedSignals.current.add(s._id);
        try {
          const data = JSON.parse(s.payload);
          if (s.kind === "offer") {
            // Perfect-negotiation glare handling: the polite peer yields.
            if (pc.signalingState !== "stable" && polite) {
              await clearSignal({ signalId: s._id });
              continue;
            }
            await pc.setRemoteDescription(new RTCSessionDescription(data));
            remoteDescSet.current = true;
            for (const c of pendingCandidates.current.splice(0)) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch { /* noop */ } }
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await send(s.fromUserId as Id<"users">, "answer", JSON.stringify(answer));
          } else if (s.kind === "answer") {
            if (pc.signalingState === "have-local-offer") {
              await pc.setRemoteDescription(new RTCSessionDescription(data));
              remoteDescSet.current = true;
              for (const c of pendingCandidates.current.splice(0)) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch { /* noop */ } }
            }
          } else if (s.kind === "candidate") {
            if (remoteDescSet.current) { try { await pc.addIceCandidate(new RTCIceCandidate(data)); } catch { /* noop */ } }
            else pendingCandidates.current.push(data);
          }
        } catch { /* ignore out-of-order signaling */ }
        await clearSignal({ signalId: s._id });
      }
    })();
  }, [signals, clearSignal, send, myUserId, peerId]);

  // ---- Controls (operate on existing tracks; never rebuild the connection) ----
  function toggleMute() {
    const next = !muted;
    setMuted(next);
    localStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = !next));
  }

  async function toggleCamera() {
    const pc = pcRef.current;
    if (!pc) return;
    const stream = localStreamRef.current;
    const existing = stream?.getVideoTracks()[0];

    if (cameraOn && existing) {
      existing.enabled = false; // keep the track and connection alive
      setCameraOn(false);
      return;
    }
    if (existing && existing.readyState === "live") {
      existing.enabled = true;
      setCameraOn(true);
      setCameraError(null);
      return;
    }

    setCameraError(null);
    try {
      const vs = await navigator.mediaDevices.getUserMedia({ video: true });
      const track = vs.getVideoTracks()[0];
      if (!track) { setCameraError("No camera was found."); return; }
      let s = stream;
      if (!s) { s = new MediaStream(); localStreamRef.current = s; setLocalStream(s); }
      s.addTrack(track);
      const sender = pc.getSenders().find((x) => x.track?.kind === "video");
      if (sender) {
        // Replace in place — no renegotiation and no flicker on the remote side.
        await sender.replaceTrack(track);
      } else {
        pc.addTrack(track, s);
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await send(peerId, "offer", JSON.stringify(offer));
        } catch { /* renegotiation retried */ }
      }
      setCameraOn(true);
    } catch (err) {
      const name = (err as DOMException)?.name;
      setCameraError(name === "NotAllowedError" ? "Camera permission is required to turn your camera on." : "Could not access your camera.");
      toast.error(name === "NotAllowedError" ? "Camera permission is required to turn your camera on." : "Could not access your camera.");
    }
  }

  // ---- Keep the view in sync with the external minimize flag (nav changes) ----
  useEffect(() => {
    setView((v) => {
      if (minimized) return v === "full" ? "compact" : v === "compact" ? "compact" : "compact";
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
      {/* Always-mounted audio sink so audio keeps playing in every view. */}
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
            <span className="fc-callwin-time">{connection === "connected" ? fmtDuration(seconds) : label}</span>
          </div>

          {/* Stage — always mounted so the <video> elements never unmount. */}
          <div className="fc-callwin-stage">
            <div className="fc-callwin-remote">
              <video
                className={`fc-callwin-video ${remoteHasVideo ? "" : "hidden"}`}
                autoPlay
                playsInline
                ref={remoteVideoRef}
              />
              {!remoteHasVideo && (
                <span className="fc-callwin-avbig"><ProfileAvatar name={peerName} url={peerAvatarUrl} size={view === "full" ? 96 : 60} showPresence={false} /></span>
              )}
              <span className="fc-callwin-tag">{peerName}{peerUsername ? ` · @${peerUsername}` : ""}</span>
              <span className="fc-callwin-timer">{connection === "connected" ? fmtDuration(seconds) : label}</span>
            </div>
            <div className="fc-callwin-local">
              <video className={`fc-callwin-selfvideo ${cameraOn ? "" : "hidden"}`} autoPlay playsInline muted ref={localVideoRef} />
              {cameraOn && <span className="fc-callwin-tag">You</span>}
            </div>
            {cameraError && <p className="fc-callwin-camerr">{cameraError}</p>}
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
          {view === "full"
            ? <button onClick={() => setViewAndNotify("float")} aria-label="Shrink call window" title="Shrink"><Minimize2 size={16} /></button>
            : <button onClick={() => setViewAndNotify("full")} aria-label="Expand call window" title="Expand"><Maximize2 size={16} /></button>}
          <button className="danger" onClick={onLeave} aria-label="End call" title="End call"><PhoneOff size={16} /></button>
        </div>
      </div>
    </>
  );
}
