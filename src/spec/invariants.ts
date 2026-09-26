import { LIMITS } from "./limits";
import { PHASE_RULES, type NemesisSpec } from "./types";

/**
 * Fairness rules a spec must satisfy before it is allowed into the arena.
 * normalizeDraft() should always produce a spec that passes; this is the release gate that proves it.
 */
export function checkInvariants(spec: NemesisSpec): string[] {
  const problems: string[] = [];
  const { maxHp } = spec.stats;
  if (maxHp < LIMITS.maxHp.min || maxHp > LIMITS.maxHp.max) problems.push(`maxHp out of range: ${maxHp}`);
  if (spec.phases.length < LIMITS.phases.min || spec.phases.length > LIMITS.phases.max) problems.push(`phase count ${spec.phases.length}`);
  if (spec.phases[0]?.hpThreshold !== 1) problems.push("phase 1 must start at hpThreshold 1");

  spec.phases.forEach((phase, index) => {
    const label = `phase${index + 1}`;
    if (phase.moves.length < LIMITS.movesPerPhase.min) problems.push(`${label} has ${phase.moves.length} moves (< ${LIMITS.movesPerPhase.min})`);
    if (index > 0) {
      const previous = spec.phases[index - 1]?.hpThreshold ?? 1;
      if (phase.hpThreshold >= previous) problems.push(`${label} threshold ${phase.hpThreshold} not below previous ${previous}`);
    }
    if (!PHASE_RULES.includes(phase.rule)) problems.push(`${label} has unknown arena rule ${String(phase.rule)}`);
    const distinct = new Set(phase.moves.map((m) => m.type));
    if (distinct.size < 2) problems.push(`${label} needs at least 2 distinct move types`);
    phase.moves.forEach((move, moveIndex) => {
      const moveLabel = `${label}.move${moveIndex + 1}`;
      if (move.telegraphMs < LIMITS.telegraphMs.min) problems.push(`${moveLabel} telegraph ${move.telegraphMs}ms < ${LIMITS.telegraphMs.min}ms`);
      if (move.damage > maxHp * LIMITS.damageFractionOfHp.max) problems.push(`${moveLabel} damage ${move.damage} > 35% of boss HP`);
      if (move.damage > LIMITS.damage.max) problems.push(`${moveLabel} damage ${move.damage} > ${LIMITS.damage.max}`);
      if (move.followUp === move.type) problems.push(`${moveLabel} follows up into itself`);
    });
  });

  if (spec.voice.lines.taunt.length === 0) problems.push("no taunt lines");
  if (spec.music.bpm < LIMITS.bpm.min || spec.music.bpm > LIMITS.bpm.max) problems.push(`bpm ${spec.music.bpm}`);
  return problems;
}
