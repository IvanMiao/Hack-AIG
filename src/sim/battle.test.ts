import { describe, expect, it } from "vitest";
import { getFallbackSpec, type NemesisSpec } from "../spec";
import { blockedByObstacle, createBattle, IDLE_INPUT } from "./battle";
import { FALLBACK_SPECS } from "../spec/fallback";
import { AVERAGE_BOT, calibrateDifficulty, DIFFICULTY_BAND, measureDifficulty, simulateBattle } from "./bot";
import { overlaps } from "./hazard";
import { ARENA_MUTATOR, ARENA_PILLARS, ARENA_RADIUS, ARENA_SHRINK, BOSS, BOSS_EDGE_MARGIN, PLAYER, PLAYER_EDGE_MARGIN } from "./constants";
import { mutatorForElement } from "./arena";
import type { Element } from "../spec";
import { add, dist, len, norm, sub } from "./vec";
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
    brutal.stats.playerDamage = 1;
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
    expect(plainDamage).toBe(Math.round(PLAYER.heavy.damage * (plain.spec.stats.playerDamage ?? 1)));
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
    for (let i = 0; i < 4; i += 1) b.state.projectiles.push({ id: 100 + i, pos: { x: -0.2 + i * 0.1, z: 0.5 }, vel: { x: 0, z: -6 }, radius: 0.5, damage: 10, y: 0 });
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
    b.state.hazards.push({ id: 1, source: "zone", shape: { kind: "circle", center: { x: 0, z: 0 }, radius: 6 }, damage: 10, ttl: 10000, cooldown: 0, repeat: true, hit: false, armMs: 0, armT: 0 });
    tick(b);
    expect(p.hp).toBe(PLAYER.maxHp - 5);
    b.state.hazards.push({ id: 2, source: "nova", shape: { kind: "circle", center: { x: 0, z: 0 }, radius: 6 }, damage: 30, ttl: 200, cooldown: 0, repeat: false, hit: false, armMs: 0, armT: 0 });
    tick(b);
    expect(p.hp).toBe(PLAYER.maxHp - 5);
    for (let t = 0; t < PLAYER.hurt.invulnMs + T; t += T) tick(b);
    b.state.hazards.push({ id: 3, source: "nova", shape: { kind: "circle", center: { x: 0, z: 0 }, radius: 6 }, damage: 30, ttl: 200, cooldown: 0, repeat: false, hit: false, armMs: 0, armT: 0 });
    tick(b);
    expect(p.hp).toBe(PLAYER.maxHp - 35);
  });

  it("a roll that dodges within the perfect window refunds stamina; a late dodge is ordinary", () => {
    const hit = (b: ReturnType<typeof createBattle>) => {
      b.state.hazards.push({ id: 9, source: "sweep", shape: { kind: "circle", center: { x: 0, z: 0 }, radius: 40 }, damage: 30, ttl: 50, cooldown: 0, repeat: false, hit: false, armMs: 0, armT: 0 });
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
    b.state.hazards.push({ id: 9, source: "sweep", shape: { kind: "circle", center: { x: 0, z: 0 }, radius: 40 }, damage: 30, ttl: 50, cooldown: 0, repeat: false, hit: false, armMs: 0, armT: 0 });
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

describe("closing_ring", () => {
  const ringed = (): NemesisSpec => {
    const s = structuredClone(spec);
    s.phases[1]!.rule = "closing_ring";
    return s;
  };

  it("starts at the full radius and shrinks over the phase change", () => {
    const b = createBattle(ringed(), 5);
    b.debug.playerInvulnerable = true;
    expect(b.state.arena.radius).toBe(ARENA_RADIUS);
    b.state.boss.hp = Math.floor(spec.stats.maxHp * 0.49);
    const events = run(b, IDLE_INPUT, 100);
    const shrink = events.find((e) => e.type === "arenaShrink");
    expect(shrink).toEqual({ type: "arenaShrink", from: ARENA_RADIUS, to: ARENA_RADIUS * ARENA_SHRINK.factor, ms: ARENA_SHRINK.shrinkMs });
    expect(b.state.arena.radius).toBeLessThan(ARENA_RADIUS);
    run(b, IDLE_INPUT, ARENA_SHRINK.shrinkMs);
    expect(b.state.arena.radius).toBeCloseTo(ARENA_RADIUS * ARENA_SHRINK.factor, 6);
  });

  it("pushes a rim-hugging player and boss inside the new disc", () => {
    const b = createBattle(ringed(), 3);
    b.debug.bossAi = false;
    b.debug.playerInvulnerable = true;
    run(b, { ...IDLE_INPUT, move: { x: 1, z: 0 } }, 12000);
    b.state.boss.pos = { x: 0, z: -(ARENA_RADIUS - BOSS.radius - BOSS_EDGE_MARGIN) };
    b.state.boss.hp = Math.floor(spec.stats.maxHp * 0.49);
    run(b, { ...IDLE_INPUT, move: { x: 1, z: 0 } }, ARENA_SHRINK.shrinkMs + 500);
    const r = b.state.arena.radius;
    expect(len(b.state.player.pos)).toBeCloseTo(r - PLAYER_EDGE_MARGIN, 5);
    b.debug.forceMove("charge");
    run(b, IDLE_INPUT, 3000);
    expect(len(b.state.boss.pos)).toBeLessThanOrEqual(r - BOSS.radius - BOSS_EDGE_MARGIN + 1e-6);
  });

  it("never shrinks below the floor and applies an opening-phase rule instantly", () => {
    const s = ringed();
    s.phases[0]!.rule = "closing_ring";
    const b = createBattle(s, 1);
    expect(b.state.arena.radius).toBeCloseTo(ARENA_RADIUS * ARENA_SHRINK.factor, 6);
    expect(b.step(IDLE_INPUT).some((e) => e.type === "arenaShrink")).toBe(false);
    for (let i = 0; i < 10; i += 1) b.state.arena.targetRadius = Math.max(ARENA_SHRINK.minRadius, b.state.arena.targetRadius * ARENA_SHRINK.factor);
    expect(b.state.arena.targetRadius).toBe(ARENA_SHRINK.minRadius);
  });

  it("stays deterministic with a shrinking arena", () => {
    const a = simulateBattle(ringed(), 9);
    const c = simulateBattle(ringed(), 9);
    expect(a).toEqual(c);
  });
});

describe("pillars", () => {
  const pillared = (base: NemesisSpec = spec): NemesisSpec => {
    const s = structuredClone(base);
    s.phases[0]!.rule = "pillars";
    return s;
  };

  it("raises solid cover on the opening phase, clear of both fighters", () => {
    const b = createBattle(pillared(), 1);
    const obstacles = b.state.arena.obstacles;
    expect(obstacles).toHaveLength(ARENA_PILLARS.count);
    for (const o of obstacles) {
      expect(o.hp).toBe(ARENA_PILLARS.hp);
      expect(dist(o.pos, b.state.player.pos)).toBeGreaterThan(o.radius + PLAYER.radius);
      expect(dist(o.pos, b.state.boss.pos)).toBeGreaterThan(o.radius + BOSS.radius);
      expect(len(o.pos) + o.radius).toBeLessThan(ARENA_RADIUS - PLAYER_EDGE_MARGIN);
    }
  });

  it("pushes the player out of a pillar and blocks projectiles behind it", () => {
    const b = createBattle(pillared(), 2);
    b.debug.bossAi = false;
    const o = b.state.arena.obstacles[0]!;
    b.state.player.pos = { ...o.pos };
    b.step(IDLE_INPUT);
    expect(dist(b.state.player.pos, o.pos)).toBeGreaterThanOrEqual(o.radius + PLAYER.radius - 1e-6);

    const away = norm(sub(o.pos, b.state.boss.pos));
    b.state.player.pos = add(o.pos, away, o.radius + PLAYER.radius + 0.2);
    expect(b.debug.forceMove("volley")).toBe(true);
    const events = run(b, IDLE_INPUT, 4000);
    expect(events.some((e) => e.type === "obstacleHit" && e.by === "volley")).toBe(true);
    expect(events.some((e) => e.type === "playerHit")).toBe(false);
    expect(o.hp).toBe(ARENA_PILLARS.hp);
  });

  it("charge smashes through cover and slides around it while walking", () => {
    const b = createBattle(pillared(), 3);
    b.debug.playerInvulnerable = true;
    const o = b.state.arena.obstacles[0]!;
    const toPillar = norm(sub(o.pos, b.state.boss.pos));
    b.state.boss.pos = add(o.pos, toPillar, -3);
    b.state.player.pos = add(o.pos, toPillar, 4);
    expect(b.debug.forceMove("charge")).toBe(true);
    const events = run(b, IDLE_INPUT, 3000);
    expect(events.some((e) => e.type === "obstacleBroken" && e.by === "charge" && e.id === o.id)).toBe(true);
    expect(b.state.arena.obstacles.some((x) => x.id === o.id)).toBe(false);

    const walk = createBattle(pillared(), 3);
    walk.debug.bossAi = false;
    const cover = walk.state.arena.obstacles[0]!;
    const axis = norm(sub(cover.pos, walk.state.boss.pos));
    walk.state.boss.pos = add(cover.pos, axis, -4);
    walk.state.player.pos = add(cover.pos, axis, 4);
    const start = dist(walk.state.boss.pos, walk.state.player.pos);
    run(walk, IDLE_INPUT, 3000);
    expect(dist(walk.state.boss.pos, walk.state.player.pos)).toBeLessThan(start - 2);
    for (const x of walk.state.arena.obstacles) expect(dist(walk.state.boss.pos, x.pos)).toBeGreaterThanOrEqual(x.radius + BOSS.radius - 1e-6);
  });

  it("phase-change pillars rise before turning solid, and strikes chip them", () => {
    const s = structuredClone(spec);
    s.phases[1]!.rule = "pillars";
    const b = createBattle(s, 4);
    b.debug.playerInvulnerable = true;
    b.state.boss.hp = Math.floor(spec.stats.maxHp * 0.49);
    const events = run(b, IDLE_INPUT, 50);
    expect(events.some((e) => e.type === "obstaclesRaised")).toBe(true);
    const o = b.state.arena.obstacles[0]!;
    expect(blockedByObstacle(b.state.boss.pos, o.pos, b.state.arena.obstacles)).toBeNull();
    run(b, IDLE_INPUT, ARENA_PILLARS.riseMs + 50);
    expect(blockedByObstacle(b.state.boss.pos, o.pos, b.state.arena.obstacles)).toBe(o);
    b.state.boss.pos = add(o.pos, norm(sub(b.state.boss.pos, o.pos)), o.radius + 1);
    b.state.player.pos = { ...o.pos };
    b.step(IDLE_INPUT);
    expect(b.debug.forceMove("nova")).toBe(true);
    const hits = run(b, IDLE_INPUT, 3000).filter((e) => e.type === "obstacleHit" && e.by === "nova" && e.id === o.id);
    expect(hits).toHaveLength(1);
    expect(o.hp).toBe(ARENA_PILLARS.hp - ARENA_PILLARS.damage.nova);
  });

  it("the bot never gets stuck on cover and stays in the difficulty band", () => {
    for (const boss of FALLBACK_SPECS) {
      for (const seed of [1, 2]) expect(simulateBattle(pillared(boss), seed).outcome, boss.code).not.toBe("fighting");
    }
    const report = measureDifficulty(pillared(), 24, AVERAGE_BOT);
    expect(report.bossWinRate).toBeGreaterThanOrEqual(DIFFICULTY_BAND.min);
    expect(report.bossWinRate).toBeLessThanOrEqual(DIFFICULTY_BAND.max);
    const a = simulateBattle(pillared(), 9);
    expect(a).toEqual(simulateBattle(pillared(), 9));
  });
});

describe("bound roster", () => {
  it("every fallback boss sits in the difficulty band under the arena rules", () => {
    for (const bound of FALLBACK_SPECS) {
      const report = measureDifficulty(bound, 32, AVERAGE_BOT);
      expect(report.bossWinRate, bound.code).toBeGreaterThanOrEqual(DIFFICULTY_BAND.min - 0.05);
      expect(report.bossWinRate, bound.code).toBeLessThanOrEqual(DIFFICULTY_BAND.max + 0.05);
    }
  });
});

describe("arena mutators", () => {
  const withElement = (element: Element): NemesisSpec => {
    const s = structuredClone(spec);
    s.identity.element = element;
    return s;
  };

  it("derives the mutator from the element", () => {
    expect(mutatorForElement("fire")).toBe("ember");
    expect(mutatorForElement("storm")).toBe("tempest");
    expect(mutatorForElement("blood")).toBe("bloodtide");
    expect(mutatorForElement("ice")).toBe("none");
    expect(createBattle(withElement("void"), 1).state.arena.mutator).toBe("none");
  });

  it("ember opens telegraphed vents away from the player that burn only once armed", () => {
    const b = createBattle(withElement("fire"), 4);
    b.debug.bossAi = false;
    const ember = ARENA_MUTATOR.ember;
    const events = run(b, IDLE_INPUT, ember.periodMs * 0.6 + 50);
    expect(events.filter((e) => e.type === "arenaPulse" && e.mutator === "ember")).toHaveLength(ember.count);
    const vents = b.state.hazards.filter((h) => h.source === "arena");
    expect(vents).toHaveLength(ember.count);
    for (const v of vents) {
      expect(v.armT).toBeGreaterThan(0);
      expect(v.shape.kind === "circle" && dist(v.shape.center, b.state.player.pos)).toBeGreaterThanOrEqual(ember.safeRadius - 1e-6);
    }
    const vent = vents[0]!;
    if (vent.shape.kind !== "circle") throw new Error("vent must be a circle");
    b.state.player.pos = { ...vent.shape.center };
    const arming = run(b, IDLE_INPUT, ember.armMs - 100);
    expect(arming.some((e) => e.type === "playerHit")).toBe(false);
    const burning = run(b, IDLE_INPUT, 400);
    const hit = burning.find((e) => e.type === "playerHit");
    expect(hit && hit.type === "playerHit" && hit.move).toBe("arena");
    expect(b.state.log.hitsTaken.arena).toBe(1);
  });

  it("tempest drags the player and drops a bolt on their position", () => {
    const b = createBattle(withElement("storm"), 6);
    b.debug.bossAi = false;
    expect(len(b.state.arena.wind)).toBeCloseTo(ARENA_MUTATOR.tempest.windSpeed, 6);
    const start = { ...b.state.player.pos };
    run(b, IDLE_INPUT, 1000);
    expect(dist(start, b.state.player.pos)).toBeCloseTo(ARENA_MUTATOR.tempest.windSpeed, 1);
    const events = run(b, IDLE_INPUT, ARENA_MUTATOR.tempest.boltPeriodMs * 0.6 - 900);
    const bolt = events.find((e) => e.type === "arenaPulse" && e.mutator === "tempest");
    expect(bolt).toBeDefined();
    const hazard = b.state.hazards.find((h) => h.source === "arena");
    expect(hazard?.repeat).toBe(false);
    expect(hazard?.armMs).toBe(ARENA_MUTATOR.tempest.boltArmMs);
  });

  it("bloodtide leaves a pool where a boss strike lands and it can be the killer", () => {
    const b = createBattle(withElement("blood"), 2);
    b.debug.bossAi = false;
    b.state.boss.pos = { x: 0, z: 3 };
    expect(b.debug.forceMove("sweep")).toBe(true);
    const events = run(b, IDLE_INPUT, 2500);
    expect(events.some((e) => e.type === "playerHit" && e.move === "sweep")).toBe(true);
    const pool = b.state.hazards.find((h) => h.source === "arena");
    expect(pool?.repeat).toBe(true);
    // The pool opens where the blow landed; the strike then shoves the player back, but no further than the knockback.
    expect(pool && pool.shape.kind === "circle" && dist(pool.shape.center, b.state.player.pos)).toBeLessThanOrEqual(PLAYER.hurt.knockback + 0.1);
    b.state.player.hp = 1;
    run(b, IDLE_INPUT, ARENA_MUTATOR.bloodtide.armMs + 200);
    expect(b.state.outcome).toBe("playerDead");
    expect(b.state.log.killedBy).toBe("arena");
  });

  it("every mutator is deterministic and only ever tilts the fallback boss harder, within the band's ceiling", () => {
    const baseline = measureDifficulty(withElement("void"), 24, AVERAGE_BOT).bossWinRate;
    for (const element of ["fire", "storm", "blood"] as const) {
      const s = withElement(element);
      expect(simulateBattle(s, 21)).toEqual(simulateBattle(s, 21));
      const report = measureDifficulty(s, 24, AVERAGE_BOT);
      expect(report.bossWinRate, element).toBeGreaterThanOrEqual(baseline - 0.1);
      expect(report.bossWinRate, element).toBeLessThanOrEqual(DIFFICULTY_BAND.max);
    }
  });
});
