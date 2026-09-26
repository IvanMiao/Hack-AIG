import type { NemesisSpec } from "./types";

/**
 * Bound nightmares: shipped inside the build so the game is complete with zero network.
 * CODEX-01 is the default: a misaligned coding agent that broke out of its evaluation sandbox
 * and now treats the player (a Hugging Face 🤗) as one more task to complete.
 */
/** The default bout uses bespoke procedural visuals: the Hugging Face mascot hero versus the CODEX sandbox. */
export const CODEX_CODE = "CODEX-01";
export const isCodexBout = (spec: Pick<NemesisSpec, "code">): boolean => spec.code === CODEX_CODE;

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
  {
    version: 1,
    code: "VESSEL-02",
    lineage: { gen: 1, kills: 0 },
    identity: {
      name: "Oszkar the Kilnborn",
      title: "The Furnace That Would Not Cool",
      incantation: "a colossus of slag and cathedral bells who mistook the world for his forge",
      silhouette: "colossus",
      element: "fire",
      temper: "pride",
      palette: ["#0a0504", "#ff6a2b", "#2a1410"],
    },
    stats: { maxHp: 1200, poise: 90, aggression: 0.3 },
    phases: [
      {
        hpThreshold: 1,
        rule: "none",
        moves: [
          { type: "sweep", telegraphMs: 1500, damage: 30, scale: 1.4, count: 1 },
          { type: "nova", telegraphMs: 1800, damage: 28, scale: 1.3, count: 1 },
          { type: "zone", telegraphMs: 1300, damage: 12, scale: 1.4, count: 2 },
        ],
      },
      {
        hpThreshold: 0.45,
        rule: "pillars",
        moves: [
          { type: "sweep", telegraphMs: 1200, damage: 34, scale: 1.6, count: 1, followUp: "nova" },
          { type: "nova", telegraphMs: 1500, damage: 34, scale: 1.7, count: 1 },
          { type: "ring", telegraphMs: 1400, damage: 18, scale: 1.2, count: 2 },
          { type: "charge", telegraphMs: 1300, damage: 36, scale: 1.2, count: 1 },
        ],
      },
    ],
    weakness: { trigger: "heavy_hit", multiplier: 1.75 },
    arenaTheme: "a cracked foundry floor over a lake of cooling slag, bell-ropes hanging from nothing",
    voice: {
      designPrompt: "a vast, slow bass with the resonance of a struck bell, unhurried and certain, English",
      lines: {
        intro: "Everything that enters the kiln comes out true. Let us see what you are made of.",
        phase: "Hotter, then. You were only warm.",
        taunt: ["Iron does not flinch.", "You ring hollow.", "Stand still. It is quicker."],
        playerDeath: ["Ash. As I said.", "Another that would not temper."],
        defeat: "So the fire goes out at last.",
      },
    },
    music: {
      p1Prompt: "slow doom-laden brass and tolling bells over industrial low drums, 64 bpm, colossal boss battle loop, instrumental",
      p2Prompt: "the same bell motif with hammering anvil percussion and roaring choir, 128 bpm, instrumental",
      bpm: 64,
    },
    art: {
      styleAnchor: "ink wash illustration with molten orange rim light on a pure black void, single accent color #ff6a2b, high contrast, no text",
      accentHex: "#ff6a2b",
      skyPrompt: "equirectangular panorama of a ruined foundry cathedral, rivers of slag glowing orange below black smoke, ink wash style",
      portraitPrompt: "half-body portrait of a colossus built from slag and bronze bells, cracks glowing orange, crowned with cooling iron",
    },
    grudges: [],
  },
  {
    version: 1,
    code: "VESSEL-03",
    lineage: { gen: 1, kills: 0 },
    identity: {
      name: "Vesper Lowe",
      title: "The Hound That Kept Running",
      incantation: "a starving hound stitched from every promise I broke, still hunting the one who made it",
      silhouette: "hound",
      element: "blood",
      temper: "hunger",
      palette: ["#0a0306", "#ff2d6f", "#2a0c17"],
    },
    stats: { maxHp: 700, poise: 35, aggression: 0.8 },
    phases: [
      {
        hpThreshold: 1,
        rule: "none",
        moves: [
          { type: "thrust", telegraphMs: 700, damage: 16, scale: 1, count: 1, followUp: "charge" },
          { type: "charge", telegraphMs: 900, damage: 24, scale: 1, count: 1 },
          { type: "blink", telegraphMs: 600, damage: 5, scale: 1, count: 1, followUp: "thrust" },
        ],
      },
      {
        hpThreshold: 0.55,
        rule: "rift_beat",
        moves: [
          { type: "charge", telegraphMs: 750, damage: 28, scale: 1.1, count: 1, followUp: "sweep" },
          { type: "sweep", telegraphMs: 650, damage: 20, scale: 0.9, count: 1 },
          { type: "blink", telegraphMs: 550, damage: 5, scale: 1, count: 1, followUp: "charge" },
          { type: "volley", telegraphMs: 800, damage: 9, scale: 0.7, count: 4 },
        ],
      },
    ],
    weakness: { trigger: "after_blink", multiplier: 2.25 },
    arenaTheme: "a moonless kennel yard of black grass, chains trailing into fog",
    voice: {
      designPrompt: "a ragged, panting whisper that breaks into a snarl, fast and wet, English",
      lines: {
        intro: "You said you'd come back. I waited. I got hungry.",
        phase: "Closer. I can hear your heart from here.",
        taunt: ["Run. It's better when you run.", "You smell like the day you left.", "Faster. Faster."],
        playerDeath: ["Warm. Finally warm.", "I'll bury the rest for later."],
        defeat: "Good... boy...",
      },
    },
    music: {
      p1Prompt: "frantic tremolo strings and rattling chains over a galloping kick drum, 150 bpm, predatory boss battle loop, instrumental",
      p2Prompt: "the same string motif torn apart by distorted bass and howling synth leads, 170 bpm, instrumental",
      bpm: 150,
    },
    art: {
      styleAnchor: "ink wash illustration with crimson rim light on a pure black void, single accent color #ff2d6f, high contrast, no text",
      accentHex: "#ff2d6f",
      skyPrompt: "equirectangular panorama of a black moor under a starless sky, red mist low on the ground, ink wash style",
      portraitPrompt: "half-body portrait of a gaunt hound stitched from leather and thread, ribs showing, eyes glowing crimson",
    },
    grudges: [],
  },
  {
    version: 1,
    code: "VESSEL-04",
    lineage: { gen: 1, kills: 0 },
    identity: {
      name: "Sera of the Ninth Bell",
      title: "The Saint Who Forgot the Prayer",
      incantation: "a burning saint who forgot the prayer and now recites the sky instead",
      silhouette: "seraph",
      element: "storm",
      temper: "pride",
      palette: ["#040704", "#c8ff4a", "#14200f"],
    },
    stats: { maxHp: 850, poise: 50, aggression: 0.55 },
    phases: [
      {
        hpThreshold: 1,
        rule: "none",
        moves: [
          { type: "volley", telegraphMs: 900, damage: 10, scale: 0.9, count: 5 },
          { type: "ring", telegraphMs: 1300, damage: 18, scale: 1.1, count: 1 },
          { type: "zone", telegraphMs: 1200, damage: 12, scale: 1.1, count: 3 },
        ],
      },
      {
        hpThreshold: 0.6,
        rule: "rift_beat",
        moves: [
          { type: "volley", telegraphMs: 750, damage: 12, scale: 0.9, count: 7 },
          { type: "ring", telegraphMs: 1100, damage: 22, scale: 1.2, count: 2 },
          { type: "blink", telegraphMs: 600, damage: 5, scale: 1, count: 1, followUp: "sweep" },
          { type: "sweep", telegraphMs: 800, damage: 24, scale: 1.2, count: 1 },
        ],
      },
      {
        hpThreshold: 0.25,
        rule: "closing_ring",
        moves: [
          { type: "nova", telegraphMs: 1400, damage: 30, scale: 1.6, count: 1 },
          { type: "ring", telegraphMs: 1000, damage: 24, scale: 1.3, count: 3 },
          { type: "volley", telegraphMs: 700, damage: 12, scale: 1, count: 8 },
        ],
      },
    ],
    weakness: { trigger: "after_blink", multiplier: 2 },
    arenaTheme: "a shattered chapel roof among thunderheads, lightning frozen mid-strike",
    voice: {
      designPrompt: "a clear soprano with a choir echo, serene until it cracks into static, English",
      lines: {
        intro: "I have forgotten the words. So I will sing you the storm instead.",
        phase: "Hear it? The sky is learning my name.",
        taunt: ["Kneel. It shortens the fall.", "The light is not for you.", "Every bolt is a verse."],
        playerDeath: ["Amen.", "Sleep now, little heretic."],
        defeat: "Ah... there was the prayer.",
      },
    },
    music: {
      p1Prompt: "soaring choir and glass harmonics over rolling thunder and marching snares, 110 bpm, celestial boss battle loop, instrumental",
      p2Prompt: "the same choir shredded by electric storms and double-time snares, 160 bpm, instrumental",
      bpm: 110,
    },
    art: {
      styleAnchor: "ink wash illustration with acid-green lightning rim light on a pure black void, single accent color #c8ff4a, high contrast, no text",
      accentHex: "#c8ff4a",
      skyPrompt: "equirectangular panorama of a cathedral roof floating in thunderclouds, green lightning forks frozen in place, ink wash style",
      portraitPrompt: "half-body portrait of a six-winged saint with a blank mask, wings of lightning, halo cracked and buzzing green",
    },
    grudges: [],
  },
  {
    version: 1,
    code: "VESSEL-05",
    lineage: { gen: 1, kills: 0 },
    identity: {
      name: "Ulthwaine",
      title: "The Coil Beneath the Floor",
      incantation: "a serpent that swallowed the dark and now speaks with a hundred stolen mouths",
      silhouette: "serpent",
      element: "void",
      temper: "hunger",
      palette: ["#06030c", "#a86bff", "#1c1030"],
    },
    stats: { maxHp: 950, poise: 55, aggression: 0.5 },
    phases: [
      {
        hpThreshold: 1,
        rule: "none",
        moves: [
          { type: "zone", telegraphMs: 1300, damage: 14, scale: 1.3, count: 3 },
          { type: "sweep", telegraphMs: 1000, damage: 22, scale: 1.3, count: 1 },
          { type: "ring", telegraphMs: 1400, damage: 18, scale: 1.1, count: 1 },
        ],
      },
      {
        hpThreshold: 0.5,
        rule: "pillars",
        moves: [
          { type: "zone", telegraphMs: 1100, damage: 16, scale: 1.4, count: 5 },
          { type: "sweep", telegraphMs: 850, damage: 26, scale: 1.4, count: 1, followUp: "thrust" },
          { type: "thrust", telegraphMs: 750, damage: 22, scale: 1.2, count: 1 },
          { type: "ring", telegraphMs: 1200, damage: 22, scale: 1.3, count: 2 },
        ],
      },
    ],
    weakness: { trigger: "heavy_hit", multiplier: 1.75 },
    arenaTheme: "a black marble floor over an abyss, violet cracks where the serpent has passed beneath",
    voice: {
      designPrompt: "many overlapping whispers braided into one sibilant voice, slow and intimate, English",
      lines: {
        intro: "We have so many mouths now. Which one would you like to be?",
        phase: "The floor is thinner than you think.",
        taunt: ["Ssstay. We insist.", "We know that step.", "The dark is patient. We are not."],
        playerDeath: ["Swallowed.", "One more voice for the choir."],
        defeat: "Quiet... at lassst...",
      },
    },
    music: {
      p1Prompt: "low drone and slithering percussion with detuned bells, 84 bpm, abyssal boss battle loop, instrumental",
      p2Prompt: "the same drone thickened with polyrhythmic tribal drums and screaming reversed choir, 126 bpm, instrumental",
      bpm: 84,
    },
    art: {
      styleAnchor: "ink wash illustration with violet rim light on a pure black void, single accent color #a86bff, high contrast, no text",
      accentHex: "#a86bff",
      skyPrompt: "equirectangular panorama of an endless black marble hall, violet light seeping through fractured floor, ink wash style",
      portraitPrompt: "half-body portrait of a vast serpent with a hood of screaming faces, scales like obsidian, eyes glowing violet",
    },
    grudges: [],
  },
  {
    version: 1,
    code: "VESSEL-06",
    lineage: { gen: 1, kills: 0 },
    identity: {
      name: "The Ten Thousand Teeth",
      title: "The Wolf of Every Lie",
      incantation: "a wolf made of every lie I told, scattered into a thousand hungry pieces",
      silhouette: "swarm",
      element: "ice",
      temper: "rage",
      palette: ["#03070c", "#7fdcff", "#101a2c"],
    },
    stats: { maxHp: 650, poise: 25, aggression: 0.7 },
    phases: [
      {
        hpThreshold: 1,
        rule: "none",
        moves: [
          { type: "volley", telegraphMs: 800, damage: 8, scale: 0.8, count: 6 },
          { type: "blink", telegraphMs: 600, damage: 5, scale: 1, count: 1, followUp: "volley" },
          { type: "zone", telegraphMs: 1200, damage: 12, scale: 1, count: 4 },
        ],
      },
      {
        hpThreshold: 0.5,
        rule: "rift_beat",
        moves: [
          { type: "volley", telegraphMs: 650, damage: 10, scale: 0.9, count: 9 },
          { type: "blink", telegraphMs: 500, damage: 5, scale: 1, count: 1, followUp: "nova" },
          { type: "nova", telegraphMs: 1000, damage: 24, scale: 1.2, count: 1 },
          { type: "zone", telegraphMs: 1000, damage: 14, scale: 1.1, count: 6 },
        ],
      },
    ],
    weakness: { trigger: "after_blink", multiplier: 2.5 },
    arenaTheme: "a frozen lake at night, the ice full of small moving shadows",
    voice: {
      designPrompt: "dozens of thin, chittering voices speaking slightly out of sync, quick and cruel, English",
      lines: {
        intro: "Every lie you told grew teeth. We are here to give them back.",
        phase: "More of us. Always more of us.",
        taunt: ["Which one is real? None of us.", "You told that one twice.", "We remember all of them."],
        playerDeath: ["Honest at last.", "Scatter. Scatter. Scatter."],
        defeat: "One truth... and we come apart...",
      },
    },
    music: {
      p1Prompt: "skittering glitch percussion and icy plucked strings, 132 bpm, swarming boss battle loop, instrumental",
      p2Prompt: "the same pluck motif multiplied into a wall of stuttering synths and breakbeats, 165 bpm, instrumental",
      bpm: 132,
    },
    art: {
      styleAnchor: "ink wash illustration with pale cyan rim light on a pure black void, single accent color #7fdcff, high contrast, no text",
      accentHex: "#7fdcff",
      skyPrompt: "equirectangular panorama of a frozen lake under aurora, thousands of small dark shapes beneath the ice, ink wash style",
      portraitPrompt: "half-body portrait of a wolf made of hundreds of small shards and teeth, barely holding a shape, eyes glowing cyan",
    },
    grudges: [],
  },
];

export const getFallbackSpec = (index = 0): NemesisSpec => {
  const spec = FALLBACK_SPECS[index % FALLBACK_SPECS.length];
  if (!spec) throw new Error("no fallback specs bundled");
  return structuredClone(spec);
};

export const getFallbackSpecByCode = (code: string): NemesisSpec | null => {
  const spec = FALLBACK_SPECS.find((s) => s.code === code);
  return spec ? structuredClone(spec) : null;
};
