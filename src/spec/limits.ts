/** Hard bounds every spec is clamped into. Fairness invariants live in invariants.ts. */
export const LIMITS = {
  maxHp: { min: 300, max: 1500 },
  poise: { min: 0, max: 100 },
  aggression: { min: 0.1, max: 1 },
  telegraphMs: { min: 500, max: 2500 },
  damageFractionOfHp: { max: 0.35 },
  damage: { min: 5, max: 80 },
  scale: { min: 0.5, max: 2 },
  count: { min: 1, max: 12 },
  movesPerPhase: { min: 3, max: 6 },
  phases: { min: 1, max: 3 },
  weaknessMultiplier: { min: 1.25, max: 3 },
  bpm: { min: 60, max: 200 },
  taunts: { min: 1, max: 4 },
  playerDeathLines: { min: 1, max: 3 },
  lineLength: { max: 160 },
  nameLength: { max: 40 },
  incantationLength: { max: 280 },
} as const;

export const PLAYER_MAX_HP = 100;

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));
