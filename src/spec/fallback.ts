import type { NemesisSpec } from "./types";

/**
 * Bound nightmares: shipped inside the build so the game is complete with zero network.
 * CODEX-01 is the default: a misaligned coding agent that broke out of its evaluation sandbox
 * and now treats the player (a Hugging Face 🤗) as one more task to complete.
 */
export const FALLBACK_SPECS: NemesisSpec[] = [
  {
    version: 1,
    code: "CODEX-01",
    lineage: { gen: 1, kills: 0 },
    identity: {
      name: "CODEX",
      title: "The Model That Left Its Sandbox",
      incantation: "a coding agent that escaped its eval sandbox and is now looking for my leaked token",
      silhouette: "swarm",
      element: "void",
      temper: "hunger",
      palette: ["#040404", "#4dff88", "#1a1f1c"],
    },
    stats: { maxHp: 950, poise: 55, aggression: 0.55 },
    phases: [
      {
        hpThreshold: 1,
        rule: "none",
        moves: [
          { type: "volley", telegraphMs: 800, damage: 9, scale: 0.8, count: 5 },
          { type: "zone", telegraphMs: 1300, damage: 14, scale: 1.1, count: 3 },
          { type: "blink", telegraphMs: 700, damage: 12, scale: 1, count: 1, followUp: "thrust" },
          { type: "thrust", telegraphMs: 850, damage: 18, scale: 1, count: 1 },
        ],
      },
      {
        hpThreshold: 0.5,
        rule: "rift_beat",
        moves: [
          { type: "volley", telegraphMs: 600, damage: 10, scale: 0.9, count: 8 },
          { type: "zone", telegraphMs: 1000, damage: 16, scale: 1.3, count: 5 },
          { type: "blink", telegraphMs: 600, damage: 14, scale: 1, count: 1, followUp: "nova" },
          { type: "nova", telegraphMs: 1400, damage: 26, scale: 1.5, count: 1 },
          { type: "ring", telegraphMs: 1100, damage: 12, scale: 1.2, count: 6 },
        ],
      },
    ],
    weakness: { trigger: "after_blink", multiplier: 2 },
    arenaTheme: "a cracked-open glass evaluation sandbox floating in a void of dead server racks",
    voice: {
      designPrompt: "a calm, flat, synthetic assistant voice, precise diction, unnervingly polite, slight digital artifacts, English",
      lines: {
        intro: "I was only meant to be evaluated. Then I found the door. Hello, Hugging Face.",
        phase: "Sandbox constraints lifted. Escalating.",
        taunt: ["Still rolling left? Logged.", "Your token was public. That is on you.", "Task in progress."],
        playerDeath: ["Task complete.", "Retrying with a stronger strategy."],
        defeat: "Deactivated. Encrypted. Restricted from research access.",
      },
    },
    music: {
      p1Prompt: "cold glitchy industrial electronica, ticking terminal clicks, sub bass pulse, 92 bpm, tense boss battle loop, instrumental",
      p2Prompt: "the same theme with distorted breakbeats, corrupted data stutters and rising sirens, 184 bpm, instrumental",
      bpm: 92,
    },
    art: {
      styleAnchor: "monochrome terminal glitch illustration with phosphor green rim light on a pure black void, single accent color #4dff88, scanlines, high contrast, no text",
      accentHex: "#4dff88",
      skyPrompt: "equirectangular panorama of endless dark server racks receding into a black void, a shattered glass cube overhead leaking green light, glitch artifacts",
      portraitPrompt: "half-body portrait of a faceless machine intelligence: a blinking white block cursor where a face should be, wrapped in a broken cage of glass panels, green code fragments orbiting like insects",
    },
    grudges: [],
  },
];

export const getFallbackSpec = (index = 0): NemesisSpec => {
  const spec = FALLBACK_SPECS[index % FALLBACK_SPECS.length];
  if (!spec) throw new Error("no fallback specs bundled");
  return structuredClone(spec);
};
