import type { AssetBundle, AssetKind } from "../assetsClient";
import type { NemesisSpec } from "../spec";

export type CardName = "form" | "temper" | "voice" | "arena";
const CARD_NAMES: CardName[] = ["form", "temper", "voice", "arena"];
const CARD_FOR_ASSET: Record<AssetKind, CardName> = { portrait: "form", music: "temper", voice: "voice", sky: "arena" };
const TOTAL_TASKS = 4;
const AUTO_ENTER_DELAY_MS = 1400;

export interface Ritual {
  begin(incantation: string): void;
  /** Flip the four Forge cards with the spec's fields as soon as Gemini answers. */
  revealSpec(spec: NemesisSpec): void;
  markAsset(bundle: AssetBundle): void;
  failAsset(kind: AssetKind): void;
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

const text = (value: string) => value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

export function createRitual(): Ritual {
  const panel = byId("ritual");
  const echo = byId("ritual-incantation");
  const status = byId("ritual-status");
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
  let entered = false;
  let onEnterHandler: () => void = () => undefined;

  const settle = () => {
    settled += 1;
    fill.style.width = `${(settled / TOTAL_TASKS) * 100}%`;
    if (settled >= TOTAL_TASKS) window.setTimeout(() => { if (!entered && !enter.disabled) enter.click(); }, AUTO_ENTER_DELAY_MS);
  };

  enter.addEventListener("click", () => {
    if (enter.disabled || entered) return;
    entered = true;
    onEnterHandler();
  });

  return {
    begin(incantation) {
      settled = 0;
      entered = false;
      fill.style.width = "0%";
      echo.textContent = `“${incantation}”`;
      status.textContent = "The void is listening…";
      enter.disabled = true;
      for (const name of CARD_NAMES) {
        const el = card(name);
        el.classList.remove("revealed", "ready", "failed");
        el.style.removeProperty("--card-art");
        childOf(el, ".card-body").textContent = "";
        childOf(el, ".card-badge").textContent = "forging";
      }
      panel.classList.remove("hidden");
    },
    revealSpec(spec) {
      const { identity, voice, arenaTheme, music, weakness, phases } = spec;
      const secondWind = Math.round((phases[1]?.hpThreshold ?? 0.5) * 100);
      childOf(card("form"), ".card-body").innerHTML =
        `<strong>${text(identity.name)}</strong><em>${text(identity.title)}</em><span>${identity.silhouette} · ${identity.element}</span>`;
      childOf(card("temper"), ".card-body").innerHTML =
        `<strong>${identity.temper}</strong><span>${music.bpm} bpm · second wind at ${secondWind}% hp</span>`;
      childOf(card("voice"), ".card-body").innerHTML =
        `<span class="whisper">${text(voice.designPrompt)}</span><q>${text(voice.lines.intro)}</q>`;
      childOf(card("arena"), ".card-body").innerHTML =
        `<span>${text(arenaTheme)}</span><span class="whisper">opening: ${weakness.trigger.replace("_", " ")} ×${weakness.multiplier}</span>`;
      CARD_NAMES.forEach((name, i) => window.setTimeout(() => card(name).classList.add("revealed"), 120 + i * 260));
      status.textContent = `${identity.name} takes shape. Its voice, sky and music are still being forged…`;
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
    failAsset(kind) {
      const el = card(CARD_FOR_ASSET[kind]);
      el.classList.add("failed");
      childOf(el, ".card-badge").textContent = "silent";
      settle();
    },
    setStatus(value) { status.textContent = value; },
    onEnter(handler) { onEnterHandler = handler; },
    hide() { panel.classList.add("hidden"); },
  };
}
