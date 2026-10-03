import { useEffect, useRef, useState } from "react";

/**
 * Looping call ringtone.
 *
 * The requested asset is the Pixabay sound "Discord SFX Calling":
 *   https://pixabay.com/sound-effects/film-special-effects-discord-sfx-calling-250633/
 *
 * Pixabay blocks automated downloads (HTTP 403), so the exact file cannot be
 * bundled at build time. The ringtone is loaded from, in order:
 *   1. `VITE_CALL_SFX_URL` — a direct audio URL set in the Keys/env UI.
 *   2. `/sounds/discord-calling.mp3` — the file dropped into `public/sounds/`.
 * Only if neither exists does it fall back to a synthesised ring pattern, so
 * an incoming call is never silent. It is never presented as the Pixabay sound
 * when it is the fallback.
 */
const ENV_URL = (import.meta.env.VITE_CALL_SFX_URL as string | undefined)?.trim() || "";
const LOCAL_URL = "/sounds/discord-calling.mp3";
const CANDIDATES = [ENV_URL, LOCAL_URL].filter(Boolean);

function probe(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof Audio === "undefined") { resolve(false); return; }
    const audio = new Audio();
    audio.preload = "auto";
    let settled = false;
    const done = (ok: boolean) => { if (!settled) { settled = true; audio.oncanplay = null; audio.onerror = null; resolve(ok); } };
    audio.oncanplay = () => done(true);
    audio.onerror = () => done(false);
    audio.src = url;
    audio.load();
    window.setTimeout(() => done(false), 4000);
  });
}

export function useCallSound(active: boolean) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const timerRef = useRef<number | null>(null);
  const [assetUrl, setAssetUrl] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const url of CANDIDATES) {
        if (await probe(url)) {
          if (cancelled) return;
          const el = new Audio(url);
          el.loop = true;
          audioRef.current = el;
          setAssetUrl(url);
          setResolved(true);
          return;
        }
      }
      if (!cancelled) setResolved(true);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!resolved) return;
    if (!active) {
      audioRef.current?.pause();
      if (audioRef.current) audioRef.current.currentTime = 0;
      if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; }
      void ctxRef.current?.close().catch(() => {});
      ctxRef.current = null;
      return;
    }

    if (audioRef.current) {
      void audioRef.current.play().catch(() => { /* awaits a user gesture */ });
      return;
    }

    // Fallback ring: two short tones every 2 seconds.
    const ring = () => {
      try {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return;
        if (!ctxRef.current) ctxRef.current = new Ctx();
        const ctx = ctxRef.current;
        if (ctx.state === "suspended") void ctx.resume();
        for (const [offset, freq] of [[0, 660], [0.35, 550]] as const) {
          const start = ctx.currentTime + offset;
          const gain = ctx.createGain();
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.exponentialRampToValueAtTime(0.09, start + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
          gain.connect(ctx.destination);
          const osc = ctx.createOscillator();
          osc.type = "triangle";
          osc.frequency.setValueAtTime(freq, start);
          osc.connect(gain);
          osc.start(start);
          osc.stop(start + 0.3);
        }
      } catch { /* audio is a nicety */ }
    };
    ring();
    timerRef.current = window.setInterval(ring, 2000);
    return () => {
      if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; }
    };
  }, [active, resolved]);

  return { usingRingtoneAsset: assetUrl !== null, assetUrl };
}
