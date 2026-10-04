/**
 * Screen sharing helpers shared by the channel voice panel and the DM call
 * panel. Everything here uses the browser's REAL screen capture
 * (`navigator.mediaDevices.getDisplayMedia`) and the real WebRTC sender API —
 * there is no simulated preview anywhere.
 */

/** Per-peer senders for one screen session (kept so toggling never renegotiates). */
export type ScreenSenders = { video?: RTCRtpSender; audio?: RTCRtpSender };

export type CaptureResult =
  | { ok: true; stream: MediaStream }
  | { ok: false; cancelled: boolean; message?: string };

/**
 * Ask the browser to capture a screen / window / tab.
 *
 * A cancelled picker is NOT an error — it resolves with `cancelled: true` so the
 * call stays completely untouched. A genuine failure resolves with a message.
 */
export async function captureDisplay(): Promise<CaptureResult> {
  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (!md?.getDisplayMedia) {
    return { ok: false, cancelled: false, message: "Screen sharing isn't supported in this browser." };
  }
  try {
    return { ok: true, stream: await md.getDisplayMedia({ video: true, audio: true }) };
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (name === "NotAllowedError" || name === "AbortError") return { ok: false, cancelled: true };
    // Some browsers/OSes reject the audio request outright — retry video only.
    try {
      return { ok: true, stream: await md.getDisplayMedia({ video: true }) };
    } catch (err2) {
      const n2 = (err2 as DOMException)?.name;
      if (n2 === "NotAllowedError" || n2 === "AbortError") return { ok: false, cancelled: true };
      return { ok: false, cancelled: false, message: "Screen sharing isn't available in this browser." };
    }
  }
}

/**
 * Attach or replace the screen-share track on ONE peer connection.
 *
 * The first call creates a dedicated send-only transceiver for the screen
 * stream; every later call just replaces the track in place. That way starting
 * or stopping screen share never tears down, renegotiates from scratch, or
 * interferes with the microphone/camera tracks already flowing.
 */
export async function applyScreenToPeer(
  pc: RTCPeerConnection,
  holders: ScreenSenders,
  screenStream: MediaStream,
  videoTrack: MediaStreamTrack | null,
  audioTrack: MediaStreamTrack | null,
): Promise<void> {
  if (holders.video) {
    if (holders.video.track !== videoTrack) {
      try { await holders.video.replaceTrack(videoTrack); } catch { /* noop */ }
    }
  } else if (videoTrack) {
    const tx = pc.addTransceiver(videoTrack, { direction: "sendonly", streams: [screenStream] });
    holders.video = tx.sender;
  }

  if (holders.audio) {
    if (holders.audio.track !== audioTrack) {
      try { await holders.audio.replaceTrack(audioTrack); } catch { /* noop */ }
    }
  } else if (audioTrack) {
    const tx = pc.addTransceiver(audioTrack, { direction: "sendonly", streams: [screenStream] });
    holders.audio = tx.sender;
  }
}
