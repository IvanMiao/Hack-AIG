import type { NemesisSpec } from "../spec";
import { createBattle, IDLE_INPUT } from "./battle";
import { BOSS, PLAYER } from "./constants";
import { createRng } from "./rng";
import type { BattleEvent, BattleState, DeathLog, Outcome, PlayerInput } from "./types";
import { dist, norm, perp, scale, sub, vec } from "./vec";

export interface BotProfile {
  /** ms after a telegraph starts before the bot may react */
  reactionMs: number;
  /** chance the bot actually rolls a telegraphed hit */
  dodgeRate: number;
  /** preferred distance from the boss while circling */
  spacing: number;
  /** probability of heavy over light when punishing */
  heavyRate: number;
}

/** A competent-but-mortal player: the difficulty gate is tuned against this profile. */
export const AVERAGE_BOT: BotProfile = { reactionMs: 260, dodgeRate: 0.62, spacing: 2.2, heavyRate: 0.35 };

export interface SimResult {
  outcome: Outcome;
  durationMs: number;
  playerHpLeft: number;
  bossHpLeft: number;
  log: DeathLog;
}

export function simulateBattle(spec: NemesisSpec, seed: number, profile: BotProfile = AVERAGE_BOT, maxMs = 240_000): SimResult {
  const battle = createBattle(spec, seed);
  const rng = createRng(seed ^ 0x9e3779b9);
  const { state } = battle;
  let telegraphAge: number | null = null;
  let willDodge = false;
  let circleSign = 1;
  let punishUntil = 0;

  while (state.outcome === "fighting" && state.timeMs < maxMs) {
    const input = decide(state, battle.spec, profile);
    const events = battle.step(input);
    for (const e of events) handleEvent(e);
  }
  return { outcome: state.outcome, durationMs: state.timeMs, playerHpLeft: state.player.hp, bossHpLeft: state.boss.hp, log: state.log };

  function handleEvent(e: BattleEvent) {
    if (e.type === "telegraph") { telegraphAge = 0; willDodge = rng.next() < profile.dodgeRate; }
    if (e.type === "moveActive") { telegraphAge = null; punishUntil = state.timeMs + 600; }
    if (e.type === "bossStagger" || e.type === "weaknessOpen") punishUntil = state.timeMs + 1400;
    if (e.type === "phaseChange") circleSign *= -1;
  }

  function decide(s: BattleState, _spec: NemesisSpec, prof: BotProfile): PlayerInput {
    const p = s.player;
    const b = s.boss;
    const toBoss = norm(sub(b.pos, p.pos));
    const d = dist(p.pos, b.pos) - BOSS.radius;
    const current = b.current;
    const input: PlayerInput = { ...IDLE_INPUT, move: vec() };

    if (telegraphAge !== null && current?.phase === "telegraph") {
      telegraphAge += 1000 / 60;
      const remaining = current.telegraphMs - current.t;
      // Roll just before the hit lands; ranged moves are dodged by sidestepping instead.
      if (willDodge && telegraphAge >= prof.reactionMs && remaining <= PLAYER.roll.iframeMs * 0.8 && p.action === "idle") {
        input.roll = true;
        const side = scale(perp(toBoss), circleSign);
        input.move = current.move.type === "thrust" || current.move.type === "charge" || current.move.type === "volley" ? side : current.move.type === "nova" ? scale(toBoss, -1) : side;
        return input;
      }
      if (current.move.type === "volley" || current.move.type === "zone" || current.move.type === "ring") {
        input.move = scale(perp(toBoss), circleSign);
        return input;
      }
    }

    const punishing = s.timeMs < punishUntil || b.staggerT > 0 || b.weaknessT > 0;
    if (punishing && d <= PLAYER.light.range && p.action === "idle" && p.stamina > PLAYER.light.stamina + 10) {
      if (rng.next() < prof.heavyRate && p.stamina > PLAYER.heavy.stamina + 10) input.heavy = true; else input.light = true;
      return input;
    }
    if (punishing && d > PLAYER.light.range) { input.move = toBoss; return input; }

    // Neutral: trade a light hit whenever in range and nothing is telegraphed, otherwise keep spacing and strafe.
    const bossBusy = current !== null && current.phase !== "recover";
    if (!bossBusy && d <= PLAYER.light.range && p.action === "idle" && p.stamina > PLAYER.light.stamina + PLAYER.roll.stamina) {
      input.light = true;
      return input;
    }
    if (d > prof.spacing + 0.6) input.move = toBoss;
    else if (d < prof.spacing - 0.6) input.move = scale(toBoss, -1);
    else input.move = scale(perp(toBoss), circleSign);
    return input;
  }
}

export interface DifficultyReport {
  runs: number;
  bossWinRate: number;
  avgDurationMs: number;
  avgPlayerHpLeftOnWin: number;
  killsByMove: Partial<Record<string, number>>;
}

export function measureDifficulty(spec: NemesisSpec, runs = 40, profile = AVERAGE_BOT): DifficultyReport {
  let bossWins = 0;
  let duration = 0;
  let hpLeft = 0;
  let wins = 0;
  const killsByMove: Partial<Record<string, number>> = {};
  for (let i = 0; i < runs; i += 1) {
    const r = simulateBattle(spec, 1000 + i * 7919, profile);
    duration += r.durationMs;
    if (r.outcome === "playerDead") { bossWins += 1; if (r.log.killedBy) killsByMove[r.log.killedBy] = (killsByMove[r.log.killedBy] ?? 0) + 1; }
    if (r.outcome === "bossDead") { wins += 1; hpLeft += r.playerHpLeft; }
    if (r.outcome === "fighting") bossWins += 0.5;
  }
  return { runs, bossWinRate: bossWins / runs, avgDurationMs: duration / runs, avgPlayerHpLeftOnWin: wins ? hpLeft / wins : 0, killsByMove };
}

/** Target band for the average bot: the boss should win often enough to earn a grudge, not always. */
export const DIFFICULTY_BAND = { min: 0.35, max: 0.8 } as const;

export interface CalibrationResult { spec: NemesisSpec; before: number; after: number; steps: string[] }

/** Nudges damage/hp by ≤ 25% total until bossWinRate lands in DIFFICULTY_BAND. Pure; returns a new spec. */
export function calibrateDifficulty(spec: NemesisSpec, runs = 24, maxSteps = 4): CalibrationResult {
  let current = structuredClone(spec);
  const before = measureDifficulty(current, runs).bossWinRate;
  let rate = before;
  const steps: string[] = [];
  for (let i = 0; i < maxSteps && (rate < DIFFICULTY_BAND.min || rate > DIFFICULTY_BAND.max); i += 1) {
    const distance = rate < DIFFICULTY_BAND.min ? DIFFICULTY_BAND.min - rate : rate - DIFFICULTY_BAND.max;
    const magnitude = distance > 0.15 ? 0.15 : 0.08;
    const factor = rate < DIFFICULTY_BAND.min ? 1 + magnitude : 1 - magnitude;
    current = scaleSpec(current, factor);
    rate = measureDifficulty(current, runs).bossWinRate;
    steps.push(`${factor > 1 ? "harder" : "easier"} ×${factor} → bossWinRate ${rate.toFixed(2)}`);
  }
  return { spec: current, before, after: rate, steps };
}

function scaleSpec(spec: NemesisSpec, factor: number): NemesisSpec {
  const next = structuredClone(spec);
  next.stats.maxHp = Math.round(Math.min(1500, Math.max(300, next.stats.maxHp * factor)));
  for (const phase of next.phases) for (const move of phase.moves) {
    move.damage = Math.round(Math.min(80, Math.max(5, move.damage * factor)));
  }
  return next;
}
