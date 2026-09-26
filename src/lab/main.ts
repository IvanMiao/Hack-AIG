/**
 * NEMESIS Lab — /dev.html
 *
 * Skips the ritual and the network: picks a bound spec, runs the local sim, and exposes every
 * knob that matters for feel and look through lil-gui. Nothing here ships in the game build;
 * `vite build` only emits index.html.
 */
import GUI from "lil-gui";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { createStage, DEFAULT_TUNING } from "../game/createStage";
import { createCombatInput } from "../game/input";
import { ELEMENT_PALETTES } from "../game/render/palette";
import { BOSS, createBattle, MOVE, PLAYER, TICK_MS, type Battle, type BattleEvent } from "../sim";
import { ELEMENTS, FALLBACK_SPECS, MOVE_TYPES, PHASE_RULES, type Element, type MoveType, type NemesisSpec, type PhaseRule } from "../spec";

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

const canvas = $<HTMLCanvasElement>("stage");
const tuning = DEFAULT_TUNING();
const stage = createStage(canvas, tuning);
const combat = createCombatInput(canvas);
const orbit = new OrbitControls(stage.camera, canvas);
orbit.enabled = false;
orbit.enableDamping = true;
orbit.target.set(0, 1.2, 0);

// Sim constants are `as const` for the game; the Lab deliberately writes through them.
const player = PLAYER as Mutable<typeof PLAYER>;
const bossC = BOSS as Mutable<typeof BOSS>;
const move = MOVE as Mutable<typeof MOVE>;

const lab = {
  bossCode: FALLBACK_SPECS[0]!.code,
  element: FALLBACK_SPECS[0]!.identity.element as Element,
  seed: 1,
  paused: false,
  timeScale: 1,
  bossAi: true,
  invulnerable: false,
  autoRetry: true,
  hitboxes: false,
  freeCamera: false,
  forceMove: "sweep" as MoveType,
  forceRule: "closing_ring" as PhaseRule,
  mutator: "",
};

let battle: Battle = createBattle(FALLBACK_SPECS[0]!, lab.seed);
let accumulator = 0;
let hitStopMs = 0;
let specOverride: NemesisSpec = structuredClone(FALLBACK_SPECS[0]!);
const eventLog: string[] = [];

const currentSpec = (): NemesisSpec => {
  const base = FALLBACK_SPECS.find((s) => s.code === lab.bossCode) ?? FALLBACK_SPECS[0]!;
  const spec = structuredClone(base);
  spec.identity.element = lab.element;
  return spec;
};

const reset = () => {
  specOverride = currentSpec();
  battle = createBattle(specOverride, lab.seed);
  battle.debug.bossAi = lab.bossAi;
  battle.debug.playerInvulnerable = lab.invulnerable;
  accumulator = 0;
  hitStopMs = 0;
  eventLog.length = 0;
  stage.applySpec(specOverride);
  stage.setMode("fight");
  document.documentElement.style.setProperty("--accent", stage.palette().accent);
  void stage.preloadBoss(specOverride);
  rebuildMoveFolder();
};

// ---- GUI -------------------------------------------------------------------------------------
const gui = new GUI({ title: "NEMESIS Lab" });

const fight = gui.addFolder("Fight");
fight.add(lab, "bossCode", FALLBACK_SPECS.map((s) => s.code)).name("boss").onChange((code: string) => {
  const spec = FALLBACK_SPECS.find((s) => s.code === code);
  if (spec) lab.element = spec.identity.element;
  reset();
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
});
fight.add(lab, "element", [...ELEMENTS]).onChange(reset);
fight.add(lab, "seed", 0, 9999, 1).onFinishChange(reset);
fight.add({ reset }, "reset").name("reset (R)");
fight.add(lab, "paused").name("pause (P)").listen();
fight.add({ step: () => stepOnce() }, "step").name("step 1 tick (.)");
fight.add(lab, "timeScale", 0.05, 2, 0.05).name("time scale ([ ])").listen();
fight.add(lab, "bossAi").name("boss AI").onChange((v: boolean) => { battle.debug.bossAi = v; });
fight.add(lab, "invulnerable").name("player invulnerable").onChange((v: boolean) => { battle.debug.playerInvulnerable = v; });
fight.add(lab, "autoRetry").name("auto reset on death");
fight.add(lab, "forceMove", [...MOVE_TYPES]).name("force move");
fight.add({ go: () => forceMove(lab.forceMove) }, "go").name("→ force now (1–8)");

const arenaFolder = gui.addFolder("Arena");
arenaFolder.add(lab, "mutator").name("mutator (element)").listen().disable();
arenaFolder.add(lab, "forceRule", PHASE_RULES.filter((r) => r !== "none")).name("phase rule");
arenaFolder.add({ go: () => { battle.debug.forceRule(lab.forceRule); pushEvent(`force rule <em>${lab.forceRule}</em>`); } }, "go").name("→ apply rule now");

const debugFolder = gui.addFolder("Debug view");
debugFolder.add(lab, "hitboxes").name("hitboxes (H)").listen().onChange((v: boolean) => { stage.debug.hitboxes = v; });
debugFolder.add(lab, "freeCamera").name("free camera (C)").listen().onChange(setFreeCamera);

const playerFolder = gui.addFolder("Player").close();
playerFolder.add(player, "speed", 2, 12, 0.1);
playerFolder.add(player, "radius", 0.2, 1, 0.01);
playerFolder.add(player, "staminaRegenPerSec", 5, 80, 1);
playerFolder.add(player, "staminaRegenDelayMs", 0, 1500, 10);
const roll = playerFolder.addFolder("roll");
roll.add(player.roll, "durationMs", 100, 900, 10);
roll.add(player.roll, "iframeMs", 0, 900, 10);
roll.add(player.roll, "distance", 1, 8, 0.1);
roll.add(player.roll, "stamina", 0, 60, 1);
for (const key of ["light", "heavy"] as const) {
  const f = playerFolder.addFolder(key);
  f.add(player[key], "windupMs", 0, 900, 10);
  f.add(player[key], "activeMs", 20, 400, 10);
  f.add(player[key], "recoverMs", 0, 900, 10);
  f.add(player[key], "damage", 1, 120, 1);
  f.add(player[key], "poise", 0, 80, 1);
  f.add(player[key], "range", 1, 5, 0.1);
  f.add(player[key], "stamina", 0, 60, 1);
}

const bossFolder = gui.addFolder("Boss").close();
bossFolder.add(bossC, "walkSpeed", 0, 8, 0.1);
bossFolder.add(bossC, "meleeRange", 1, 7, 0.1);
bossFolder.add(bossC, "staggerMs", 200, 3000, 50);
bossFolder.add(bossC, "weaknessWindowMs", 200, 4000, 50);
bossFolder.add(bossC, "followUpTelegraphScale", 0.2, 1, 0.05);
bossFolder.add(bossC.idleMs, "slow", 200, 4000, 50).name("idle slow");
bossFolder.add(bossC.idleMs, "fast", 100, 2000, 50).name("idle fast");
const specFolder = bossFolder.addFolder("spec stats");
let specControllers: GUI | null = null;
function rebuildMoveFolder() {
  specControllers?.destroy();
  specControllers = specFolder.addFolder(specOverride.identity.name);
  specControllers.add(specOverride.stats, "maxHp", 100, 5000, 10).onChange((v: number) => { battle.state.boss.hp = Math.min(battle.state.boss.hp, v); });
  specControllers.add(specOverride.stats, "poise", 10, 400, 5);
  specControllers.add(specOverride.stats, "aggression", 0.1, 1, 0.05);
  specOverride.phases.forEach((phase, pi) => {
    const pf = specControllers!.addFolder(`phase ${pi + 1} · ${phase.rule} · hp<${Math.round(phase.hpThreshold * 100)}%`).close();
    phase.moves.forEach((m) => {
      const mf = pf.addFolder(m.type);
      mf.add(m, "telegraphMs", 300, 3000, 10);
      mf.add(m, "damage", 1, 60, 1);
      mf.add(m, "scale", 0.5, 2, 0.05);
      mf.add(m, "count", 1, 8, 1);
    });
  });
}

const moveFolder = gui.addFolder("Move timings").close();
for (const type of MOVE_TYPES) {
  const f = moveFolder.addFolder(type).close();
  const m = move[type] as Record<string, number>;
  for (const key of Object.keys(m)) {
    const value = m[key]!;
    const max = key.endsWith("Ms") ? 3000 : key === "halfAngle" ? Math.PI : key === "tickFraction" ? 1 : Math.max(10, value * 3);
    f.add(m, key, 0, max, key.endsWith("Ms") ? 10 : 0.01);
  }
}

const lookFolder = gui.addFolder("Look");
const lights = lookFolder.addFolder("lights");
lights.add(tuning.lights, "hemisphere", 0, 6, 0.05);
lights.add(tuning.lights, "key", 0, 10, 0.1);
lights.add(tuning.lights, "rim", 0, 10, 0.1);
lights.add(tuning.lights, "fill", 0, 6, 0.1);
lights.add(tuning.lights, "heroLamp", 0, 40, 0.5);
lights.add(tuning.lights, "pool", 0, 1500, 10);
lights.add(tuning.lights, "poolRadius", 3, 14, 0.5);
lights.add(tuning.fog, "density", 0, 0.08, 0.001).name("fog density");
lights.add(tuning.rim, "strength", 0, 2, 0.01).name("toon rim strength");
lights.add(tuning.rim, "power", 1, 8, 0.1).name("toon rim power");
const postFolder = lookFolder.addFolder("post");
postFolder.add(tuning.post, "enabled");
postFolder.add(tuning.post, "exposure", 0.4, 2.5, 0.01);
postFolder.add(tuning.post, "bloomStrength", 0, 2, 0.01);
postFolder.add(tuning.post, "bloomThreshold", 0, 1.5, 0.01);
postFolder.add(tuning.post, "bloomRadius", 0, 1, 0.01);
postFolder.add(tuning.post, "vignette", 0, 1.5, 0.01);
postFolder.add(tuning.post, "grain", 0, 0.2, 0.001);
postFolder.add(tuning.post, "aberration", 0, 0.01, 0.0001);
postFolder.add(tuning.post, "pixelate", 1, 8, 1);
postFolder.add(tuning.post, "posterize", 0, 16, 1);
postFolder.add(tuning.post, "saturation", 0.5, 1.5, 0.01);
const fx = lookFolder.addFolder("fx");
fx.add(tuning.fx, "particles");
fx.add(tuning.fx, "ambient").name("ambient motes");
const paletteFolder = lookFolder.addFolder("palette (element)").close();
for (const element of ELEMENTS) {
  const pf = paletteFolder.addFolder(element).close();
  const pal = ELEMENT_PALETTES[element];
  for (const key of Object.keys(pal) as (keyof typeof pal)[]) pf.addColor(pal, key).onChange(() => stage.applySpec(specOverride));
}
const cameraFolder = lookFolder.addFolder("camera").close();
cameraFolder.add(tuning.camera, "fov", 30, 90, 1);
cameraFolder.add(tuning.camera, "distance", 3, 14, 0.1);
cameraFolder.add(tuning.camera, "side", -8, 8, 0.1);
cameraFolder.add(tuning.camera, "height", 1, 12, 0.1);
cameraFolder.add(tuning.camera, "lag", 1, 30, 0.5);
cameraFolder.add(tuning.camera, "shake", 0, 2, 0.05);
cameraFolder.add(tuning.camera, "punch", 0, 2, 0.05);

gui.add({ copy: () => void copyAsTs() }, "copy").name("Copy as TS (tuning + constants)");

// ---- helpers ---------------------------------------------------------------------------------
function setFreeCamera(on: boolean) {
  lab.freeCamera = on;
  stage.debug.freeCamera = on;
  orbit.enabled = on;
  if (on) orbit.target.set(battle.state.boss.pos.x, 1.4, battle.state.boss.pos.z);
}

function forceMove(type: MoveType) {
  const ok = battle.debug.forceMove(type);
  pushEvent(ok ? `force <em>${type}</em>` : `force ${type} — boss busy`);
}

function stepOnce() {
  lab.paused = true;
  const input = combat.read();
  input.move = stage.cameraRelative(input.move);
  const events = battle.step(input);
  afterStep(events);
  stage.render(TICK_MS / 1000, battle.state, events);
}

function pushEvent(html: string) {
  eventLog.push(`${(battle.state.timeMs / 1000).toFixed(2)}s ${html}`);
  if (eventLog.length > 8) eventLog.shift();
}

function afterStep(events: BattleEvent[]) {
  for (const e of events) {
    switch (e.type) {
      case "telegraph": pushEvent(`telegraph <em>${e.move}</em> ${e.ms}ms`); break;
      case "moveActive": pushEvent(`active <em>${e.move}</em>`); break;
      case "playerHit": pushEvent(`player hit by ${e.move} −${e.damage} → ${e.hp}`); hitStopMs = Math.max(hitStopMs, 60); break;
      case "playerRoll": pushEvent(e.dodged ? "<em>perfect roll</em>" : "roll"); break;
      case "bossHit": pushEvent(`boss hit ${e.heavy ? "heavy" : "light"} −${e.damage}${e.weakness ? " (weak)" : ""}`); hitStopMs = Math.max(hitStopMs, e.heavy ? 90 : 40); break;
      case "bossStagger": pushEvent("<em>boss staggered</em>"); hitStopMs = Math.max(hitStopMs, 220); break;
      case "weaknessOpen": pushEvent(`weakness open ${e.ms}ms`); break;
      case "phaseChange": pushEvent(`<em>phase ${e.phaseIndex + 1}</em>`); break;
      case "arenaShrink": pushEvent(`arena shrinks ${e.from.toFixed(1)} → ${e.to.toFixed(1)} over ${e.ms}ms`); break;
      case "obstaclesRaised": pushEvent(`<em>${e.ids.length} pillars</em> rise`); break;
      case "obstacleHit": pushEvent(`pillar ${e.id} hit by ${e.by} (${e.hpLeft} hp)`); break;
      case "obstacleBroken": pushEvent(`<em>pillar ${e.id} shattered</em> by ${e.by}`); hitStopMs = Math.max(hitStopMs, 40); break;
      case "arenaPulse": pushEvent(`arena pulse <em>${e.mutator}</em>`); break;
      case "bossDefeat": pushEvent("<em>boss defeated</em>"); break;
      case "playerDeath": pushEvent("player died"); break;
      case "taunt": break;
    }
  }
  lab.mutator = battle.state.arena.mutator;
  if (battle.state.outcome !== "fighting" && lab.autoRetry) window.setTimeout(reset, 1200);
}

async function copyAsTs() {
  const text = [
    "// Paste into src/game/createStage.ts DEFAULT_TUNING",
    `export const DEFAULT_TUNING = (): StageTuning => (${JSON.stringify(tuning, null, 2)});`,
    "",
    "// Paste into src/sim/constants.ts",
    `export const PLAYER = ${JSON.stringify(PLAYER, null, 2)} as const;`,
    `export const BOSS = ${JSON.stringify(BOSS, null, 2)} as const;`,
    `export const MOVE = ${JSON.stringify(MOVE, null, 2)} as const;`,
    "",
    "// Element palettes (src/game/render/palette.ts)",
    `export const ELEMENT_PALETTES = ${JSON.stringify(ELEMENT_PALETTES, null, 2)};`,
    "",
    `// Boss spec (${specOverride.code})`,
    `export const SPEC = ${JSON.stringify(specOverride, null, 2)} satisfies NemesisSpec;`,
  ].join("\n");
  try {
    await navigator.clipboard.writeText(text);
    pushEvent("<em>copied</em> tuning + constants as TS");
  } catch {
    console.log(text);
    pushEvent("clipboard blocked — dumped to console");
  }
}

// ---- HUD -------------------------------------------------------------------------------------
const php = $("lab-php");
const pst = $("lab-pst");
const bhp = $("lab-bhp");
const bpo = $("lab-bpo");
const tlTele = $("lab-tl-tele");
const tlAct = $("lab-tl-act");
const tlRec = $("lab-tl-rec");
const tlLabel = $("lab-tl-label");
const status = $("lab-status");
const eventsEl = $("lab-events");

function syncHud() {
  const s = battle.state;
  const p = s.player;
  const b = s.boss;
  php.style.transform = `scaleX(${p.hp / PLAYER.maxHp})`;
  pst.style.transform = `scaleX(${p.stamina / PLAYER.maxStamina})`;
  bhp.style.transform = `scaleX(${b.hp / specOverride.stats.maxHp})`;
  bpo.style.transform = `scaleX(${Math.min(1, b.poiseDamage / specOverride.stats.poise)})`;
  const cur = b.current;
  if (cur) {
    const timing = MOVE[cur.move.type];
    const activeMs = "activeMs" in timing ? timing.activeMs : 0;
    tlTele.style.transform = `scaleX(${cur.phase === "telegraph" ? cur.t / cur.telegraphMs : 1})`;
    tlAct.style.transform = `scaleX(${cur.phase === "telegraph" ? 0 : cur.phase === "active" ? (activeMs ? cur.t / activeMs : 1) : 1})`;
    tlRec.style.transform = `scaleX(${cur.phase === "recover" ? cur.t / timing.recoverMs : 0})`;
    tlLabel.textContent = `${cur.move.type} · ${cur.phase} ${Math.round(cur.t)}ms`;
  } else {
    tlTele.style.transform = tlAct.style.transform = tlRec.style.transform = "scaleX(0)";
    tlLabel.textContent = b.staggerT > 0 ? `stagger ${Math.round(b.staggerT)}ms` : `idle ${Math.round(b.idleT)}/${Math.round(b.idleFor)}ms`;
  }
  status.textContent = [
    `t ${(s.timeMs / 1000).toFixed(2)}s  ×${lab.timeScale.toFixed(2)}  ${s.outcome}`,
    `player ${p.action}${p.action !== "idle" ? ` ${Math.round(p.actionT)}ms` : ""}  hp ${p.hp}  st ${Math.round(p.stamina)}  pos ${p.pos.x.toFixed(1)},${p.pos.z.toFixed(1)}`,
    `boss   phase ${b.phaseIndex + 1}/${specOverride.phases.length}  hp ${b.hp}  poise ${b.poiseDamage}/${specOverride.stats.poise}  weak ${Math.round(b.weaknessT)}ms  inv ${Math.round(b.invulnerableT)}ms`,
    `hazards ${s.hazards.length}  projectiles ${s.projectiles.length}  dist ${Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z).toFixed(2)}`,
    `palette ${specOverride.identity.element}  accent ${stage.palette().accent}  hot ${stage.palette().hot}`,
  ].join("\n");
  eventsEl.innerHTML = eventLog.map((line) => `<li>${line}</li>`).join("");
  document.body.classList.toggle("lab-paused", lab.paused);
}

// ---- keys ------------------------------------------------------------------------------------
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  switch (e.code) {
    case "KeyP": lab.paused = !lab.paused; break;
    case "Period": stepOnce(); break;
    case "BracketLeft": lab.timeScale = Math.max(0.05, +(lab.timeScale - 0.1).toFixed(2)); break;
    case "BracketRight": lab.timeScale = Math.min(2, +(lab.timeScale + 0.1).toFixed(2)); break;
    case "KeyR": reset(); break;
    case "KeyH": lab.hitboxes = !lab.hitboxes; stage.debug.hitboxes = lab.hitboxes; break;
    case "KeyC": setFreeCamera(!lab.freeCamera); break;
    default: {
      const index = Number.parseInt(e.key, 10);
      if (index >= 1 && index <= MOVE_TYPES.length) forceMove(MOVE_TYPES[index - 1]!);
    }
  }
});

// ---- loop ------------------------------------------------------------------------------------
reset();
let last = performance.now();
const loop = (now: number) => {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const events: BattleEvent[] = [];
  if (lab.paused) {
    combat.read();
  } else if (hitStopMs > 0) {
    hitStopMs -= dt * 1000;
    combat.read();
  } else {
    accumulator += dt * 1000 * lab.timeScale;
    const input = combat.read();
    input.move = stage.cameraRelative(input.move);
    while (accumulator >= TICK_MS) {
      accumulator -= TICK_MS;
      events.push(...battle.step(input));
      input.light = input.heavy = input.roll = input.jump = false;
    }
    afterStep(events);
  }
  if (orbit.enabled) orbit.update();
  syncHud();
  stage.render(dt * lab.timeScale, battle.state, events);
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);

declare global {
  interface Window { lab: { stage: typeof stage; battle: () => Battle; tuning: typeof tuning } }
}
window.lab = { stage, battle: () => battle, tuning };
