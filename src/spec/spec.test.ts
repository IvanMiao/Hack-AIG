import { describe, expect, it } from "vitest";
import { FALLBACK_SPECS } from "./fallback";
import { checkInvariants } from "./invariants";
import { LIMITS } from "./limits";
import { normalizeDraft } from "./normalize";
import { parseDeathLog, parseForgeDraft } from "./schema";
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

  it("rejects identity and weakness values outside the enums", () => {
    const hostile = structuredClone(FALLBACK_SPECS[0]!);
    (hostile.identity as { silhouette: string }).silhouette = "<img src=x onerror=alert(1)>";
    (hostile.weakness as { trigger: string }).trigger = "<svg onload=alert(1)>";
    const problems = checkInvariants(hostile);
    expect(problems).toContainEqual(expect.stringContaining("silhouette"));
    expect(problems).toContainEqual(expect.stringContaining("weakness trigger"));
  });
});

describe("parseDeathLog", () => {
  const log = () => ({
    durationMs: 42_000,
    rolls: { left: 3, right: 1, toward: 0, away: 2 },
    rollsDodged: 2,
    hitsTaken: { sweep: 2, arena: 1 },
    lightAttacks: 5,
    heavyAttacks: 1,
    attacksDuringTelegraph: 2,
    attacksDuringRecover: 1,
    weaknessHits: 0,
    killedBy: "sweep",
    phaseReached: 1,
    bossHpFractionAtDeath: 0.4,
  });

  it("accepts a real death log, including an arena kill", () => {
    expect(parseDeathLog(log()).ok).toBe(true);
    expect(parseDeathLog({ ...log(), killedBy: "arena" }).ok).toBe(true);
    expect(parseDeathLog({ ...log(), killedBy: null }).ok).toBe(true);
  });

  it("rejects unknown hazards and out-of-range counters", () => {
    expect(parseDeathLog({ ...log(), killedBy: "laser" }).ok).toBe(false);
    expect(parseDeathLog({ ...log(), phaseReached: -1 }).ok).toBe(false);
    expect(parseDeathLog({ ...log(), lightAttacks: "5" }).ok).toBe(false);
    expect(parseDeathLog(null).ok).toBe(false);
  });

  it("strips fields the log does not declare", () => {
    const input = { ...log(), hitsTaken: { sweep: 2, "<b>": 1 }, spec: {} };
    const result = parseDeathLog(input);
    expect(result.ok).toBe(true);
    expect(input.hitsTaken).toEqual({ sweep: 2 });
    expect("spec" in input).toBe(false);
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
