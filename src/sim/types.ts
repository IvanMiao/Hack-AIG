import type { Move, MoveType } from "../spec";

export interface Vec2 { x: number; z: number }

export type PlayerAction = "idle" | "light" | "heavy" | "roll";

export interface PlayerInput {
  move: Vec2;
  light: boolean;
  heavy: boolean;
  roll: boolean;
}

export interface PlayerState {
  pos: Vec2;
  facing: Vec2;
  hp: number;
  stamina: number;
  action: PlayerAction;
  /** ms elapsed inside the current action */
  actionT: number;
  rollDir: Vec2;
  /** the current attack has already connected (one hit per swing) */
  attackLanded: boolean;
  staminaRegenDelay: number;
  hitFlash: number;
}

export type MovePhase = "telegraph" | "active" | "recover";

export interface BossMove {
  move: Move;
  phase: MovePhase;
  t: number;
  /** where the boss was aiming when the telegraph started (moves commit to this) */
  aim: Vec2;
  /** charge/blink travel vector for the active window */
  travel: Vec2;
  /** shortened telegraph for follow-ups */
  telegraphMs: number;
  spawned: boolean;
}

export interface BossState {
  pos: Vec2;
  facing: Vec2;
  hp: number;
  poiseDamage: number;
  phaseIndex: number;
  current: BossMove | null;
  idleT: number;
  idleFor: number;
  staggerT: number;
  invulnerableT: number;
  weaknessT: number;
  lastMoveType: MoveType | null;
  hitFlash: number;
}

export type HazardShape =
  | { kind: "arc"; center: Vec2; radius: number; dir: Vec2; halfAngle: number }
  | { kind: "circle"; center: Vec2; radius: number }
  | { kind: "line"; start: Vec2; dir: Vec2; length: number; halfWidth: number }
  | { kind: "ring"; center: Vec2; radius: number; thickness: number; growth: number; maxRadius: number };

export interface Hazard {
  id: number;
  source: MoveType;
  shape: HazardShape;
  damage: number;
  /** ms remaining. 0 → removed. */
  ttl: number;
  /** ms until this hazard may hurt the player again (zones tick) */
  cooldown: number;
  repeat: boolean;
  hit: boolean;
}

export interface Projectile {
  id: number;
  pos: Vec2;
  vel: Vec2;
  radius: number;
  damage: number;
}

export type BattleEvent =
  | { type: "telegraph"; move: MoveType; ms: number }
  | { type: "moveActive"; move: MoveType }
  | { type: "playerHit"; move: MoveType; damage: number; hp: number }
  | { type: "playerRoll"; dodged: boolean }
  | { type: "bossHit"; damage: number; heavy: boolean; weakness: boolean; hp: number }
  | { type: "bossStagger" }
  | { type: "weaknessOpen"; ms: number }
  | { type: "phaseChange"; phaseIndex: number }
  | { type: "arenaShrink"; from: number; to: number; ms: number }
  | { type: "obstaclesRaised"; ids: number[] }
  | { type: "obstacleHit"; id: number; hpLeft: number; by: HazardSource }
  | { type: "obstacleBroken"; id: number; pos: Vec2; by: HazardSource }
  | { type: "taunt"; index: number }
  | { type: "playerDeath"; lineIndex: number }
  | { type: "bossDefeat" };

export type Outcome = "fighting" | "playerDead" | "bossDead";

/** Everything GRUDGE needs later: how the player moved, what killed them, how they attacked. */
export interface DeathLog {
  durationMs: number;
  rolls: { left: number; right: number; toward: number; away: number };
  rollsDodged: number;
  hitsTaken: Partial<Record<MoveType, number>>;
  lightAttacks: number;
  heavyAttacks: number;
  attacksDuringTelegraph: number;
  attacksDuringRecover: number;
  weaknessHits: number;
  killedBy: MoveType | null;
  phaseReached: number;
  bossHpFractionAtDeath: number;
}

/** What dealt damage: a boss move, or the arena itself (collapsing rim, element hazards). */
export type HazardSource = MoveType | "arena";

/** Breakable cover: a solid disc both fighters slide around; blocks projectiles, chipped by boss strikes. */
export interface Obstacle {
  id: number;
  pos: Vec2;
  radius: number;
  hp: number;
  /** ms since it rose; solid only once past the rise */
  age: number;
}

/** Runtime arena: the playable disc can shrink mid-fight; visuals read `radius`, clamps read it every tick. */
export interface ArenaState {
  radius: number;
  targetRadius: number;
  shrinkFrom: number;
  /** ms elapsed in the current shrink; equals `shrinkMs` once settled */
  shrinkT: number;
  shrinkMs: number;
  obstacles: Obstacle[];
}

export interface BattleState {
  seed: number;
  arena: ArenaState;
  timeMs: number;
  outcome: Outcome;
  player: PlayerState;
  boss: BossState;
  hazards: Hazard[];
  projectiles: Projectile[];
  nextId: number;
  log: DeathLog;
  tauntT: number;
}
