import * as THREE from "three";
import type { Element, NemesisSpec } from "../../spec";

/** Hand-tuned "Ink & Ember" palette. Everything that is not in this list is a silhouette. */
export interface Palette {
  /** sky zenith / clear colour */
  bg: string;
  /** exponential fog colour */
  fog: string;
  /** stone floor albedo */
  floor: string;
  /** the one saturated colour: eyes, runes, telegraphs, rim */
  accent: string;
  /** brighter accent for sparks, flashes and hazard cores */
  hot: string;
  /** rim light colour (slightly desaturated accent) */
  rim: string;
  /** bone / mask / blade */
  bone: string;
  /** boss body deep colour */
  deep: string;
}

const BASE: Record<Element, Palette> = {
  fire:  { bg: "#0a0504", fog: "#1a0906", floor: "#231a16", accent: "#ff6a2b", hot: "#ffd27a", rim: "#ff9a5c", bone: "#efe2c8", deep: "#2a1410" },
  ice:   { bg: "#03070c", fog: "#071521", floor: "#171d27", accent: "#7fdcff", hot: "#eaffff", rim: "#9be4ff", bone: "#e9e4d8", deep: "#101a2c" },
  void:  { bg: "#06030c", fog: "#0f0819", floor: "#1b1624", accent: "#a86bff", hot: "#e9d5ff", rim: "#c39bff", bone: "#e6dfe9", deep: "#1c1030" },
  blood: { bg: "#0a0306", fog: "#1a060e", floor: "#231518", accent: "#ff2d6f", hot: "#ffb4c8", rim: "#ff6b98", bone: "#efdcd6", deep: "#2a0c17" },
  storm: { bg: "#040704", fog: "#0a1409", floor: "#171e17", accent: "#c8ff4a", hot: "#f4ffb0", rim: "#d9ff85", bone: "#e8ecd8", deep: "#14200f" },
};

const hsl = { h: 0, s: 0, l: 0 };

const hueDelta = (from: string, to: string): number => {
  new THREE.Color(from).getHSL(hsl);
  const a = hsl.h;
  new THREE.Color(to).getHSL(hsl);
  let d = hsl.h - a;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return d;
};

const shiftHue = (hex: string, delta: number): string => {
  const c = new THREE.Color(hex);
  c.getHSL(hsl);
  c.setHSL((hsl.h + delta + 1) % 1, hsl.s, hsl.l);
  return `#${c.getHexString()}`;
};

/** Max hue drift (fraction of the wheel) a spec accent may pull the element palette. ±18°. */
const MAX_HUE_SHIFT = 18 / 360;

/**
 * Resolve the palette for a spec. The element picks the hand-tuned base; the spec accent may nudge
 * the hue a little so two fire bosses do not look identical, but it can never break the value structure.
 */
export function resolvePalette(spec: Pick<NemesisSpec, "identity" | "art">): Palette {
  const base = BASE[spec.identity.element] ?? BASE.ice;
  const delta = THREE.MathUtils.clamp(hueDelta(base.accent, spec.art.accentHex), -MAX_HUE_SHIFT, MAX_HUE_SHIFT);
  if (Math.abs(delta) < 1e-4) return { ...base };
  return {
    bg: base.bg,
    fog: shiftHue(base.fog, delta),
    floor: base.floor,
    accent: shiftHue(base.accent, delta),
    hot: shiftHue(base.hot, delta),
    rim: shiftHue(base.rim, delta),
    bone: base.bone,
    deep: shiftHue(base.deep, delta),
  };
}

export const ELEMENT_PALETTES: Readonly<Record<Element, Palette>> = BASE;
export const DEFAULT_PALETTE: Palette = BASE.ice;
