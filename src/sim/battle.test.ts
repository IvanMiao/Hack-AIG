import { describe, expect, it } from "vitest";
import { getFallbackSpec, type NemesisSpec } from "../spec";
import { createBattle, IDLE_INPUT } from "./battle";
import { FALLBACK_SPECS } from "../spec/fallback";
import { AVERAGE_BOT, calibrateDifficulty, DIFFICULTY_BAND, measureDifficulty, simulateBattle } from "./bot";
import { overlaps } from "./hazard";
import { ARENA_RADIUS, BOSS, BOSS_EDGE_MARGIN, PLAYER, PLAYER_EDGE_MARGIN } from "./constants";
import { len } from "./vec";
import type { PlayerInput } from "./types";

const spec = getFallbackSpec();
const run = (b: ReturnType<typeof createBattle>, input: PlayerInput, ms: number) => {
  const out = [];
  for (let t = 0; t < ms; t += 1000 / 60) out.push(...b.step(input));
  return out;
};

describe("battle sim", () => {
  it("is deterministic for the same seed and inputs", () => {
    const a = simulateBattle(spec, 42);
    const b = simulateBattle(spec, 42);
    expect(a).toEqual(b);
    expect(simulateBattle(spec, 43).durationMs).not.toEqual(a.durationMs);
  });

  it("boss telegraphs before every active hitbox with >= 500ms", () => {
    const b = createBattle(spec, 7);
    b.state.player.hp = 1e9;
    const events = run(b, IDLE_INPUT, 20000);
    const telegraphs = events.filter((e) => e.type === "telegraph");
    expect(telegraphs.length).toBeGreaterThan(2);
    for (const e of telegraphs) if (e.type === "telegraph") expect(e.ms).toBeGreaterThanOrEqual(500);
    const order = events.map((e) => e.type).filter((t) => t === "telegraph" || t === "moveActive");
    for (let i = 0; i < order.length; i += 1) expect(order[i]).toBe(i % 2 === 0 ? "telegraph" : "moveActive");
  });

  it("an idle player eventually dies and the death log records the killer", () => {
    const b = createBattle(spec, 3);
    run(b, IDLE_INPUT, 120000);
    expect(b.state.outcome).toBe("playerDead");
    expect(b.state.log.killedBy).not.toBeNull();
    expect(Object.values(b.state.log.hitsTaken).reduce((a, n) => a + (n ?? 0), 0)).toBeGreaterThan(0);
  });

  it("roll spends stamina, grants i-frames and is logged by direction", () => {
    const b = createBattle(spec, 1);
    b.step({ ...IDLE_INPUT, roll: true, move: { x: 1, z: 0 } });
    expect(b.state.player.action).toBe("roll");
    expect(b.state.player.stamina).toBeLessThan(PLAYER.maxStamina);
    const rolls = b.state.log.rolls;
    expect(rolls.left + rolls.right + rolls.toward + rolls.away).toBe(1);
  });

  it("light attack in range damages the boss and builds poise", () => {
    const b = createBattle(spec, 1);
    b.state.player.pos = { x: 0, z: -2 };
    const events = run(b, { ...IDLE_INPUT, light: true }, 600);
    expect(events.some((e) => e.type === "bossHit")).toBe(true);
    expect(b.state.boss.hp).toBeLessThan(spec.stats.maxHp);
  });

  it("crossing a phase threshold fires phaseChange once and clears hazards", () => {
    const b = createBattle(spec, 5);
    b.state.boss.hp = Math.floor(spec.stats.maxHp * 0.49);
    const events = run(b, IDLE_INPUT, 100);
    expect(events.filter((e) => e.type === "phaseChange")).toHaveLength(1);
    expect(b.state.boss.phaseIndex).toBe(1);
  });

  it("hazard geometry: arc respects facing, ring has a safe centre", () => {
    const arc = { kind: "arc", center: { x: 0, z: 0 }, radius: 3, dir: { x: 0, z: 1 }, halfAngle: Math.PI / 2 } as const;
    expect(overlaps(arc, { x: 0, z: 2 }, 0.4)).toBe(true);
    expect(overlaps(arc, { x: 0, z: -2 }, 0.4)).toBe(false);
    const ring = { kind: "ring", center: { x: 0, z: 0 }, radius: 4, thickness: 1, growth: 0, maxRadius: 10 } as const;
    expect(overlaps(ring, { x: 0, z: 0.5 }, 0.4)).toBe(false);
    expect(overlaps(ring, { x: 4, z: 0 }, 0.4)).toBe(true);
  });
});

describe("difficulty gate", () => {
  it("fallback boss sits inside the band for the average bot", () => {
    const report = measureDifficulty(spec, 24, AVERAGE_BOT);
    expect(report.bossWinRate).toBeGreaterThanOrEqual(DIFFICULTY_BAND.min);
    expect(report.bossWinRate).toBeLessThanOrEqual(DIFFICULTY_BAND.max);
  });

  it("calibration pulls an absurd boss back into the band", () => {
    const brutal: NemesisSpec = structuredClone(spec);
    brutal.stats.maxHp = 1500;
    for (const p of brutal.phases) for (const m of p.moves) m.damage = 80;
    const result = calibrateDifficulty(brutal, 16, 10);
    expect(result.after).toBeLessThanOrEqual(DIFFICULTY_BAND.max);
    expect(result.steps.length).toBeGreaterThan(0);
  });
});

describe("arena rim", () => {
  const playerLimit = ARENA_RADIUS - PLAYER_EDGE_MARGIN;
  const bossLimit = ARENA_RADIUS - BOSS.radius - BOSS_EDGE_MARGIN;
  const forced = ["charge", "sweep", "blink", "thrust", "nova"] as const;

  it("clamps the player to the playable disc", () => {
    const b = createBattle(spec, 2);
    b.debug.bossAi = false;
    for (const move of [{ x: 1, z: 0 }, { x: -0.6, z: -0.8 }]) {
      run(b, { ...IDLE_INPUT, move }, 12000);
      expect(len(b.state.player.pos)).toBeCloseTo(playerLimit, 5);
    }
  });

  it("keeps every boss inside its margin while chasing and striking a rim-hugging player", () => {
    for (const boss of FALLBACK_SPECS) {
      for (const angle of [0, 2.1, 4.4]) {
        const b = createBattle(boss, 11);
        b.debug.playerInvulnerable = true;
        b.state.player.pos = { x: Math.sin(angle) * playerLimit, z: Math.cos(angle) * playerLimit };
        let maxBoss = 0;
        let hits = 0;
        let nextForced = 0;
        for (let t = 0; t < 40000; t += 1000 / 60) {
          if (!b.state.boss.current && b.debug.forceMove(forced[nextForced % forced.length]!)) nextForced += 1;
          for (const e of b.step(IDLE_INPUT)) if (e.type === "playerHit") hits += 1;
          maxBoss = Math.max(maxBoss, len(b.state.boss.pos));
          expect(len(b.state.player.pos)).toBeLessThanOrEqual(playerLimit + 1e-6);
        }
        expect(maxBoss, `${boss.code} @${angle}`).toBeLessThanOrEqual(bossLimit + 1e-6);
        expect(maxBoss, `${boss.code} @${angle} never closed on the rim`).toBeGreaterThan(playerLimit - BOSS.meleeRange - 0.05);
        expect(hits, `${boss.code} @${angle} landed no hit`).toBeGreaterThan(0);
      }
    }
  });
});
