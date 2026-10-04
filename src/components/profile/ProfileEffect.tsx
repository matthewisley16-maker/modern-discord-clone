import { useMemo } from "react";
import type { CSSProperties } from "react";
import { EFFECTS } from "@/lib/cosmetics";

/**
 * Decorative background effect for a profile banner.
 *
 * Renders *behind* the banner content and never blocks reading or interaction
 * (`pointer-events: none`). Each effect is a real animated system of multiple
 * elements rendered with CSS transforms/opacity. Respects reduced motion.
 */

type Motion = "drift" | "twinkle" | "fall" | "rise" | "glow" | "aurora" | "digital";

interface FxConfig {
  motion: Motion;
  shape: string;
  color: string;
  alt?: string[];
  count: number;
  minDur: number;
  maxDur: number;
  /** Relative size multiplier for particles. */
  scale?: number;
}

const CONFIG: Record<string, FxConfig> = {
  effect_particles: { motion: "drift", shape: "dot", color: "rgba(255,255,255,.7)", count: 20, minDur: 12, maxDur: 24 },
  effect_sparkles: { motion: "twinkle", shape: "star", color: "#fdf3c4", count: 18, minDur: 2, maxDur: 4.4 },
  effect_stars: { motion: "twinkle", shape: "star", color: "#e8e3ff", count: 24, minDur: 3, maxDur: 7, scale: 0.8 },
  effect_snow: { motion: "fall", shape: "flake", color: "#eaf5ff", count: 22, minDur: 7, maxDur: 15 },
  effect_confetti: { motion: "fall", shape: "square", color: "#f472b6", alt: ["#fbbf24", "#34d399", "#60a5fa", "#a78bfa", "#fb7185"], count: 26, minDur: 5, maxDur: 11 },
  effect_glow: { motion: "glow", shape: "dot", color: "#a78bfa", count: 0, minDur: 3, maxDur: 4 },
  effect_fireflies: { motion: "drift", shape: "dot", color: "#ffe08a", count: 16, minDur: 6, maxDur: 13 },
  effect_bubbles: { motion: "rise", shape: "ring", color: "rgba(180,225,255,.85)", count: 16, minDur: 6, maxDur: 12 },
  effect_leaves: { motion: "fall", shape: "leaf", color: "#e0a35c", alt: ["#c9772f", "#f0b866", "#a35a2a"], count: 16, minDur: 7, maxDur: 14 },
  effect_digital: { motion: "digital", shape: "bar", color: "#4ade80", count: 22, minDur: 3, maxDur: 7 },
  effect_aurora: { motion: "aurora", shape: "dot", color: "#34d399", count: 0, minDur: 8, maxDur: 12 },
};

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

export default function ProfileEffect({
  effectId,
  reducedMotion,
  density = 18,
}: {
  effectId?: string | null;
  reducedMotion?: boolean;
  density?: number;
}) {
  const effect = EFFECTS.find((e) => e.id === effectId);
  const cfg = effectId ? CONFIG[effectId] : undefined;

  const particles = useMemo(() => {
    if (!cfg || cfg.count === 0) return [];
    const rand = mulberry32((effectId ?? "").split("").reduce((a, c) => (a * 33 + c.charCodeAt(0)) | 0, 5));
    return Array.from({ length: cfg.count }, (_, i) => ({
      x: `${Math.round(2 + rand() * 96)}%`,
      y: `${Math.round(4 + rand() * 88)}%`,
      delay: `${(rand() * (cfg.maxDur / 2)).toFixed(2)}s`,
      dur: `${(cfg.minDur + rand() * (cfg.maxDur - cfg.minDur)).toFixed(2)}s`,
      sz: `${(cfg.scale ? cfg.scale * 100 : 100) * (0.4 + rand() * 0.9)}%`,
      rot: `${Math.round(-260 + rand() * 520)}deg`,
      color: cfg.alt && cfg.alt.length ? cfg.alt[i % cfg.alt.length] : cfg.color,
      opacity: (0.35 + rand() * 0.55).toFixed(2),
    }));
  }, [cfg, effectId]);

  if (!effect || effect.id === "effect_none" || !cfg) return null;

  if (cfg.motion === "glow") {
    return <span className={`pf-effect-glow ${reducedMotion ? "reduced" : ""}`} aria-hidden="true" data-effect={effect.id} />;
  }
  if (cfg.motion === "aurora") {
    return <span className={`pf-effect-aurora ${reducedMotion ? "reduced" : ""}`} aria-hidden="true" data-effect={effect.id} />;
  }

  return (
    <span
      className={`pf-effect pf-fx-${cfg.motion} ${reducedMotion ? "reduced" : ""}`}
      aria-hidden="true"
      data-effect={effect.id}
    >
      {particles.map((p, i) => (
        <i
          key={i}
          className={`pf-fx-p s-${cfg.shape}`}
          style={{
            "--x": p.x,
            "--y": p.y,
            "--delay": p.delay,
            "--dur": p.dur,
            "--sz": p.sz,
            "--rot": p.rot,
            "--c": p.color,
            "--o": p.opacity,
          } as CSSProperties}
        />
      ))}
    </span>
  );
}
