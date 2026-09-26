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

describe("souls feel", () => {
  const T = 1000 / 60;
  const tick = (b: ReturnType<typeof createBattle>, input: Partial<PlayerInput> = {}) => b.step({ ...IDLE_INPUT, ...input });
  const quiet = (seed = 1) => {
    const b = createBattle(spec, seed);
    b.debug.bossAi = false;
    b.state.player.pos = { x: 0, z: -2 };
    return b;
  };
  const untilIdle = (b: ReturnType<typeof createBattle>, maxMs = 3000) => {
    for (let t = 0; t < maxMs && b.state.player.action !== "idle"; t += T) tick(b);
  };

  it("a light pressed during the swing is buffered and chains into hit 2 inside the cancel window", () => {
    const b = quiet();
    tick(b, { light: true });
    expect(b.state.player.comboIndex).toBe(0);
    for (let i = 0; i < 6; i += 1) tick(b);
    tick(b, { light: true });
    expect(b.state.player.action).toBe("light");
    expect(b.state.player.comboIndex).toBe(0);
    let chainedAt: number | null = null;
    for (let t = 0; t < 1000; t += T) {
      const events = tick(b);
      if (events.some((e) => e.type === "playerAttack" && e.combo === 1)) { chainedAt = b.state.player.actionT; break; }
    }
    expect(chainedAt).not.toBeNull();
    const first = PLAYER.combo[0]!;
    expect(b.state.player.comboIndex).toBe(1);
    expect(first.windupMs + first.activeMs + first.recoverMs * PLAYER.cancel.lightIntoLight).toBeLessThan(first.windupMs + first.activeMs + first.recoverMs);
  });

  it("a press older than the buffer window is dropped", () => {
    const b = quiet();
    tick(b, { heavy: true });
    tick(b, { light: true });
    untilIdle(b);
    for (let t = 0; t < PLAYER.bufferMs + T; t += T) tick(b);
    expect(b.state.player.action).toBe("idle");
    expect(b.state.log.lightAttacks).toBe(0);
  });

  it("the light string runs three hits and the finisher hits harder, then restarts at hit 1", () => {
    const b = quiet();
    b.state.boss.hp = 1e6;
    const damages: number[] = [];
    const combos: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      for (let t = 0; t < 2000; t += T) {
        const events = tick(b, { light: t === 0 });
        for (const e of events) if (e.type === "bossHit") { damages.push(e.damage); combos.push(e.combo); }
        if (b.state.player.action === "idle" && t > 0 && i < 3 && b.state.player.comboIdleT >= PLAYER.comboResetMs / 2) break;
        if (b.state.player.action === "idle" && t > 0 && i === 3) break;
      }
      if (i === 2) for (let t = 0; t < PLAYER.comboResetMs + T; t += T) tick(b);
    }
    expect(combos).toEqual([0, 1, 2, 0]);
    expect(damages[2]).toBeGreaterThan(damages[0]!);
  });

  it("roll cancels a light recover immediately but a heavy only late", () => {
    const light = quiet();
    tick(light, { light: true });
    const l = PLAYER.combo[0]!;
    for (let t = T; t < l.windupMs + l.activeMs + T; t += T) tick(light);
    tick(light, { roll: true });
    expect(light.state.player.action).toBe("roll");

    const heavy = quiet();
    tick(heavy, { heavy: true });
    for (let t = T; t < PLAYER.heavy.windupMs + PLAYER.heavy.activeMs + T; t += T) tick(heavy);
    let rolledAt: number | null = null;
    for (let t = 0; t < PLAYER.heavy.recoverMs && rolledAt === null; t += T) {
      const before = heavy.state.player.actionT;
      tick(heavy, { roll: true });
      if (heavy.state.player.action === "roll") rolledAt = before;
    }
    const openAt = PLAYER.heavy.windupMs + PLAYER.heavy.activeMs + PLAYER.heavy.recoverMs * PLAYER.cancel.heavyIntoRoll;
    expect(rolledAt).not.toBeNull();
    expect(rolledAt!).toBeGreaterThanOrEqual(openAt - T);
    expect(rolledAt!).toBeLessThan(openAt + 2 * T);
  });

  it("holding heavy parks the windup, charges, and the release hits harder", () => {
    const plain = quiet();
    plain.state.boss.hp = 1e6;
    let plainDamage = 0;
    tick(plain, { heavy: true });
    for (let t = 0; t < 2000 && !plainDamage; t += T) for (const e of tick(plain)) if (e.type === "bossHit") plainDamage = e.damage;

    const charged = quiet();
    charged.state.boss.hp = 1e6;
    tick(charged, { heavy: true, heavyHeld: true });
    for (let t = 0; t < PLAYER.heavy.windupMs + 300; t += T) tick(charged, { heavyHeld: true });
    expect(charged.state.player.action).toBe("heavy");
    expect(charged.state.player.charging).toBe(true);
    expect(charged.state.player.charge).toBeGreaterThan(0.3);
    expect(charged.state.player.attackLanded).toBe(false);
    let chargedDamage = 0;
    let charge = 0;
    for (let t = 0; t < 2000 && !chargedDamage; t += T) for (const e of tick(charged)) if (e.type === "bossHit") { chargedDamage = e.damage; charge = e.charge; }
    expect(plainDamage).toBe(PLAYER.heavy.damage);
    expect(charge).toBeGreaterThan(0.3);
    expect(chargedDamage).toBeGreaterThan(plainDamage);

    const held = quiet();
    tick(held, { heavy: true, heavyHeld: true });
    for (let t = 0; t < PLAYER.heavy.windupMs + PLAYER.charge.maxMs + 500; t += T) tick(held, { heavyHeld: true });
    expect(held.state.player.charge).toBe(1);
    expect(held.state.player.charging).toBe(false);
    expect(held.state.player.actionT).toBeGreaterThan(PLAYER.heavy.windupMs);
  });

  it("a salvo landing on the same tick hurts once, stuns and shoves the player", () => {
    const b = quiet();
    const p = b.state.player;
    p.pos = { x: 0, z: 0 };
    for (let i = 0; i < 4; i += 1) b.state.projectiles.push({ id: 100 + i, pos: { x: -0.2 + i * 0.1, z: 0.5 }, vel: { x: 0, z: -6 }, radius: 0.5, damage: 10 });
    const events = tick(b);
    expect(events.filter((e) => e.type === "playerHit")).toHaveLength(1);
    expect(p.hp).toBe(PLAYER.maxHp - 10);
    expect(p.action).toBe("hurt");
    expect(p.hurtT).toBeGreaterThan(0);
    const before = p.pos.z;
    tick(b);
    expect(p.pos.z).toBeLessThan(before);
    for (let t = 0; t < PLAYER.hurt.stunMs + T; t += T) tick(b);
    expect(p.action).toBe("idle");
  });

  it("a hit during the post-hit grace is ignored; after it the player is vulnerable again", () => {
    const b = quiet();
    const p = b.state.player;
    p.pos = { x: 0, z: 0 };
    b.state.hazards.push({ id: 1, source: "zone", shape: { kind: "circle", center: { x: 0, z: 0 }, radius: 6 }, damage: 10, ttl: 10000, cooldown: 0, repeat: true, hit: false });
    tick(b);
    expect(p.hp).toBe(PLAYER.maxHp - 5);
    b.state.hazards.push({ id: 2, source: "nova", shape: { kind: "circle", center: { x: 0, z: 0 }, radius: 6 }, damage: 30, ttl: 200, cooldown: 0, repeat: false, hit: false });
    tick(b);
    expect(p.hp).toBe(PLAYER.maxHp - 5);
    for (let t = 0; t < PLAYER.hurt.invulnMs + T; t += T) tick(b);
    b.state.hazards.push({ id: 3, source: "nova", shape: { kind: "circle", center: { x: 0, z: 0 }, radius: 6 }, damage: 30, ttl: 200, cooldown: 0, repeat: false, hit: false });
    tick(b);
    expect(p.hp).toBe(PLAYER.maxHp - 35);
  });

  it("a roll that dodges within the perfect window refunds stamina; a late dodge is ordinary", () => {
    const hit = (b: ReturnType<typeof createBattle>) => {
      b.state.hazards.push({ id: 9, source: "sweep", shape: { kind: "circle", center: { x: 0, z: 0 }, radius: 40 }, damage: 30, ttl: 50, cooldown: 0, repeat: false, hit: false });
      return tick(b, { move: { x: 1, z: 0 } });
    };
    const perfect = quiet();
    tick(perfect, { roll: true, move: { x: 1, z: 0 } });
    const afterRoll = perfect.state.player.stamina;
    const events = hit(perfect);
    expect(events).toContainEqual({ type: "playerRoll", dodged: true, perfect: true });
    expect(perfect.state.player.stamina).toBeGreaterThan(afterRoll);
    expect(perfect.state.player.hp).toBe(PLAYER.maxHp);

    const late = quiet();
    tick(late, { roll: true, move: { x: 1, z: 0 } });
    for (let t = 0; t < PLAYER.perfectRoll.windowMs + T; t += T) tick(late);
    expect(late.state.player.actionT).toBeLessThanOrEqual(PLAYER.roll.iframeMs);
    const lateEvents = hit(late);
    expect(lateEvents).toContainEqual({ type: "playerRoll", dodged: true, perfect: false });
    expect(late.state.player.hp).toBe(PLAYER.maxHp);
  });

  it("the roll tail is vulnerable", () => {
    const b = quiet();
    tick(b, { roll: true, move: { x: 1, z: 0 } });
    for (let t = 0; t < PLAYER.roll.iframeMs + T; t += T) tick(b);
    expect(b.state.player.action).toBe("roll");
    b.state.hazards.push({ id: 9, source: "sweep", shape: { kind: "circle", center: { x: 0, z: 0 }, radius: 40 }, damage: 30, ttl: 50, cooldown: 0, repeat: false, hit: false });
    tick(b);
    expect(b.state.player.hp).toBe(PLAYER.maxHp - 30);
  });

  it("the opening move is a readable melee swing even when a ranged move is gentler", () => {
    const s: NemesisSpec = structuredClone(spec);
    s.phases[0]!.moves = [
      { type: "volley", telegraphMs: 800, damage: 5, scale: 1, count: 6 },
      { type: "sweep", telegraphMs: 900, damage: 20, scale: 1, count: 1 },
    ];
    const b = createBattle(s, 4);
    const events = run(b, IDLE_INPUT, 6000);
    const first = events.find((e) => e.type === "telegraph");
    expect(first).toEqual({ type: "telegraph", move: "sweep", ms: 900 });
  });

  it("distance bands: a far player draws gap-closers and ranged tools, a near one draws swings", () => {
    const s: NemesisSpec = structuredClone(spec);
    s.phases[0]!.moves = [
      { type: "sweep", telegraphMs: 800, damage: 10, scale: 1, count: 1 },
      { type: "charge", telegraphMs: 800, damage: 10, scale: 1, count: 1 },
      { type: "volley", telegraphMs: 800, damage: 10, scale: 1, count: 3 },
    ];
    const count = (pin: number) => {
      const b = createBattle(s, 8);
      b.debug.playerInvulnerable = true;
      const tally: Record<string, number> = {};
      for (let t = 0; t < 60000; t += T) {
        b.state.boss.pos = { x: 0, z: -pin / 2 };
        b.state.player.pos = { x: 0, z: pin / 2 };
        b.state.player.hp = PLAYER.maxHp;
        for (const e of b.step(IDLE_INPUT)) if (e.type === "telegraph") tally[e.move] = (tally[e.move] ?? 0) + 1;
      }
      return tally;
    };
    const far = count(18);
    const near = count(2);
    expect((far.charge ?? 0) + (far.volley ?? 0)).toBeGreaterThan((far.sweep ?? 0) * 3);
    expect(near.sweep ?? 0).toBeGreaterThan((near.charge ?? 0) + (near.volley ?? 0));
  });

  it("panic rolling stretches the next melee telegraph", () => {
    const b = createBattle(spec, 2);
    b.debug.bossAi = false;
    for (let i = 0; i < BOSS.panic.rolls; i += 1) {
      tick(b, { roll: true, move: { x: 1, z: 0 } });
      untilIdle(b);
    }
    b.state.player.stamina = PLAYER.maxStamina;
    expect(b.debug.forceMove("sweep")).toBe(true);
    const events = tick(b);
    const telegraph = events.find((e) => e.type === "telegraph");
    const sweep = spec.phases.flatMap((p) => p.moves).find((m) => m.type === "sweep");
    expect(telegraph?.type === "telegraph" ? telegraph.ms : 0).toBeCloseTo((sweep?.telegraphMs ?? 1000) * BOSS.panic.telegraphScale, 5);
  });
});
