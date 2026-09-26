import type { Move, MoveType } from "../spec";

export interface Vec2 { x: number; z: number }

export type PlayerAction = "idle" | "light" | "heavy" | "roll" | "hurt";

export type PlayerCommand = "light" | "heavy" | "roll";

export interface PlayerInput {
  move: Vec2;
  /** edge-triggered: true on the tick the key went down */
  light: boolean;
  heavy: boolean;
  roll: boolean;
  /** flatline phases only; ignored while the arena is 3D */
  jump: boolean;
  /** level-triggered: heavy is still held (charges the heavy past its windup) */
  heavyHeld?: boolean;
}

export interface BufferedCommand {
  kind: PlayerCommand;
  /** stick direction at the time of the press (rolls use it) */
  move: Vec2;
  /** ms since the press */
  age: number;
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
  /** which hit of the light string the current/next light is (0-based) */
  comboIndex: number;
  /** ms since the last light hit finished; past PLAYER.comboResetMs the string restarts */
  comboIdleT: number;
  /** 0..1 charge of the heavy being wound up; frozen at release */
  charge: number;
  /** heavy is parked at the end of its windup while the button is held */
  charging: boolean;
  buffered: BufferedCommand | null;
  /** ms of post-hit invulnerability remaining */
  hurtT: number;
  knockDir: Vec2;
  knockT: number;
  /** the current roll already produced its perfect dodge */
  rollPerfect: boolean;
  /** sim times of recent rolls (the boss reads these to punish panic rolling) */
  recentRolls: number[];
  /** height of the feet above the floor; always 0 outside flatline phases */
  y: number;
  vy: number;
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
  /** how many moves have been chosen so far this fight */
  movesChosen: number;
}

export type HazardShape =
  | { kind: "arc"; center: Vec2; radius: number; dir: Vec2; halfAngle: number }
  | { kind: "circle"; center: Vec2; radius: number }
  | { kind: "line"; start: Vec2; dir: Vec2; length: number; halfWidth: number }
  | { kind: "ring"; center: Vec2; radius: number; thickness: number; growth: number; maxRadius: number };

export interface Hazard {
  id: number;
  source: HazardSource;
  shape: HazardShape;
  damage: number;
  /** ms remaining. 0 → removed. */
  ttl: number;
  /** ms until this hazard may hurt the player again (zones tick) */
  cooldown: number;
  repeat: boolean;
  hit: boolean;
  /** telegraph length for hazards that arm after spawning (arena pulses); 0 for boss strikes */
  armMs: number;
  /** ms until armed; harmless while > 0 */
  armT: number;
}

export interface Projectile {
  id: number;
  pos: Vec2;
  vel: Vec2;
  /** height of the shot; only tested against the player in flatline phases */
  y: number;
  radius: number;
  damage: number;
}

export type BattleEvent =
  | { type: "telegraph"; move: MoveType; ms: number }
  | { type: "moveActive"; move: MoveType }
  | { type: "playerHit"; move: HazardSource; damage: number; hp: number; dir: Vec2 }
  | { type: "playerRoll"; dodged: boolean; perfect: boolean }
  | { type: "playerAttack"; kind: "light" | "heavy"; combo: number; charge: number }
  | { type: "bossHit"; damage: number; heavy: boolean; weakness: boolean; hp: number; combo: number; charge: number }
  | { type: "bossStagger" }
  | { type: "weaknessOpen"; ms: number }
  | { type: "phaseChange"; phaseIndex: number }
  | { type: "arenaShrink"; from: number; to: number; ms: number }
  | { type: "arenaPulse"; mutator: ArenaMutator; at: Vec2 }
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
  hitsTaken: Partial<Record<HazardSource, number>>;
  lightAttacks: number;
  heavyAttacks: number;
  attacksDuringTelegraph: number;
  attacksDuringRecover: number;
  weaknessHits: number;
  killedBy: HazardSource | null;
  phaseReached: number;
  bossHpFractionAtDeath: number;
}

/** What dealt damage: a boss move, or the arena itself (collapsing rim, element hazards). */
export type HazardSource = MoveType | "arena";

/** Element-driven arena behaviour, derived from `identity.element`: the boss brings its own weather. */
export const ARENA_MUTATORS = ["none", "ember", "tempest", "bloodtide"] as const;
export type ArenaMutator = (typeof ARENA_MUTATORS)[number];

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
  mutator: ArenaMutator;
  /** ms until the mutator's next pulse */
  mutatorT: number;
  /** tempest: constant push on the player, units/s */
  wind: Vec2;
}

export interface BattleState {
  seed: number;
  arena: ArenaState;
  timeMs: number;
  outcome: Outcome;
  /** the arena has collapsed onto the x axis (a `flatline` phase was reached) */
  flat: boolean;
  player: PlayerState;
  boss: BossState;
  hazards: Hazard[];
  projectiles: Projectile[];
  nextId: number;
  log: DeathLog;
  tauntT: number;
}
