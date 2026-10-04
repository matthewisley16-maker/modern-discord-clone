import { useMemo } from "react";
import type { CSSProperties } from "react";
import { DECORATIONS } from "@/lib/cosmetics";

/**
 * Real profile decorations.
 *
 * Each decoration is a small particle system (multiple animated shapes) drawn
 * around the avatar with pure CSS transforms/opacity, so it stays GPU-friendly
 * and never lays out. The layer is `pointer-events: none` and respects
 * `prefers-reduced-motion` (shapes remain, motion stops).
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
  /** Orbital radius as a fraction of the decoration box (0–1). */
  radius?: number;
}

const CONFIG: Record<string, DecoConfig> = {
  dec_stars: { motion: "orbit", shape: "star", color: "#ffe08a", count: 8, minDur: 12, maxDur: 20, radius: 0.42 },
  dec_sparkles: { motion: "twinkle", shape: "star", color: "#f4f0ff", count: 12, minDur: 2.2, maxDur: 4.2 },
  dec_hearts: { motion: "rise", shape: "heart", color: "#ff6fae", count: 8, minDur: 5, maxDur: 9 },
  dec_flames: { motion: "rise", shape: "flame", color: "#ff8a3d", alt: ["#ffd166", "#ff5d3d", "#ffab4a"], count: 10, minDur: 3.2, maxDur: 6 },
  dec_clouds: { motion: "drift", shape: "cloud", color: "#d7e6ff", count: 5, minDur: 10, maxDur: 16 },
  dec_leaves: { motion: "fall", shape: "leaf", color: "#7ed492", alt: ["#a3e07f", "#5fbf7a", "#c9e37a"], count: 9, minDur: 6, maxDur: 11 },
  dec_bolt: { motion: "pulse", shape: "bolt", color: "#ffe14d", count: 8, minDur: 1.4, maxDur: 2.8 },
  dec_snow: { motion: "fall", shape: "flake", color: "#e6f3ff", count: 11, minDur: 7, maxDur: 13 },
  dec_flowers: { motion: "orbit", shape: "blossom", color: "#ffb3d9", alt: ["#ffd1e8", "#f9a8d4", "#fbcfe8"], count: 8, minDur: 14, maxDur: 22, radius: 0.42 },
  dec_rings: { motion: "spin", shape: "dot", color: "#6fe3ff", count: 3, minDur: 3, maxDur: 6 },
  dec_pixel: { motion: "twinkle", shape: "square", color: "#a78bfa", alt: ["#68e1fd", "#f0abfc", "#c4b5fd"], count: 12, minDur: 1.8, maxDur: 3.6 },
  dec_pumpkin: { motion: "rise", shape: "pumpkin", color: "#ff9f43", alt: ["#ff8a3d", "#ffc061"], count: 6, minDur: 6, maxDur: 10 },
  dec_confetti: { motion: "fall", shape: "square", color: "#f472b6", alt: ["#fbbf24", "#34d399", "#60a5fa", "#a78bfa"], count: 14, minDur: 4, maxDur: 8 },
  dec_crown: { motion: "twinkle", shape: "crown", color: "#ffd76a", count: 6, minDur: 2.6, maxDur: 4.8 },
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
    const box = Math.round(size * 1.45);
    return Array.from({ length: cfg.count }, (_, i) => {
      const spread = cfg.count > 1 ? i / cfg.count : 0;
      return {
        angle: Math.round(spread * 360 + (rand() - 0.5) * (360 / cfg.count) * 0.9),
        radius: Math.round(box * (cfg.radius ?? 0.42) * (0.88 + rand() * 0.22)),
        x: `${Math.round(6 + rand() * 88)}%`,
        y: `${Math.round(8 + rand() * 80)}%`,
        delay: `${(rand() * (cfg.maxDur / 2)).toFixed(2)}s`,
        dur: `${(cfg.minDur + rand() * (cfg.maxDur - cfg.minDur)).toFixed(2)}s`,
        sz: `${(size * (0.13 + rand() * 0.1)).toFixed(1)}px`,
        rot: `${Math.round(-220 + rand() * 440)}deg`,
        drift: `${Math.round(-30 + rand() * 60)}deg`,
        color: cfg.alt && cfg.alt.length ? cfg.alt[i % cfg.alt.length] : cfg.color,
        opacity: (0.6 + rand() * 0.4).toFixed(2),
      };
    });
  }, [cfg, decorationId, size]);

  if (!cfg || !dec) return null;

  // Largest particle duration drives the orbital rotation speed.
  const spin = `${Math.round(cfg.maxDur * 0.9)}s`;
  const box = Math.round(size * 1.45);
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
              style={{ width: `${size * (1.05 + i * 0.24)}px`, height: `${size * (1.05 + i * 0.24)}px`, animationDuration: p.dur, animationDelay: p.delay, borderColor: p.color } as CSSProperties}
            />
          ))}
        {cfg.motion !== "spin" && particles.map((p, i) => (
          <i
            key={i}
            className={`pf-deco-p s-${cfg.shape}`}
            style={{
              "--a": `${p.angle}deg`,
              "--r": `${p.radius}px`,
              "--x": p.x,
              "--y": p.y,
              "--delay": p.delay,
              "--dur": p.dur,
              "--sz": p.sz,
              "--rot": p.rot,
              "--drift": p.drift,
              "--c": p.color,
              "--o": p.opacity,
            } as CSSProperties}
          />
        ))}
      </span>
    </span>
  );
}
