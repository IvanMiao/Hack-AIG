import { ASSET_KINDS, bakedBundles, type AssetBundle } from "./bakedAssets";
import { createGameAudio } from "./game/audio";
import { createStage } from "./game/createStage";
import { createCombatInput } from "./game/input";
import { applyGrudge, FALLBACK_SPECS, getFallbackSpec, getFallbackSpecByCode, PLAYER_MAX_HP, ruleGrudge, type NemesisSpec } from "./spec";
import { BOSS, createBattle, createInitialState, PLAYER, TICK_MS, type Battle, type BattleEvent } from "./sim";
import { createRitual } from "./ui/ritual";
import { presentationFor } from "./ui/presentation";

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
};

const canvas = $<HTMLCanvasElement>("stage");
const incantationPanel = $("incantation");
const fightPanel = $("fight");
const outcomePanel = $("outcome");
const boundList = $("bound-list");
const retryButton = $<HTMLButtonElement>("retry-btn");
const newButton = $<HTMLButtonElement>("new-btn");
const retreatButton = $<HTMLButtonElement>("retreat-btn");
const status = $("incantation-status");
const bossHp = $("boss-hp");
const bossPoise = $("boss-poise");
const playerHp = $("player-hp");
const playerStamina = $("player-stamina");
const vigorValue = $("vigor-value");
const staminaValue = $("stamina-value");
const subtitle = $("subtitle");
const hitVignette = $("hit-vignette");
const comboPips = Array.from($("combo-pips").children) as HTMLElement[];
const comboPipsBox = $("combo-pips");
const heavyCharge = $("heavy-charge");
const combatCue = $("combat-cue");
const portrait = $<HTMLImageElement>("portrait");
const grudgeCard = $("grudge");
const grudgeObservation = $("grudge-observation");
const grudgePatch = $("grudge-patch");
const introCard = $("boss-intro");
const enterButton = $("enter-btn");
const stage = createStage(canvas);
const combat = createCombatInput(canvas);
const audio = createGameAudio();
const ritual = createRitual();
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const INTRO_PORTRAIT_MS = 5200;
const INTRO_CARD_MS = 2500;
/** Longest a spoken line may hold its subtitle if the clip never reports ending. */
const VOICE_LINE_MAX_MS = 12_000;
let spec: NemesisSpec | null = null;
let battle: Battle | null = null;
let seed = 1;
let hitStopMs = 0;
let accumulator = 0;
let subtitleTimer: number | undefined;
let portraitTimer: number | undefined;
let cueTimer: number | undefined;
let introTimer: number | undefined;
let introHoldMs = 0;
let introFadeTimer: number | undefined;
let battleStartedAt = 0;
let summonToken = 0;

const say = (line: string, holdMs = 3200) => {
  subtitle.textContent = line;
  subtitle.classList.add("visible");
  window.clearTimeout(subtitleTimer);
  subtitleTimer = window.setTimeout(() => subtitle.classList.remove("visible"), holdMs);
};

/** Subtitle and clip for the same line: the text stays up for as long as the boss is actually saying it. */
const speakLine = (name: string, line: string, holdMs = 3200) => {
  say(line, holdMs);
  const spoken = audio.speak(name, () => {
    if (subtitle.textContent !== line) return;
    window.clearTimeout(subtitleTimer);
    subtitleTimer = window.setTimeout(() => subtitle.classList.remove("visible"), 400);
  });
  if (spoken) {
    window.clearTimeout(subtitleTimer);
    subtitleTimer = window.setTimeout(() => subtitle.classList.remove("visible"), Math.max(holdMs, VOICE_LINE_MAX_MS));
  }
};

/** Short combat callout under the hero: PERFECT / FINISHER / CHARGED / a hit taken. */
const cue = (text: string, kind: "perfect" | "finisher" | "charged" | "hurt") => {
  combatCue.textContent = text;
  combatCue.dataset.kind = kind;
  combatCue.classList.remove("show");
  void combatCue.offsetWidth;
  combatCue.classList.add("show");
  window.clearTimeout(cueTimer);
  cueTimer = window.setTimeout(() => combatCue.classList.remove("show"), 800);
};

const showPortrait = (ms: number | null) => {
  if (!portrait.getAttribute("src")) return;
  portrait.classList.add("shown");
  window.clearTimeout(portraitTimer);
  if (ms !== null) portraitTimer = window.setTimeout(() => portrait.classList.remove("shown"), ms);
};

function applyAsset(bundle: AssetBundle) {
  switch (bundle.kind) {
    case "sky":
      if (bundle.files.sky) stage.setSky(bundle.files.sky);
      break;
    case "portrait":
      portrait.src = bundle.files.portrait ?? "";
      stage.setPortrait(bundle.files.portrait ?? null);
      break;
    case "music":
      if (bundle.files.p1 && bundle.files.p2) {
        audio.setMusic(bundle.files.p1, bundle.files.p2);
        audio.playPhase(battle && battle.state.boss.phaseIndex > 0 ? 2 : 1);
      }
      break;
    case "voice":
      audio.setVoice(bundle.files);
      // Voice that lands during the intro still gets to say the intro; any later and it would talk over the fight.
      if (spec && battle && performance.now() - battleStartedAt < INTRO_PORTRAIT_MS) speakLine("intro", spec.voice.lines.intro, 4500);
      break;
    default:
      break;
  }
}

function applyPresentation(next: NemesisSpec) {
  const copy = presentationFor(next);
  enterButton.textContent = copy.enter;
  $("player-health-label").textContent = copy.playerHealth;
  playerHp.parentElement?.setAttribute("aria-label", copy.playerHealthAria);
  $("player-stamina-label").textContent = copy.playerStamina;
  playerStamina.parentElement?.setAttribute("aria-label", copy.playerStaminaAria);
  $("boss-eyebrow").textContent = copy.bossEyebrow;
  bossHp.parentElement?.setAttribute("aria-label", copy.bossHealthAria);
  bossPoise.parentElement?.setAttribute("aria-label", copy.bossPoiseAria);
  $("intro-eyebrow").textContent = copy.introEyebrow;
}

function summon(next: NemesisSpec) {
  const token = ++summonToken;
  pendingGrudge = null;
  portrait.src = "";
  stage.setPortrait(null);
  audio.setVoice({});
  portrait.classList.remove("shown");
  stage.setSky(null);
  audio.stopMusic();
  incantationPanel.classList.add("hidden");
  ritual.begin(next.identity.title);
  spec = next;
  applyPresentation(next);
  stage.applySpec(next);
  document.documentElement.style.setProperty("--accent", next.art.accentHex);
  ritual.revealSpec(next);

  // The selected boss and every available soundtrack, image, and voice clip come from this build.
  const baked = bakedBundles(next.code);
  for (const bundle of baked) {
    applyAsset(bundle);
    ritual.markAsset(bundle);
  }
  for (const kind of ASSET_KINDS) {
    if (!baked.some((bundle) => bundle.kind === kind)) ritual.skipAsset(kind);
  }
  ritual.setStatus(baked.length === ASSET_KINDS.length
    ? "Local arena, voice and music ready."
    : "Local arena ready. Missing voice clips use subtitles; visuals use game defaults.");

  void stage.preloadBoss(next, (fraction) => {
    if (token === summonToken) ritual.markModel(fraction);
  }).then(() => {
    if (token === summonToken) ritual.markModel(1);
  });
}

function syncPhasePips(phaseIndex: number) {
  for (const [index, pip] of [...document.querySelectorAll<HTMLElement>(".phase-pip")].entries()) {
    pip.classList.toggle("active", index === phaseIndex);
    pip.classList.toggle("done", index < phaseIndex);
  }
}

function startBattle(next: NemesisSpec) {
  spec = next;
  applyPresentation(next);
  seed += 1;
  battle = createBattle(next, seed);
  accumulator = 0;
  hitStopMs = 0;
  introHoldMs = reducedMotion.matches ? 0 : INTRO_CARD_MS;
  stage.applySpec(next);
  stage.setMode("fight");
  document.body.classList.remove("flatline");
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
  }, reducedMotion.matches ? 0 : INTRO_CARD_MS);
  audio.playPhase(1);
  battleStartedAt = performance.now();
  speakLine("intro", next.voice.lines.intro, 4500);
  showPortrait(INTRO_PORTRAIT_MS);
  syncHud();
}

/** The offline rule system adapts the selected boss between retries. */
let pendingGrudge: { observation: string; patch: string; gen: number } | null = null;

function renderGrudge() {
  if (!pendingGrudge) return;
  grudgeObservation.textContent = pendingGrudge.observation;
  grudgePatch.textContent = pendingGrudge.patch;
  retryButton.textContent = `RETRY · GEN ${pendingGrudge.gen}`;
}

function showOutcome(kind: "death" | "victory") {
  if (!spec) return;
  const copy = presentationFor(spec);
  $("outcome-title").textContent = kind === "death" ? copy.deathTitle : copy.victoryTitle;
  $("outcome-line").textContent = kind === "death" ? `${spec.identity.name} remembers this defeat.` : spec.voice.lines.defeat;
  if (kind === "death" && pendingGrudge) {
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
      case "bossHit": {
        const finisher = !event.heavy && event.combo === PLAYER.combo.length - 1;
        hitStopMs = Math.max(hitStopMs, event.heavy ? 90 + event.charge * 50 : finisher ? 65 : 40);
        if (event.heavy && event.charge >= 0.99) cue("CHARGED", "charged");
        else if (finisher) cue("FINISHER", "finisher");
        break;
      }
      case "playerRoll":
        if (event.perfect) {
          hitStopMs = Math.max(hitStopMs, 70);
          cue("PERFECT", "perfect");
        }
        break;
      case "playerHit": {
        hitStopMs = Math.max(hitStopMs, 60);
        // Light the edge the blow came from: the wash centre moves along the shove, in screen space.
        const shove = stage.screenRelative(event.dir);
        hitVignette.style.setProperty("--hit-x", `${50 + shove.x * 30}%`);
        hitVignette.style.setProperty("--hit-y", `${50 - shove.z * 30}%`);
        hitVignette.classList.remove("flash");
        void hitVignette.offsetWidth;
        hitVignette.classList.add("flash");
        cue(`-${event.damage}`, "hurt");
        break;
      }
      case "phaseChange":
        hitStopMs = Math.max(hitStopMs, 220);
        syncPhasePips(event.phaseIndex);
        document.body.classList.toggle("flatline", spec.phases[event.phaseIndex]?.rule === "flatline");
        speakLine("phase", spec.voice.lines.phase, 4000);
        audio.playPhase(2);
        break;
      case "taunt":
        speakLine(`taunt${event.index}`, spec.voice.lines.taunt[event.index] ?? spec.voice.lines.taunt[0] ?? "");
        break;
      case "weaknessOpen":
        if (!audio.isSpeaking()) say("— an opening —", 1200);
        break;
      case "playerDeath":
        speakLine(`playerDeath${event.lineIndex}`, spec.voice.lines.playerDeath[event.lineIndex] ?? spec.voice.lines.playerDeath[0] ?? "", 6000);
        try {
          const patch = ruleGrudge(spec, battle.state.log);
          spec = applyGrudge(spec, patch);
          pendingGrudge = { observation: patch.observation, patch: patch.patch, gen: spec.lineage.gen };
        } catch (error) {
          console.warn("[grudge] local adaptation failed", error);
          pendingGrudge = null;
        }
        const finishedBattle = battle;
        window.setTimeout(() => {
          if (battle === finishedBattle) showOutcome("death");
        }, 900);
        break;
      case "bossDefeat":
        audio.speak("defeat");
        audio.stopMusic();
        const defeatedBattle = battle;
        window.setTimeout(() => {
          if (battle === defeatedBattle) showOutcome("victory");
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
  // Poise drains as the player lands hits; empty means a stagger is imminent. During the stagger it shows the refill.
  const poiseLeft = boss.staggerT > 0 ? spec.stats.poise * (1 - boss.staggerT / BOSS.staggerMs) : spec.stats.poise - boss.poiseDamage;
  setProgress(bossPoise, poiseLeft, spec.stats.poise);
  bossPoise.parentElement?.classList.toggle("staggered", boss.staggerT > 0);
  setProgress(playerHp, player.hp, PLAYER_MAX_HP);
  setProgress(playerStamina, player.stamina, PLAYER.maxStamina);
  vigorValue.textContent = `${Math.ceil(player.hp)} / ${PLAYER_MAX_HP}`;
  staminaValue.textContent = `${Math.ceil(player.stamina)} / ${PLAYER.maxStamina}`;
  // Combo pips: how many hits of the chain have been thrown; the chain drops back to zero once the window lapses.
  const chainLive = player.action === "light" || player.comboIdleT < PLAYER.comboResetMs;
  const lit = chainLive ? player.comboIndex + 1 : 0;
  comboPips.forEach((pip, i) => {
    pip.classList.toggle("lit", i < lit);
    pip.classList.toggle("finisher", lit === PLAYER.combo.length && i === PLAYER.combo.length - 1);
  });
  comboPipsBox.setAttribute("aria-label", lit > 0 ? `Light combo: hit ${lit} of ${PLAYER.combo.length}` : "Light combo: ready");
  const charge = player.action === "heavy" ? player.charge : 0;
  setProgress(heavyCharge, charge, 1);
  heavyCharge.parentElement?.classList.toggle("full", charge >= 0.99);
}

function retreat() {
  battle = null;
  summonToken += 1;
  accumulator = 0;
  hitStopMs = 0;
  window.clearTimeout(introTimer);
  window.clearTimeout(introFadeTimer);
  window.clearTimeout(subtitleTimer);
  window.clearTimeout(cueTimer);
  combatCue.classList.remove("show");
  audio.stopMusic();
  document.body.classList.remove("flatline");
  portrait.classList.remove("shown");
  fightPanel.classList.add("hidden");
  fightPanel.classList.remove("intro-active");
  outcomePanel.classList.add("hidden");
  introCard.classList.add("hidden");
  stage.setSky(null);
  stage.setMode("attract");
  ritual.hide();
  incantationPanel.classList.remove("hidden");
  status.textContent = "Choose a boss to fight again.";
  boundList.querySelector<HTMLButtonElement>("button")?.focus();
}

ritual.onEnter(() => {
  if (spec) startBattle(spec);
});

for (const bound of FALLBACK_SPECS) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "bound-card";
  card.setAttribute("role", "listitem");
  card.style.setProperty("--bound-accent", bound.art.accentHex);
  card.innerHTML = `<strong></strong><em></em><span></span>`;
  card.querySelector("strong")!.textContent = bound.identity.name;
  card.querySelector("em")!.textContent = bound.identity.title;
  card.querySelector("span")!.textContent = `${bound.identity.silhouette} · ${bound.identity.element}`;
  card.addEventListener("click", () => {
    const chosen = getFallbackSpecByCode(bound.code) ?? getFallbackSpec();
    summon(chosen);
  });
  boundList.append(card);
}

document.addEventListener("keydown", (event) => {
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
    if (introHoldMs > 0) {
      // The sim waits for the intro card; the player would otherwise be taking hits behind it.
      introHoldMs -= dt * 1000;
      combat.read();
    } else if (hitStopMs > 0) hitStopMs -= dt * 1000;
    else {
      accumulator += dt * 1000;
      const inputNow = combat.read();
      inputNow.move = stage.cameraRelative(inputNow.move);
      while (accumulator >= TICK_MS) {
        accumulator -= TICK_MS;
        events.push(...battle.step(inputNow));
        inputNow.light = inputNow.heavy = inputNow.roll = inputNow.jump = false;
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
