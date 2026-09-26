import type { Move, MoveType, NemesisSpec, Phase } from "../spec";
import { ARENA_RADIUS, BOSS, BOSS_EDGE_MARGIN, MOVE, PLAYER, PLAYER_EDGE_MARGIN, TICK_MS } from "./constants";

const BOSS_LIMIT = ARENA_RADIUS - BOSS.radius - BOSS_EDGE_MARGIN;
import { advanceHazard, overlaps } from "./hazard";
import { createRng, type Rng } from "./rng";
import type { AttackSpec } from "./constants";
import type { BattleEvent, BattleState, BossMove, BossState, DeathLog, Hazard, HazardShape, PlayerCommand, PlayerInput, PlayerState, Projectile, Vec2 } from "./types";
import { add, clampToDisc, dist, dot, len, norm, perp, rotate, scale, sub, vec } from "./vec";

/** Lab-only switches. All default off; the shipped game never touches them. */
export interface BattleDebug {
  /** false → the boss never starts a move on its own (forced moves still work). */
  bossAi: boolean;
  /** true → hazards and projectiles still resolve but the player takes no damage. */
  playerInvulnerable: boolean;
  /** Start `type` immediately (idle boss only). Returns false if the boss is busy or the move is not in any phase. */
  forceMove(type: MoveType, template?: Partial<Move>): boolean;
}

export interface Battle {
  readonly spec: NemesisSpec;
  readonly state: BattleState;
  readonly debug: BattleDebug;
  /** Advance one fixed tick. Returns the events that happened during it. */
  step(input: PlayerInput): BattleEvent[];
}

export const IDLE_INPUT: PlayerInput = { move: vec(), light: false, heavy: false, roll: false };

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
  return {
    seed,
    timeMs: 0,
    outcome: "fighting",
    player: {
      pos: vec(0, 5), facing: vec(0, -1), hp: PLAYER.maxHp, stamina: PLAYER.maxStamina,
      action: "idle", actionT: 0, rollDir: vec(0, -1), attackLanded: false, staminaRegenDelay: 0, hitFlash: 0,
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
}

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
  const pendingEvents: BattleEvent[] = [];
  const tickAttack = (attack: AttackSpec) => attack.windupMs + attack.activeMs + attack.recoverMs;

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

  const startCommand = (kind: PlayerCommand, stick: Vec2, input: PlayerInput, toBoss: Vec2, events: BattleEvent[]) => {
    const p = state.player;
    if (kind === "roll") {
      if (p.stamina < PLAYER.roll.stamina) return;
      const wants = len(stick) > 0.01 ? norm(stick) : len(input.move) > 0.01 ? norm(input.move) : scale(toBoss, -1);
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
    const toBoss = norm(sub(b.pos, p.pos));
    const wants = norm(input.move, vec());
    const moving = len(input.move) > 0.01;

    // Presses are queued (latest wins) and fire as soon as the current action opens a window for them.
    if (p.buffered) {
      p.buffered.age += TICK_MS;
      if (p.buffered.age > PLAYER.bufferMs) p.buffered = null;
    }
    const pressed: PlayerCommand | null = input.roll ? "roll" : input.heavy ? "heavy" : input.light ? "light" : null;
    if (pressed) p.buffered = { kind: pressed, move: { ...input.move }, age: 0 };
    if (p.buffered && accepts(p, p.buffered.kind)) {
      const command = p.buffered;
      p.buffered = null;
      startCommand(command.kind, command.move, input, toBoss, events);
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
    p.pos = clampToDisc(p.pos, ARENA_RADIUS - PLAYER_EDGE_MARGIN);
    p.hurtT = Math.max(0, p.hurtT - TICK_MS);
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

  const hurtPlayer = (damage: number, source: MoveType, events: BattleEvent[], from?: Vec2) => {
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
    p.knockT = PLAYER.hurt.knockbackMs;
    p.action = "hurt";
    p.actionT = 0;
    p.charging = false;
    p.charge = 0;
    p.comboIdleT = PLAYER.comboResetMs;
    state.log.hitsTaken[source] = (state.log.hitsTaken[source] ?? 0) + 1;
    events.push({ type: "playerHit", move: source, damage, hp: p.hp, dir: { ...p.knockDir } });
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
    const dealt = Math.round(damage * (weakness ? spec.weakness.multiplier : 1));
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

  const spawnHazard = (source: MoveType, shape: Hazard["shape"], damage: number, ttl: number, repeat = false): Hazard => {
    const hazard: Hazard = { id: state.nextId++, source, shape, damage, ttl, cooldown: 0, repeat, hit: false };
    state.hazards.push(hazard);
    return hazard;
  };

  const activateMove = (current: BossMove, events: BattleEvent[]) => {
    const b = state.boss;
    const { move } = current;
    const dir = norm(sub(current.aim, b.pos), b.facing);
    b.facing = dir;
    events.push({ type: "moveActive", move: move.type });
    switch (move.type) {
      case "sweep":
        spawnHazard("sweep", { kind: "arc", center: { ...b.pos }, radius: MOVE.sweep.radius * move.scale, dir, halfAngle: MOVE.sweep.halfAngle }, move.damage, MOVE.sweep.activeMs);
        break;
      case "thrust":
        spawnHazard("thrust", { kind: "line", start: { ...b.pos }, dir, length: MOVE.thrust.length * move.scale, halfWidth: MOVE.thrust.halfWidth * move.scale }, move.damage, MOVE.thrust.activeMs);
        break;
      case "nova":
        spawnHazard("nova", { kind: "circle", center: { ...b.pos }, radius: MOVE.nova.radius * move.scale }, move.damage, MOVE.nova.activeMs);
        break;
      case "charge":
        current.travel = scale(dir, MOVE.charge.speed);
        break;
      case "ring":
        for (let i = 0; i < move.count; i += 1) {
          const h = spawnHazard("ring", { kind: "ring", center: { ...b.pos }, radius: MOVE.ring.startRadius - (MOVE.ring.growth * MOVE.ring.waveGapMs * i) / 1000, thickness: MOVE.ring.thickness * move.scale, growth: MOVE.ring.growth, maxRadius: ARENA_RADIUS + 1 }, move.damage, 60000);
          h.cooldown = 0;
        }
        break;
      case "volley": {
        const spread = MOVE.volley.spread * move.scale;
        for (let i = 0; i < move.count; i += 1) {
          const angle = move.count === 1 ? 0 : -spread / 2 + (spread * i) / (move.count - 1);
          const projectile: Projectile = { id: state.nextId++, pos: add(b.pos, dir, BOSS.radius), vel: scale(rotate(dir, angle), MOVE.volley.speed), radius: MOVE.volley.radius * move.scale, damage: move.damage };
          state.projectiles.push(projectile);
        }
        break;
      }
      case "zone":
        for (let i = 0; i < move.count; i += 1) {
          const offset = i === 0 ? vec() : rotate(vec(0, MOVE.zone.scatter), rng.range(0, Math.PI * 2));
          const center = clampToDisc(add(current.aim, offset), ARENA_RADIUS - 0.5);
          spawnHazard("zone", { kind: "circle", center, radius: MOVE.zone.radius * move.scale }, move.damage, MOVE.zone.ttlMs, true);
        }
        break;
      case "blink": {
        const behind = norm(sub(state.player.pos, b.pos));
        b.pos = clampToDisc(add(state.player.pos, behind, MOVE.blink.distanceBehind), BOSS_LIMIT);
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
        events.push({ type: "phaseChange", phaseIndex: i });
        break;
      }
    }

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
      if (dist(b.pos, p.pos) > BOSS.meleeRange) b.pos = clampToDisc(add(b.pos, toPlayer, (BOSS.walkSpeed * TICK_MS) / 1000), BOSS_LIMIT);
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
        b.pos = clampToDisc(add(b.pos, b.facing, (BOSS.walkSpeed * 0.55 * TICK_MS) / 1000), BOSS_LIMIT);
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
        b.pos = clampToDisc(add(b.pos, current.travel, TICK_MS / 1000), BOSS_LIMIT);
        if (dist(b.pos, p.pos) <= MOVE.charge.hitRadius * current.move.scale + PLAYER.radius && !current.spawned) {
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
      const canHit = h.repeat ? h.cooldown <= 0 : !h.hit;
      if (canHit && overlaps(h.shape, p.pos, PLAYER.radius)) {
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
      pr.pos = add(pr.pos, pr.vel, TICK_MS / 1000);
      if (len(pr.pos) > ARENA_RADIUS + 1) continue;
      if (dist(pr.pos, p.pos) <= pr.radius + PLAYER.radius) {
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
  };

  return { spec, state, debug, step };
}

/** Ground decal to draw while a move is telegraphed: the same geometry the hitbox will use. */
export function previewShape(current: BossMove, boss: BossState): HazardShape | null {
  const { move } = current;
  const dir = norm(sub(current.aim, boss.pos), boss.facing);
  switch (move.type) {
    case "sweep": return { kind: "arc", center: boss.pos, radius: MOVE.sweep.radius * move.scale, dir, halfAngle: MOVE.sweep.halfAngle };
    case "thrust": return { kind: "line", start: boss.pos, dir, length: MOVE.thrust.length * move.scale, halfWidth: MOVE.thrust.halfWidth * move.scale };
    case "charge": return { kind: "line", start: boss.pos, dir, length: (MOVE.charge.speed * MOVE.charge.activeMs) / 1000, halfWidth: MOVE.charge.hitRadius * move.scale };
    case "nova": return { kind: "circle", center: boss.pos, radius: MOVE.nova.radius * move.scale };
    case "ring": return { kind: "ring", center: boss.pos, radius: MOVE.ring.startRadius, thickness: MOVE.ring.thickness * move.scale, growth: 0, maxRadius: ARENA_RADIUS };
    case "volley": return { kind: "arc", center: boss.pos, radius: ARENA_RADIUS, dir, halfAngle: (MOVE.volley.spread * move.scale) / 2 };
    case "zone": return { kind: "circle", center: current.aim, radius: MOVE.zone.radius * move.scale };
    case "blink": return null;
  }
}
