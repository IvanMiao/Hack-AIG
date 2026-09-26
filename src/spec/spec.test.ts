import { describe, expect, it } from "vitest";
import { FALLBACK_SPECS } from "./fallback";
import { checkInvariants } from "./invariants";
import { LIMITS } from "./limits";
import { normalizeDraft } from "./normalize";
import { parseForgeDraft } from "./schema";
import type { ForgeDraft, NemesisSpec } from "./types";

const draftFromSpec = (spec: NemesisSpec): ForgeDraft => ({
  identity: structuredClone(spec.identity),
  stats: { ...spec.stats },
  phases: structuredClone(spec.phases),
  weakness: { ...spec.weakness },
  arenaTheme: spec.arenaTheme,
  voice: { designPrompt: spec.voice.designPrompt, lines: structuredClone(spec.voice.lines) },
  music: { p1Prompt: spec.music.p1Prompt, p2Prompt: spec.music.p2Prompt, bpm: spec.music.bpm },
  art: { styleAnchor: spec.art.styleAnchor, accentHex: spec.art.accentHex, skyPrompt: spec.art.skyPrompt, portraitPrompt: spec.art.portraitPrompt },
});

const baseDraft = (): ForgeDraft => draftFromSpec(FALLBACK_SPECS[0]!);

describe("fallback specs", () => {
  it("pass the fairness invariants", () => {
    for (const spec of FALLBACK_SPECS) expect(checkInvariants(spec)).toEqual([]);
    const greedy = structuredClone(FALLBACK_SPECS[0]!);
    greedy.stats.playerDamage = 4;
    expect(checkInvariants(greedy)).toContainEqual(expect.stringContaining("playerDamage"));
  });
});

describe("parseForgeDraft", () => {
  it("accepts a well-formed draft and strips unknown fields", () => {
    const draft = { ...baseDraft(), extra: "junk" };
    const result = parseForgeDraft(draft);
    expect(result.ok).toBe(true);
    expect("extra" in draft).toBe(false);
  });

  it("rejects an unknown move type", () => {
    const draft = baseDraft();
    (draft.phases[0]!.moves[0] as { type: string }).type = "laser";
    const result = parseForgeDraft(draft);
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed palette color", () => {
    const draft = baseDraft();
    draft.identity.palette = ["red", "#000000", "#111111"];
    expect(parseForgeDraft(draft).ok).toBe(false);
  });
});

describe("normalizeDraft", () => {
  it("clamps unfair values and records repairs", () => {
    const draft = baseDraft();
    draft.stats.maxHp = 99999;
    draft.phases[0]!.moves[0]!.telegraphMs = 50;
    draft.phases[0]!.moves[1]!.damage = 900;
    const { spec, repairs } = normalizeDraft(draft, "TEST");
    expect(spec.stats.maxHp).toBe(LIMITS.maxHp.max);
    expect(spec.phases[0]!.moves[0]!.telegraphMs).toBe(LIMITS.telegraphMs.min);
    expect(spec.phases[0]!.moves[1]!.damage).toBeLessThanOrEqual(LIMITS.damage.max);
    expect(repairs.length).toBeGreaterThanOrEqual(3);
    expect(checkInvariants(spec)).toEqual([]);
  });

  it("forces phase thresholds to descend from 1", () => {
    const draft = baseDraft();
    draft.phases[0]!.hpThreshold = 0.4;
    draft.phases[1]!.hpThreshold = 0.95;
    const { spec } = normalizeDraft(draft, "TEST");
    expect(spec.phases[0]!.hpThreshold).toBe(1);
    expect(spec.phases[1]!.hpThreshold).toBeLessThan(1);
    expect(checkInvariants(spec)).toEqual([]);
  });

  it("pads a phase with too few moves", () => {
    const draft = baseDraft();
    draft.phases[0]!.moves = [draft.phases[0]!.moves[0]!, draft.phases[0]!.moves[1]!];
    const { spec } = normalizeDraft(draft, "TEST");
    expect(spec.phases[0]!.moves.length).toBe(LIMITS.movesPerPhase.min);
  });

  it("stamps code and fresh lineage", () => {
    const { spec } = normalizeDraft(baseDraft(), "ABC123");
    expect(spec.code).toBe("ABC123");
    expect(spec.lineage).toEqual({ gen: 1, kills: 0 });
    expect(spec.grudges).toEqual([]);
  });
});
