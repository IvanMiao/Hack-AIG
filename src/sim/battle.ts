import type { Move, MoveType, NemesisSpec, Phase, PhaseRule } from "../spec";
import { ARENA_PILLARS, ARENA_RADIUS, ARENA_SHRINK, BOSS, BOSS_EDGE_MARGIN, FLAT, MOVE, PLAYER, PLAYER_EDGE_MARGIN, TICK_MS } from "./constants";
import { advanceHazard, overlaps } from "./hazard";
import { createRng, type Rng } from "./rng";
import type { AttackSpec } from "./constants";
import type { ArenaState, BattleEvent, BattleState, BossMove, BossState, DeathLog, Hazard, HazardShape, HazardSource, Obstacle, PlayerCommand, PlayerInput, PlayerState, Projectile, Vec2 } from "./types";
import { add, clampToDisc, dist, dot, len, norm, perp, rotate, scale, sub, vec } from "./vec";
import { initialMutatorT, initialWind, mutatorForElement, onPlayerWounded, stepMutator } from "./arena";

/** Lab-only switches. All default off; the shipped game never touches them. */
export interface BattleDebug {
  /** false → the boss never starts a move on its own (forced moves still work). */
  bossAi: boolean;
  /** true → hazards and projectiles still resolve but the player takes no damage. */
  playerInvulnerable: boolean;
  /** Start `type` immediately (idle boss only). Returns false if the boss is busy or the move is not in any phase. */
  forceMove(type: MoveType, template?: Partial<Move>): boolean;
  /** Apply an arena rule now, as if the current phase had just begun with it. */
  forceRule(rule: PhaseRule): void;
}

export interface Battle {
  readonly spec: NemesisSpec;
  readonly state: BattleState;
  readonly debug: BattleDebug;
  /** Advance one fixed tick. Returns the events that happened during it. */
  step(input: PlayerInput): BattleEvent[];
}

export const IDLE_INPUT: PlayerInput = { move: vec(), light: false, heavy: false, roll: false, jump: false };

const emptyLog = (): DeathLog => ({
  durationMs: 0,
  rolls: { left: 0, right: 0, toward: 0, away: 0 },
  rollsDodged: 0,
  hitsTaken: {},
  lightAttacks: 0,
  heavyAttacks: 0,
  attacksDuringTelegraph: 0,
  attacksDuringRecover: 0,
  weaknessHits: 0,
  killedBy: null,
  phaseReached: 0,
  bossHpFractionAtDeath: 1,
});

export function createInitialState(spec: NemesisSpec, seed: number): BattleState {
  const mutator = mutatorForElement(spec.identity.element);
  const arena: ArenaState = {
    radius: ARENA_RADIUS, targetRadius: ARENA_RADIUS, shrinkFrom: ARENA_RADIUS, shrinkT: 0, shrinkMs: 0, obstacles: [],
    mutator, mutatorT: initialMutatorT(mutator), wind: initialWind(mutator, createRng(seed ^ 0x5bd1e995)),
  };
  const state: BattleState = {
    seed,
    arena,
    timeMs: 0,
    outcome: "fighting",
    flat: spec.phases[0]?.rule === "flatline",
    player: {
      pos: vec(0, 5), facing: vec(0, -1), hp: PLAYER.maxHp, stamina: PLAYER.maxStamina,
      action: "idle", actionT: 0, rollDir: vec(0, -1), attackLanded: false, staminaRegenDelay: 0, hitFlash: 0, y: 0, vy: 0,
      comboIndex: 0, comboIdleT: PLAYER.comboResetMs, charge: 0, charging: false, buffered: null,
      hurtT: 0, knockDir: vec(0, 1), knockT: 0, rollPerfect: false, recentRolls: [],
    },
    boss: {
      pos: vec(0, -4), facing: vec(0, 1), hp: spec.stats.maxHp, poiseDamage: 0, phaseIndex: 0, current: null,
      idleT: 0, idleFor: BOSS.openingIdleMs, staggerT: 0, invulnerableT: 0, weaknessT: 0, lastMoveType: null, hitFlash: 0,
      movesChosen: 0,
    },
    hazards: [],
    projectiles: [],
    nextId: 1,
    log: emptyLog(),
    tauntT: BOSS.tauntEveryMs * 0.6,
  };
  const opening = spec.phases[0];
  if (opening) applyPhaseRule(state, opening, null);
  return state;
}

/**
 * Arena side of a phase rule. `closing_ring` shrinks the disc; with `events` the shrink eases in over
 * `ARENA_SHRINK.shrinkMs` and is announced, without (opening phase) it applies instantly.
 * `pillars` raises a ring of breakable cover around the fighters, replacing any cover still standing.
 */
export function applyPhaseRule(state: BattleState, phase: Phase, events: BattleEvent[] | null): void {
  const arena = state.arena;
  if (phase.rule === "flatline") {
    // Cover from an earlier phase has no place on the lane: it shatters as the arena folds.
    for (const o of arena.obstacles) events?.push({ type: "obstacleBroken", id: o.id, pos: o.pos, by: "arena" });
    arena.obstacles = [];
    return;
  }
  if (phase.rule === "pillars") {
    const centre = scale(add(state.player.pos, state.boss.pos), 0.5);
    const axis = norm(sub(state.player.pos, state.boss.pos));
    const limit = arena.targetRadius - PLAYER_EDGE_MARGIN - ARENA_PILLARS.radius - 0.5;
    const ids: number[] = [];
    arena.obstacles = [];
    for (let i = 0; i < ARENA_PILLARS.count; i += 1) {
      // Offset by half a step so no pillar sits on the line between the fighters at the moment it rises.
      const dir = rotate(axis, (Math.PI * 2 * (i + 0.5)) / ARENA_PILLARS.count);
      let pos = clampToDisc(add(centre, dir, ARENA_PILLARS.ring), limit);
      for (const body of [state.player.pos, state.boss.pos]) {
        const gap = ARENA_PILLARS.radius + BOSS.radius + 0.4;
        if (dist(pos, body) < gap) pos = clampToDisc(add(body, norm(sub(pos, body), dir), gap), limit);
      }
      const obstacle: Obstacle = { id: state.nextId++, pos, radius: ARENA_PILLARS.radius, hp: ARENA_PILLARS.hp, age: events ? 0 : ARENA_PILLARS.riseMs };
      arena.obstacles.push(obstacle);
      ids.push(obstacle.id);
    }
    events?.push({ type: "obstaclesRaised", ids });
    return;
  }
  if (phase.rule !== "closing_ring") return;
  const to = Math.max(ARENA_SHRINK.minRadius, arena.targetRadius * ARENA_SHRINK.factor);
  if (to >= arena.targetRadius - 1e-6) return;
  arena.shrinkFrom = arena.radius;
  arena.targetRadius = to;
  if (!events) {
    arena.radius = to;
    arena.shrinkT = arena.shrinkMs = 0;
    return;
  }
  arena.shrinkT = 0;
  arena.shrinkMs = ARENA_SHRINK.shrinkMs;
  events.push({ type: "arenaShrink", from: arena.shrinkFrom, to, ms: arena.shrinkMs });
}

const solid = (o: Obstacle) => o.age >= ARENA_PILLARS.riseMs;

/** Push a body of `radius` out of every standing pillar. Purely positional, so a chaser slides around cover. */
export function separateFromObstacles(pos: Vec2, radius: number, obstacles: readonly Obstacle[]): Vec2 {
  let out = pos;
  for (const o of obstacles) {
    if (!solid(o)) continue;
    const gap = o.radius + radius;
    const d = dist(out, o.pos);
    if (d >= gap) continue;
    out = add(o.pos, norm(sub(out, o.pos), { x: 0, z: 1 }), gap);
  }
  return out;
}

/** True when the segment a→b passes through a standing pillar (used by projectiles and the bot's cover check). */
export function blockedByObstacle(a: Vec2, b: Vec2, obstacles: readonly Obstacle[], pad = 0): Obstacle | null {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  for (const o of obstacles) {
    if (!solid(o)) continue;
    const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, dot(sub(o.pos, a), ab) / l2));
    if (dist(add(a, ab, t), o.pos) <= o.radius + pad) return o;
  }
  return null;
}

const stepArena = (state: BattleState, events: BattleEvent[]) => {
  const arena = state.arena;
  for (const o of arena.obstacles) o.age = Math.min(ARENA_PILLARS.riseMs, o.age + TICK_MS);
  if (arena.shrinkT >= arena.shrinkMs) return;
  arena.shrinkT = Math.min(arena.shrinkMs, arena.shrinkT + TICK_MS);
  const u = arena.shrinkT / arena.shrinkMs;
  const ease = u * u * (3 - 2 * u);
  arena.radius = arena.shrinkFrom + (arena.targetRadius - arena.shrinkFrom) * ease;
  // Cover standing on the collapsing rim goes down with it.
  const keep: Obstacle[] = [];
  for (const o of arena.obstacles) {
    if (len(o.pos) + o.radius > arena.radius - PLAYER_EDGE_MARGIN) events.push({ type: "obstacleBroken", id: o.id, pos: o.pos, by: "arena" });
    else keep.push(o);
  }
  arena.obstacles = keep;
};

const idleGap = (aggression: number) => BOSS.idleMs.slow + (BOSS.idleMs.fast - BOSS.idleMs.slow) * aggression;

const currentPhase = (spec: NemesisSpec, boss: BossState): Phase => {
  const phase = spec.phases[boss.phaseIndex] ?? spec.phases[0];
  if (!phase) throw new Error("spec has no phases");
  return phase;
};

const isMelee = (type: MoveType) => type === "sweep" || type === "thrust" || type === "nova";

/** Moves the boss is allowed to open with: close, readable, single-commit. */
const OPENING_MOVES: readonly MoveType[] = ["sweep", "thrust", "nova"];

export type RangeBand = "near" | "mid" | "far";

export const rangeBand = (gap: number): RangeBand => (gap <= BOSS.meleeRange ? "near" : gap <= BOSS.midRange ? "mid" : "far");

/** Relative pick weight of each move type per distance band (edge of the boss to the player's centre). */
export const BAND_WEIGHTS: Record<RangeBand, Record<MoveType, number>> = {
  near: { sweep: 3, nova: 2.5, thrust: 1.5, blink: 1, ring: 1.5, charge: 0.25, volley: 0.3, zone: 0.5 },
  mid: { thrust: 3, charge: 3, blink: 2, volley: 1.5, zone: 1.5, ring: 1, sweep: 0.3, nova: 0.3 },
  far: { charge: 3.5, blink: 3, volley: 3, zone: 2, ring: 0.6, thrust: 0.8, sweep: 0.1, nova: 0.1 },
};

/** The player's attack for an action: the combo stage for lights, the heavy otherwise. */
export const attackFor = (p: Pick<PlayerState, "action" | "comboIndex">): AttackSpec =>
  p.action === "heavy" ? PLAYER.heavy : PLAYER.combo[Math.min(p.comboIndex, PLAYER.combo.length - 1)] ?? PLAYER.light;

/** Active/recover windows for a move type; ranged moves have no active window. */
export function moveTiming(type: MoveType): { activeMs: number; recoverMs: number } {
  switch (type) {
    case "sweep": return MOVE.sweep;
    case "thrust": return MOVE.thrust;
    case "charge": return MOVE.charge;
    case "nova": return MOVE.nova;
    case "ring": return { activeMs: 0, recoverMs: MOVE.ring.recoverMs };
    case "volley": return { activeMs: 0, recoverMs: MOVE.volley.recoverMs };
    case "zone": return { activeMs: 0, recoverMs: MOVE.zone.recoverMs };
    case "blink": return MOVE.blink;
  }
}

export function createBattle(spec: NemesisSpec, seed = 1): Battle {
  const state = createInitialState(spec, seed);
  const rng: Rng = createRng(seed);
  /** Arena pulses draw from their own stream so weather never reshuffles the boss's move choices. */
  const arenaRng: Rng = createRng(seed ^ 0x5bd1e995);
  const pendingEvents: BattleEvent[] = [];
  const tickAttack = (attack: AttackSpec) => attack.windupMs + attack.activeMs + attack.recoverMs;
  const bossLimit = () => state.arena.radius - BOSS.radius - BOSS_EDGE_MARGIN;

  const damageObstacle = (o: Obstacle, amount: number, by: HazardSource, events: BattleEvent[]) => {
    o.hp -= amount;
    if (o.hp > 0) {
      events.push({ type: "obstacleHit", id: o.id, hpLeft: o.hp, by });
      return;
    }
    state.arena.obstacles = state.arena.obstacles.filter((x) => x !== o);
    events.push({ type: "obstacleBroken", id: o.id, pos: o.pos, by });
  };

  /** Strike hazards chip every pillar their shape covers the moment they land. */
  const strikeObstacles = (shape: HazardShape, amount: number, by: MoveType, events: BattleEvent[]) => {
    for (const o of [...state.arena.obstacles]) {
      if (solid(o) && overlaps(shape, o.pos, o.radius)) damageObstacle(o, amount, by, events);
    }
  };

  // ---- player -------------------------------------------------------------------------------
  const rollDirectionLabel = (dir: Vec2, toBoss: Vec2): keyof DeathLog["rolls"] => {
    const forward = dot(dir, toBoss);
    const side = dot(dir, perp(toBoss));
    if (Math.abs(forward) >= Math.abs(side)) return forward > 0 ? "toward" : "away";
    return side > 0 ? "left" : "right";
  };

  const startAction = (p: PlayerState, action: PlayerState["action"], cost: number) => {
    p.action = action;
    p.actionT = 0;
    p.attackLanded = false;
    p.charging = false;
    p.charge = 0;
    p.stamina = Math.max(0, p.stamina - cost);
    p.staminaRegenDelay = PLAYER.staminaRegenDelayMs;
  };

  /** Pull a position onto the lane (z = 0) over a few ticks. */
  const snapToLane = (pos: Vec2) => {
    pos.z *= FLAT.laneSnap;
    if (Math.abs(pos.z) < 0.01) pos.z = 0;
  };

  const grounded = (p: PlayerState) => p.y <= 0 && p.vy <= 0;
  /** Airborne enough to clear a ground hazard (flat phases only). */
  const clearsGround = () => state.flat && state.player.y >= FLAT.groundHazardHeight;

  /** Fraction of the current attack's recover window elapsed, or -1 while still winding up / active. */
  const recoverFraction = (p: PlayerState): number => {
    const attack = attackFor(p);
    const recoverT = p.actionT - attack.windupMs - attack.activeMs;
    return recoverT < 0 ? -1 : recoverT / attack.recoverMs;
  };

  /** Whether the current action lets `kind` start right now (idle, or inside a cancel window). */
  const accepts = (p: PlayerState, kind: PlayerCommand): boolean => {
    switch (p.action) {
      case "idle": return true;
      case "hurt": return false;
      case "roll": return kind !== "roll" && p.actionT >= PLAYER.roll.cancelMs;
      case "light": {
        const f = recoverFraction(p);
        if (f < 0) return false;
        if (kind === "roll") return f >= PLAYER.cancel.lightIntoRoll;
        if (kind === "light") return p.comboIndex < PLAYER.combo.length - 1 && f >= PLAYER.cancel.lightIntoLight;
        return f >= PLAYER.cancel.lightIntoHeavy;
      }
      case "heavy": {
        const f = recoverFraction(p);
        return kind === "roll" && f >= PLAYER.cancel.heavyIntoRoll;
      }
    }
  };

  const startCommand = (kind: PlayerCommand, stick: Vec2, nowStick: Vec2, input: PlayerInput, toBoss: Vec2, events: BattleEvent[]) => {
    const p = state.player;
    if (kind === "roll") {
      if (p.stamina < PLAYER.roll.stamina) return;
      const wants = len(stick) > 0.01 ? norm(stick) : len(nowStick) > 0.01 ? norm(nowStick) : scale(toBoss, -1);
      p.rollDir = wants;
      startAction(p, "roll", PLAYER.roll.stamina);
      p.rollPerfect = false;
      p.comboIdleT = PLAYER.comboResetMs;
      p.recentRolls = p.recentRolls.filter((t) => state.timeMs - t <= BOSS.panic.windowMs);
      p.recentRolls.push(state.timeMs);
      state.log.rolls[rollDirectionLabel(p.rollDir, toBoss)] += 1;
      events.push({ type: "playerRoll", dodged: false, perfect: false });
      return;
    }
    if (kind === "heavy") {
      if (p.stamina < PLAYER.heavy.stamina) return;
      startAction(p, "heavy", PLAYER.heavy.stamina);
      p.charging = input.heavyHeld === true;
      p.comboIdleT = PLAYER.comboResetMs;
      state.log.heavyAttacks += 1;
      noteAttackTiming();
      events.push({ type: "playerAttack", kind: "heavy", combo: 0, charge: 0 });
      return;
    }
    const chaining = p.action === "light" || p.comboIdleT < PLAYER.comboResetMs;
    const stage = chaining && p.comboIndex + 1 < PLAYER.combo.length ? p.comboIndex + 1 : 0;
    const attack = PLAYER.combo[stage] ?? PLAYER.light;
    if (p.stamina < attack.stamina) return;
    startAction(p, "light", attack.stamina);
    p.comboIndex = stage;
    state.log.lightAttacks += 1;
    noteAttackTiming();
    events.push({ type: "playerAttack", kind: "light", combo: stage, charge: 0 });
  };

  const stepPlayer = (input: PlayerInput, events: BattleEvent[]) => {
    const p = state.player;
    const b = state.boss;
    const flat = state.flat;
    if (flat) snapToLane(p.pos);
    const toBoss = norm(sub(b.pos, p.pos));
    const stick = flat ? vec(input.move.x, 0) : input.move;
    const wants = norm(stick, vec());
    const moving = len(stick) > 0.01;
    const onGround = !flat || grounded(p);

    if (flat && input.jump && grounded(p) && (p.action === "idle" || p.action === "roll")) {
      p.action = "idle";
      p.vy = FLAT.jumpVelocity;
    }

    // Presses are queued (latest wins) and fire as soon as the current action opens a window for them.
    // On the lane Space is the jump, so it never queues a roll; airborne presses wait for the landing.
    if (p.buffered) {
      p.buffered.age += TICK_MS;
      if (p.buffered.age > PLAYER.bufferMs) p.buffered = null;
    }
    const rollPressed = input.roll && !(flat && input.jump);
    const pressed: PlayerCommand | null = rollPressed ? "roll" : input.heavy ? "heavy" : input.light ? "light" : null;
    if (pressed) p.buffered = { kind: pressed, move: { ...stick }, age: 0 };
    if (p.buffered && onGround && accepts(p, p.buffered.kind)) {
      const command = p.buffered;
      p.buffered = null;
      startCommand(command.kind, command.move, stick, input, toBoss, events);
    }

    if (p.action === "idle") {
      if (moving) p.pos = add(p.pos, wants, (PLAYER.speed * TICK_MS) / 1000);
      p.facing = toBoss;
      p.comboIdleT = Math.min(PLAYER.comboResetMs, p.comboIdleT + TICK_MS);
    } else if (p.action === "roll") {
      p.actionT += TICK_MS;
      p.pos = add(p.pos, p.rollDir, (PLAYER.roll.distance / PLAYER.roll.durationMs) * TICK_MS);
      if (p.actionT >= PLAYER.roll.durationMs) p.action = "idle";
    } else if (p.action === "hurt") {
      p.actionT += TICK_MS;
      if (p.actionT >= PLAYER.hurt.stunMs) p.action = "idle";
    } else {
      const attack = attackFor(p);
      const heavy = p.action === "heavy";
      p.facing = toBoss;
      if (heavy && p.charging && input.heavyHeld !== true) p.charging = false;
      if (heavy && p.charging && p.actionT + TICK_MS >= attack.windupMs) {
        // Parked at the end of the windup: the swing waits for the release or a full charge.
        p.charge = Math.min(1, p.charge + TICK_MS / PLAYER.charge.maxMs);
        if (p.charge >= 1) p.charging = false;
      } else {
        p.actionT += TICK_MS;
      }
      const chargeMul = (mul: number) => 1 + (mul - 1) * (heavy ? p.charge : 0);
      const inActive = p.actionT >= attack.windupMs && p.actionT < attack.windupMs + attack.activeMs;
      if (inActive) {
        const gap = dist(p.pos, b.pos) - BOSS.radius - PLAYER.radius;
        const lunge = attack.lunge * chargeMul(PLAYER.charge.lungeMul);
        p.pos = add(p.pos, toBoss, Math.max(0, Math.min(gap, (lunge / attack.activeMs) * TICK_MS)));
      }
      if (inActive && !p.attackLanded && dist(p.pos, b.pos) <= attack.range + BOSS.radius && b.invulnerableT <= 0) {
        p.attackLanded = true;
        hitBoss(Math.round(attack.damage * chargeMul(PLAYER.charge.damageMul)), attack.poise * chargeMul(PLAYER.charge.poiseMul), heavy, events, heavy ? 0 : p.comboIndex, heavy ? p.charge : 0);
      }
      if (p.actionT >= tickAttack(attack)) {
        p.action = "idle";
        p.comboIdleT = heavy ? PLAYER.comboResetMs : 0;
      }
    }

    if (p.knockT > 0) {
      p.knockT = Math.max(0, p.knockT - TICK_MS);
      p.pos = add(p.pos, p.knockDir, (PLAYER.hurt.knockback / PLAYER.hurt.knockbackMs) * TICK_MS);
    }
    p.hurtT = Math.max(0, p.hurtT - TICK_MS);

    if (flat) {
      p.vy -= (FLAT.gravity * TICK_MS) / 1000;
      p.y += (p.vy * TICK_MS) / 1000;
      if (p.y <= 0) { p.y = 0; p.vy = 0; }
      if (p.vy < 0 && p.y >= FLAT.stomp.minY && p.y <= FLAT.stomp.maxY && dist(p.pos, b.pos) <= BOSS.radius + PLAYER.radius && b.invulnerableT <= 0) {
        p.vy = FLAT.jumpVelocity * FLAT.stomp.bounce;
        state.log.lightAttacks += 1;
        hitBoss(PLAYER.light.damage, PLAYER.light.poise, false, events, 0, 0);
      }
    }

    if (state.arena.mutator === "tempest") p.pos = add(p.pos, state.arena.wind, TICK_MS / 1000);
    p.pos = clampToDisc(separateFromObstacles(p.pos, PLAYER.radius, state.arena.obstacles), state.arena.radius - PLAYER_EDGE_MARGIN);
    p.staminaRegenDelay = Math.max(0, p.staminaRegenDelay - TICK_MS);
    if (p.staminaRegenDelay === 0 && p.action !== "roll") p.stamina = Math.min(PLAYER.maxStamina, p.stamina + (PLAYER.staminaRegenPerSec * TICK_MS) / 1000);
    p.hitFlash = Math.max(0, p.hitFlash - TICK_MS);
  };

  const noteAttackTiming = () => {
    const current = state.boss.current;
    if (!current) return;
    if (current.phase === "telegraph") state.log.attacksDuringTelegraph += 1;
    if (current.phase === "recover") state.log.attacksDuringRecover += 1;
  };

  const playerInvulnerable = () => state.player.action === "roll" && state.player.actionT <= PLAYER.roll.iframeMs;

  const hurtPlayer = (damage: number, source: HazardSource, events: BattleEvent[], from?: Vec2) => {
    const p = state.player;
    if (state.outcome !== "fighting") return;
    if (p.hurtT > 0) return;
    if (playerInvulnerable()) {
      const perfect = !p.rollPerfect && p.actionT <= PLAYER.perfectRoll.windowMs;
      if (perfect) {
        p.rollPerfect = true;
        p.stamina = Math.min(PLAYER.maxStamina, p.stamina + PLAYER.perfectRoll.staminaRefund);
      }
      state.log.rollsDodged += 1;
      events.push({ type: "playerRoll", dodged: true, perfect });
      return;
    }
    p.hp = debug.playerInvulnerable ? p.hp : Math.max(0, p.hp - damage);
    p.hitFlash = 200;
    p.hurtT = PLAYER.hurt.invulnMs;
    const away = from ? sub(p.pos, from) : sub(p.pos, state.boss.pos);
    p.knockDir = norm(away, scale(state.player.facing, -1));
    // Weather ticks (pools, vents, bolts) burn without shoving: only the boss's own blows knock and stun.
    if (source !== "arena") {
      p.knockT = PLAYER.hurt.knockbackMs;
      p.action = "hurt";
      p.actionT = 0;
      p.charging = false;
      p.charge = 0;
      p.comboIdleT = PLAYER.comboResetMs;
    }
    state.log.hitsTaken[source] = (state.log.hitsTaken[source] ?? 0) + 1;
    events.push({ type: "playerHit", move: source, damage, hp: p.hp, dir: { ...p.knockDir } });
    onPlayerWounded(state, source, spawnArenaHazard, events);
    if (p.hp <= 0) {
      state.outcome = "playerDead";
      state.log.killedBy = source;
      state.log.durationMs = state.timeMs;
      state.log.phaseReached = state.boss.phaseIndex;
      state.log.bossHpFractionAtDeath = state.boss.hp / spec.stats.maxHp;
      events.push({ type: "playerDeath", lineIndex: Math.floor(rng.next() * spec.voice.lines.playerDeath.length) });
    }
  };

  /** Where a hazard came from, for knockback direction. */
  const hazardOrigin = (shape: HazardShape): Vec2 => (shape.kind === "line" ? shape.start : shape.center);

  // ---- boss ---------------------------------------------------------------------------------
  const hitBoss = (damage: number, poise: number, heavy: boolean, events: BattleEvent[], combo: number, charge: number) => {
    const b = state.boss;
    const weakness = b.weaknessT > 0;
    const dealt = Math.round(damage * (spec.stats.playerDamage ?? 1) * (weakness ? spec.weakness.multiplier : 1));
    b.hp = Math.max(0, b.hp - dealt);
    b.hitFlash = 120;
    b.poiseDamage += poise;
    if (weakness) state.log.weaknessHits += 1;
    events.push({ type: "bossHit", damage: dealt, heavy, weakness, hp: b.hp, combo, charge });
    if (heavy && spec.weakness.trigger === "heavy_hit" && b.weaknessT <= 0) openWeakness(events);
    if (b.poiseDamage >= spec.stats.poise && b.staggerT <= 0) {
      b.poiseDamage = 0;
      b.staggerT = BOSS.staggerMs;
      b.current = null;
      events.push({ type: "bossStagger" });
    }
    if (b.hp <= 0) {
      state.outcome = "bossDead";
      state.log.durationMs = state.timeMs;
      state.log.phaseReached = b.phaseIndex;
      state.log.bossHpFractionAtDeath = 0;
      events.push({ type: "bossDefeat" });
    }
  };

  const openWeakness = (events: BattleEvent[]) => {
    state.boss.weaknessT = BOSS.weaknessWindowMs;
    events.push({ type: "weaknessOpen", ms: BOSS.weaknessWindowMs });
  };

  const playerPanicRolling = () => state.player.recentRolls.filter((t) => state.timeMs - t <= BOSS.panic.windowMs).length >= BOSS.panic.rolls;

  const chooseMove = (phase: Phase): Move => {
    const b = state.boss;
    b.movesChosen += 1;
    if (b.movesChosen === 1) {
      // Opening move: a close, single-commit swing so the first exchange teaches the telegraph language.
      const openers = phase.moves.filter((m) => OPENING_MOVES.includes(m.type)).sort((x, y) => x.damage - y.damage);
      const gentlest = openers[0] ?? [...phase.moves].sort((x, y) => x.damage - y.damage)[0];
      if (gentlest) return gentlest;
    }
    const band = rangeBand(dist(b.pos, state.player.pos) - BOSS.radius);
    const weights = BAND_WEIGHTS[band];
    const panic = playerPanicRolling();
    const scored = phase.moves.map((m) => {
      let w = weights[m.type];
      if (m.type === b.lastMoveType && phase.moves.length > 1) w *= 0.2;
      // Lingering hazards punish a player who rolls on reflex: the roll ends inside them.
      if (panic && (m.type === "zone" || m.type === "nova" || m.type === "ring")) w *= 1.8;
      return { m, w };
    });
    const total = scored.reduce((sum, s) => sum + s.w, 0);
    let roll = rng.next() * total;
    for (const s of scored) {
      roll -= s.w;
      if (roll <= 0) return s.m;
    }
    return scored[scored.length - 1]?.m ?? rng.pick(phase.moves);
  };

  const beginMove = (move: Move, followUp: boolean, events: BattleEvent[]) => {
    const b = state.boss;
    let telegraphMs = followUp ? Math.max(500, move.telegraphMs * BOSS.followUpTelegraphScale) : move.telegraphMs;
    // A player who rolls on reflex gets a delayed commit that lands after the i-frames.
    if (!followUp && isMelee(move.type) && playerPanicRolling()) telegraphMs *= BOSS.panic.telegraphScale;
    b.current = { move, phase: "telegraph", t: 0, aim: { ...state.player.pos }, travel: vec(), telegraphMs, spawned: false };
    b.lastMoveType = move.type;
    events.push({ type: "telegraph", move: move.type, ms: telegraphMs });
  };

  const spawnHazard = (source: HazardSource, shape: Hazard["shape"], damage: number, ttl: number, repeat = false, armMs = 0): Hazard => {
    const hazard: Hazard = { id: state.nextId++, source, shape, damage, ttl, cooldown: 0, repeat, hit: false, armMs, armT: armMs };
    state.hazards.push(hazard);
    return hazard;
  };
  const spawnArenaHazard = (shape: HazardShape, damage: number, ttl: number, repeat: boolean, armMs: number) => spawnHazard("arena", shape, damage, ttl, repeat, armMs);

  const activateMove = (current: BossMove, events: BattleEvent[]) => {
    const b = state.boss;
    const { move } = current;
    const dir = norm(sub(current.aim, b.pos), b.facing);
    b.facing = dir;
    events.push({ type: "moveActive", move: move.type });
    switch (move.type) {
      case "sweep": {
        const h = spawnHazard("sweep", { kind: "arc", center: { ...b.pos }, radius: MOVE.sweep.radius * move.scale, dir, halfAngle: MOVE.sweep.halfAngle }, move.damage, MOVE.sweep.activeMs);
        strikeObstacles(h.shape, ARENA_PILLARS.damage.sweep, "sweep", events);
        break;
      }
      case "thrust": {
        const h = spawnHazard("thrust", { kind: "line", start: { ...b.pos }, dir, length: MOVE.thrust.length * move.scale, halfWidth: MOVE.thrust.halfWidth * move.scale }, move.damage, MOVE.thrust.activeMs);
        strikeObstacles(h.shape, ARENA_PILLARS.damage.thrust, "thrust", events);
        break;
      }
      case "nova": {
        const h = spawnHazard("nova", { kind: "circle", center: { ...b.pos }, radius: MOVE.nova.radius * move.scale }, move.damage, MOVE.nova.activeMs);
        strikeObstacles(h.shape, ARENA_PILLARS.damage.nova, "nova", events);
        break;
      }
      case "charge":
        current.travel = scale(dir, MOVE.charge.speed);
        break;
      case "ring":
        for (let i = 0; i < move.count; i += 1) {
          const h = spawnHazard("ring", { kind: "ring", center: { ...b.pos }, radius: MOVE.ring.startRadius - (MOVE.ring.growth * MOVE.ring.waveGapMs * i) / 1000, thickness: MOVE.ring.thickness * move.scale, growth: MOVE.ring.growth, maxRadius: state.arena.radius + 1 }, move.damage, 60000);
          h.cooldown = 0;
        }
        break;
      case "volley": {
        const spread = MOVE.volley.spread * move.scale;
        for (let i = 0; i < move.count; i += 1) {
          if (state.flat) {
            // One lane, so the fan becomes a stream: shots queue up behind the boss on a low or high line.
            const lane = norm(vec(dir.x, 0), vec(b.facing.x < 0 ? -1 : 1, 0));
            const y = rng.next() < 0.5 ? FLAT.volley.lowY : FLAT.volley.highY;
            state.projectiles.push({ id: state.nextId++, pos: add(b.pos, lane, BOSS.radius - i * FLAT.volley.gap), vel: scale(lane, MOVE.volley.speed), y, radius: MOVE.volley.radius * move.scale, damage: move.damage });
            continue;
          }
          const angle = move.count === 1 ? 0 : -spread / 2 + (spread * i) / (move.count - 1);
          const projectile: Projectile = { id: state.nextId++, pos: add(b.pos, dir, BOSS.radius), vel: scale(rotate(dir, angle), MOVE.volley.speed), y: 1, radius: MOVE.volley.radius * move.scale, damage: move.damage };
          state.projectiles.push(projectile);
        }
        break;
      }
      case "zone":
        for (let i = 0; i < move.count; i += 1) {
          const offset = i === 0 ? vec() : state.flat ? vec(rng.range(-1.6, 1.6) * MOVE.zone.scatter, 0) : rotate(vec(0, MOVE.zone.scatter), rng.range(0, Math.PI * 2));
          const center = clampToDisc(add(current.aim, offset), state.arena.radius - 0.5);
          spawnHazard("zone", { kind: "circle", center, radius: MOVE.zone.radius * move.scale }, move.damage, MOVE.zone.ttlMs, true);
        }
        break;
      case "blink": {
        const behind = norm(sub(state.player.pos, b.pos));
        b.pos = clampToDisc(separateFromObstacles(add(state.player.pos, behind, MOVE.blink.distanceBehind), BOSS.radius, state.arena.obstacles), bossLimit());
        b.facing = scale(behind, -1);
        if (spec.weakness.trigger === "after_blink") openWeakness(events);
        break;
      }
    }
  };

  const stepBoss = (events: BattleEvent[]) => {
    const b = state.boss;
    const p = state.player;
    b.hitFlash = Math.max(0, b.hitFlash - TICK_MS);
    b.weaknessT = Math.max(0, b.weaknessT - TICK_MS);
    b.invulnerableT = Math.max(0, b.invulnerableT - TICK_MS);

    // Phase transitions: check thresholds from the highest phase downward.
    for (let i = spec.phases.length - 1; i > b.phaseIndex; i -= 1) {
      const phase = spec.phases[i];
      if (phase && b.hp / spec.stats.maxHp <= phase.hpThreshold) {
        b.phaseIndex = i;
        b.current = null;
        b.staggerT = 0;
        b.poiseDamage = 0;
        b.invulnerableT = BOSS.phaseChangeInvulnMs;
        b.idleT = 0;
        b.idleFor = BOSS.phaseChangeInvulnMs + 300;
        state.hazards = [];
        state.projectiles = [];
        if (phase.rule === "flatline") state.flat = true;
        events.push({ type: "phaseChange", phaseIndex: i });
        applyPhaseRule(state, phase, events);
        break;
      }
    }

    if (state.flat) snapToLane(b.pos);
    if (b.staggerT > 0) { b.staggerT = Math.max(0, b.staggerT - TICK_MS); return; }

    const phase = currentPhase(spec, b);
    const toPlayer = norm(sub(p.pos, b.pos), b.facing);

    if (!b.current) {
      b.idleT += TICK_MS;
      state.tauntT -= TICK_MS;
      if (state.tauntT <= 0) {
        state.tauntT = BOSS.tauntEveryMs;
        events.push({ type: "taunt", index: Math.floor(rng.next() * spec.voice.lines.taunt.length) });
      }
      b.facing = toPlayer;
      if (dist(b.pos, p.pos) > BOSS.meleeRange) {
        const stepLen = (BOSS.walkSpeed * TICK_MS) / 1000;
        let next = add(b.pos, toPlayer, stepLen);
        const cover = blockedByObstacle(b.pos, next, state.arena.obstacles, BOSS.radius);
        if (cover) {
          // Slide around cover instead of grinding into it: pick the tangent that keeps closing on the player.
          const side = perp(norm(sub(cover.pos, b.pos)));
          next = add(b.pos, side, stepLen * (dot(side, toPlayer) >= 0 ? 1 : -1));
        }
        b.pos = clampToDisc(separateFromObstacles(next, BOSS.radius, state.arena.obstacles), bossLimit());
      }
      if (debug.bossAi && b.idleT >= b.idleFor && b.invulnerableT <= 0) {
        beginMove(chooseMove(phase), false, events);
        b.idleT = 0;
        b.idleFor = idleGap(spec.stats.aggression) * rng.range(0.8, 1.2);
      }
      return;
    }

    const current = b.current;
    current.t += TICK_MS;
    const timing = moveTiming(current.move.type);
    if (current.phase === "telegraph") {
      // Track the player slowly during telegraph so the commit point is readable but not free.
      current.aim = add(current.aim, sub(p.pos, current.aim), 0.06);
      b.facing = norm(sub(current.aim, b.pos), b.facing);
      // Melee swings step in while winding up so a player backing off is still met by the arc.
      if (isMelee(current.move.type) && dist(b.pos, p.pos) > BOSS.meleeRange * 0.75) {
        b.pos = clampToDisc(add(b.pos, b.facing, (BOSS.walkSpeed * 0.55 * TICK_MS) / 1000), bossLimit());
      }
      if (current.t >= current.telegraphMs) {
        current.phase = "active";
        current.t = 0;
        activateMove(current, events);
      }
      return;
    }
    if (current.phase === "active") {
      if (current.move.type === "charge") {
        b.pos = clampToDisc(add(b.pos, current.travel, TICK_MS / 1000), bossLimit());
        for (const o of [...state.arena.obstacles]) {
          if (solid(o) && dist(b.pos, o.pos) <= o.radius + MOVE.charge.hitRadius * current.move.scale) damageObstacle(o, ARENA_PILLARS.damage.charge, "charge", events);
        }
        if (dist(b.pos, p.pos) <= MOVE.charge.hitRadius * current.move.scale + PLAYER.radius && !current.spawned && !clearsGround()) {
          current.spawned = true;
          hurtPlayer(current.move.damage, "charge", events, b.pos);
        }
      }
      if (current.t >= timing.activeMs) {
        current.phase = "recover";
        current.t = 0;
        if (current.move.type === "charge" && spec.weakness.trigger === "after_charge") openWeakness(events);
      }
      return;
    }
    if (current.t >= timing.recoverMs) {
      const followUp = current.move.followUp ? phase.moves.find((m) => m.type === current.move.followUp) ?? { ...current.move, type: current.move.followUp, followUp: undefined } : null;
      b.current = null;
      if (followUp) beginMove(followUp, true, events);
    }
  };

  // ---- hazards + projectiles ---------------------------------------------------------------
  const stepHazards = (events: BattleEvent[]) => {
    const p = state.player;
    const next: Hazard[] = [];
    for (const raw of state.hazards) {
      const h = advanceHazard(raw, TICK_MS);
      if (h.ttl <= 0) continue;
      const canHit = h.armT <= 0 && (h.repeat ? h.cooldown <= 0 : !h.hit);
      if (canHit && !clearsGround() && overlaps(h.shape, p.pos, PLAYER.radius)) {
        // A dodged swing is spent: rolling through the front of a hitbox never gets clipped by its tail.
        h.hit = true;
        h.cooldown = MOVE.zone.tickMs;
        // Lingering zones tick for a fraction of the listed damage; one-shot hazards deal it all.
        hurtPlayer(h.repeat ? Math.max(1, Math.round(h.damage * MOVE.zone.tickFraction)) : h.damage, h.source, events, hazardOrigin(h.shape));
      }
      next.push(h);
    }
    state.hazards = next;

    const alive: Projectile[] = [];
    for (const pr of state.projectiles) {
      const from = pr.pos;
      pr.pos = add(pr.pos, pr.vel, TICK_MS / 1000);
      // Flat volleys queue up outside the disc behind the boss; only drop shots that are leaving.
      if (len(pr.pos) > state.arena.radius + 1 && dot(pr.pos, pr.vel) > 0) continue;
      const cover = blockedByObstacle(from, pr.pos, state.arena.obstacles, pr.radius);
      if (cover) {
        events.push({ type: "obstacleHit", id: cover.id, hpLeft: cover.hp, by: "volley" });
        continue;
      }
      const inHeight = !state.flat || Math.abs(pr.y - (p.y + PLAYER.radius)) <= pr.radius + PLAYER.radius;
      if (inHeight && dist(pr.pos, p.pos) <= pr.radius + PLAYER.radius) {
        hurtPlayer(pr.damage, "volley", events, sub(p.pos, pr.vel));
        continue;
      }
      alive.push(pr);
    }
    state.projectiles = alive;
  };

  const step = (input: PlayerInput): BattleEvent[] => {
    const events: BattleEvent[] = [];
    if (state.outcome !== "fighting") return events;
    if (pendingEvents.length > 0) events.push(...pendingEvents.splice(0));
    state.timeMs += TICK_MS;
    stepArena(state, events);
    stepMutator(state, TICK_MS, arenaRng, spawnArenaHazard, events);
    stepPlayer(input, events);
    if (state.outcome !== "fighting") return events;
    stepBoss(events);
    if (state.outcome !== "fighting") return events;
    stepHazards(events);
    return events;
  };

  const debug: BattleDebug = {
    bossAi: true,
    playerInvulnerable: false,
    forceMove(type, template) {
      const b = state.boss;
      if (b.current || b.staggerT > 0 || state.outcome !== "fighting") return false;
      const known = spec.phases.flatMap((phase) => phase.moves).find((m) => m.type === type);
      const move: Move = { ...(known ?? { type, telegraphMs: 1000, damage: 20, scale: 1, count: 3 }), ...template, type };
      const events: BattleEvent[] = [];
      beginMove(move, false, events);
      b.idleT = 0;
      pendingEvents.push(...events);
      return true;
    },
    forceRule(rule) {
      const phase = spec.phases[state.boss.phaseIndex] ?? spec.phases[0];
      if (!phase || state.outcome !== "fighting") return;
      applyPhaseRule(state, { ...phase, rule }, pendingEvents);
    },
  };

  return { spec, state, debug, step };
}

/** Ground decal to draw while a move is telegraphed: the same geometry the hitbox will use. */
export function previewShape(current: BossMove, boss: BossState, arenaRadius = ARENA_RADIUS): HazardShape | null {
  const { move } = current;
  const dir = norm(sub(current.aim, boss.pos), boss.facing);
  switch (move.type) {
    case "sweep": return { kind: "arc", center: boss.pos, radius: MOVE.sweep.radius * move.scale, dir, halfAngle: MOVE.sweep.halfAngle };
    case "thrust": return { kind: "line", start: boss.pos, dir, length: MOVE.thrust.length * move.scale, halfWidth: MOVE.thrust.halfWidth * move.scale };
    case "charge": return { kind: "line", start: boss.pos, dir, length: (MOVE.charge.speed * MOVE.charge.activeMs) / 1000, halfWidth: MOVE.charge.hitRadius * move.scale };
    case "nova": return { kind: "circle", center: boss.pos, radius: MOVE.nova.radius * move.scale };
    case "ring": return { kind: "ring", center: boss.pos, radius: MOVE.ring.startRadius, thickness: MOVE.ring.thickness * move.scale, growth: 0, maxRadius: arenaRadius };
    case "volley": return { kind: "arc", center: boss.pos, radius: arenaRadius, dir, halfAngle: (MOVE.volley.spread * move.scale) / 2 };
    case "zone": return { kind: "circle", center: current.aim, radius: MOVE.zone.radius * move.scale };
    case "blink": return null;
  }
}
