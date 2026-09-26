export const TICK_MS = 1000 / 60;
export const ARENA_RADIUS = 27;
export const PLAYER_EDGE_MARGIN = 0.8;

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
  walkSpeed: 2.6,
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
