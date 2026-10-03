import { useMemo } from "react";
import { EFFECTS } from "@/lib/cosmetics";

/**
 * Decorative profile effect. Renders behind profile content and never blocks
 * reading or interaction (pointer-events: none). Respects reduced-motion.
 */
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
  // Stable pseudo-random positions so the effect doesn't jump on every render.
  const particles = useMemo(() => {
    const seed = (effectId ?? "").split("").reduce((a, c) => a + c.charCodeAt(0), 7);
    return Array.from({ length: density }, (_, i) => {
      const n = (seed * (i + 3) * 9301 + 49297) % 233280;
      const r = n / 233280;
      const r2 = ((seed * (i + 7) * 4021 + 12345) % 233280) / 233280;
      return {
        left: `${Math.round(r * 100)}%`,
        delay: `${(r2 * 6).toFixed(2)}s`,
        duration: `${(7 + r * 7).toFixed(2)}s`,
        size: `${(5 + r2 * 9).toFixed(1)}px`,
      };
    });
  }, [effectId, density]);

  if (!effect || effect.id === "effect_none" || reducedMotion) return null;

  if (effect.id === "effect_glow") {
    return <span className="pf-effect-glow" aria-hidden="true" />;
  }
  if (effect.id === "effect_aurora") {
    return <span className="pf-effect-aurora" aria-hidden="true" />;
  }

  return (
    <span className="pf-effect" aria-hidden="true" data-effect={effect.id}>
      {particles.map((p, i) => (
        <span
          key={i}
          className="pf-particle"
          style={{ left: p.left, animationDelay: p.delay, animationDuration: p.duration, fontSize: p.size }}
        >
          {effect.glyph ?? "•"}
        </span>
      ))}
    </span>
  );
}
