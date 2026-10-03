import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import ProfileAvatar from "@/components/profile/ProfileAvatar";
import { toast } from "sonner";
import { Maximize2, Mic, MicOff, Minimize2, MonitorUp, PhoneOff, Video, VideoOff, VolumeX, X } from "lucide-react";

const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const SPEAK_THRESHOLD = 0.045; // RMS above this counts as speech
const SPEAK_HOLD_MS = 350; // keep the ring on briefly after speech stops

/**
 * Voice channel panel.
 *
 * Speaking detection is REAL: we run an AnalyserNode over the local microphone
 * stream, compute RMS each frame, and report only on transitions (talking
 * started / stopped). That keeps network traffic minimal while the speaking
 * ring stays in sync for everyone in the channel.
 *
 * Audio is transmitted peer-to-peer over WebRTC; signalling is relayed through
 * Convex. The component stays mounted across navigation, so `minimized` only
 * changes what is drawn — the call itself keeps running.
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
  const signals = useQuery(api.communities.pollSignals, { channelId });
  const sendSignal = useMutation(api.communities.sendSignal);
  const clearSignal = useMutation(api.communities.clearSignal);
  const setVoiceFlags = useMutation(api.voice.setVoiceFlags);
  const setSpeaking = useMutation(api.voice.setSpeaking);

  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [videoOn, setVideoOn] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [connection, setConnection] = useState<"connecting" | "connected" | "lost">("connecting");
  const [level, setLevel] = useState(0);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  // True once the mic attempt has finished (granted or denied), so peer
  // connections can still form for camera-only / listen-only participants.
  const [mediaReady, setMediaReady] = useState(false);

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
            setLevel(Math.min(1, rms * 8));

            const now = Date.now();
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
      localStream.current?.getTracks().forEach((t) => t.stop());
      localStream.current = null;
    };
  }, [setSpeaking]);

  // ---- WebRTC peer connections ----
  function attachRemote(userId: string, stream: MediaStream) {
    setRemoteStreams((prev) => ({ ...prev, [userId]: stream }));
    // The same MediaStream feeds both the audio sink and the video tile, so a
    // participant's audio keeps playing whether or not their camera is on.
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
    pc.ontrack = (e) => {
      e.streams[0]?.getTracks().forEach((t) => remote.addTrack(t));
      attachRemote(remoteId, remote);
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) sendSignal({ channelId, toUserId: remoteId as Id<"users">, kind: "candidate", payload: JSON.stringify(e.candidate) }).catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        setConnection("lost");
        // Attempt a clean reconnect.
        setTimeout(() => { peers.current.delete(remoteId); createPeer(remoteId, initiator); }, 1500);
      } else if (pc.connectionState === "connected") {
        setConnection("connected");
      }
    };
    if (initiator) {
      pc.onnegotiationneeded = async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await sendSignal({ channelId, toUserId: remoteId as Id<"users">, kind: "offer", payload: JSON.stringify(offer) });
        } catch { /* retried on reconnect */ }
      };
    }
    return pc;
  }

  useEffect(() => {
    if (!details || !mediaReady) return;
    for (const p of details.participants) {
      if (p.userId === myUserId) continue;
      if (!peers.current.has(p.userId)) createPeer(p.userId, myUserId < p.userId);
    }
    // Drop peer connections for people who left (no ghost streams/tiles).
    const present = new Set(details.participants.map((p) => p.userId as string));
    for (const [id, pc] of peers.current) {
      if (!present.has(id)) { pc.close(); peers.current.delete(id); }
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
   * Turn the camera on/off without disturbing the microphone or the call.
   * Video is requested on its own so the existing audio track is never
   * duplicated, and every peer either gets the new track or drops it.
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

  async function toggleScreen() {
    if (sharing) { setSharing(false); await setVoiceFlags({ screen: false }).catch(() => {}); return; }
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = display.getVideoTracks()[0];
      for (const [remoteId, pc] of peers.current) {
        const sender = pc.getSenders().find((s) => s.track?.kind === "video");
        if (sender) await sender.replaceTrack(track);
        else pc.addTrack(track, display);
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await sendSignal({ channelId, toUserId: remoteId as Id<"users">, kind: "offer", payload: JSON.stringify(offer) });
        } catch { /* retried on reconnect */ }
      }
      track.onended = () => { setSharing(false); setVoiceFlags({ screen: false }).catch(() => {}); };
      setSharing(true);
      await setVoiceFlags({ screen: true }).catch(() => {});
    } catch (err) {
      const name = (err as DOMException)?.name;
      toast.error(name === "NotAllowedError" ? "Screen sharing permission was denied." : "Screen sharing isn't supported here.");
    }
  }

  const participants = details?.participants ?? [];
  const statusLabel = connection === "connected" ? "Voice Connected" : connection === "connecting" ? "Connecting…" : "Connection Lost";

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
            ref={(el) => { if (el) { audioEls.current.set(p.userId, el); const s = remoteStreams[p.userId]; if (s) el.srcObject = s; el.muted = deafened; } }}
          />
        ))}
      </div>

      {minimized ? (
        <div className="vp-mini" role="region" aria-label={`${channelName} call`} onClick={onExpand} title="Open the call">
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
          {videoOn && (
            <video
              className="vp-mini-cam"
              autoPlay
              playsInline
              muted
              ref={(el) => { if (el) { el.srcObject = localStream.current; void el.play().catch(() => {}); } }}
            />
          )}
          <div className="vp-mini-controls" onClick={(e) => e.stopPropagation()}>
            <button className={muted ? "active" : ""} onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute" : "Mute"}>
              {muted ? <MicOff size={16} /> : <Mic size={16} />}
            </button>
            <button className={videoOn ? "active" : ""} onClick={toggleVideo} aria-label="Toggle camera" title="Toggle camera">
              {videoOn ? <Video size={16} /> : <VideoOff size={16} />}
            </button>
            <button className={deafened ? "active" : ""} onClick={toggleDeafen} aria-label="Toggle deafen" title="Deafen">
              <VolumeX size={16} />
            </button>
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
                {onMinimize && (
                  <Button size="sm" variant="outline" onClick={onMinimize} title="Minimize — stay connected while you use Freecord">
                    <Minimize2 className="mr-1 h-4 w-4" /> Minimize
                  </Button>
                )}
                <Button size="sm" variant="destructive" onClick={onLeave}><PhoneOff className="mr-1 h-4 w-4" /> Disconnect</Button>
              </div>
            </header>

            <div className="vp-grid">
              {participants.map((p) => {
                const isSelf = p.userId === myUserId;
                const stream = remoteStreams[p.userId];
                const showVideo = isSelf ? videoOn : p.video;
                return (
                  <div key={p.userId} className={`vp-tile ${p.speaking ? "speaking" : ""} ${isSelf ? "self" : ""}`}>
                    <div className="vp-media">
                      {showVideo ? (
                        <video
                          className="vp-video"
                          autoPlay
                          playsInline
                          muted={isSelf}
                          ref={(el) => {
                            if (!el) return;
                            if (isSelf) {
                              localVideoRef.current = el;
                              el.srcObject = localStream.current;
                              void el.play().catch(() => {});
                            } else {
                              videoEls.current.set(p.userId, el);
                              el.srcObject = stream ?? null;
                              void el.play().catch(() => {});
                            }
                          }}
                        />
                      ) : (
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
              <button className={sharing ? "active" : ""} onClick={toggleScreen} aria-label="Share screen" title="Share screen">
                <MonitorUp className="h-5 w-5" />
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
