import { useCallback, useRef } from "react";

/**
 * Message send/receive sound effect.
 *
 * The requested Pixabay asset ("Message envoyé – iPhone Apple") is free to use,
 * but its audio file cannot be fetched at build time, so we do NOT pretend to
 * bundle it. Instead:
 *   1. If `VITE_MESSAGE_SFX_URL` is set, that URL is played.
 *   2. Otherwise a short, locally synthesised blip stands in, so the feature
 *      still works. Set the env var to the Pixabay file to use the exact sound.
 *
 * Reference: https://pixabay.com/sound-effects/film-special-effects-message-envoy%C3%A9-iphone-apple-391098/
 */
const SFX_URL = (import.meta.env.VITE_MESSAGE_SFX_URL as string | undefined) ?? "";

export function useMessageSound() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);

  const play = useCallback(() => {
    try {
      if (SFX_URL) {
        if (!audioRef.current) audioRef.current = new Audio(SFX_URL);
        audioRef.current.currentTime = 0;
        void audioRef.current.play().catch(() => {});
        return;
      }
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      if (!ctxRef.current) ctxRef.current = new Ctx();
      const ctx = ctxRef.current;
      if (ctx.state === "suspended") void ctx.resume();
      const now = ctx.currentTime;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.08, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
      gain.connect(ctx.destination);
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(1320, now + 0.09);
      osc.connect(gain);
      osc.start(now);
      osc.stop(now + 0.2);
    } catch {
      // Audio is a nicety — never let it break messaging.
    }
  }, []);

  return { play, usingRemoteAsset: Boolean(SFX_URL) };
}
