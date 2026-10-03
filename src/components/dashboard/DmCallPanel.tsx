import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import ProfileAvatar from "@/components/profile/ProfileAvatar";
import { toast } from "sonner";
import { Mic, MicOff, PhoneOff, VolumeX } from "lucide-react";

const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

/**
 * A real 1:1 call inside a DM conversation.
 *
 * Audio is peer-to-peer over WebRTC; signaling is relayed through Convex scoped
 * to the conversation, so two accepted users actually connect and can hear each
 * other — no fake "call accepted" toast.
 */
export default function DmCallPanel({
  conversationId,
  peerId,
  peerName,
  peerAvatarUrl,
  myUserId,
  media,
  onLeave,
}: {
  conversationId: Id<"dmConversations">;
  peerId: Id<"users">;
  peerName: string;
  peerAvatarUrl?: string | null;
  myUserId: string;
  media: "voice" | "video";
  onLeave: () => void;
}) {
  const signals = useQuery(api.calls.pollDmSignals, { conversationId });
  const sendSignal = useMutation(api.calls.sendDmSignal);
  const clearSignal = useMutation(api.calls.clearDmSignal);

  const [muted, setMuted] = useState(false);
  const [connection, setConnection] = useState<"connecting" | "connected" | "lost">("connecting");
  const [remoteAudible, setRemoteAudible] = useState(false);

  const localStream = useRef<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const audioEl = useRef<HTMLAudioElement | null>(null);
  const startedRef = useRef(false);

  // Acquire the mic and build the peer connection once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: media === "video" });
      } catch (err) {
        const name = (err as DOMException)?.name;
        toast.error(name === "NotAllowedError" ? "Microphone permission was denied — allow access to talk." : "Could not access your microphone.");
        setConnection("lost");
        return;
      }
      if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
      localStream.current = stream;

      const pc = new RTCPeerConnection(ICE);
      pcRef.current = pc;
      stream.getTracks().forEach((t) => pc.addTrack(t, stream!));

      const remote = new MediaStream();
      pc.ontrack = (e) => {
        e.streams[0]?.getTracks().forEach((t) => remote.addTrack(t));
        if (audioEl.current) { audioEl.current.srcObject = remote; void audioEl.current.play().catch(() => {}); }
        setRemoteAudible(true);
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

  const label = connection === "connected" ? "Connected" : connection === "connecting" ? "Connecting…" : "Connection lost";

  return (
    <div className="vp-panel" role="dialog" aria-label={`Call with ${peerName}`}>
      <header className="vp-head">
        <div>
          <p className="vp-title">{media === "video" ? "Video call" : "Voice call"} · {peerName}</p>
          <p className={`vp-status ${connection}`}><span className="vp-dot" /> {label}</p>
        </div>
        <Button size="sm" variant="destructive" onClick={onLeave}><PhoneOff className="mr-1 h-4 w-4" /> Leave</Button>
      </header>

      <div className="vp-grid">
        <div className="vp-tile self">
          <span className="vp-avatar-holder"><ProfileAvatar name="You" size={64} showPresence={false} /></span>
          <span className="vp-name">You{muted ? " (muted)" : ""}</span>
        </div>
        <div className={`vp-tile ${remoteAudible ? "speaking" : ""}`}>
          <span className="vp-avatar-holder"><ProfileAvatar name={peerName} url={peerAvatarUrl} size={64} showPresence={false} /></span>
          <span className="vp-name">{peerName}</span>
        </div>
      </div>

      <footer className="vp-controls">
        <button className={muted ? "active" : ""} onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute" : "Mute"}>
          {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
        </button>
      </footer>

      <audio ref={audioEl} autoPlay playsInline />
      <span className="vp-hidden-volume" aria-hidden="true"><VolumeX size={1} /></span>
    </div>
  );
}
