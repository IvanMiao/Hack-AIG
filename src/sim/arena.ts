import type { Element } from "../spec";
import { ARENA_MUTATOR } from "./constants";
import type { Rng } from "./rng";
import type { ArenaMutator, BattleEvent, BattleState, Hazard, HazardShape, HazardSource, Vec2 } from "./types";
import { add, clampToDisc, dist, norm, rotate, scale, sub, vec } from "./vec";

export function mutatorForElement(element: Element): ArenaMutator {
  switch (element) {
    case "fire": return "ember";
    case "storm": return "tempest";
    case "blood": return "bloodtide";
    case "ice":
    case "void":
      return "none";
  }
}

/** First pulse lands just after the boss's opening grace so the arena reads before it bites. */
export function initialMutatorT(mutator: ArenaMutator): number {
  switch (mutator) {
    case "ember": return ARENA_MUTATOR.ember.periodMs * 0.6;
    case "tempest": return ARENA_MUTATOR.tempest.boltPeriodMs * 0.6;
    case "bloodtide":
    case "none":
      return 0;
  }
}

export function initialWind(mutator: ArenaMutator, rng: Rng): Vec2 {
  if (mutator !== "tempest") return vec();
  return scale(rotate(vec(0, 1), rng.range(0, Math.PI * 2)), ARENA_MUTATOR.tempest.windSpeed);
}

export type SpawnArenaHazard = (shape: HazardShape, damage: number, ttlMs: number, repeat: boolean, armMs: number) => Hazard;

/** Periodic arena behaviour. Called once per tick; owns `arena.mutatorT` and `arena.wind`. */
export function stepMutator(state: BattleState, dtMs: number, rng: Rng, spawn: SpawnArenaHazard, events: BattleEvent[]): void {
  const arena = state.arena;
  if (arena.mutator === "none" || arena.mutator === "bloodtide") return;
  arena.mutatorT -= dtMs;
  if (arena.mutator === "tempest") {
    // The wind veers on the same clock as the bolts so both read as one storm.
    if (arena.mutatorT <= 0) {
      arena.wind = rotate(arena.wind, rng.range(-1.2, 1.2));
      const at = { ...state.player.pos };
      spawn({ kind: "circle", center: at, radius: ARENA_MUTATOR.tempest.boltRadius }, ARENA_MUTATOR.tempest.boltDamage, ARENA_MUTATOR.tempest.boltArmMs + 250, false, ARENA_MUTATOR.tempest.boltArmMs);
      events.push({ type: "arenaPulse", mutator: "tempest", at });
      arena.mutatorT += ARENA_MUTATOR.tempest.boltPeriodMs;
    }
    return;
  }
  if (arena.mutatorT > 0) return;
  const ember = ARENA_MUTATOR.ember;
  const limit = arena.radius * ember.spread;
  for (let i = 0; i < ember.count; i += 1) {
    let at = clampToDisc(rotate(vec(0, Math.sqrt(rng.next()) * limit), rng.range(0, Math.PI * 2)), limit);
    // Never open a vent under the player: the telegraph must be dodgeable, not a coin flip.
    if (dist(at, state.player.pos) < ember.safeRadius) at = clampToDisc(add(state.player.pos, norm(sub(at, state.player.pos), vec(1, 0)), ember.safeRadius), limit);
    spawn({ kind: "circle", center: at, radius: ember.radius }, ember.damage, ember.ttlMs, true, ember.armMs);
    events.push({ type: "arenaPulse", mutator: "ember", at });
  }
  arena.mutatorT += ember.periodMs;
}

/** bloodtide: a boss wound leaves a pool where the player stood. */
export function onPlayerWounded(state: BattleState, source: HazardSource, spawn: SpawnArenaHazard, events: BattleEvent[]): void {
  if (state.arena.mutator !== "bloodtide" || source === "arena") return;
  const pool = ARENA_MUTATOR.bloodtide;
  const at = { ...state.player.pos };
  spawn({ kind: "circle", center: at, radius: pool.poolRadius }, pool.damage, pool.ttlMs, true, pool.armMs);
  events.push({ type: "arenaPulse", mutator: "bloodtide", at });
}
