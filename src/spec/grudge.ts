import Ajv, { type JSONSchemaType } from "ajv";
import { checkInvariants } from "./invariants";
import { LIMITS, clamp } from "./limits";
import { clampMove } from "./normalize";
import { MOVE_TYPES, type Move, type MoveType, type NemesisSpec } from "./types";
import type { DeathLog } from "../sim/types";

/** Whitelisted ways a boss may evolve after a kill. Everything else Gemini writes is rejected. */
export type GrudgeOp =
  | { op: "addMove"; phaseIndex: number; move: Move }
  | { op: "tuneMove"; phaseIndex: number; moveIndex: number; telegraphMs?: number; damage?: number; scale?: number; count?: number }
  | { op: "tuneStats"; aggression?: number; poise?: number }
  | { op: "addTaunt"; line: string };

export interface GrudgePatch { observation: string; patch: string; ops: GrudgeOp[] }

const moveJsonSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: [...MOVE_TYPES] },
    telegraphMs: { type: "number" },
    damage: { type: "number" },
    scale: { type: "number" },
    count: { type: "number" },
    followUp: { type: "string", enum: [...MOVE_TYPES, null], nullable: true },
  },
  required: ["type", "telegraphMs", "damage", "scale", "count"],
  additionalProperties: false,
} as const;

const optionalNumber = { type: "number", nullable: true } as const;

/** Shared by ajv (validation) and Gemini (responseSchema). Bounds are enforced by applyGrudge, not here. */
export const grudgePatchSchema = {
  type: "object",
  properties: {
    observation: { type: "string" },
    patch: { type: "string" },
    ops: {
      type: "array",
      items: {
        anyOf: [
          {
            type: "object",
            properties: { op: { type: "string", enum: ["addMove"] }, phaseIndex: { type: "number" }, move: moveJsonSchema },
            required: ["op", "phaseIndex", "move"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              op: { type: "string", enum: ["tuneMove"] },
              phaseIndex: { type: "number" },
              moveIndex: { type: "number" },
              telegraphMs: optionalNumber,
              damage: optionalNumber,
              scale: optionalNumber,
              count: optionalNumber,
            },
            required: ["op", "phaseIndex", "moveIndex"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { op: { type: "string", enum: ["tuneStats"] }, aggression: optionalNumber, poise: optionalNumber },
            required: ["op"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { op: { type: "string", enum: ["addTaunt"] }, line: { type: "string" } },
            required: ["op", "line"],
            additionalProperties: false,
          },
        ],
      },
    },
  },
  required: ["observation", "patch", "ops"],
  additionalProperties: false,
} as unknown as JSONSchemaType<GrudgePatch>;

// No removeAdditional: it would strip properties inside anyOf branches before the discriminating branch validates.
const ajv = new Ajv({ allErrors: true });
const validateGrudgePatch = ajv.compile(grudgePatchSchema);

export type GrudgeValidation = { ok: true; patch: GrudgePatch } | { ok: false; errors: string[] };

export function parseGrudgePatch(input: unknown): GrudgeValidation {
  if (validateGrudgePatch(input)) return { ok: true, patch: input };
  const errors = (validateGrudgePatch.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim());
  return { ok: false, errors };
}

const num = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Apply a whitelisted patch to a spec. Ops beyond the per-kind caps are ignored;
 * the result is re-checked against the fairness invariants and throws if it fails.
 */
export function applyGrudge(spec: NemesisSpec, patch: GrudgePatch): NemesisSpec {
  const next = structuredClone(spec);
  const maxDamage = Math.min(LIMITS.damage.max, Math.floor(next.stats.maxHp * LIMITS.damageFractionOfHp.max));
  let addMoves = 0;
  let tunes = 0;
  let taunts = 0;

  for (const op of patch.ops) {
    switch (op.op) {
      case "addMove": {
        if (addMoves >= 1) break;
        const phaseIndex = Math.round(clamp(op.phaseIndex, 0, next.phases.length - 1));
        const phase = next.phases[phaseIndex];
        if (!phase || phase.moves.length >= LIMITS.movesPerPhase.max) break;
        phase.moves.push(clampMove(op.move, next.stats.maxHp));
        addMoves += 1;
        break;
      }
      case "tuneMove": {
        if (tunes >= 2) break;
        const phase = next.phases[Math.round(clamp(op.phaseIndex, 0, next.phases.length - 1))];
        if (!phase || phase.moves.length === 0) break;
        const move = phase.moves[Math.round(clamp(op.moveIndex, 0, phase.moves.length - 1))];
        if (!move) break;
        if (num(op.telegraphMs)) move.telegraphMs = Math.round(clamp(op.telegraphMs, LIMITS.telegraphMs.min, LIMITS.telegraphMs.max));
        if (num(op.damage)) move.damage = Math.round(clamp(op.damage, LIMITS.damage.min, maxDamage));
        if (num(op.scale)) move.scale = clamp(op.scale, LIMITS.scale.min, LIMITS.scale.max);
        if (num(op.count)) move.count = Math.round(clamp(op.count, LIMITS.count.min, LIMITS.count.max));
        tunes += 1;
        break;
      }
      case "tuneStats": {
        if (tunes >= 2) break;
        if (num(op.aggression)) next.stats.aggression = clamp(op.aggression, LIMITS.aggression.min, LIMITS.aggression.max);
        if (num(op.poise)) next.stats.poise = Math.round(clamp(op.poise, LIMITS.poise.min, LIMITS.poise.max));
        tunes += 1;
        break;
      }
      case "addTaunt": {
        if (taunts >= 1 || next.voice.lines.taunt.length >= LIMITS.taunts.max) break;
        const line = op.line.trim().slice(0, LIMITS.lineLength.max);
        if (!line) break;
        next.voice.lines.taunt.push(line);
        taunts += 1;
        break;
      }
      default:
        break;
    }
  }

  next.grudges.push({ observation: patch.observation, patch: patch.patch });
  next.lineage.gen += 1;

  const problems = checkInvariants(next);
  if (problems.length > 0) throw new Error(`grudge broke invariants: ${problems.join("; ")}`);
  return next;
}

const pct = (part: number, total: number): number => (total > 0 ? Math.round((part / total) * 100) : 0);

/** Human-readable summary of one death, shared by the Gemini prompt, tests, and debugging. */
export function describeDeath(log: DeathLog): string {
  const seconds = Math.round(log.durationMs / 1000);
  const parts: string[] = [`Survived ${seconds}s, reached phase ${log.phaseReached + 1}.`];

  const totalRolls = log.rolls.left + log.rolls.right + log.rolls.toward + log.rolls.away;
  if (totalRolls > 0) {
    const dirs = (["left", "right", "toward", "away"] as const).map((d) => `${d} ${pct(log.rolls[d], totalRolls)}%`).join(", ");
    parts.push(`Rolled ${totalRolls} times: ${dirs}; ${log.rollsDodged} dodged.`);
  } else {
    parts.push("Never rolled.");
  }

  const hits = Object.entries(log.hitsTaken).filter((entry): entry is [MoveType, number] => typeof entry[1] === "number" && entry[1] > 0);
  const totalHits = hits.reduce((sum, [, n]) => sum + n, 0);
  if (totalHits > 0) {
    const [topType, topCount] = hits.reduce((a, b) => (b[1] > a[1] ? b : a));
    parts.push(`Hit ${totalHits} times, mostly by ${topType} (${topCount})${log.killedBy ? `; killed by ${log.killedBy}` : ""}.`);
  } else {
    parts.push(`Took no recorded hits${log.killedBy ? `; killed by ${log.killedBy}` : ""}.`);
  }

  const totalAttacks = log.lightAttacks + log.heavyAttacks;
  if (totalAttacks > 0) {
    parts.push(`Attacked ${totalAttacks} times (heavy ${log.heavyAttacks}), ${log.attacksDuringTelegraph} during telegraphs, ${log.attacksDuringRecover} in recovery windows, ${log.weaknessHits} on the weakness.`);
  } else {
    parts.push("Never attacked.");
  }

  return parts.join(" ");
}

type RollDirection = keyof DeathLog["rolls"];
const ROLL_DIRECTIONS: RollDirection[] = ["left", "right", "toward", "away"];

const RULE1_MOVE: Record<RollDirection, Move> = {
  left: { type: "ring", telegraphMs: 900, damage: 16, scale: 1.2, count: 1 },
  right: { type: "ring", telegraphMs: 900, damage: 16, scale: 1.2, count: 1 },
  away: { type: "charge", telegraphMs: 900, damage: 20, scale: 1, count: 1 },
  toward: { type: "nova", telegraphMs: 1000, damage: 22, scale: 1.2, count: 1 },
};

const RULE1_PATCH: Record<RollDirection, string> = {
  left: "A closing ring now punishes sidesteps.",
  right: "A closing ring now punishes sidesteps.",
  away: "It charges the coward's road.",
  toward: "The air itself will burn the bold.",
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Deterministic zero-API grudge: read the death log, pick the first matching habit, write a whitelisted patch. */
export function ruleGrudge(spec: NemesisSpec, log: DeathLog): GrudgePatch {
  const phaseIndex = Math.min(Math.max(0, log.phaseReached), spec.phases.length - 1);
  const phase = spec.phases[phaseIndex] ?? spec.phases[0];
  const moves = phase?.moves ?? [];
  const killedByIndex = Math.max(0, moves.findIndex((m) => m.type === log.killedBy));
  const killedBy = moves[killedByIndex];

  const totalRolls = ROLL_DIRECTIONS.reduce((sum, d) => sum + log.rolls[d], 0);
  const dominant = ROLL_DIRECTIONS.reduce((a, b) => (log.rolls[b] > log.rolls[a] ? b : a));
  const dominantPct = pct(log.rolls[dominant], totalRolls);

  const totalAttacks = log.lightAttacks + log.heavyAttacks;
  const telegraphPct = pct(log.attacksDuringTelegraph, totalAttacks);

  let observation: string;
  let patch: string;
  const ops: GrudgeOp[] = [];

  if (totalRolls >= 4 && dominantPct >= 55) {
    const move = RULE1_MOVE[dominant];
    const existingIndex = moves.findIndex((m) => m.type === move.type);
    if (existingIndex >= 0) {
      const existing = moves[existingIndex]!;
      ops.push({ op: "tuneMove", phaseIndex, moveIndex: existingIndex, telegraphMs: existing.telegraphMs - 150, damage: existing.damage + 4 });
    } else {
      ops.push({ op: "addMove", phaseIndex, move });
    }
    observation = `You rolled ${dominant} ${dominantPct}% of the time.`;
    patch = RULE1_PATCH[dominant];
    ops.push({ op: "addTaunt", line: `${capitalize(dominant)} again? I know the way you flinch.` });
  } else if (totalAttacks >= 6 && telegraphPct >= 50) {
    const moveType = killedBy?.type ?? "sweep";
    ops.push({ op: "tuneMove", phaseIndex, moveIndex: killedByIndex, telegraphMs: (killedBy?.telegraphMs ?? 900) - 200 });
    observation = `You swing into ${telegraphPct}% of its wind-ups.`;
    patch = `Its ${moveType} comes faster.`;
    ops.push({ op: "addTaunt", line: "Swing into my wind-up again. I dare you." });
  } else {
    const moveType = log.killedBy ?? killedBy?.type ?? "its blows";
    const seconds = Math.round(log.durationMs / 1000);
    if (killedBy) ops.push({ op: "tuneMove", phaseIndex, moveIndex: killedByIndex, damage: killedBy.damage + 5 });
    ops.push({ op: "tuneStats", aggression: spec.stats.aggression + 0.1 });
    observation = `It killed you with ${moveType} after ${seconds}s.`;
    patch = "It grows bolder.";
    ops.push({ op: "addTaunt", line: `${capitalize(moveType)} remembers you. So do I.` });
  }

  return { observation, patch, ops };
}
