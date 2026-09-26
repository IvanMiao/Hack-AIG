import {
  applyGrudge, describeDeath, grudgePatchSchema, LIMITS, parseGrudgePatch, ruleGrudge,
  type NemesisSpec,
} from "../../src/spec";
import type { DeathLog } from "../../src/sim/types";
import type { Env } from "./env";
import { generateStructured } from "./gemini";

export interface LearnResult {
  spec: NemesisSpec;
  grudge: { observation: string; patch: string };
  source: "gemini" | "rule";
}

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 7;

export const LEARN_SYSTEM_PROMPT = `You are the memory of a NEMESIS boss. The player just died to you. From their death log, produce ONE grudge: a short observation about how they fought (second person, cruel, quotable, under 90 characters, e.g. "You rolled left 78% of the time."), a short description of the change you make ("patch", under 90 characters), and 1 to 3 whitelisted ops that make that exact habit fatal next time. Rules: at most one addMove (a move type this phase does not already have, telegraphMs ${LIMITS.telegraphMs.min}-${LIMITS.telegraphMs.max}, damage ${LIMITS.damage.min}-${LIMITS.damage.max}, scale ${LIMITS.scale.min}-${LIMITS.scale.max}, count ${LIMITS.count.min}-${LIMITS.count.max}), at most two tune ops with modest changes (telegraph -100 to -300ms, damage +3 to +10, aggression +0.05 to +0.15), and exactly one addTaunt: a line the boss will say next fight, referencing the habit, under ${LIMITS.lineLength.max} characters, no stage directions. phaseIndex is 0-based. The patch text must describe only the ops you actually emit (do not claim a damage change unless a damage op is present). Do not change what does not relate to the death.`;

const learnUserPrompt = (spec: NemesisSpec, deathLog: DeathLog): string => {
  const phases = spec.phases.map((p) => ({
    hpThreshold: p.hpThreshold,
    moves: p.moves.map((m) => ({ type: m.type, telegraphMs: m.telegraphMs, damage: m.damage })),
  }));
  return `Boss: ${spec.identity.name} (temper: ${spec.identity.temper})
Phases: ${JSON.stringify(phases)}
Death: ${describeDeath(deathLog)}`;
};

/** Gemini writes a whitelisted patch; any failure falls back to the deterministic rule grudge. */
export async function learnNemesis(env: Env, spec: NemesisSpec, deathLog: DeathLog): Promise<LearnResult> {
  let next: NemesisSpec;
  let source: LearnResult["source"] = "gemini";
  try {
    const raw = await generateStructured<unknown>(env, {
      system: LEARN_SYSTEM_PROMPT,
      user: learnUserPrompt(spec, deathLog),
      schema: grudgePatchSchema,
      temperature: 0.7,
    });
    const parsed = parseGrudgePatch(raw);
    if (!parsed.ok) throw new Error(`grudge patch invalid: ${parsed.errors.join("; ")}`);
    next = applyGrudge(spec, parsed.patch);
  } catch (cause) {
    console.warn("[learn] falling back to rule grudge", cause);
    next = applyGrudge(spec, ruleGrudge(spec, deathLog));
    source = "rule";
  }

  await env.NEMESIS_KV.put(`code:${next.code}`, JSON.stringify(next), { expirationTtl: CACHE_TTL_SECONDS });
  const grudge = next.grudges[next.grudges.length - 1] ?? { observation: "", patch: "" };
  return { spec: next, grudge, source };
}
