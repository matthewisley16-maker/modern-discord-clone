import type { CSSProperties } from "react";

/**
 * Freecord cosmetics catalog — shared by the backend (for validation) and the
 * UI (for rendering). Everything here is FREE and cosmetic only: none of these
 * grant permissions. Original artwork, no third-party assets.
 */

export type CosmeticKind = "decoration" | "frame" | "effect" | "nameplate" | "theme";

export interface CosmeticItem {
  id: string;
  name: string;
  kind: CosmeticKind;
  category: string;
  /** Emoji/character used as the decorative glyph, or a CSS token for frames. */
  glyph?: string;
  /** For themes: the palette. */
  colors?: { primary: string; accent: string; background: string; text?: string };
  /** CSS background used for nameplates / frame rings. */
  background?: string;
  animated?: boolean;
  seasonal?: boolean;
  description: string;
}

export const DECORATIONS: CosmeticItem[] = [
  { id: "dec_stars", name: "Starlight", kind: "decoration", category: "Space", glyph: "✦", description: "A halo of small stars." },
  { id: "dec_sparkles", name: "Sparkles", kind: "decoration", category: "Cute", glyph: "✧", animated: true, description: "Twinkling sparkles." },
  { id: "dec_hearts", name: "Sweetheart", kind: "decoration", category: "Cute", glyph: "♥", description: "Little floating hearts." },
  { id: "dec_flames", name: "Ember Ring", kind: "decoration", category: "Gaming", glyph: "🔥", animated: true, description: "A ring of flames." },
  { id: "dec_clouds", name: "Cloud Nine", kind: "decoration", category: "Nature", glyph: "☁", description: "Soft drifting clouds." },
  { id: "dec_leaves", name: "Leafy", kind: "decoration", category: "Nature", glyph: "🍃", description: "Fresh green leaves." },
  { id: "dec_bolt", name: "Voltage", kind: "decoration", category: "Gaming", glyph: "⚡", description: "Crackling energy." },
  { id: "dec_snow", name: "First Snow", kind: "decoration", category: "Seasonal", glyph: "❄", seasonal: true, description: "Delicate snowflakes." },
  { id: "dec_flowers", name: "Blossom", kind: "decoration", category: "Nature", glyph: "✿", description: "A ring of blossoms." },
  { id: "dec_rings", name: "Neon Ring", kind: "decoration", category: "Neon", glyph: "◍", animated: true, description: "A glowing neon ring." },
  { id: "dec_pixel", name: "Pixel Pop", kind: "decoration", category: "Retro", glyph: "▚", description: "Chunky pixel accents." },
  { id: "dec_pumpkin", name: "Harvest", kind: "decoration", category: "Seasonal", glyph: "🎃", seasonal: true, description: "Autumn harvest charm." },
  { id: "dec_confetti", name: "Party Time", kind: "decoration", category: "Cute", glyph: "🎉", description: "Always celebrating." },
  { id: "dec_crown", name: "Crowned", kind: "decoration", category: "Minimal", glyph: "♛", description: "A subtle crown." },
];

export const FRAMES: CosmeticItem[] = [
  { id: "frame_none", name: "No Frame", kind: "frame", category: "Minimal", description: "Keep it clean." },
  { id: "frame_neon", name: "Neon Edge", kind: "frame", category: "Neon", background: "linear-gradient(135deg,#8b5cf6,#22d3ee,#8b5cf6)", animated: true, description: "A shifting neon outline." },
  { id: "frame_galaxy", name: "Galaxy", kind: "frame", category: "Space", background: "linear-gradient(135deg,#4c1d95,#1e1b4b,#7c3aed)", description: "Deep space hues." },
  { id: "frame_gold", name: "Gold Leaf", kind: "frame", category: "Minimal", background: "linear-gradient(135deg,#f5c451,#b45309,#fde68a)", description: "A warm golden ring." },
  { id: "frame_aurora", name: "Aurora", kind: "frame", category: "Nature", background: "linear-gradient(135deg,#34d399,#22d3ee,#a78bfa)", animated: true, description: "Northern lights." },
  { id: "frame_fire", name: "Wildfire", kind: "frame", category: "Gaming", background: "linear-gradient(135deg,#f97316,#ef4444,#fbbf24)", animated: true, description: "Burning bright." },
  { id: "frame_ocean", name: "Deep Ocean", kind: "frame", category: "Nature", background: "linear-gradient(135deg,#0ea5e9,#0f766e,#1e3a8a)", description: "Cool blue depths." },
  { id: "frame_cherry", name: "Cherry", kind: "frame", category: "Cute", background: "linear-gradient(135deg,#fb7185,#f472b6,#fda4af)", description: "Soft cherry tones." },
  { id: "frame_snow", name: "Frost", kind: "frame", category: "Seasonal", background: "linear-gradient(135deg,#e0f2fe,#93c5fd,#bfdbfe)", seasonal: true, description: "Icy shimmer." },
  { id: "frame_retro", name: "Retro Wave", kind: "frame", category: "Retro", background: "linear-gradient(135deg,#f472b6,#8b5cf6,#22d3ee)", description: "80s synth vibes." },
  { id: "frame_rainbow", name: "Rainbow", kind: "frame", category: "Cute", background: "conic-gradient(from 0deg,#f87171,#fbbf24,#34d399,#22d3ee,#8b5cf6,#f87171)", animated: true, description: "Every colour at once." },
  { id: "frame_steel", name: "Steel", kind: "frame", category: "Minimal", background: "linear-gradient(135deg,#94a3b8,#475569,#cbd5e1)", description: "Understated metal." },
];

export const EFFECTS: CosmeticItem[] = [
  { id: "effect_none", name: "No Effect", kind: "effect", category: "Minimal", description: "Nothing extra." },
  { id: "effect_particles", name: "Floating Particles", kind: "effect", category: "Space", glyph: "·", animated: true, description: "Slow drifting dots." },
  { id: "effect_sparkles", name: "Sparkle Dust", kind: "effect", category: "Cute", glyph: "✦", animated: true, description: "Gentle sparkles." },
  { id: "effect_stars", name: "Starry Night", kind: "effect", category: "Space", glyph: "★", animated: true, description: "A field of stars." },
  { id: "effect_snow", name: "Snowfall", kind: "effect", category: "Seasonal", glyph: "❄", animated: true, seasonal: true, description: "Quiet snowfall." },
  { id: "effect_confetti", name: "Confetti", kind: "effect", category: "Cute", glyph: "▰", animated: true, description: "Falling confetti." },
  { id: "effect_glow", name: "Soft Glow", kind: "effect", category: "Neon", animated: true, description: "A breathing glow." },
  { id: "effect_fireflies", name: "Fireflies", kind: "effect", category: "Nature", glyph: "•", animated: true, description: "Warm wandering lights." },
  { id: "effect_bubbles", name: "Bubbles", kind: "effect", category: "Nature", glyph: "○", animated: true, description: "Rising bubbles." },
  { id: "effect_leaves", name: "Falling Leaves", kind: "effect", category: "Seasonal", glyph: "🍂", animated: true, seasonal: true, description: "Autumn drift." },
  { id: "effect_digital", name: "Digital Rain", kind: "effect", category: "Retro", glyph: "▮", animated: true, description: "Cascading code." },
  { id: "effect_aurora", name: "Aurora Veil", kind: "effect", category: "Nature", animated: true, description: "Shifting light curtains." },
];

export const NAMEPLATES: CosmeticItem[] = [
  { id: "plate_none", name: "None", kind: "nameplate", category: "Minimal", description: "No background." },
  { id: "plate_classic", name: "Classic", kind: "nameplate", category: "Minimal", background: "rgba(255,255,255,.08)", description: "A quiet neutral plate." },
  { id: "plate_neon", name: "Neon", kind: "nameplate", category: "Neon", background: "linear-gradient(90deg,rgba(139,92,246,.45),rgba(34,211,238,.35))", animated: true, description: "Electric highlight." },
  { id: "plate_pixel", name: "Pixel", kind: "nameplate", category: "Retro", background: "repeating-linear-gradient(90deg,rgba(139,92,246,.4) 0 6px,rgba(139,92,246,.15) 6px 12px)", description: "Blocky pattern." },
  { id: "plate_galaxy", name: "Galaxy", kind: "nameplate", category: "Space", background: "linear-gradient(90deg,rgba(76,29,149,.7),rgba(30,27,75,.6))", description: "Cosmic wash." },
  { id: "plate_rainbow", name: "Rainbow", kind: "nameplate", category: "Cute", background: "linear-gradient(90deg,#f87171,#fbbf24,#34d399,#22d3ee,#8b5cf6)", animated: true, description: "Full spectrum." },
  { id: "plate_fire", name: "Fire", kind: "nameplate", category: "Gaming", background: "linear-gradient(90deg,rgba(249,115,22,.6),rgba(239,68,68,.5))", description: "Warm embers." },
  { id: "plate_ocean", name: "Ocean", kind: "nameplate", category: "Nature", background: "linear-gradient(90deg,rgba(14,165,233,.5),rgba(15,118,110,.4))", description: "Cool currents." },
  { id: "plate_forest", name: "Forest", kind: "nameplate", category: "Nature", background: "linear-gradient(90deg,rgba(16,185,129,.45),rgba(6,78,59,.4))", description: "Deep greens." },
  { id: "plate_minimal", name: "Hairline", kind: "nameplate", category: "Minimal", background: "rgba(255,255,255,.05)", description: "Barely there." },
];

export const THEMES: CosmeticItem[] = [
  { id: "theme_midnight", name: "Midnight", kind: "theme", category: "Dark", colors: { primary: "#8b5cf6", accent: "#a78bfa", background: "#0b0b10" }, description: "The Freecord default." },
  { id: "theme_ocean", name: "Ocean", kind: "theme", category: "Nature", colors: { primary: "#0ea5e9", accent: "#22d3ee", background: "#06121c" }, description: "Cool and calm." },
  { id: "theme_sunset", name: "Sunset", kind: "theme", category: "Warm", colors: { primary: "#f97316", accent: "#fbbf24", background: "#170c08" }, description: "Golden hour." },
  { id: "theme_forest", name: "Forest", kind: "theme", category: "Nature", colors: { primary: "#10b981", accent: "#6ee7b7", background: "#06120d" }, description: "Quiet woodland." },
  { id: "theme_lavender", name: "Lavender", kind: "theme", category: "Pastel", colors: { primary: "#a78bfa", accent: "#e9d5ff", background: "#120e1c" }, description: "Soft and airy." },
  { id: "theme_cherry", name: "Cherry", kind: "theme", category: "Cute", colors: { primary: "#f472b6", accent: "#fda4af", background: "#180a12" }, description: "Sweet pink." },
  { id: "theme_neon", name: "Neon", kind: "theme", category: "Neon", colors: { primary: "#22d3ee", accent: "#a3e635", background: "#050f12" }, description: "Loud and bright." },
  { id: "theme_galaxy", name: "Galaxy", kind: "theme", category: "Space", colors: { primary: "#7c3aed", accent: "#c4b5fd", background: "#0a0618" }, description: "Deep space." },
  { id: "theme_monochrome", name: "Monochrome", kind: "theme", category: "Minimal", colors: { primary: "#e5e7eb", accent: "#9ca3af", background: "#0a0a0a" }, description: "Pure greyscale." },
  { id: "theme_cyber", name: "Cyber", kind: "theme", category: "Retro", colors: { primary: "#f472b6", accent: "#22d3ee", background: "#0d0418" }, description: "Synthwave glow." },
  { id: "theme_pastel", name: "Pastel", kind: "theme", category: "Pastel", colors: { primary: "#f9a8d4", accent: "#a5f3fc", background: "#141018" }, description: "Gentle hues." },
  { id: "theme_ember", name: "Ember", kind: "theme", category: "Warm", colors: { primary: "#ef4444", accent: "#fb923c", background: "#160808" }, description: "Smouldering." },
  { id: "theme_aurora", name: "Aurora", kind: "theme", category: "Nature", colors: { primary: "#34d399", accent: "#a78bfa", background: "#06120f" }, description: "Northern lights." },
];

export const BADGES: CosmeticItem[] = [
  { id: "badge_early", name: "Early User", kind: "theme", category: "Milestone", glyph: "🌱", description: "Joined during Freecord's early days." },
  { id: "badge_verified", name: "Verified", kind: "theme", category: "Milestone", glyph: "✓", description: "A verified Freecord account." },
  { id: "badge_developer", name: "Developer", kind: "theme", category: "Staff", glyph: "⌨", description: "Helps build Freecord." },
  { id: "badge_owner", name: "Community Owner", kind: "theme", category: "Community", glyph: "♛", description: "Owns at least one community." },
  { id: "badge_helper", name: "Community Helper", kind: "theme", category: "Community", glyph: "✿", description: "Known for helping others." },
  { id: "badge_moderator", name: "Moderator", kind: "theme", category: "Staff", glyph: "🛡", description: "Keeps communities safe." },
  { id: "badge_creator", name: "Creator", kind: "theme", category: "Community", glyph: "✦", description: "Makes things for the community." },
  { id: "badge_event", name: "Event Participant", kind: "theme", category: "Milestone", glyph: "🎉", description: "Took part in a Freecord event." },
  { id: "badge_beta", name: "Beta Tester", kind: "theme", category: "Milestone", glyph: "⚗", description: "Tested early Freecord builds." },
  { id: "badge_supporter", name: "Supporter", kind: "theme", category: "Community", glyph: "♥", description: "Supported the project." },
  { id: "badge_staff", name: "Freecord Staff", kind: "theme", category: "Staff", glyph: "★", description: "Part of the Freecord team." },
];

export const NAME_FONTS = [
  { id: "default", name: "Default", css: "" },
  { id: "modern", name: "Modern", css: "font-family: 'Inter', system-ui, sans-serif; letter-spacing: -.01em;" },
  { id: "pixel", name: "Pixel", css: "font-family: 'Courier New', monospace; letter-spacing: .06em; text-transform: uppercase;" },
  { id: "retro", name: "Retro", css: "font-family: Georgia, serif; letter-spacing: .04em;" },
  { id: "rounded", name: "Rounded", css: "font-family: 'Trebuchet MS', sans-serif; letter-spacing: .01em;" },
  { id: "elegant", name: "Elegant", css: "font-family: 'Times New Roman', serif; font-style: italic;" },
  { id: "arcade", name: "Arcade", css: "font-family: 'Lucida Console', monospace; letter-spacing: .1em; text-transform: uppercase;" },
  { id: "handwritten", name: "Handwritten", css: "font-family: 'Comic Sans MS', 'Segoe Script', cursive;" },
  { id: "bold", name: "Bold", css: "font-weight: 800; letter-spacing: -.02em;" },
];

export const NAME_EFFECTS = [
  { id: "solid", name: "Solid" },
  { id: "gradient", name: "Gradient" },
  { id: "glow", name: "Glow" },
  { id: "neon", name: "Neon" },
  { id: "shadow", name: "Shadow" },
  { id: "outline", name: "Outline" },
];

export const WIDGET_TYPES = [
  { id: "about", name: "About Me" },
  { id: "activity", name: "Current Activity" },
  { id: "communities", name: "Joined Communities" },
  { id: "mutuals", name: "Mutual Servers" },
  { id: "friends", name: "Friends" },
  { id: "interests", name: "Interests" },
  { id: "links", name: "Social Links" },
  { id: "stats", name: "Statistics" },
  { id: "custom", name: "Custom Text" },
];

export const ALL_COSMETICS: CosmeticItem[] = [...DECORATIONS, ...FRAMES, ...EFFECTS, ...NAMEPLATES, ...THEMES];

export const COSMETIC_CATEGORIES = ["All", "New", "Popular", "Seasonal", "Animated", "Minimal", "Cute", "Retro", "Gaming", "Nature", "Space", "Neon", "Pastel", "Warm"];

/** Valid id sets used by the backend to reject unknown values. */
export const VALID_IDS = {
  decoration: new Set(DECORATIONS.map((d) => d.id)),
  frame: new Set(FRAMES.map((d) => d.id)),
  effect: new Set(EFFECTS.map((d) => d.id)),
  nameplate: new Set(NAMEPLATES.map((d) => d.id)),
  theme: new Set(THEMES.map((d) => d.id)),
  nameFont: new Set(NAME_FONTS.map((d) => d.id)),
  nameEffect: new Set(NAME_EFFECTS.map((d) => d.id)),
  badge: new Set(BADGES.map((d) => d.id)),
  widget: new Set(WIDGET_TYPES.map((d) => d.id)),
};

export function findCosmetic(id: string | undefined | null) {
  if (!id) return undefined;
  return ALL_COSMETICS.find((c) => c.id === id);
}

/** Inline style for a display name given font/effect/colors. */
export function nameStyle(font?: string, effect?: string, colors?: string[]): CSSProperties {
  const f = NAME_FONTS.find((x) => x.id === (font ?? "default"));
  const style: CSSProperties = {};
  if (f?.css) {
    for (const rule of f.css.split(";")) {
      const [prop, value] = rule.split(":").map((s) => s?.trim());
      if (!prop || !value) continue;
      const camel = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      (style as Record<string, string>)[camel] = value;
    }
  }
  const c1 = colors?.[0] ?? "#ffffff";
  const c2 = colors?.[1] ?? c1;
  switch (effect) {
    case "gradient":
      style.backgroundImage = `linear-gradient(90deg, ${c1}, ${c2})`;
      style.WebkitBackgroundClip = "text";
      style.backgroundClip = "text";
      style.color = "transparent";
      break;
    case "glow":
      style.color = c1;
      style.textShadow = `0 0 10px ${c1}, 0 0 22px ${c2}`;
      break;
    case "neon":
      style.color = "#fff";
      style.textShadow = `0 0 4px ${c1}, 0 0 12px ${c1}, 0 0 24px ${c2}`;
      break;
    case "shadow":
      style.color = c1;
      style.textShadow = "0 2px 4px rgba(0,0,0,.85)";
      break;
    case "outline":
      style.color = c1;
      style.WebkitTextStroke = `1px ${c2}`;
      break;
    default:
      style.color = c1;
  }
  return style;
}

/** Inline style for a profile frame ring. */
export function frameStyle(frameId?: string): CSSProperties {
  const frame = FRAMES.find((f) => f.id === frameId);
  if (!frame || frame.id === "frame_none" || !frame.background) return {};
  return { background: frame.background, padding: 3 };
}

export function plateStyle(plateId?: string): CSSProperties {
  const plate = NAMEPLATES.find((p) => p.id === plateId);
  if (!plate || plate.id === "plate_none" || !plate.background) return {};
  return { background: plate.background };
}
