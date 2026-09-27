import type { AssetBundle, AssetKind } from "../bakedAssets";
import { ELEMENTS, SILHOUETTES, TEMPERS, WEAKNESS_TRIGGERS, type NemesisSpec } from "../spec";

export type CardName = "form" | "temper" | "voice" | "arena";
const CARD_NAMES: CardName[] = ["form", "temper", "voice", "arena"];
const CARD_FOR_ASSET: Record<AssetKind, CardName> = { portrait: "form", music: "temper", voice: "voice", sky: "arena" };
/** Portrait, music, voice, sky, plus the boss model streaming in. */
const TOTAL_TASKS = 5;
const AUTO_ENTER_DELAY_MS = 1400;

export interface Ritual {
  begin(bossTitle: string): void;
  /** Show the selected offline boss and its bundled assets. */
  revealSpec(spec: NemesisSpec): void;
  markAsset(bundle: AssetBundle): void;
  skipAsset(kind: AssetKind): void;
  /** Boss model download progress in [0, 1]; reaching 1 settles the model task. */
  markModel(fraction: number): void;
  setStatus(text: string): void;
  onEnter(handler: () => void): void;
  hide(): void;
}

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
};

const childOf = (card: HTMLElement, selector: string): HTMLElement => {
  const element = card.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`card missing ${selector}`);
  return element;
};

const text = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** Enum-ish spec fields are rendered only when they are one of the known values; anything else shows as `?`. */
const oneOf = <T extends string>(allowed: readonly T[], value: string): string => (allowed.includes(value as T) ? value : "?");

const num = (value: number): string => (typeof value === "number" && Number.isFinite(value) ? String(value) : "?");

export function createRitual(): Ritual {
  const panel = byId("ritual");
  const echo = byId("ritual-incantation");
  const status = byId("ritual-status");
  const progress = panel.querySelector<HTMLElement>(".ritual-progress");
  if (!progress) throw new Error("missing ritual progress bar");
  const fill = byId("ritual-progress-fill");
  const enter = byId<HTMLButtonElement>("enter-btn");
  const cards = new Map<CardName, HTMLElement>();
  for (const name of CARD_NAMES) {
    const card = panel.querySelector<HTMLElement>(`[data-card="${name}"]`);
    if (!card) throw new Error(`missing card ${name}`);
    cards.set(name, card);
  }
  const card = (name: CardName): HTMLElement => cards.get(name) as HTMLElement;

  let settled = 0;
  let modelFraction = 0;
  let modelSettled = false;
  let entered = false;
  let onEnterHandler: () => void = () => undefined;

  const paint = () => {
    const value = Math.round(((settled + (modelSettled ? 0 : modelFraction)) / TOTAL_TASKS) * 100);
    fill.style.width = `${value}%`;
    progress.setAttribute("aria-valuenow", String(value));
  };

  const settle = () => {
    settled += 1;
    paint();
    if (settled >= TOTAL_TASKS) window.setTimeout(() => { if (!entered && !enter.disabled) enter.click(); }, AUTO_ENTER_DELAY_MS);
  };

  enter.addEventListener("click", () => {
    if (enter.disabled || entered) return;
    entered = true;
    onEnterHandler();
  });

  return {
    begin(bossTitle) {
      settled = 0;
      modelFraction = 0;
      modelSettled = false;
      entered = false;
      fill.style.width = "0%";
      progress.setAttribute("aria-valuenow", "0");
      echo.textContent = bossTitle;
      status.textContent = "Loading the arena…";
      enter.disabled = true;
      for (const name of CARD_NAMES) {
        const el = card(name);
        el.classList.remove("revealed", "ready", "skipped");
        el.style.removeProperty("--card-art");
        childOf(el, ".card-body").textContent = "";
        childOf(el, ".card-badge").textContent = "loading";
      }
      panel.classList.remove("hidden");
    },
    revealSpec(spec) {
      const { identity, voice, arenaTheme, weakness, phases } = spec;
      const secondWind = Math.round((phases[1]?.hpThreshold ?? 0.5) * 100);
      const silhouette = oneOf(SILHOUETTES, identity.silhouette);
      const element = oneOf(ELEMENTS, identity.element);
      const temper = oneOf(TEMPERS, identity.temper);
      const trigger = oneOf(WEAKNESS_TRIGGERS, weakness.trigger).replace("_", " ");
      childOf(card("form"), ".card-body").innerHTML =
        `<strong>${text(identity.name)}</strong><em>${text(identity.title)}</em><span>${text(silhouette)} · ${text(element)}</span>`;
      childOf(card("temper"), ".card-body").innerHTML =
        `<strong>${text(temper)}</strong><span>Second phase at ${num(secondWind)}% health</span>`;
      childOf(card("voice"), ".card-body").innerHTML =
        `<q>${text(voice.lines.intro)}</q>`;
      childOf(card("arena"), ".card-body").innerHTML =
        `<span>${text(arenaTheme)}</span><span class="whisper">opening: ${text(trigger)} ×${num(weakness.multiplier)}</span>`;
      CARD_NAMES.forEach((name, i) => window.setTimeout(() => card(name).classList.add("revealed"), 120 + i * 260));
      status.textContent = `${identity.name} takes shape. Loading local assets…`;
      enter.disabled = false;
    },
    markAsset(bundle) {
      const el = card(CARD_FOR_ASSET[bundle.kind]);
      el.classList.add("ready");
      childOf(el, ".card-badge").textContent = "ready";
      const art = bundle.files.portrait ?? bundle.files.sky;
      if (art) el.style.setProperty("--card-art", `url("${art}")`);
      settle();
    },
    skipAsset(kind) {
      const el = card(CARD_FOR_ASSET[kind]);
      el.classList.add("skipped");
      childOf(el, ".card-badge").textContent = kind === "voice" ? "subtitles" : kind === "music" ? "silent" : "built in";
      settle();
    },
    markModel(fraction) {
      if (modelSettled) return;
      modelFraction = Math.max(modelFraction, Math.min(1, fraction));
      if (modelFraction >= 1) {
        modelSettled = true;
        settle();
      } else {
        paint();
      }
    },
    setStatus(value) { status.textContent = value; },
    onEnter(handler) { onEnterHandler = handler; },
    hide() { panel.classList.add("hidden"); },
  };
}
