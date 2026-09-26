import { describe, expect, it } from "vitest";
import { getFallbackSpec } from "./fallback";
import { applyGrudge, describeDeath, parseGrudgePatch, ruleGrudge, type GrudgePatch } from "./grudge";
import { checkInvariants } from "./invariants";
import { LIMITS } from "./limits";
import type { DeathLog } from "../sim/types";

const log = (over: Partial<DeathLog>): DeathLog => ({
  durationMs: 48000,
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
  ...over,
});

describe("ruleGrudge + applyGrudge", () => {
  it("punishes left-heavy rolling with a ring move", () => {
    const spec = getFallbackSpec();
    const death = log({
      rolls: { left: 11, right: 1, toward: 0, away: 2 },
      rollsDodged: 5,
      hitsTaken: { sweep: 5, thrust: 4 },
      lightAttacks: 16,
      heavyAttacks: 6,
      killedBy: "sweep",
    });
    const next = applyGrudge(spec, ruleGrudge(spec, death));
    expect(checkInvariants(next)).toEqual([]);
    expect(next.lineage.gen).toBe(2);
    expect(next.grudges.length).toBe(1);
    const phase = next.phases[0]!;
    expect(phase.moves.some((m) => m.type === "ring")).toBe(true);
    expect(phase.moves.length).toBeLessThanOrEqual(LIMITS.movesPerPhase.max);
  });

  it("hastens the killer move when the player spams telegraphs", () => {
    const spec = getFallbackSpec();
    const before = spec.phases[0]!.moves[0]!.telegraphMs;
    const death = log({
      rolls: { left: 1, right: 1, toward: 1, away: 1 },
      lightAttacks: 16,
      heavyAttacks: 6,
      attacksDuringTelegraph: 12,
      killedBy: "sweep",
    });
    const next = applyGrudge(spec, ruleGrudge(spec, death));
    expect(checkInvariants(next)).toEqual([]);
    expect(next.lineage.gen).toBe(2);
    expect(next.grudges.length).toBe(1);
    expect(next.phases[0]!.moves[0]!.telegraphMs).toBe(before - 200);
  });

  it("falls back to damage + aggression on a neutral death", () => {
    const spec = getFallbackSpec();
    const death = log({
      lightAttacks: 4,
      heavyAttacks: 1,
      attacksDuringTelegraph: 1,
      hitsTaken: { thrust: 3 },
      killedBy: "thrust",
    });
    const next = applyGrudge(spec, ruleGrudge(spec, death));
    expect(checkInvariants(next)).toEqual([]);
    expect(next.lineage.gen).toBe(2);
    expect(next.grudges.length).toBe(1);
    expect(next.stats.aggression).toBeCloseTo(spec.stats.aggression + 0.1, 5);
    const thrust = next.phases[0]!.moves.find((m) => m.type === "thrust")!;
    expect(thrust.damage).toBe(spec.phases[0]!.moves.find((m) => m.type === "thrust")!.damage + 5);
  });
});

describe("applyGrudge", () => {
  it("clamps tuneMove values into LIMITS", () => {
    const spec = getFallbackSpec();
    const patch: GrudgePatch = {
      observation: "o",
      patch: "p",
      ops: [{ op: "tuneMove", phaseIndex: 0, moveIndex: 0, damage: 999, telegraphMs: 50 }],
    };
    const next = applyGrudge(spec, patch);
    const move = next.phases[0]!.moves[0]!;
    expect(move.damage).toBeLessThanOrEqual(LIMITS.damage.max);
    expect(move.damage).toBeLessThanOrEqual(Math.floor(next.stats.maxHp * LIMITS.damageFractionOfHp.max));
    expect(move.telegraphMs).toBe(LIMITS.telegraphMs.min);
  });

  it("ignores a second addMove and never exceeds movesPerPhase.max", () => {
    const spec = getFallbackSpec();
    const move = { type: "ring" as const, telegraphMs: 900, damage: 16, scale: 1.2, count: 1 };
    const patch: GrudgePatch = {
      observation: "o",
      patch: "p",
      ops: [
        { op: "addMove", phaseIndex: 0, move },
        { op: "addMove", phaseIndex: 0, move: { ...move, type: "nova" } },
      ],
    };
    const next = applyGrudge(spec, patch);
    const phase = next.phases[0]!;
    expect(phase.moves.filter((m) => m.type === "ring").length).toBe(1);
    expect(phase.moves.some((m) => m.type === "nova")).toBe(false);
    expect(phase.moves.length).toBeLessThanOrEqual(LIMITS.movesPerPhase.max);

    // A phase already at cap skips addMove entirely.
    const full = getFallbackSpec();
    while (full.phases[0]!.moves.length < LIMITS.movesPerPhase.max) {
      full.phases[0]!.moves.push({ type: "volley", telegraphMs: 900, damage: 10, scale: 1, count: 2 });
    }
    const after = applyGrudge(full, { observation: "o", patch: "p", ops: [{ op: "addMove", phaseIndex: 0, move }] });
    expect(after.phases[0]!.moves.length).toBe(LIMITS.movesPerPhase.max);
  });
});

describe("parseGrudgePatch", () => {
  it("rejects an unknown op", () => {
    const result = parseGrudgePatch({ observation: "o", patch: "p", ops: [{ op: "stealSoul" }] });
    expect(result.ok).toBe(false);
  });

  it("accepts a valid patch with null optional fields", () => {
    const result = parseGrudgePatch({
      observation: "You rolled left 78% of the time.",
      patch: "A ring punishes sidesteps.",
      ops: [
        { op: "tuneMove", phaseIndex: 0, moveIndex: 0, telegraphMs: 800, damage: null, scale: null, count: null },
        { op: "tuneStats", aggression: null, poise: 55 },
        { op: "addTaunt", line: "Left again?" },
      ],
    });
    expect(result.ok).toBe(true);
  });
});

describe("describeDeath", () => {
  it("handles zero rolls and zero attacks without NaN", () => {
    const text = describeDeath(log({}));
    expect(text).not.toContain("NaN");
    expect(text).toContain("Never rolled.");
    expect(text).toContain("Never attacked.");
  });

  it("summarizes a representative death", () => {
    const text = describeDeath(log({
      rolls: { left: 11, right: 1, toward: 0, away: 2 },
      rollsDodged: 5,
      hitsTaken: { sweep: 5, thrust: 4 },
      lightAttacks: 16,
      heavyAttacks: 6,
      attacksDuringTelegraph: 12,
      attacksDuringRecover: 4,
      weaknessHits: 2,
      killedBy: "charge",
    }));
    expect(text).toContain("Survived 48s, reached phase 1.");
    expect(text).toContain("left 79%");
    expect(text).toContain("killed by charge");
    expect(text).toContain("Attacked 22 times (heavy 6)");
  });
});
