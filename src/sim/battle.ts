import type { Move, MoveType, NemesisSpec, Phase } from "../spec";
import { ARENA_RADIUS, BOSS, MOVE, PLAYER, PLAYER_EDGE_MARGIN, TICK_MS } from "./constants";
import { advanceHazard, overlaps } from "./hazard";
import { createRng, type Rng } from "./rng";
import type { BattleEvent, BattleState, BossMove, BossState, DeathLog, Hazard, HazardShape, PlayerInput, PlayerState, Projectile, Vec2 } from "./types";
import { add, clampToDisc, dist, dot, len, norm, perp, rotate, scale, sub, vec } from "./vec";

export interface Battle {
  readonly spec: NemesisSpec;
  readonly state: BattleState;
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
    },
    boss: {
      pos: vec(0, -4), facing: vec(0, 1), hp: spec.stats.maxHp, poiseDamage: 0, phaseIndex: 0, current: null,
      idleT: 0, idleFor: 900, staggerT: 0, invulnerableT: 0, weaknessT: 0, lastMoveType: null, hitFlash: 0,
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
  const tickAttack = (attack: typeof PLAYER.light | typeof PLAYER.heavy) => attack.windupMs + attack.activeMs + attack.recoverMs;

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
    p.stamina = Math.max(0, p.stamina - cost);
    p.staminaRegenDelay = PLAYER.staminaRegenDelayMs;
  };

  const stepPlayer = (input: PlayerInput, events: BattleEvent[]) => {
    const p = state.player;
    const b = state.boss;
    const toBoss = norm(sub(b.pos, p.pos));
    const wants = norm(input.move, vec());
    const moving = len(input.move) > 0.01;

    if (p.action === "idle") {
      if (input.roll && p.stamina >= PLAYER.roll.stamina) {
        p.rollDir = moving ? wants : scale(toBoss, -1);
        startAction(p, "roll", PLAYER.roll.stamina);
        state.log.rolls[rollDirectionLabel(p.rollDir, toBoss)] += 1;
        events.push({ type: "playerRoll", dodged: false });
      } else if (input.heavy && p.stamina >= PLAYER.heavy.stamina) {
        startAction(p, "heavy", PLAYER.heavy.stamina);
        state.log.heavyAttacks += 1;
        noteAttackTiming();
      } else if (input.light && p.stamina >= PLAYER.light.stamina) {
        startAction(p, "light", PLAYER.light.stamina);
        state.log.lightAttacks += 1;
        noteAttackTiming();
      }
    }

    if (p.action === "idle") {
      if (moving) p.pos = add(p.pos, wants, (PLAYER.speed * TICK_MS) / 1000);
      p.facing = toBoss;
    } else if (p.action === "roll") {
      p.actionT += TICK_MS;
      p.pos = add(p.pos, p.rollDir, (PLAYER.roll.distance / PLAYER.roll.durationMs) * TICK_MS);
      if (p.actionT >= PLAYER.roll.durationMs) p.action = "idle";
    } else {
      const attack = p.action === "heavy" ? PLAYER.heavy : PLAYER.light;
      p.actionT += TICK_MS;
      p.facing = toBoss;
      const inActive = p.actionT >= attack.windupMs && p.actionT < attack.windupMs + attack.activeMs;
      if (inActive && !p.attackLanded && dist(p.pos, b.pos) <= attack.range + BOSS.radius && b.invulnerableT <= 0) {
        p.attackLanded = true;
        hitBoss(attack.damage, attack.poise, p.action === "heavy", events);
      }
      if (p.actionT >= tickAttack(attack)) p.action = "idle";
    }

    p.pos = clampToDisc(p.pos, ARENA_RADIUS - PLAYER_EDGE_MARGIN);
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

  const hurtPlayer = (damage: number, source: MoveType, events: BattleEvent[]) => {
    const p = state.player;
    if (state.outcome !== "fighting") return;
    if (playerInvulnerable()) {
      state.log.rollsDodged += 1;
      events.push({ type: "playerRoll", dodged: true });
      return;
    }
    p.hp = Math.max(0, p.hp - damage);
    p.hitFlash = 200;
    state.log.hitsTaken[source] = (state.log.hitsTaken[source] ?? 0) + 1;
    events.push({ type: "playerHit", move: source, damage, hp: p.hp });
    if (p.hp <= 0) {
      state.outcome = "playerDead";
      state.log.killedBy = source;
      state.log.durationMs = state.timeMs;
      state.log.phaseReached = state.boss.phaseIndex;
      state.log.bossHpFractionAtDeath = state.boss.hp / spec.stats.maxHp;
      events.push({ type: "playerDeath", lineIndex: Math.floor(rng.next() * spec.voice.lines.playerDeath.length) });
    }
  };

  // ---- boss ---------------------------------------------------------------------------------
  const hitBoss = (damage: number, poise: number, heavy: boolean, events: BattleEvent[]) => {
    const b = state.boss;
    const weakness = b.weaknessT > 0;
    const dealt = Math.round(damage * (weakness ? spec.weakness.multiplier : 1));
    b.hp = Math.max(0, b.hp - dealt);
    b.hitFlash = 120;
    b.poiseDamage += poise;
    if (weakness) state.log.weaknessHits += 1;
    events.push({ type: "bossHit", damage: dealt, heavy, weakness, hp: b.hp });
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

  const chooseMove = (phase: Phase): Move => {
    const b = state.boss;
    const near = dist(b.pos, state.player.pos) <= BOSS.meleeRange + 1.5;
    const candidates = phase.moves.filter((m) => m.type !== b.lastMoveType || phase.moves.length === 1);
    const preferred = candidates.filter((m) => (near ? isMelee(m.type) || m.type === "blink" : !isMelee(m.type)));
    const pool = preferred.length > 0 && rng.next() < 0.7 ? preferred : candidates;
    return rng.pick(pool);
  };

  const beginMove = (move: Move, followUp: boolean, events: BattleEvent[]) => {
    const b = state.boss;
    const telegraphMs = followUp ? Math.max(500, move.telegraphMs * BOSS.followUpTelegraphScale) : move.telegraphMs;
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
        b.pos = clampToDisc(add(state.player.pos, behind, MOVE.blink.distanceBehind), ARENA_RADIUS - BOSS.radius);
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
      if (dist(b.pos, p.pos) > BOSS.meleeRange) b.pos = add(b.pos, toPlayer, (BOSS.walkSpeed * TICK_MS) / 1000);
      if (b.idleT >= b.idleFor && b.invulnerableT <= 0) {
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
      if (current.t >= current.telegraphMs) {
        current.phase = "active";
        current.t = 0;
        activateMove(current, events);
      }
      return;
    }
    if (current.phase === "active") {
      if (current.move.type === "charge") {
        b.pos = clampToDisc(add(b.pos, current.travel, TICK_MS / 1000), ARENA_RADIUS - BOSS.radius);
        if (dist(b.pos, p.pos) <= MOVE.charge.hitRadius * current.move.scale + PLAYER.radius && !current.spawned) {
          current.spawned = true;
          hurtPlayer(current.move.damage, "charge", events);
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
        hurtPlayer(h.repeat ? Math.max(1, Math.round(h.damage * MOVE.zone.tickFraction)) : h.damage, h.source, events);
      }
      next.push(h);
    }
    state.hazards = next;

    const alive: Projectile[] = [];
    for (const pr of state.projectiles) {
      pr.pos = add(pr.pos, pr.vel, TICK_MS / 1000);
      if (len(pr.pos) > ARENA_RADIUS + 1) continue;
      if (dist(pr.pos, p.pos) <= pr.radius + PLAYER.radius) {
        hurtPlayer(pr.damage, "volley", events);
        continue;
      }
      alive.push(pr);
    }
    state.projectiles = alive;
  };

  const step = (input: PlayerInput): BattleEvent[] => {
    const events: BattleEvent[] = [];
    if (state.outcome !== "fighting") return events;
    state.timeMs += TICK_MS;
    stepPlayer(input, events);
    if (state.outcome !== "fighting") return events;
    stepBoss(events);
    if (state.outcome !== "fighting") return events;
    stepHazards(events);
    return events;
  };

  return { spec, state, step };
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
