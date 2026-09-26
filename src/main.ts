import "@fontsource/cinzel/600.css";
import "@fontsource/cinzel/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import { requestAllAssets, type AssetBundle } from "./assetsClient";
import { forge } from "./forgeClient";
import { learn } from "./learnClient";
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
const ritualPanel = $("ritual");
const outcomePanel = $("outcome");
const form = $<HTMLFormElement>("incantation-form");
const input = $<HTMLTextAreaElement>("incantation-input");
const summonButton = $<HTMLButtonElement>("summon-btn");
const fallbackButton = $<HTMLButtonElement>("fallback-btn");
const retryButton = $<HTMLButtonElement>("retry-btn");
const newButton = $<HTMLButtonElement>("new-btn");
const retreatButton = $<HTMLButtonElement>("retreat-btn");
const status = $("incantation-status");
const errorMessage = $("incantation-error");
const counter = $("char-count");
const bossHp = $("boss-hp");
const playerHp = $("player-hp");
const playerStamina = $("player-stamina");
const vigorValue = $("vigor-value");
const staminaValue = $("stamina-value");
const subtitle = $("subtitle");
const hitVignette = $("hit-vignette");
const portrait = $<HTMLImageElement>("portrait");
const grudgeCard = $("grudge");
const grudgeObservation = $("grudge-observation");
const grudgePatch = $("grudge-patch");
const introCard = $("boss-intro");
const stage = createStage(canvas);
const combat = createCombatInput(canvas);
const audio = createGameAudio();
const ritual = createRitual();
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const INTRO_PORTRAIT_MS = 5200;
let spec: NemesisSpec | null = null;
let battle: Battle | null = null;
let seed = 1;
let hitStopMs = 0;
let accumulator = 0;
let subtitleTimer: number | undefined;
let portraitTimer: number | undefined;
let introTimer: number | undefined;
let introFadeTimer: number | undefined;
let introSpoken = false;
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

const updateCounter = () => {
  counter.textContent = `${input.value.length}/280`;
};

function validateIncantation(required: boolean): boolean {
  const length = input.value.trim().length;
  if (!length && !required) {
    errorMessage.textContent = "";
    input.setAttribute("aria-invalid", "false");
    return true;
  }
  if (length < 4) {
    errorMessage.textContent = "Say more. It needs a shape.";
    input.setAttribute("aria-invalid", "true");
    return false;
  }
  errorMessage.textContent = "";
  input.setAttribute("aria-invalid", "false");
  return true;
}

function setRitualBusy(busy: boolean) {
  ritualPanel.setAttribute("aria-busy", String(busy));
  input.disabled = busy;
  fallbackButton.disabled = busy;
  for (const chip of document.querySelectorAll<HTMLButtonElement>(".example-chip")) chip.disabled = busy;
  summonButton.disabled = busy;
  if (busy) {
    summonButton.innerHTML = '<span class="spinner" aria-hidden="true"></span> SUMMONING…';
  } else {
    summonButton.textContent = "SUMMON";
  }
}

function rememberDeath(log: DeathLog, code: string) {
  try {
    localStorage.setItem(`nemesis:death:${code}`, JSON.stringify(log));
  } catch {
  }
}

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
      if (!introSpoken) {
        introSpoken = true;
        audio.speak("intro");
      }
      break;
    default:
      break;
  }
}

async function summon(
  incantation: string,
  forgeSpec: () => Promise<{ spec: NemesisSpec; source: "gemini" | "fallback" }>,
) {
  const token = ++summonToken;
  introSpoken = false;
  portrait.src = "";
  portrait.classList.remove("shown");
  stage.setSky(null);
  audio.stopMusic();
  incantationPanel.classList.add("hidden");
  ritual.begin(incantation);
  setRitualBusy(true);

  let result: { spec: NemesisSpec; source: "gemini" | "fallback" };
  try {
    result = await forgeSpec();
  } catch (error) {
    console.warn("[forge] request failed; using a bound nightmare", error);
    result = { spec: getFallbackSpec(), source: "fallback" };
  }
  if (token !== summonToken) return;
  spec = result.spec;
  stage.applySpec(result.spec);
  document.documentElement.style.setProperty("--accent", result.spec.art.accentHex);
  ritual.revealSpec(result.spec);
  if (result.source === "fallback") ritual.setStatus("The rift was silent. A bound nightmare answers instead.");

  await requestAllAssets(result.spec.code, {
    onReady: (bundle) => {
      if (token !== summonToken) return;
      applyAsset(bundle);
      ritual.markAsset(bundle);
    },
    onFail: (kind, error) => {
      if (token !== summonToken) return;
      console.warn(`[asset] ${kind} failed`, error);
      ritual.failAsset(kind);
    },
  });
  if (token === summonToken) setRitualBusy(false);
}

function syncPhasePips(phaseIndex: number) {
  for (const [index, pip] of [...document.querySelectorAll<HTMLElement>(".phase-pip")].entries()) {
    pip.classList.toggle("active", index === phaseIndex);
  }
}

function startBattle(next: NemesisSpec) {
  spec = next;
  seed += 1;
  battle = createBattle(next, seed);
  accumulator = 0;
  hitStopMs = 0;
  stage.applySpec(next);
  stage.setMode("fight");
  document.documentElement.style.setProperty("--accent", next.art.accentHex);
  $("boss-name").textContent = next.identity.name;
  $("boss-title").textContent = next.identity.title;
  $("intro-name").textContent = next.identity.name;
  $("intro-title").textContent = next.identity.title;
  $("outcome-title").textContent = "";
  outcomePanel.classList.add("hidden");
  const phasePips = $("phase-pips");
  phasePips.replaceChildren();
  phasePips.setAttribute("aria-label", `${next.phases.length} boss phases`);
  next.phases.forEach((_, index) => {
    const pip = document.createElement("span");
    pip.className = `phase-pip${index === 0 ? " active" : ""}`;
    pip.setAttribute("aria-hidden", "true");
    phasePips.append(pip);
  });
  incantationPanel.classList.add("hidden");
  ritual.hide();
  fightPanel.classList.remove("hidden");
  fightPanel.classList.add("intro-active");
  introCard.classList.remove("hidden", "departing");
  window.clearTimeout(introTimer);
  window.clearTimeout(introFadeTimer);
  introTimer = window.setTimeout(() => {
    introCard.classList.add("departing");
    introFadeTimer = window.setTimeout(() => {
      introCard.classList.add("hidden");
      introCard.classList.remove("departing");
      fightPanel.classList.remove("intro-active");
    }, reducedMotion.matches ? 0 : 400);
  }, reducedMotion.matches ? 0 : 2500);
  audio.playPhase(1);
  say(next.voice.lines.intro, 4500);
  showPortrait(INTRO_PORTRAIT_MS);
  if (!introSpoken) {
    introSpoken = true;
    audio.speak("intro");
  }
  syncHud();
}

/** Grudge for the current death, or null while /learn is still pending. Rendered whenever the death screen is (re)drawn. */
let pendingGrudge: { observation: string; patch: string; gen: number } | null = null;

function renderGrudge() {
  if (pendingGrudge) {
    grudgeObservation.textContent = pendingGrudge.observation;
    grudgePatch.textContent = pendingGrudge.patch;
    retryButton.textContent = `FACE IT AGAIN · GEN ${pendingGrudge.gen}`;
  } else {
    grudgeObservation.textContent = "It is studying how you died…";
    grudgePatch.textContent = "";
    retryButton.textContent = "FIGHT AGAIN";
  }
}

function showOutcome(kind: "death" | "victory") {
  if (!spec) return;
  $("outcome-title").textContent = kind === "death" ? "YOU DIED" : "NEMESIS FELLED";
  $("outcome-line").textContent = kind === "death" ? `${spec.identity.name} will remember this.` : spec.voice.lines.defeat;
  if (kind === "death") {
    grudgeCard.classList.remove("hidden");
    renderGrudge();
  } else {
    grudgeCard.classList.add("hidden");
    retryButton.textContent = "FIGHT AGAIN";
  }
  outcomePanel.classList.remove("hidden");
  outcomePanel.dataset.kind = kind;
  showPortrait(null);
}

function handleEvents(events: readonly BattleEvent[]) {
  if (!spec || !battle) return;
  for (const event of events) {
    switch (event.type) {
      case "bossHit":
        hitStopMs = Math.max(hitStopMs, event.heavy ? 90 : 40);
        break;
      case "playerHit":
        hitStopMs = Math.max(hitStopMs, 60);
        hitVignette.classList.remove("flash");
        void hitVignette.offsetWidth;
        hitVignette.classList.add("flash");
        break;
      case "phaseChange":
        hitStopMs = Math.max(hitStopMs, 220);
        syncPhasePips(event.phaseIndex);
        say(spec.voice.lines.phase, 4000);
        audio.speak("phase");
        audio.playPhase(2);
        break;
      case "taunt":
        say(spec.voice.lines.taunt[event.index] ?? spec.voice.lines.taunt[0] ?? "");
        audio.speak(`taunt${event.index}`);
        break;
      case "weaknessOpen":
        say("— an opening —", 1200);
        break;
      case "playerDeath":
        say(spec.voice.lines.playerDeath[event.lineIndex] ?? spec.voice.lines.playerDeath[0] ?? "", 6000);
        audio.speak(`playerDeath${event.lineIndex}`);
        rememberDeath(battle.state.log, spec.code);
        {
          const deadSpec = spec;
          const deadBattle = battle;
          const token = summonToken;
          pendingGrudge = null;
          void learn(deadSpec, deadBattle.state.log).then((result) => {
            // Drop the grudge if the player already retried or started a new summon.
            if (token !== summonToken || battle !== deadBattle) return;
            spec = result.spec;
            pendingGrudge = { ...result.grudge, gen: result.spec.lineage.gen };
            renderGrudge();
          });
        }
        window.setTimeout(() => {
          if (battle) showOutcome("death");
        }, 900);
        break;
      case "bossDefeat":
        audio.speak("defeat");
        audio.stopMusic();
        window.setTimeout(() => {
          if (battle) showOutcome("victory");
        }, 900);
        break;
      default:
        break;
    }
  }
}

function setProgress(fill: HTMLElement, value: number, maximum: number) {
  const percent = maximum > 0 ? Math.max(0, Math.min(100, (value / maximum) * 100)) : 0;
  fill.style.width = `${percent}%`;
  fill.parentElement?.setAttribute("aria-valuenow", String(Math.round(percent)));
  fill.parentElement?.setAttribute("aria-valuetext", `${Math.max(0, Math.ceil(value))} of ${maximum}`);
}

function syncHud() {
  if (!battle || !spec) return;
  const { player, boss } = battle.state;
  setProgress(bossHp, boss.hp, spec.stats.maxHp);
  setProgress(playerHp, player.hp, PLAYER_MAX_HP);
  setProgress(playerStamina, player.stamina, PLAYER.maxStamina);
  vigorValue.textContent = `${Math.ceil(player.hp)} / ${PLAYER_MAX_HP}`;
  staminaValue.textContent = `${Math.ceil(player.stamina)} / ${PLAYER.maxStamina}`;
}

function retreat() {
  battle = null;
  summonToken += 1;
  accumulator = 0;
  hitStopMs = 0;
  window.clearTimeout(introTimer);
  window.clearTimeout(introFadeTimer);
  window.clearTimeout(subtitleTimer);
  audio.stopMusic();
  portrait.classList.remove("shown");
  fightPanel.classList.add("hidden");
  fightPanel.classList.remove("intro-active");
  outcomePanel.classList.add("hidden");
  introCard.classList.add("hidden");
  stage.setSky(null);
  stage.setMode("attract");
  ritual.hide();
  setRitualBusy(false);
  incantationPanel.classList.remove("hidden");
  status.textContent = "The nightmare waits where you left it.";
  input.focus();
}

ritual.onEnter(() => {
  setRitualBusy(false);
  if (spec) startBattle(spec);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!validateIncantation(true)) {
    status.textContent = "";
    input.focus();
    return;
  }
  const incantation = input.value.trim();
  status.textContent = "";
  void summon(incantation, () => forge(incantation));
});

fallbackButton.addEventListener("click", () => {
  const bound = getFallbackSpec();
  void summon(bound.identity.incantation, () => Promise.resolve({ spec: bound, source: "fallback" }));
});

input.addEventListener("input", () => {
  updateCounter();
  if (input.value.trim().length >= 4 || errorMessage.textContent) validateIncantation(false);
});
input.addEventListener("blur", () => {
  if (input.value.trim()) validateIncantation(false);
});

for (const chip of document.querySelectorAll<HTMLButtonElement>(".example-chip")) {
  chip.addEventListener("click", () => {
    input.value = chip.dataset.example ?? "";
    updateCounter();
    validateIncantation(false);
    input.focus();
  });
}

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (!summonButton.disabled && !incantationPanel.classList.contains("hidden")) form.requestSubmit();
  }
  if (event.key === "Escape" && battle) retreat();
});

retreatButton.addEventListener("click", retreat);
retryButton.addEventListener("click", () => {
  if (spec) startBattle(spec);
});
newButton.addEventListener("click", retreat);

stage.setMode("attract");

const idleState = createInitialState(getFallbackSpec(), 0);
let last = performance.now();
const loop = (now: number) => {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const events: BattleEvent[] = [];
  if (battle) {
    if (hitStopMs > 0) hitStopMs -= dt * 1000;
    else {
      accumulator += dt * 1000;
      const inputNow = combat.read();
      inputNow.move = stage.cameraRelative(inputNow.move);
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

window.addEventListener("beforeunload", () => {
  window.clearTimeout(subtitleTimer);
  window.clearTimeout(portraitTimer);
  window.clearTimeout(introTimer);
  window.clearTimeout(introFadeTimer);
  combat.dispose();
  stage.dispose();
});

updateCounter();
