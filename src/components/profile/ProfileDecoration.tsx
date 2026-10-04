import { useMemo } from "react";
import type { CSSProperties } from "react";
import { DECORATIONS } from "@/lib/cosmetics";

/**
 * Real profile decorations.
 *
 * Every decoration is a small particle system drawn on a *ring* around the
 * avatar. Particles are positioned by an explicit ring point (angle + radius in
 * px relative to the avatar centre), so their visual centre always sits outside
 * the avatar's circular edge — the same placement model that makes the stars
 * decoration read as a halo.
 *
 * Important invariants:
 *  - radius > 0.6 × avatar size and animation travel is capped so a particle
 *    can never drift inward over the picture (radius − amplitude ≥ 0.5 × size).
 *  - the animation drives `transform` only; positioning lives on `left/top`
 *    with a negative margin, so motion never fights the layout transform.
 *  - `pointer-events: none`, `aria-hidden`, and reduced-motion aware.
 */

type Motion = "orbit" | "twinkle" | "rise" | "fall" | "drift" | "spin" | "pulse";

interface DecoConfig {
  motion: Motion;
  shape: string;
  color: string;
  /** Extra colours cycled across particles (confetti, embers, …). */
  alt?: string[];
  count: number;
  minDur: number;
  maxDur: number;
  /** Ring radius as a fraction of the avatar size (must stay > 0.5). */
  radius: number;
  /** Particle size as a fraction of the avatar size. */
  psize: number;
  /** Animation travel as a fraction of the avatar size (kept small + outward). */
  amp?: number;
}

/**
 * Per-decoration tuning. Values are intentionally individual: different shapes
 * and counts need a different ring radius, particle size and travel so each
 * one sits cleanly around the avatar edge like the `dec_stars` reference.
 */
const CONFIG: Record<string, DecoConfig> = {
  dec_stars: { motion: "orbit", shape: "star", color: "#ffe08a", count: 8, minDur: 12, maxDur: 20, radius: 0.64, psize: 0.15, amp: 0.05 },
  dec_sparkles: { motion: "twinkle", shape: "star", color: "#f4f0ff", count: 12, minDur: 2.2, maxDur: 4.2, radius: 0.66, psize: 0.1 },
  dec_hearts: { motion: "rise", shape: "heart", color: "#ff6fae", count: 8, minDur: 5, maxDur: 9, radius: 0.65, psize: 0.14, amp: 0.09 },
  dec_flames: { motion: "rise", shape: "flame", color: "#ff8a3d", alt: ["#ffd166", "#ff5d3d", "#ffab4a"], count: 10, minDur: 3.2, maxDur: 6, radius: 0.65, psize: 0.15, amp: 0.09 },
  dec_clouds: { motion: "drift", shape: "cloud", color: "#d7e6ff", count: 5, minDur: 10, maxDur: 16, radius: 0.68, psize: 0.24, amp: 0.05 },
  dec_leaves: { motion: "fall", shape: "leaf", color: "#7ed492", alt: ["#a3e07f", "#5fbf7a", "#c9e37a"], count: 9, minDur: 6, maxDur: 11, radius: 0.67, psize: 0.16, amp: 0.09 },
  dec_bolt: { motion: "pulse", shape: "bolt", color: "#ffe14d", count: 8, minDur: 1.4, maxDur: 2.8, radius: 0.66, psize: 0.15 },
  dec_snow: { motion: "fall", shape: "flake", color: "#e6f3ff", count: 11, minDur: 7, maxDur: 13, radius: 0.67, psize: 0.13, amp: 0.09 },
  dec_flowers: { motion: "orbit", shape: "blossom", color: "#ffb3d9", alt: ["#ffd1e8", "#f9a8d4", "#fbcfe8"], count: 8, minDur: 14, maxDur: 22, radius: 0.64, psize: 0.18, amp: 0.04 },
  dec_rings: { motion: "spin", shape: "dot", color: "#6fe3ff", count: 3, minDur: 3, maxDur: 6, radius: 0.64, psize: 0.12 },
  dec_pixel: { motion: "twinkle", shape: "square", color: "#a78bfa", alt: ["#68e1fd", "#f0abfc", "#c4b5fd"], count: 12, minDur: 1.8, maxDur: 3.6, radius: 0.66, psize: 0.12 },
  dec_pumpkin: { motion: "rise", shape: "pumpkin", color: "#ff9f43", alt: ["#ff8a3d", "#ffc061"], count: 6, minDur: 6, maxDur: 10, radius: 0.69, psize: 0.19, amp: 0.07 },
  dec_confetti: { motion: "fall", shape: "square", color: "#f472b6", alt: ["#fbbf24", "#34d399", "#60a5fa", "#a78bfa"], count: 14, minDur: 4, maxDur: 8, radius: 0.68, psize: 0.13, amp: 0.09 },
  dec_crown: { motion: "twinkle", shape: "crown", color: "#ffd76a", count: 6, minDur: 2.6, maxDur: 4.8, radius: 0.66, psize: 0.18 },
};

/** Deterministic PRNG so a decoration looks identical on every render/reload. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export default function ProfileDecoration({
  decorationId,
  size = 40,
  reducedMotion,
}: {
  decorationId?: string | null;
  size?: number;
  reducedMotion?: boolean;
}) {
  const dec = DECORATIONS.find((d) => d.id === decorationId);
  const cfg = decorationId ? CONFIG[decorationId] : undefined;

  const particles = useMemo(() => {
    if (!cfg) return [];
    const rand = mulberry32((decorationId ?? "").split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 17));
    const ring = size * cfg.radius;
    const psize = Math.max(3, size * cfg.psize);
    const amp = size * (cfg.amp ?? 0.08);
    return Array.from({ length: cfg.count }, (_, i) => {
      const spread = cfg.count > 1 ? i / cfg.count : 0;
      // Even distribution around the ring with a small deterministic jitter.
      const angle = spread * Math.PI * 2 + (rand() - 0.5) * ((Math.PI * 2) / cfg.count) * 0.6;
      const r = ring * (0.96 + rand() * 0.08);
      return {
        left: `calc(50% + ${(Math.cos(angle) * r).toFixed(1)}px)`,
        top: `calc(50% + ${(Math.sin(angle) * r).toFixed(1)}px)`,
        sz: `${psize.toFixed(1)}px`,
        amp: `${amp.toFixed(1)}px`,
        delay: `${(rand() * (cfg.maxDur / 2)).toFixed(2)}s`,
        dur: `${(cfg.minDur + rand() * (cfg.maxDur - cfg.minDur)).toFixed(2)}s`,
        rot: `${Math.round(-220 + rand() * 440)}deg`,
        color: cfg.alt && cfg.alt.length ? cfg.alt[i % cfg.alt.length] : cfg.color,
        opacity: (0.55 + rand() * 0.45).toFixed(2),
      };
    });
  }, [cfg, decorationId, size]);

  if (!cfg || !dec) return null;

  // Largest particle duration drives the orbital rotation speed.
  const spin = `${Math.round(cfg.maxDur * 0.9)}s`;
  const box = Math.round(size * 1.9);
  const style = { "--box": `${box}px`, "--spin": spin } as CSSProperties;

  return (
    <span
      className={`pf-deco pf-deco-${cfg.motion} ${reducedMotion ? "reduced" : ""}`}
      data-deco={decorationId}
      style={style}
      aria-hidden="true"
    >
      <span className="pf-deco-inner">
        {cfg.motion === "spin" &&
          particles.map((p, i) => (
            <i
              key={`loop-${i}`}
              className="pf-deco-loop"
              style={{ width: `${size * (1.08 + i * 0.22)}px`, height: `${size * (1.08 + i * 0.22)}px`, animationDuration: p.dur, animationDelay: p.delay, borderColor: p.color } as CSSProperties}
            />
          ))}
        {cfg.motion !== "spin" && particles.map((p, i) => (
          <i
            key={i}
            className={`pf-deco-p s-${cfg.shape}`}
            style={{
              left: p.left,
              top: p.top,
              "--sz": p.sz,
              "--amp": p.amp,
              "--delay": p.delay,
              "--dur": p.dur,
              "--rot": p.rot,
              "--c": p.color,
              "--o": p.opacity,
            } as CSSProperties}
          />
        ))}
      </span>
    </span>
  );
}
