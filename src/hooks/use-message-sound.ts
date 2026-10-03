import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Message send/receive sound effect.
 *
 * The requested asset is the Pixabay sound "Message envoyé – iPhone / Apple":
 *   https://pixabay.com/sound-effects/film-special-effects-message-envoy%C3%A9-iphone-apple-391098/
 *
 * Pixabay blocks automated downloads (HTTP 403), so the file cannot be fetched
 * at build time. This hook therefore loads the *exact* file from, in order:
 *   1. `VITE_MESSAGE_SFX_URL` — a direct audio URL set in the Keys/env UI.
 *   2. `/sounds/message-envoye-iphone.mp3` — the audio file dropped into
 *      `public/sounds/` (same directory is served at the site root).
 *
 * Only if NEITHER is present does it fall back to a short synthesised blip, so
 * messaging still has feedback. It never pretends the fallback is the Pixabay
 * sound — the exact asset is used whenever it is available.
 */
const ENV_URL = (import.meta.env.VITE_MESSAGE_SFX_URL as string | undefined)?.trim() || "";
const LOCAL_URL = "/sounds/message-envoye-iphone.mp3";

/** Candidate URLs, most authoritative first. */
const CANDIDATES = [ENV_URL, LOCAL_URL].filter(Boolean);

/** True when `url` resolves to a decodable audio file. */
function probe(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof Audio === "undefined") { resolve(false); return; }
    const audio = new Audio();
    audio.preload = "auto";
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      audio.oncanplay = null;
      audio.onerror = null;
      resolve(ok);
    };
    audio.oncanplay = () => done(true);
    audio.onerror = () => done(false);
    audio.src = url;
    audio.load();
    // If the file is missing the browser fires `error` quickly; guard anyway.
    window.setTimeout(() => done(false), 4000);
  });
}

export function useMessageSound() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const [assetUrl, setAssetUrl] = useState<string | null>(null);

  // Resolve which audio file actually exists, once, on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const url of CANDIDATES) {
        if (await probe(url)) {
          if (cancelled) return;
          audioRef.current = new Audio(url);
          audioRef.current.preload = "auto";
          setAssetUrl(url);
          return;
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /** Short synthesised blip — only used when the real asset is unavailable. */
  const blip = useCallback(() => {
    try {
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

  const play = useCallback(() => {
    if (audioRef.current) {
      try {
        audioRef.current.currentTime = 0;
        void audioRef.current.play().catch(() => blip());
        return;
      } catch {
        blip();
        return;
      }
    }
    blip();
  }, [blip]);

  return { play, usingRemoteAsset: assetUrl !== null, assetUrl };
}
