export const TICK_MS = 1000 / 60;
export const ARENA_RADIUS = 27;
/** Visible stone extends past the playable disc so boss bodies and strike lunges at the clamp stay over the floor. */
export const ARENA_FLOOR_RADIUS = ARENA_RADIUS + 2;
export const PLAYER_EDGE_MARGIN = 0.8;
export const BOSS_EDGE_MARGIN = 1.6;

export interface AttackSpec {
  windupMs: number;
  activeMs: number;
  recoverMs: number;
  damage: number;
  poise: number;
  range: number;
  stamina: number;
  /** forward step taken during the active window (world units) */
  lunge: number;
}

const LIGHT_1: AttackSpec = { windupMs: 140, activeMs: 100, recoverMs: 240, damage: 22, poise: 12, range: 2.4, stamina: 14, lunge: 0.25 };
const LIGHT_2: AttackSpec = { windupMs: 110, activeMs: 100, recoverMs: 220, damage: 20, poise: 12, range: 2.4, stamina: 12, lunge: 0.3 };
const LIGHT_3: AttackSpec = { windupMs: 190, activeMs: 120, recoverMs: 400, damage: 34, poise: 24, range: 2.7, stamina: 16, lunge: 0.7 };

export const PLAYER = {
  maxHp: 100,
  maxStamina: 100,
  speed: 6,
  radius: 0.45,
  staminaRegenPerSec: 32,
  staminaRegenDelayMs: 450,
  /** A press inside this window before an action can be acted on is queued instead of dropped. */
  bufferMs: 300,
  roll: {
    durationMs: 400,
    iframeMs: 280,
    distance: 4.2,
    stamina: 22,
    /** An attack may interrupt the roll from here on (roll-attack). */
    cancelMs: 260,
  },
  /** A roll that dodges a hit within this many ms of starting is perfect: stamina refund + slow-mo beat. */
  perfectRoll: { windowMs: 140, staminaRefund: 22 },
  light: LIGHT_1,
  /** Three-hit string; the third is a lunging finisher with more poise damage and a longer recovery. */
  combo: [LIGHT_1, LIGHT_2, LIGHT_3] as readonly AttackSpec[],
  /** ms after a light string ends before the next light restarts at hit 1 */
  comboResetMs: 650,
  heavy: { windupMs: 460, activeMs: 120, recoverMs: 480, damage: 52, poise: 40, range: 2.8, stamina: 34, lunge: 0.5 } as AttackSpec,
  /** Holding heavy past the windup charges it: damage/poise scale up to these multipliers at full charge. */
  charge: { maxMs: 700, damageMul: 1.6, poiseMul: 1.75, lungeMul: 1.8 },
  /** Fractions of the recover window after which a follow-up is accepted. Roll cancels a light recover at once. */
  cancel: { lightIntoLight: 0.35, lightIntoHeavy: 0.5, heavyIntoRoll: 0.45, lightIntoRoll: 0 },
  /** Taking a hit: brief invulnerability so a salvo lands once, a stun that drops the current action, a shove away from the source. */
  hurt: { invulnMs: 450, stunMs: 160, knockback: 1.2, knockbackMs: 140 },
} as const;

export const BOSS = {
  radius: 1.1,
  walkSpeed: 3.4,
  meleeRange: 3.2,
  /** Beyond this the boss favours gap-closers and ranged tools. */
  midRange: 8,
  staggerMs: 1400,
  phaseChangeInvulnMs: 1600,
  weaknessWindowMs: 1800,
  followUpTelegraphScale: 0.6,
  tauntEveryMs: 9000,
  /** Grace before the very first move so the player can read the arena after the intro card. */
  openingIdleMs: 3000,
  /** idle gap between moves, lerped by aggression: 0.1 → slow, 1 → relentless */
  idleMs: { slow: 1500, fast: 350 },
  /** Rolls within this window count as panic rolling; from `panicRolls` the boss delays its commit to catch the roll's tail. */
  panic: { windowMs: 4000, rolls: 3, telegraphScale: 1.35 },
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
