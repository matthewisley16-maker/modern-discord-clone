import { useEffect, useRef, useState } from "react";
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

type View = "compact" | "float" | "full";

/**
 * A real 1:1 call inside a DM conversation, rendered as a DRAGGABLE floating
 * window for both audio and video calls.
 *
 * Audio/video are peer-to-peer over WebRTC; signaling is relayed through Convex
 * scoped to the conversation. The component is mounted at the app shell level
 * and stays mounted while the user navigates, so the call keeps running.
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
  const [seconds, setSeconds] = useState(0);
  const [view, setView] = useState<View>(minimized ? "compact" : "float");
  const [pos, setPos] = useState<{ x: number; y: number } | null>(savedPos);
  const [dragging, setDragging] = useState(false);

  const localStream = useRef<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const audioEl = useRef<HTMLAudioElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const startedRef = useRef(false);

  // Call duration once connected.
  useEffect(() => {
    if (connection !== "connected") return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [connection]);

  // Keep speaker mute applied to the (always-mounted) remote audio sink.
  useEffect(() => { if (audioEl.current) audioEl.current.muted = speakerMuted; }, [speakerMuted]);

  // Acquire local media and build the peer connection once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: media === "video" });
      } catch (err) {
        const name = (err as DOMException)?.name;
        // Audio and video are independent: retry audio-only if video failed.
        if (media === "video" && name !== "NotAllowedError") {
          try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); setCameraOn(false); } catch { /* fall through */ }
        }
        if (!stream) {
          toast.error(name === "NotAllowedError" ? "Microphone permission was denied — allow access to talk." : "Could not access your microphone.");
          setConnection("lost");
          return;
        }
      }
      if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
      localStream.current = stream;
      setCameraOn(stream.getVideoTracks().length > 0);

      const pc = new RTCPeerConnection(ICE);
      pcRef.current = pc;
      stream.getTracks().forEach((t) => pc.addTrack(t, stream!));

      const remote = new MediaStream();
      pc.ontrack = (e) => {
        e.streams[0]?.getTracks().forEach((t) => remote.addTrack(t));
        remoteStreamRef.current = remote;
        if (audioEl.current) { audioEl.current.srcObject = remote; void audioEl.current.play().catch(() => {}); }
        if (remoteVideoRef.current) { remoteVideoRef.current.srcObject = remote; void remoteVideoRef.current.play().catch(() => {}); }
        setRemoteHasVideo(remote.getVideoTracks().length > 0);
      };
      pc.onicecandidate = (e) => {
        if (e.candidate) sendSignal({ conversationId, toUserId: peerId, kind: "candidate", payload: JSON.stringify(e.candidate) }).catch(() => {});
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") setConnection("connected");
        else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") setConnection("lost");
      };

      // The user with the smaller id initiates, so both sides agree on who offers.
      if (myUserId < peerId && !startedRef.current) {
        startedRef.current = true;
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await sendSignal({ conversationId, toUserId: peerId, kind: "offer", payload: JSON.stringify(offer) });
        } catch { /* retried when the other side signals */ }
      }
    })();

    return () => {
      cancelled = true;
      pcRef.current?.close();
      pcRef.current = null;
      localStream.current?.getTracks().forEach((t) => t.stop());
      localStream.current = null;
    };
  }, [conversationId, peerId, myUserId, media, sendSignal]);

  // Apply incoming signaling.
  useEffect(() => {
    if (!signals || !pcRef.current) return;
    (async () => {
      const pc = pcRef.current!;
      for (const s of signals) {
        try {
          const data = JSON.parse(s.payload);
          if (s.kind === "offer") {
            await pc.setRemoteDescription(new RTCSessionDescription(data));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await sendSignal({ conversationId, toUserId: s.fromUserId as Id<"users">, kind: "answer", payload: JSON.stringify(answer) });
          } else if (s.kind === "answer") {
            if (pc.signalingState !== "stable") await pc.setRemoteDescription(new RTCSessionDescription(data));
          } else if (s.kind === "candidate") {
            await pc.addIceCandidate(new RTCIceCandidate(data));
          }
        } catch { /* ignore out-of-order signaling */ }
        await clearSignal({ signalId: s._id });
      }
    })();
  }, [signals, conversationId, sendSignal, clearSignal]);

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    localStream.current?.getAudioTracks().forEach((t) => (t.enabled = !next));
  }

  async function toggleCamera() {
    const pc = pcRef.current;
    if (!pc) return;
    if (cameraOn) {
      for (const track of localStream.current?.getVideoTracks() ?? []) {
        const sender = pc.getSenders().find((s) => s.track === track);
        if (sender) pc.removeTrack(sender);
        track.stop();
        localStream.current?.removeTrack(track);
      }
      if (localVideoRef.current) localVideoRef.current.srcObject = null;
      setCameraOn(false);
      return;
    }
    try {
      const vs = await navigator.mediaDevices.getUserMedia({ video: true });
      const track = vs.getVideoTracks()[0];
      if (!track) return;
      if (!localStream.current) localStream.current = new MediaStream();
      localStream.current.addTrack(track);
      const existing = pc.getSenders().find((s) => s.track?.kind === "video");
      if (existing) await existing.replaceTrack(track);
      else pc.addTrack(track, localStream.current);
      if (localVideoRef.current) { localVideoRef.current.srcObject = localStream.current; void localVideoRef.current.play().catch(() => {}); }
      setCameraOn(true);
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await sendSignal({ conversationId, toUserId: peerId, kind: "offer", payload: JSON.stringify(offer) });
      } catch { /* renegotiation retried */ }
    } catch (err) {
      const name = (err as DOMException)?.name;
      toast.error(name === "NotAllowedError" ? "Camera permission is required to turn your camera on." : "Could not access your camera.");
    }
  }

  // ---- Dragging (header only), clamped to the visible area ----
  function startDrag(e: React.PointerEvent) {
    if ((e.target as HTMLElement).closest("button")) return; // buttons never drag
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
  const style = pos ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto" } : undefined;

  const remoteVideo = (
    <video
      className={`fc-callwin-video ${remoteHasVideo ? "" : "hidden"}`}
      autoPlay
      playsInline
      ref={(el) => { if (el) { remoteVideoRef.current = el; el.srcObject = remoteStreamRef.current; void el.play().catch(() => {}); } }}
    />
  );
  const remoteFallback = !remoteHasVideo && (
    <span className="fc-callwin-avbig"><ProfileAvatar name={peerName} url={peerAvatarUrl} size={view === "full" ? 96 : 60} showPresence={false} /></span>
  );
  const localVideo = cameraOn && (
    <video
      className="fc-callwin-selfvideo"
      autoPlay
      playsInline
      muted
      ref={(el) => { if (el) { localVideoRef.current = el; el.srcObject = localStream.current; void el.play().catch(() => {}); } }}
    />
  );

  const controls = (
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
  );

  return (
    <>
      {/* Always-mounted remote audio sink so audio keeps playing in every view. */}
      <audio ref={audioEl} autoPlay playsInline style={{ display: "none" }} />

      {view === "full" ? (
        <div className="fc-call-overlay" role="dialog" aria-label={`Call with ${peerName}`}>
          <div className="vp-panel">
            <header className="vp-head">
              <div>
                <p className="vp-title">{title} · {peerName}</p>
                <p className={`vp-status ${connection}`}><span className="vp-dot" /> {label}{connection === "connected" ? ` · ${fmtDuration(seconds)}` : ""}</p>
              </div>
              <div className="vp-head-actions">
                <Button size="sm" variant="outline" onClick={() => setViewAndNotify("float")}><Minimize2 className="mr-1 h-4 w-4" /> Shrink</Button>
                <Button size="sm" variant="destructive" onClick={onLeave}><PhoneOff className="mr-1 h-4 w-4" /> End call</Button>
              </div>
            </header>
            <div className="fc-callwin-stage">
              <div className="fc-callwin-remote">
                {remoteVideo}
                {remoteFallback}
                <span className="fc-callwin-tag">{peerName}{peerUsername ? ` · @${peerUsername}` : ""}</span>
              </div>
              <div className="fc-callwin-local">{localVideo}<span className="fc-callwin-tag">You</span></div>
            </div>
            {controls}
          </div>
        </div>
      ) : (
        <div
          ref={rootRef}
          className={`fc-callwin ${view === "compact" ? "compact" : ""} ${dragging ? "dragging" : ""} ${pos ? "" : "default-pos"}`}
          style={style}
          role="region"
          aria-label={`Call with ${peerName}`}
        >
          <div className="fc-callwin-head" onPointerDown={startDrag} title="Drag to move">
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
              <button className="danger" aria-label="End call" title="End call" onClick={(e) => { e.stopPropagation(); onLeave(); }}><X size={14} /></button>
            </span>
          </div>

          <div className="fc-callwin-body">
            {view === "compact" ? (
              <div className="fc-callwin-compact-row">
                <ProfileAvatar name={peerName} url={peerAvatarUrl} size={26} showPresence={false} />
                <span className="fc-callwin-time">{connection === "connected" ? fmtDuration(seconds) : label}</span>
              </div>
            ) : (
              <div className="fc-callwin-stage">
                <div className="fc-callwin-remote">
                  {remoteVideo}
                  {remoteFallback}
                  <span className="fc-callwin-tag">{peerName}{peerUsername ? ` · @${peerUsername}` : ""}</span>
                </div>
                <div className="fc-callwin-local">{localVideo}<span className="fc-callwin-tag">You</span></div>
                <span className="fc-callwin-timer">{connection === "connected" ? fmtDuration(seconds) : label}</span>
              </div>
            )}
          </div>

          {controls}
        </div>
      )}
    </>
  );
}
