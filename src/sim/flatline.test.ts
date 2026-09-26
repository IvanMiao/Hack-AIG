import { describe, expect, it } from "vitest";
import { CODEX_CODE, getFallbackSpecByCode } from "../spec/fallback";
import type { NemesisSpec } from "../spec";
import { createBattle, IDLE_INPUT } from "./battle";
import { AVERAGE_BOT, DIFFICULTY_BAND, measureDifficulty } from "./bot";
import { ARENA_PILLARS, FLAT, PLAYER } from "./constants";
import type { PlayerInput } from "./types";

const codex = getFallbackSpecByCode(CODEX_CODE) as NemesisSpec;
const TICK = 1000 / 60;
const run = (b: ReturnType<typeof createBattle>, input: PlayerInput, ms: number) => {
  const out = [];
  for (let t = 0; t < ms; t += TICK) out.push(...b.step(input));
  return out;
};
/** A CODEX-01 bout already in its flatline phase, with the fight paused at the transition's invulnerability. */
const flatBattle = (seed = 1) => {
  const b = createBattle(codex, seed);
  b.state.boss.hp = codex.stats.maxHp * 0.49;
  b.state.player.pos = { x: 6, z: 4 };
  b.state.boss.pos = { x: -4, z: -3 };
  run(b, IDLE_INPUT, TICK * 2);
  return b;
};

describe("flatline phase (CODEX-01 phase 2)", () => {
  it("CODEX-01 reaches flatline at its phase-2 threshold and stays within the difficulty band", () => {
    expect(codex.phases[1]?.rule).toBe("flatline");
    const b = createBattle(codex, 1);
    expect(b.state.flat).toBe(false);
    b.state.boss.hp = codex.stats.maxHp * 0.49;
    const events = run(b, IDLE_INPUT, TICK * 2);
    expect(events.some((e) => e.type === "phaseChange" && e.phaseIndex === 1)).toBe(true);
    expect(b.state.flat).toBe(true);
    const report = measureDifficulty(codex, 24, AVERAGE_BOT);
    expect(report.bossWinRate).toBeGreaterThanOrEqual(DIFFICULTY_BAND.min);
    expect(report.bossWinRate).toBeLessThanOrEqual(DIFFICULTY_BAND.max);
  });

  it("scales the player's hits by stats.playerDamage so phase 2 arrives sooner", () => {
    expect(codex.stats.playerDamage).toBeGreaterThan(1);
    const b = createBattle(codex, 1);
    b.state.player.pos = { x: 0, z: -2 };
    const hit = run(b, { ...IDLE_INPUT, light: true }, 600).find((e) => e.type === "bossHit");
    expect(hit && hit.type === "bossHit" && hit.damage).toBe(Math.round(PLAYER.light.damage * codex.stats.playerDamage!));
  });

  it("shatters any standing pillars when the arena folds", () => {
    expect(codex.phases[0]?.rule).toBe("pillars");
    const b = createBattle(codex, 1);
    expect(b.state.arena.obstacles.length).toBeGreaterThan(0);
    b.state.boss.hp = codex.stats.maxHp * 0.49;
    const events = run(b, IDLE_INPUT, TICK * 2);
    expect(events.filter((e) => e.type === "obstacleBroken")).toHaveLength(ARENA_PILLARS.count);
    expect(b.state.arena.obstacles).toEqual([]);
  });

  it("collapses both fighters onto the lane and ignores forward/back input", () => {
    const b = flatBattle();
    run(b, { ...IDLE_INPUT, move: { x: 0, z: 1 } }, 1500);
    expect(Math.abs(b.state.player.pos.z)).toBeLessThan(0.02);
    expect(Math.abs(b.state.boss.pos.z)).toBeLessThan(0.02);
    const before = b.state.player.pos.x;
    run(b, { ...IDLE_INPUT, move: { x: 1, z: 0 } }, 500);
    expect(b.state.player.pos.x).toBeGreaterThan(before + 1);
    expect(b.state.player.pos.z).toBe(0);
  });

  it("jump follows a gravity arc and lands back on the floor; roll is retired while flat", () => {
    const b = flatBattle();
    run(b, IDLE_INPUT, 800);
    b.step({ ...IDLE_INPUT, jump: true, roll: true });
    expect(b.state.player.action).not.toBe("roll");
    expect(b.state.player.vy).toBeGreaterThan(0);
    let apex = 0;
    for (let t = 0; t < 1500 && (b.state.player.y > 0 || b.state.player.vy > 0); t += TICK) {
      b.step(IDLE_INPUT);
      apex = Math.max(apex, b.state.player.y);
    }
    const expectedApex = FLAT.jumpVelocity ** 2 / (2 * FLAT.gravity);
    expect(apex).toBeGreaterThan(expectedApex * 0.85);
    expect(apex).toBeLessThanOrEqual(expectedApex + 0.2);
    expect(b.state.player.y).toBe(0);
    expect(b.state.player.vy).toBe(0);
    // No double jump mid-air.
    b.step({ ...IDLE_INPUT, jump: true });
    b.step({ ...IDLE_INPUT, jump: true });
    b.step({ ...IDLE_INPUT, jump: true });
    expect(b.state.player.vy).toBeLessThanOrEqual(FLAT.jumpVelocity);
    expect(b.state.player.y).toBeLessThan(0.5);
  });

  it("outside flatline, jump input does nothing and the player stays grounded", () => {
    const b = createBattle(codex, 1);
    run(b, { ...IDLE_INPUT, jump: true }, 500);
    expect(b.state.flat).toBe(false);
    expect(b.state.player.y).toBe(0);
    expect(b.state.player.vy).toBe(0);
  });

  it("ground hazards miss a player who is in the air", () => {
    const grounded = flatBattle(5);
    const airborne = flatBattle(5);
    grounded.state.player.hp = airborne.state.player.hp = 1e6;
    let groundedHits = 0;
    let airborneHits = 0;
    for (let t = 0; t < 30000; t += TICK) {
      for (const e of grounded.step(IDLE_INPUT)) if (e.type === "playerHit") groundedHits += 1;
      // Hold the player at a fixed height every tick so only the height check differs between the two runs.
      airborne.state.player.y = FLAT.groundHazardHeight + 0.2;
      airborne.state.player.vy = 0;
      for (const e of airborne.step(IDLE_INPUT)) if (e.type === "playerHit") airborneHits += 1;
    }
    expect(groundedHits).toBeGreaterThan(0);
    expect(airborneHits).toBeLessThan(groundedHits);
  });

  it("flatline volleys stream along the lane at two heights and only hit at matching height", () => {
    const b = flatBattle(2);
    b.state.player.hp = 1e6;
    let sawLow = false;
    let sawHigh = false;
    for (let t = 0; t < 30000 && !(sawLow && sawHigh); t += TICK) {
      b.step(IDLE_INPUT);
      for (const p of b.state.projectiles) {
        expect(Math.abs(p.pos.z)).toBeLessThan(0.05);
        expect(Math.abs(p.vel.z)).toBeLessThan(1e-6);
        if (p.y === FLAT.volley.lowY) sawLow = true;
        if (p.y === FLAT.volley.highY) sawHigh = true;
      }
    }
    expect(sawLow && sawHigh).toBe(true);
  });

  it("landing on the boss from above deals a light hit and bounces", () => {
    const b = flatBattle(3);
    run(b, IDLE_INPUT, 1800);
    b.state.player.pos = { x: b.state.boss.pos.x + 0.3, z: 0 };
    b.state.player.y = FLAT.stomp.minY + 0.6;
    b.state.player.vy = -4;
    const hp = b.state.boss.hp;
    const events = run(b, IDLE_INPUT, TICK * 3);
    expect(events.some((e) => e.type === "bossHit")).toBe(true);
    expect(b.state.boss.hp).toBeLessThanOrEqual(hp - PLAYER.light.damage + 1e-6);
    expect(b.state.player.vy).toBeGreaterThan(0);
  });
});
