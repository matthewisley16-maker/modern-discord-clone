import { useEffect, useRef, useState } from "react";
import { toSafeArray } from "@/lib/collection";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Mic, MicOff, MonitorUp, PhoneOff, Video, VideoOff, VolumeX } from "lucide-react";
import { toast } from "sonner";

type Props = {
  channelId: Id<"channels">;
  channelName: string;
  myUserId: string;
  onLeave: () => void;
};

const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

/**
 * WebRTC voice/video for a voice channel. Signaling is relayed through Convex
 * (offer/answer/ICE candidates), and media flows peer-to-peer.
 */
export default function CallPanel({ channelId, channelName, myUserId, onLeave }: Props) {
  const participants = useQuery(api.communities.voiceParticipants, { channelId });
  const signals = useQuery(api.communities.pollSignals, { channelId });
  const sendSignal = useMutation(api.communities.sendSignal);
  const clearSignal = useMutation(api.communities.clearSignal);
  const setVoiceState = useMutation(api.communities.setVoiceState);

  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [videoOn, setVideoOn] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [layout, setLayout] = useState<"grid" | "focus">("grid");

  const localStream = useRef<MediaStream | null>(null);
  const peers = useRef<Map<string, RTCPeerConnection>>(new Map());
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());

  /** Ask for mic/camera and report a useful message if the browser denies it. */
  async function getMedia(withVideo: boolean) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
    } catch (err) {
      const name = (err as DOMException)?.name;
      if (name === "NotAllowedError") {
        toast.error(withVideo ? "Camera or microphone permission was denied. Allow access in your browser to join with video." : "Microphone permission was denied. Allow access in your browser to talk.");
      } else if (name === "NotFoundError") {
        toast.error("No microphone or camera was found on this device.");
      } else {
        toast.error("Could not access your microphone or camera.");
      }
      return null;
    }
  }

  // Acquire the local stream once, and release it when leaving.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stream = await getMedia(false);
      if (cancelled) { stream?.getTracks().forEach((t) => t.stop()); return; }
      if (stream) localStream.current = stream;
    })();
    return () => {
      cancelled = true;
      peers.current.forEach((pc) => pc.close());
      peers.current.clear();
      localStream.current?.getTracks().forEach((t) => t.stop());
      localStream.current = null;
    };
  }, []);

  function attachStream(userId: string, stream: MediaStream) {
    setRemoteStreams((prev) => ({ ...prev, [userId]: stream }));
    const el = videoRefs.current.get(userId);
    if (el) el.srcObject = stream;
  }

  function createPeer(remoteId: string, initiator: boolean) {
    const existing = peers.current.get(remoteId);
    if (existing) return existing;
    const pc = new RTCPeerConnection(ICE);
    peers.current.set(remoteId, pc);

    localStream.current?.getTracks().forEach((track) => pc.addTrack(track, localStream.current!));

    const remote = new MediaStream();
    pc.ontrack = (e) => {
      e.streams[0]?.getTracks().forEach((t) => remote.addTrack(t));
      attachStream(remoteId, remote);
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendSignal({ channelId, toUserId: remoteId as Id<"users">, kind: "candidate", payload: JSON.stringify(e.candidate) });
      }
    };
    if (initiator) {
      pc.onnegotiationneeded = async () => {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await sendSignal({ channelId, toUserId: remoteId as Id<"users">, kind: "offer", payload: JSON.stringify(offer) });
      };
    }
    return pc;
  }

  // Connect to each other participant; the "lower" id initiates to avoid glare.
  useEffect(() => {
    if (!participants || !localStream.current) return;
    for (const p of participants) {
      if (p.userId === myUserId) continue;
      if (!peers.current.has(p.userId)) createPeer(p.userId, myUserId < p.userId);
    }
  }, [participants, myUserId]);

  // Process incoming signaling messages.
  useEffect(() => {
    if (!signals) return;
    (async () => {
      for (const s of signals) {
        try {
          const pc = createPeer(s.fromUserId, false);
          const data = JSON.parse(s.payload);
          if (s.kind === "offer") {
            await pc.setRemoteDescription(new RTCSessionDescription(data));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await sendSignal({ channelId, toUserId: s.fromUserId as Id<"users">, kind: "answer", payload: JSON.stringify(answer) });
          } else if (s.kind === "answer") {
            if (pc.signalingState !== "stable") await pc.setRemoteDescription(new RTCSessionDescription(data));
          } else if (s.kind === "candidate") {
            await pc.addIceCandidate(new RTCIceCandidate(data));
          }
        } catch {
          // Ignore malformed/out-of-order signaling; the peer retries.
        }
        await clearSignal({ signalId: s._id });
      }
    })();
  }, [signals, channelId, clearSignal, sendSignal]);

  async function toggleMute() {
    const next = !muted;
    setMuted(next);
    localStream.current?.getAudioTracks().forEach((t) => (t.enabled = !next));
    await setVoiceState({ muted: next });
  }

  async function toggleDeafen() {
    const next = !deafened;
    setDeafened(next);
    localStream.current?.getAudioTracks().forEach((t) => (t.enabled = !next && !muted));
    await setVoiceState({ deafened: next });
  }

  async function toggleVideo() {
    if (videoOn) {
      localStream.current?.getVideoTracks().forEach((t) => t.stop());
      setVideoOn(false);
      await setVoiceState({ video: false });
      return;
    }
    const stream = await getMedia(true);
    if (!stream) return;
    localStream.current?.getAudioTracks().forEach((t) => stream.addTrack(t));
    localStream.current = stream;
    // Re-negotiate with existing peers so they receive the new video track.
    for (const [remoteId, pc] of peers.current) {
      const sender = pc.getSenders().find((s) => s.track?.kind === "video");
      const track = stream.getVideoTracks()[0];
      if (sender && track) await sender.replaceTrack(track);
      else if (track) pc.addTrack(track, stream);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await sendSignal({ channelId, toUserId: remoteId as Id<"users">, kind: "offer", payload: JSON.stringify(offer) });
    }
    setVideoOn(true);
    await setVoiceState({ video: true });
  }

  async function toggleScreen() {
    if (sharing) {
      setSharing(false);
      await setVoiceState({ screen: false });
      return;
    }
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = display.getVideoTracks()[0];
      for (const [remoteId, pc] of peers.current) {
        const sender = pc.getSenders().find((s) => s.track?.kind === "video");
        if (sender) await sender.replaceTrack(track);
        else pc.addTrack(track, display);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await sendSignal({ channelId, toUserId: remoteId as Id<"users">, kind: "offer", payload: JSON.stringify(offer) });
      }
      track.onended = () => { setSharing(false); setVoiceState({ screen: false }); };
      setSharing(true);
      await setVoiceState({ screen: true });
    } catch (err) {
      const name = (err as DOMException)?.name;
      if (name === "NotAllowedError") toast.error("Screen sharing permission was denied.");
      else toast.error("Screen sharing isn't supported in this browser.");
    }
  }

  const participantList = toSafeArray<NonNullable<typeof participants>[number]>(participants, { label: "Voice participants", source: "api.communities.voiceParticipants" });
  const others = participantList.filter((p) => p.userId !== myUserId);
  const focused = others[0]?.userId;

  return (
    <div className="call-panel">
      <header className="call-head">
        <div>
          <p className="call-title">{channelName}</p>
          <p className="call-sub">{participants ? participantList.length : 1} in voice · connected peer-to-peer</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setLayout(layout === "grid" ? "focus" : "grid")}>
            {layout === "grid" ? "Focus" : "Grid"}
          </Button>
          <Button size="sm" variant="destructive" onClick={onLeave}>
            <PhoneOff className="mr-1 h-4 w-4" /> Leave
          </Button>
        </div>
      </header>

      <div className={`call-grid ${layout === "focus" && focused ? "is-focus" : ""}`}>
        <div className={`call-tile ${layout === "focus" && focused ? "focus" : ""}`}>
          <video ref={(el) => { if (el) el.muted = true; }} autoPlay playsInline className="call-video" data-local="true" />
          <span className="call-name">You {muted ? "(muted)" : ""}</span>
        </div>
        {others.map((p) => (
          <div className="call-tile" key={p.userId}>
            <video
              ref={(el) => {
                if (!el) return;
                videoRefs.current.set(p.userId, el);
                const s = remoteStreams[p.userId];
                if (s) el.srcObject = s;
              }}
              autoPlay
              playsInline
              className="call-video"
            />
            <span className="call-name">
              {p.name}{p.muted ? " (muted)" : ""}{p.screen ? " · sharing" : ""}
            </span>
          </div>
        ))}
        {others.length === 0 && (
          <div className="call-tile empty">
            <p className="text-sm text-muted-foreground">You're the only one here. Invite someone!</p>
          </div>
        )}
      </div>

      <footer className="call-controls">
        <button className={muted ? "active" : ""} onClick={toggleMute} aria-label={muted ? "Unmute microphone" : "Mute microphone"}>
          {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
        </button>
        <button className={deafened ? "active" : ""} onClick={toggleDeafen} aria-label={deafened ? "Undeafen" : "Deafen"}>
          <VolumeX className="h-5 w-5" />
        </button>
        <button className={videoOn ? "active" : ""} onClick={toggleVideo} aria-label={videoOn ? "Turn camera off" : "Turn camera on"}>
          {videoOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
        </button>
        <button className={sharing ? "active" : ""} onClick={toggleScreen} aria-label="Share screen">
          <MonitorUp className="h-5 w-5" />
        </button>
      </footer>
    </div>
  );
}
