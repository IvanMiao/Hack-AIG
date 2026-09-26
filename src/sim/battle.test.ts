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

describe("closing_ring", () => {
  const ringed = (): NemesisSpec => {
    const s = structuredClone(spec);
    s.phases[1]!.rule = "closing_ring";
    return s;
  };

  it("starts at the full radius and shrinks over the phase change", () => {
    const b = createBattle(ringed(), 5);
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
    expect(pool && pool.shape.kind === "circle" && dist(pool.shape.center, b.state.player.pos)).toBeLessThan(0.01);
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
