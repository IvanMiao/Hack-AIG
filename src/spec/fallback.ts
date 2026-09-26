import type { NemesisSpec } from "./types";

/** Bound nightmares: shipped inside the build so the game is complete with zero network. Assets baked in H4. */
export const FALLBACK_SPECS: NemesisSpec[] = [
  {
    version: 1,
    code: "VESSEL-01",
    lineage: { gen: 1, kills: 0 },
    identity: {
      name: "Marrowine",
      title: "The Drowned Vow",
      incantation: "an iron knight who drowned his daughter and now hates fire",
      silhouette: "knight",
      element: "ice",
      temper: "grief",
      palette: ["#05070c", "#7fdcff", "#1b3a5c"],
    },
    stats: { maxHp: 900, poise: 60, aggression: 0.45 },
    phases: [
      {
        hpThreshold: 1,
        rule: "none",
        moves: [
          { type: "sweep", telegraphMs: 1100, damage: 22, scale: 1.1, count: 1 },
          { type: "thrust", telegraphMs: 800, damage: 18, scale: 1, count: 1, followUp: "sweep" },
          { type: "zone", telegraphMs: 1400, damage: 14, scale: 1.2, count: 3 },
        ],
      },
      {
        hpThreshold: 0.5,
        rule: "closing_ring",
        moves: [
          { type: "sweep", telegraphMs: 850, damage: 26, scale: 1.2, count: 1 },
          { type: "charge", telegraphMs: 1000, damage: 30, scale: 1, count: 1, followUp: "nova" },
          { type: "nova", telegraphMs: 1500, damage: 28, scale: 1.5, count: 1 },
          { type: "volley", telegraphMs: 700, damage: 10, scale: 0.8, count: 6 },
        ],
      },
    ],
    weakness: { trigger: "after_charge", multiplier: 2 },
    arenaTheme: "a frozen cathedral floor floating over black water",
    voice: {
      designPrompt: "a drowned baritone, water in the throat, slow and tender, English",
      lines: {
        intro: "You gave me a daughter only to drown her. Come — let me return the favor.",
        phase: "The water remembers every name I gave it.",
        taunt: ["Still rolling left?", "She was quieter than you.", "Breathe. It won't help."],
        playerDeath: ["Down you go, like she did.", "I remember that one."],
        defeat: "Let the river keep me, then.",
      },
    },
    music: {
      p1Prompt: "slow minor-key pipe organ and submerged choir, 70 bpm, mournful boss battle loop, instrumental",
      p2Prompt: "the same organ theme doubled in tempo with distorted taiko and breaking ice percussion, 140 bpm, instrumental",
      bpm: 70,
    },
    art: {
      styleAnchor: "ink wash illustration with neon cyan rim light on a pure black void, single accent color #7fdcff, high contrast, no text",
      accentHex: "#7fdcff",
      skyPrompt: "equirectangular panorama of a drowned cathedral under black water, shafts of cyan light, ink wash style",
      portraitPrompt: "half-body portrait of a rusted iron knight weeping seawater, cracked visor glowing cyan",
    },
    grudges: [],
  },
];

export const getFallbackSpec = (index = 0): NemesisSpec => {
  const spec = FALLBACK_SPECS[index % FALLBACK_SPECS.length];
  if (!spec) throw new Error("no fallback specs bundled");
  return structuredClone(spec);
};
