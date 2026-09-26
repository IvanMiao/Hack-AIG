import "@fontsource/cinzel/600.css";
import "@fontsource/cinzel/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import { forge } from "./forgeClient";
import { createStage } from "./game/createStage";
import { createKeyboardInput } from "./game/input";
import { getFallbackSpec, type NemesisSpec } from "./spec";

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
};

const canvas = $<HTMLCanvasElement>("stage");
const incantationPanel = $("incantation");
const fightPanel = $("fight");
const form = $<HTMLFormElement>("incantation-form");
const input = $<HTMLTextAreaElement>("incantation-input");
const summonButton = $<HTMLButtonElement>("summon-btn");
const fallbackButton = $<HTMLButtonElement>("fallback-btn");
const status = $("incantation-status");
const errorMessage = $("incantation-error");
const counter = $("char-count");
const ritual = $("ritual");
const stage = createStage(canvas);
const keyboard = createKeyboardInput();
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let active: NemesisSpec | null = null;
let ritualTimer = 0;
let introTimer = 0;
let introFadeTimer = 0;

function updateCounter() {
  counter.textContent = `${input.value.length}/280`;
}

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
  incantationPanel.setAttribute("aria-busy", String(busy));
  if (busy) status.setAttribute("aria-busy", "true");
  else status.removeAttribute("aria-busy");
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

function showForgeStep(index: number) {
  const cards = [...document.querySelectorAll<HTMLElement>(".forge-card")];
  for (const [cardIndex, card] of cards.entries()) {
    card.classList.toggle("active", cardIndex === index);
    card.classList.remove("complete");
  }
}

function revealForge(spec: NemesisSpec) {
  const details = [
    [spec.identity.silhouette.toUpperCase(), `${spec.identity.name} takes form`],
    [`${spec.identity.temper} · ${spec.identity.element}`, "A will, given force"],
    [spec.voice.designPrompt, "The voice behind the veil"],
    [spec.arenaTheme, "The ground remembers"],
  ];
  const cards = [...document.querySelectorAll<HTMLElement>(".forge-card")];
  cards.forEach((card, index) => {
    card.classList.remove("active");
    card.classList.add("complete");
    const text = card.querySelector("p");
    if (text) text.textContent = details[index]?.[0]?.slice(0, 92) ?? "";
    const title = card.querySelector("strong");
    if (title) title.textContent = details[index]?.[1] ?? "";
  });
}

function resetForge() {
  ritual.classList.add("hidden");
  for (const card of document.querySelectorAll<HTMLElement>(".forge-card")) {
    card.classList.remove("active", "complete");
  }
}

function enterFight(spec: NemesisSpec) {
  active = spec;
  stage.applySpec(spec);
  stage.setMode("fight");
  document.documentElement.style.setProperty("--accent", spec.art.accentHex);
  $("boss-name").textContent = spec.identity.name;
  $("boss-title").textContent = spec.identity.title;
  $("intro-name").textContent = spec.identity.name;
  $("intro-title").textContent = spec.identity.title;
  $("subtitle").textContent = spec.voice.lines.intro;
  $("player-hp").style.width = "100%";
  $("player-stamina").style.width = "100%";
  $("boss-hp").style.width = "100%";
  for (const id of ["player-hp", "player-stamina", "boss-hp"]) {
    const bar = $(id).parentElement;
    bar?.setAttribute("aria-valuenow", "100");
  }
  const phasePips = $("phase-pips");
  phasePips.replaceChildren();
  phasePips.setAttribute("aria-label", `${spec.phases.length} boss phases`);
  spec.phases.forEach((_, index) => {
    const pip = document.createElement("span");
    pip.className = `phase-pip${index === 0 ? " active" : ""}`;
    pip.setAttribute("aria-hidden", "true");
    phasePips.append(pip);
  });
  incantationPanel.classList.add("hidden");
  fightPanel.classList.remove("hidden");
  fightPanel.classList.add("intro-active");
  $("boss-intro").classList.remove("hidden");
  $("subtitle").classList.remove("hidden");
  window.clearTimeout(introTimer);
  window.clearTimeout(introFadeTimer);
  $("boss-intro").classList.remove("departing");
  introTimer = window.setTimeout(() => {
    $("boss-intro").classList.add("departing");
    introFadeTimer = window.setTimeout(() => {
      $("boss-intro").classList.add("hidden");
      $("boss-intro").classList.remove("departing");
      fightPanel.classList.remove("intro-active");
    }, reducedMotion.matches ? 0 : 400);
  }, reducedMotion.matches ? 0 : 2500);
}

async function beginSummoning(resolveSpec: () => Promise<NemesisSpec>, requiresIncantation = true) {
  if (requiresIncantation && !validateIncantation(true)) {
    status.textContent = "";
    input.focus();
    return;
  }
  setRitualBusy(true);
  ritual.classList.remove("hidden");
  status.textContent = "The void is listening…";
  showForgeStep(0);
  let step = 0;
  window.clearInterval(ritualTimer);
  ritualTimer = window.setInterval(() => {
    step = (step + 1) % 4;
    showForgeStep(step);
  }, 500);
  let spec: NemesisSpec;
  try {
    spec = await resolveSpec();
  } catch {
    spec = getFallbackSpec();
    status.textContent = "The rift was silent. A bound nightmare answers instead.";
  }
  window.clearInterval(ritualTimer);
  revealForge(spec);
  if (reducedMotion.matches) {
    await Promise.resolve();
  } else {
    await new Promise((resolve) => window.setTimeout(resolve, 1200));
  }
  setRitualBusy(false);
  enterFight(spec);
}

stage.applySpec(getFallbackSpec());
stage.setMode("attract");

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void beginSummoning(async () => {
    const response = await forge(input.value.trim());
    if (response.source === "fallback") status.textContent = "The rift was silent. A bound nightmare answers instead.";
    return response.spec;
  });
});

fallbackButton.addEventListener("click", () => {
  void beginSummoning(async () => getFallbackSpec(), false);
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
  if (event.key === "Escape" && active) retreat();
});

function retreat() {
  active = null;
  window.clearTimeout(introTimer);
  window.clearTimeout(introFadeTimer);
  stage.setMode("attract");
  fightPanel.classList.add("hidden");
  fightPanel.classList.remove("intro-active");
  $("boss-intro").classList.add("hidden");
  incantationPanel.classList.remove("hidden");
  resetForge();
  status.textContent = "The nightmare waits where you left it.";
  input.focus();
}

$<HTMLButtonElement>("retreat-btn").addEventListener("click", retreat);

let last = performance.now();
const loop = (now: number) => {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  stage.update(dt, active ? keyboard.read() : { x: 0, z: 0 });
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);

window.addEventListener("beforeunload", () => {
  window.clearInterval(ritualTimer);
  window.clearTimeout(introTimer);
  window.clearTimeout(introFadeTimer);
  keyboard.dispose();
  stage.dispose();
});

updateCounter();
