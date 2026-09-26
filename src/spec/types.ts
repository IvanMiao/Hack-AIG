export const SILHOUETTES = ["colossus", "hound", "seraph", "serpent", "knight", "swarm"] as const;
export type Silhouette = (typeof SILHOUETTES)[number];

export const ELEMENTS = ["fire", "ice", "void", "blood", "storm"] as const;
export type Element = (typeof ELEMENTS)[number];

export const TEMPERS = ["grief", "rage", "hunger", "pride"] as const;
export type Temper = (typeof TEMPERS)[number];

export const MOVE_TYPES = ["sweep", "thrust", "charge", "nova", "ring", "volley", "zone", "blink"] as const;
export type MoveType = (typeof MOVE_TYPES)[number];

/** `flatline` collapses the fight onto one axis with a jump (the 2D phase); it is reserved for bound nightmares. */
export const PHASE_RULES = ["none", "closing_ring", "pillars", "rift_beat", "flatline"] as const;
export type PhaseRule = (typeof PHASE_RULES)[number];

export const WEAKNESS_TRIGGERS = ["after_blink", "after_charge", "heavy_hit", "parry"] as const;
export type WeaknessTrigger = (typeof WEAKNESS_TRIGGERS)[number];

export interface Move {
  type: MoveType;
  telegraphMs: number;
  damage: number;
  scale: number;
  count: number;
  followUp?: MoveType;
}

export interface Phase {
  hpThreshold: number;
  moves: Move[];
  rule: PhaseRule;
}

export interface Identity {
  name: string;
  title: string;
  incantation: string;
  silhouette: Silhouette;
  element: Element;
  temper: Temper;
  palette: [string, string, string];
}

export interface Stats {
  maxHp: number;
  poise: number;
  aggression: number;
}

export interface Weakness {
  trigger: WeaknessTrigger;
  multiplier: number;
}

export interface VoiceLines {
  intro: string;
  phase: string;
  taunt: string[];
  playerDeath: string[];
  defeat: string;
}

export interface Voice {
  designPrompt: string;
  voiceId?: string;
  lines: VoiceLines;
  audio?: Partial<Record<string, string>>;
}

export interface Music {
  p1Prompt: string;
  p2Prompt: string;
  bpm: number;
  p1Url?: string;
  p2Url?: string;
}

export interface Art {
  styleAnchor: string;
  accentHex: string;
  skyPrompt: string;
  portraitPrompt: string;
  skyUrl?: string;
  portraitUrl?: string;
  impactFrameUrls?: string[];
  faceTextureUrl?: string;
  splatterSheetUrl?: string;
}

export interface Grudge {
  observation: string;
  patch: string;
}

/** What Gemini is asked to produce. No ids, urls or lineage — those are stamped server-side. */
export interface ForgeDraft {
  identity: Identity;
  stats: Stats;
  phases: Phase[];
  weakness: Weakness;
  arenaTheme: string;
  voice: { designPrompt: string; lines: VoiceLines };
  music: { p1Prompt: string; p2Prompt: string; bpm: number };
  art: { styleAnchor: string; accentHex: string; skyPrompt: string; portraitPrompt: string };
}

export interface NemesisSpec {
  version: 1;
  code: string;
  lineage: { gen: number; kills: number };
  identity: Identity;
  stats: Stats;
  phases: Phase[];
  weakness: Weakness;
  arenaTheme: string;
  voice: Voice;
  music: Music;
  art: Art;
  grudges: Grudge[];
}
