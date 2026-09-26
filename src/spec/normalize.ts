import { LIMITS, clamp } from "./limits";
import type { ForgeDraft, Move, NemesisSpec, Phase, VoiceLines } from "./types";

export interface NormalizeResult {
  spec: NemesisSpec;
  repairs: string[];
}

const truncate = (text: string, max: number): string => text.trim().slice(0, max);

function normalizeMove(move: Move, maxHp: number, repairs: string[], label: string): Move {
  const maxDamage = Math.min(LIMITS.damage.max, Math.floor(maxHp * LIMITS.damageFractionOfHp.max));
  const next: Move = {
    type: move.type,
    telegraphMs: Math.round(clamp(move.telegraphMs, LIMITS.telegraphMs.min, LIMITS.telegraphMs.max)),
    damage: Math.round(clamp(move.damage, LIMITS.damage.min, maxDamage)),
    scale: clamp(move.scale, LIMITS.scale.min, LIMITS.scale.max),
    count: Math.round(clamp(move.count, LIMITS.count.min, LIMITS.count.max)),
  };
  if (move.followUp && move.followUp !== move.type) next.followUp = move.followUp;
  if (next.telegraphMs !== move.telegraphMs) repairs.push(`${label}: telegraph ${move.telegraphMs} → ${next.telegraphMs}`);
  if (next.damage !== move.damage) repairs.push(`${label}: damage ${move.damage} → ${next.damage}`);
  return next;
}

function normalizePhases(phases: Phase[], maxHp: number, repairs: string[]): Phase[] {
  const kept = phases.slice(0, LIMITS.phases.max);
  if (kept.length === 0) throw new Error("spec has no phases");
  if (kept.length !== phases.length) repairs.push(`phases ${phases.length} → ${kept.length}`);

  return kept.map((phase, index) => {
    const moves = phase.moves.slice(0, LIMITS.movesPerPhase.max)
      .map((move, moveIndex) => normalizeMove(move, maxHp, repairs, `phase${index + 1}.move${moveIndex + 1}`));
    while (moves.length < LIMITS.movesPerPhase.min) {
      const source = moves[moves.length % Math.max(1, moves.length)] ?? defaultMove();
      moves.push({ ...source });
      repairs.push(`phase${index + 1}: padded moves to ${LIMITS.movesPerPhase.min}`);
    }
    // Phase 1 always opens at full HP; later thresholds strictly descend so the fight can reach them.
    const previous = index === 0 ? 1.01 : (phases[index - 1]?.hpThreshold ?? 1);
    const threshold = index === 0 ? 1 : clamp(phase.hpThreshold, 0.15, Math.min(0.85, previous - 0.1));
    if (threshold !== phase.hpThreshold) repairs.push(`phase${index + 1}: hpThreshold ${phase.hpThreshold} → ${threshold}`);
    return { hpThreshold: threshold, moves, rule: phase.rule };
  });
}

const defaultMove = (): Move => ({ type: "sweep", telegraphMs: 900, damage: 18, scale: 1, count: 1 });

function normalizeLines(lines: VoiceLines, repairs: string[]): VoiceLines {
  const max = LIMITS.lineLength.max;
  const list = (items: string[], min: number, cap: number, fallback: string, label: string): string[] => {
    const cleaned = items.map((t) => truncate(t, max)).filter(Boolean).slice(0, cap);
    while (cleaned.length < min) { cleaned.push(fallback); repairs.push(`voice.${label}: padded`); }
    return cleaned;
  };
  return {
    intro: truncate(lines.intro, max) || "You called. I answered.",
    phase: truncate(lines.phase, max) || "Enough.",
    taunt: list(lines.taunt, LIMITS.taunts.min, LIMITS.taunts.max, "Again.", "taunt"),
    playerDeath: list(lines.playerDeath, LIMITS.playerDeathLines.min, LIMITS.playerDeathLines.max, "I remember that one.", "playerDeath"),
    defeat: truncate(lines.defeat, max) || "This is not the end of me.",
  };
}

/** Clamp a validated Gemini draft into a playable spec. Never throws on out-of-range values, only on missing phases. */
export function normalizeDraft(draft: ForgeDraft, code: string): NormalizeResult {
  const repairs: string[] = [];
  const maxHp = Math.round(clamp(draft.stats.maxHp, LIMITS.maxHp.min, LIMITS.maxHp.max));
  if (maxHp !== draft.stats.maxHp) repairs.push(`maxHp ${draft.stats.maxHp} → ${maxHp}`);

  const spec: NemesisSpec = {
    version: 1,
    code,
    lineage: { gen: 1, kills: 0 },
    identity: {
      ...draft.identity,
      name: truncate(draft.identity.name, LIMITS.nameLength.max) || "Nameless",
      title: truncate(draft.identity.title, LIMITS.nameLength.max * 2),
      incantation: truncate(draft.identity.incantation, LIMITS.incantationLength.max),
    },
    stats: {
      maxHp,
      poise: Math.round(clamp(draft.stats.poise, LIMITS.poise.min, LIMITS.poise.max)),
      aggression: clamp(draft.stats.aggression, LIMITS.aggression.min, LIMITS.aggression.max),
    },
    phases: normalizePhases(draft.phases, maxHp, repairs),
    weakness: {
      trigger: draft.weakness.trigger,
      multiplier: clamp(draft.weakness.multiplier, LIMITS.weaknessMultiplier.min, LIMITS.weaknessMultiplier.max),
    },
    arenaTheme: truncate(draft.arenaTheme, 120),
    voice: { designPrompt: truncate(draft.voice.designPrompt, 300), lines: normalizeLines(draft.voice.lines, repairs) },
    music: {
      p1Prompt: truncate(draft.music.p1Prompt, 300),
      p2Prompt: truncate(draft.music.p2Prompt, 300),
      bpm: Math.round(clamp(draft.music.bpm, LIMITS.bpm.min, LIMITS.bpm.max)),
    },
    art: {
      styleAnchor: truncate(draft.art.styleAnchor, 300),
      accentHex: draft.art.accentHex,
      skyPrompt: truncate(draft.art.skyPrompt, 300),
      portraitPrompt: truncate(draft.art.portraitPrompt, 300),
    },
    grudges: [],
  };
  return { spec, repairs };
}
