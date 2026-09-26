export const TICK_MS = 1000 / 60;
export const ARENA_RADIUS = 27;
/** Visible stone extends past the playable disc so boss bodies and strike lunges at the clamp stay over the floor. */
export const ARENA_FLOOR_RADIUS = ARENA_RADIUS + 2;
export const PLAYER_EDGE_MARGIN = 0.8;
export const BOSS_EDGE_MARGIN = 1.6;
/** `closing_ring` phase rule: each ringed phase multiplies the playable radius, eased over `shrinkMs`. */
export const ARENA_SHRINK = {
  factor: 0.7,
  minRadius: ARENA_RADIUS * 0.5,
  shrinkMs: 4000,
} as const;
/** Element mutators. Every arena hazard telegraphs for `armMs` before it can hurt; zone-style ones tick at MOVE.zone rates. */
export const ARENA_MUTATOR = {
  /** fire: vents of magma open at random spots (never under the player) and burn for a while */
  ember: { periodMs: 6500, count: 3, radius: 2.2, armMs: 1200, ttlMs: 3600, damage: 12, safeRadius: 3.5, spread: 0.7 },
  /** storm: a slow wind drags the player; lightning targets where they stand */
  tempest: { windSpeed: 1.1, turnMs: 5000, boltPeriodMs: 7000, boltRadius: 2.4, boltArmMs: 1100, boltDamage: 14 },
  /** blood: every wound leaves a pool that punishes standing in it */
  bloodtide: { poolRadius: 1.6, armMs: 900, ttlMs: 6000, damage: 8 },
} as const;
/** `pillars` phase rule: breakable cover raised around the fighters. Only boss strikes chip them; projectiles are blocked. */
export const ARENA_PILLARS = {
  count: 4,
  radius: 1.0,
  hp: 2,
  /** distance from the player/boss midpoint at which the ring of pillars rises */
  ring: 5.5,
  riseMs: 900,
  damage: { charge: 2, sweep: 1, thrust: 1, nova: 1 },
} as const;

export const PLAYER = {
  maxHp: 100,
  maxStamina: 100,
  speed: 6,
  radius: 0.45,
  staminaRegenPerSec: 32,
  staminaRegenDelayMs: 450,
  roll: { durationMs: 400, iframeMs: 360, distance: 4.2, stamina: 22 },
  light: { windupMs: 140, activeMs: 100, recoverMs: 240, damage: 22, poise: 12, range: 2.4, stamina: 14 },
  heavy: { windupMs: 460, activeMs: 120, recoverMs: 480, damage: 52, poise: 40, range: 2.8, stamina: 34 },
} as const;

export const BOSS = {
  radius: 1.1,
  walkSpeed: 3.4,
  meleeRange: 3.2,
  staggerMs: 1400,
  phaseChangeInvulnMs: 1600,
  weaknessWindowMs: 1800,
  followUpTelegraphScale: 0.6,
  tauntEveryMs: 9000,
  /** Grace before the very first move so the player can read the arena after the intro card. */
  openingIdleMs: 3000,
  /** idle gap between moves, lerped by aggression: 0.1 → slow, 1 → relentless */
  idleMs: { slow: 1500, fast: 350 },
} as const;

export const MOVE = {
  sweep: { activeMs: 260, recoverMs: 700, radius: 3.6, halfAngle: Math.PI / 2 },
  thrust: { activeMs: 200, recoverMs: 650, length: 6.5, halfWidth: 0.9 },
  charge: { activeMs: 520, recoverMs: 900, speed: 16, hitRadius: 1.6 },
  nova: { activeMs: 260, recoverMs: 900, radius: 4.0 },
  ring: { recoverMs: 800, thickness: 1.0, growth: 9, startRadius: 1.4, waveGapMs: 420 },
  volley: { recoverMs: 700, speed: 11, radius: 0.5, spread: 0.55 },
  zone: { recoverMs: 600, radius: 1.9, ttlMs: 3600, tickMs: 900, tickFraction: 0.5, scatter: 3.2 },
  blink: { activeMs: 120, recoverMs: 350, distanceBehind: 2.4 },
} as const;
