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
const input = $<HTMLTextAreaElement>("incantation-input");
const summonButton = $<HTMLButtonElement>("summon-btn");
const fallbackButton = $<HTMLButtonElement>("fallback-btn");
const status = $("incantation-status");

const stage = createStage(canvas);
const keyboard = createKeyboardInput();
let active: NemesisSpec | null = null;

function enterFight(spec: NemesisSpec) {
  active = spec;
  stage.applySpec(spec);
  document.documentElement.style.setProperty("--accent", spec.art.accentHex);
  $("boss-name").textContent = `${spec.identity.name} — ${spec.identity.title}`;
  $("subtitle").textContent = spec.voice.lines.intro;
  incantationPanel.classList.add("hidden");
  fightPanel.classList.remove("hidden");
}

summonButton.addEventListener("click", async () => {
  const incantation = input.value.trim();
  if (incantation.length < 4) { status.textContent = "Say more. It needs a shape."; return; }
  summonButton.disabled = true;
  status.textContent = "The void is listening…";
  const result = await forge(incantation);
  status.textContent = result.source === "fallback" ? "The rift was silent. A bound nightmare answers instead." : "";
  summonButton.disabled = false;
  enterFight(result.spec);
});

fallbackButton.addEventListener("click", () => enterFight(getFallbackSpec()));

let last = performance.now();
const loop = (now: number) => {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (active) stage.update(dt, keyboard.read());
  else stage.update(dt, { x: 0, z: 0 });
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);
