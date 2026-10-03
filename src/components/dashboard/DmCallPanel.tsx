import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import ProfileAvatar from "@/components/profile/ProfileAvatar";
import { toast } from "sonner";
import { Maximize2, Mic, MicOff, Minimize2, PhoneOff, Video, VideoOff, VolumeX, X } from "lucide-react";

const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

function fmtDuration(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * A real 1:1 call inside a DM conversation.
 *
 * Audio/video are peer-to-peer over WebRTC; signaling is relayed through Convex
 * scoped to the conversation. The component stays mounted while the user
 * navigates Freecord, so `minimized` only changes what is drawn.
 */
export default function DmCallPanel({
  conversationId,
  peerId,
  peerName,
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
  const [connection, setConnection] = useState<"connecting" | "connected" | "lost">("connecting");
  const [remoteAudible, setRemoteAudible] = useState(false);
  const [remoteHasVideo, setRemoteHasVideo] = useState(false);
  const [seconds, setSeconds] = useState(0);

  const localStream = useRef<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const audioEl = useRef<HTMLAudioElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const startedRef = useRef(false);

  // Call duration once connected.
  useEffect(() => {
    if (connection !== "connected") return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [connection]);

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
        setRemoteAudible(true);
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

  const label = connection === "connected" ? "Connected" : connection === "connecting" ? "Connecting…" : "Connection lost";

  return (
    <>
      {/* Always-mounted remote audio sink so audio keeps playing when minimized. */}
      <audio ref={audioEl} autoPlay playsInline style={{ display: "none" }} />
      <span className="vp-hidden-volume" aria-hidden="true"><VolumeX size={1} /></span>

      {minimized ? (
        <div className="vp-mini" role="region" aria-label={`Call with ${peerName}`} onClick={onExpand} title="Open the call">
          <div className="vp-mini-head">
            <span className="vp-mini-title"><span className={`vp-mini-dot ${connection}`} /> {media === "video" ? "Video" : "Voice"} · {peerName}</span>
            <button className="vp-mini-x" aria-label="End call" onClick={(e) => { e.stopPropagation(); onLeave(); }}><X size={14} /></button>
          </div>
          <div className="vp-mini-avs">
            <span className="vp-mini-av"><ProfileAvatar name={peerName} url={peerAvatarUrl} size={26} showPresence={false} /></span>
            <span className="vp-mini-count">{fmtDuration(seconds)}</span>
          </div>
          {cameraOn && (
            <video className="vp-mini-cam" autoPlay playsInline muted ref={(el) => { if (el) { el.srcObject = localStream.current; void el.play().catch(() => {}); } }} />
          )}
          <div className="vp-mini-controls" onClick={(e) => e.stopPropagation()}>
            <button className={muted ? "active" : ""} onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"}>{muted ? <MicOff size={16} /> : <Mic size={16} />}</button>
            <button className={cameraOn ? "active" : ""} onClick={toggleCamera} aria-label="Toggle camera">{cameraOn ? <Video size={16} /> : <VideoOff size={16} />}</button>
            <button onClick={onExpand} aria-label="Open the call"><Maximize2 size={16} /></button>
            <button className="danger" onClick={onLeave} aria-label="End call"><PhoneOff size={16} /></button>
          </div>
        </div>
      ) : (
        <div className="fc-call-overlay" role="dialog" aria-label={`Call with ${peerName}`}>
          <div className="vp-panel">
            <header className="vp-head">
              <div>
                <p className="vp-title">{media === "video" ? "Video call" : "Voice call"} · {peerName}</p>
                <p className={`vp-status ${connection}`}><span className="vp-dot" /> {label}{connection === "connected" ? ` · ${fmtDuration(seconds)}` : ""}</p>
              </div>
              <div className="vp-head-actions">
                {onMinimize && (
                  <Button size="sm" variant="outline" onClick={onMinimize} title="Minimize — stay connected while you use Freecord">
                    <Minimize2 className="mr-1 h-4 w-4" /> Minimize
                  </Button>
                )}
                <Button size="sm" variant="destructive" onClick={onLeave}><PhoneOff className="mr-1 h-4 w-4" /> End call</Button>
              </div>
            </header>

            <div className="vp-grid">
              <div className="vp-tile self">
                <div className="vp-media">
                  {cameraOn ? (
                    <video className="vp-video" autoPlay playsInline muted ref={(el) => { if (el) { localVideoRef.current = el; el.srcObject = localStream.current; void el.play().catch(() => {}); } }} />
                  ) : (
                    <span className="vp-avatar-holder"><ProfileAvatar name="You" size={64} showPresence={false} /></span>
                  )}
                </div>
                <span className="vp-name">You{muted ? " (muted)" : ""}</span>
              </div>
              <div className={`vp-tile ${remoteAudible && !remoteHasVideo ? "speaking" : ""}`}>
                <div className="vp-media">
                  {remoteHasVideo ? (
                    <video className="vp-video" autoPlay playsInline ref={(el) => { if (el) { remoteVideoRef.current = el; el.srcObject = remoteStreamRef.current; void el.play().catch(() => {}); } }} />
                  ) : (
                    <span className="vp-avatar-holder">
                      <ProfileAvatar name={peerName} url={peerAvatarUrl} size={64} showPresence={false} />
                    </span>
                  )}
                </div>
                <span className="vp-name">{peerName}</span>
              </div>
            </div>

            <footer className="vp-controls">
              <button className={muted ? "active" : ""} onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute" : "Mute"}>
                {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
              </button>
              <button className={cameraOn ? "active" : ""} onClick={toggleCamera} aria-label="Toggle camera" title="Toggle camera">
                {cameraOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
