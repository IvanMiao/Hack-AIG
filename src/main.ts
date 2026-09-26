import { requestAllAssets, type AssetBundle } from "./assetsClient";
import { forge } from "./forgeClient";
import { createGameAudio } from "./game/audio";
import { createStage } from "./game/createStage";
import { createCombatInput } from "./game/input";
import { getFallbackSpec, PLAYER_MAX_HP, type NemesisSpec } from "./spec";
import { createBattle, createInitialState, PLAYER, TICK_MS, type Battle, type BattleEvent, type DeathLog } from "./sim";
import { createRitual } from "./ui/ritual";

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
};

const canvas = $<HTMLCanvasElement>("stage");
const incantationPanel = $("incantation");
const fightPanel = $("fight");
const outcomePanel = $("outcome");
const input = $<HTMLTextAreaElement>("incantation-input");
const summonButton = $<HTMLButtonElement>("summon-btn");
const fallbackButton = $<HTMLButtonElement>("fallback-btn");
const retryButton = $<HTMLButtonElement>("retry-btn");
const newButton = $<HTMLButtonElement>("new-btn");
const status = $("incantation-status");
const bossHp = $("boss-hp");
const playerHp = $("player-hp");
const playerStamina = $("player-stamina");
const subtitle = $("subtitle");
const hitVignette = $("hit-vignette");
const portrait = $<HTMLImageElement>("portrait");

const stage = createStage(canvas);
const combat = createCombatInput(canvas);
const audio = createGameAudio();
const ritual = createRitual();

const INTRO_PORTRAIT_MS = 5200;

let spec: NemesisSpec | null = null;
let battle: Battle | null = null;
let seed = 1;
let hitStopMs = 0;
let subtitleTimer: number | undefined;
let portraitTimer: number | undefined;
let introSpoken = false;
/** Assets belong to the boss whose ritual requested them; late arrivals for an abandoned summon are dropped. */
let summonToken = 0;

const say = (line: string, holdMs = 3200) => {
  subtitle.textContent = line;
  subtitle.classList.add("visible");
  window.clearTimeout(subtitleTimer);
  subtitleTimer = window.setTimeout(() => subtitle.classList.remove("visible"), holdMs);
};

const showPortrait = (ms: number | null) => {
  if (!portrait.getAttribute("src")) return;
  portrait.classList.add("shown");
  window.clearTimeout(portraitTimer);
  if (ms !== null) portraitTimer = window.setTimeout(() => portrait.classList.remove("shown"), ms);
};

const rememberDeath = (log: DeathLog, code: string) => {
  try {
    localStorage.setItem(`nemesis:death:${code}`, JSON.stringify(log));
  } catch { /* storage may be unavailable inside the itch.io iframe */ }
};

function applyAsset(bundle: AssetBundle) {
  switch (bundle.kind) {
    case "sky":
      if (bundle.files.sky) stage.setSky(bundle.files.sky);
      break;
    case "portrait":
      portrait.src = bundle.files.portrait ?? "";
      break;
    case "music":
      if (bundle.files.p1 && bundle.files.p2) {
        audio.setMusic(bundle.files.p1, bundle.files.p2);
        audio.playPhase(battle && battle.state.boss.phaseIndex > 0 ? 2 : 1);
      }
      break;
    case "voice":
      audio.setVoice(bundle.files);
      if (!introSpoken) { introSpoken = true; audio.speak("intro"); }
      break;
    default:
      break;
  }
}

/** Summon flow: spec first (Gemini), then the four partner assets stream in while the ritual plays. */
async function summon(incantation: string, forgeSpec: () => Promise<{ spec: NemesisSpec; source: "gemini" | "fallback" }>) {
  const token = ++summonToken;
  introSpoken = false;
  portrait.src = "";
  portrait.classList.remove("shown");
  stage.setSky(null);
  audio.stopMusic();
  incantationPanel.classList.add("hidden");
  ritual.begin(incantation);

  const result = await forgeSpec();
  if (token !== summonToken) return;
  spec = result.spec;
  stage.applySpec(result.spec);
  document.documentElement.style.setProperty("--accent", result.spec.art.accentHex);
  ritual.revealSpec(result.spec);
  if (result.source === "fallback") ritual.setStatus("The rift was silent. A bound nightmare answers instead.");

  await requestAllAssets(result.spec.code, {
    onReady: (bundle) => { if (token === summonToken) { applyAsset(bundle); ritual.markAsset(bundle); } },
    onFail: (kind, error) => { if (token === summonToken) { console.warn(`[asset] ${kind} failed`, error); ritual.failAsset(kind); } },
  });
}

function startBattle(next: NemesisSpec) {
  spec = next;
  seed += 1;
  battle = createBattle(next, seed);
  stage.applySpec(next);
  document.documentElement.style.setProperty("--accent", next.art.accentHex);
  $("boss-name").textContent = `${next.identity.name} — ${next.identity.title}`;
  ritual.hide();
  incantationPanel.classList.add("hidden");
  outcomePanel.classList.add("hidden");
  fightPanel.classList.remove("hidden");
  audio.playPhase(1);
  say(next.voice.lines.intro, 4500);
  showPortrait(INTRO_PORTRAIT_MS);
  if (!introSpoken) { introSpoken = true; audio.speak("intro"); }
}

function showOutcome(kind: "death" | "victory") {
  if (!spec) return;
  $("outcome-title").textContent = kind === "death" ? "YOU DIED" : "NEMESIS FELLED";
  $("outcome-line").textContent = kind === "death" ? `${spec.identity.name} will remember this.` : spec.voice.lines.defeat;
  outcomePanel.classList.remove("hidden");
  outcomePanel.dataset.kind = kind;
  showPortrait(null);
}

function handleEvents(events: readonly BattleEvent[]) {
  if (!spec || !battle) return;
  for (const e of events) {
    switch (e.type) {
      case "bossHit":
        hitStopMs = Math.max(hitStopMs, e.heavy ? 90 : 40);
        break;
      case "playerHit":
        hitStopMs = Math.max(hitStopMs, 60);
        hitVignette.classList.remove("flash");
        void hitVignette.offsetWidth;
        hitVignette.classList.add("flash");
        break;
      case "phaseChange":
        hitStopMs = Math.max(hitStopMs, 220);
        say(spec.voice.lines.phase, 4000);
        audio.speak("phase");
        audio.playPhase(2);
        break;
      case "taunt":
        say(spec.voice.lines.taunt[e.index] ?? spec.voice.lines.taunt[0] ?? "");
        audio.speak(`taunt${e.index}`);
        break;
      case "weaknessOpen":
        say("— an opening —", 1200);
        break;
      case "playerDeath":
        say(spec.voice.lines.playerDeath[e.lineIndex] ?? spec.voice.lines.playerDeath[0] ?? "", 6000);
        audio.speak(`playerDeath${e.lineIndex}`);
        rememberDeath(battle.state.log, spec.code);
        window.setTimeout(() => showOutcome("death"), 900);
        break;
      case "bossDefeat":
        audio.speak("defeat");
        audio.stopMusic();
        window.setTimeout(() => showOutcome("victory"), 900);
        break;
      default:
        break;
    }
  }
}

function syncHud() {
  if (!battle || !spec) return;
  const { player, boss } = battle.state;
  bossHp.style.width = `${(boss.hp / spec.stats.maxHp) * 100}%`;
  playerHp.style.width = `${(player.hp / PLAYER_MAX_HP) * 100}%`;
  playerStamina.style.width = `${(player.stamina / PLAYER.maxStamina) * 100}%`;
}

summonButton.addEventListener("click", () => {
  const incantation = input.value.trim();
  if (incantation.length < 4) { status.textContent = "Say more. It needs a shape."; return; }
  status.textContent = "";
  void summon(incantation, () => forge(incantation));
});

fallbackButton.addEventListener("click", () => {
  const bound = getFallbackSpec();
  void summon(bound.identity.incantation, () => Promise.resolve({ spec: bound, source: "gemini" as const }));
});

ritual.onEnter(() => { if (spec) startBattle(spec); });
retryButton.addEventListener("click", () => { if (spec) startBattle(spec); });
newButton.addEventListener("click", () => {
  battle = null;
  summonToken += 1;
  audio.stopMusic();
  portrait.classList.remove("shown");
  fightPanel.classList.add("hidden");
  outcomePanel.classList.add("hidden");
  incantationPanel.classList.remove("hidden");
});

// Fixed-step sim (60Hz) decoupled from render; hit-stop pauses the sim for a few frames without touching the renderer.
const idleState = createInitialState(getFallbackSpec(), 0);
let last = performance.now();
let accumulator = 0;
const loop = (now: number) => {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const events: BattleEvent[] = [];
  if (battle) {
    if (hitStopMs > 0) hitStopMs -= dt * 1000;
    else {
      accumulator += dt * 1000;
      const inputNow = combat.read();
      while (accumulator >= TICK_MS) {
        accumulator -= TICK_MS;
        events.push(...battle.step(inputNow));
        inputNow.light = inputNow.heavy = inputNow.roll = false;
      }
    }
    handleEvents(events);
    syncHud();
    stage.render(dt, battle.state, events);
  } else {
    combat.read();
    stage.render(dt, idleState, []);
  }
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);
