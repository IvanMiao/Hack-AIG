import * as THREE from "three";
import { addOutline, createToonMaterial, RIM } from "./materials";
import { instantiate, loadAssetLibrary, type AssetLibrary } from "./assets";
import { createHazardView } from "./hazardView";
import { createHFHero, type HFHero } from "./hfHero";
import { createCodexBoss, type CodexBoss } from "./codexBoss";
import { createFlatlineSet } from "./flatline";
import { createPostFX, DEFAULT_POST, type PostSettings } from "./fx/post";
import { createParticles } from "./fx/particles";
import { createPillars } from "./fx/pillars";
import { createRimCollapse } from "./fx/rimCollapse";
import { DEFAULT_PALETTE, resolvePalette, type Palette } from "./render/palette";
import { nextCameraYaw } from "./cameraFollow";
import { attackFraction, Locomotion, type Overlay } from "./locomotion";
import { isCodexBout, type MoveType, type NemesisSpec } from "../spec";
import { ARENA_FLOOR_RADIUS, ARENA_RADIUS, BOSS, PLAYER, attackFor, moveTiming, type AttackSpec, type BattleEvent, type BattleState, type Vec2 } from "../sim";
import skyUrl from "../../blender/art/textures/sky.jpg?url";

/** Everything the lab may retune live. Plain mutable objects so lil-gui can bind to them directly. */
export interface StageTuning {
  lights: {
    hemisphere: number;
    key: number;
    rim: number;
    fill: number;
    heroLamp: number;
    /** Warm accent pool on the arena centre. */
    pool: number;
    poolRadius: number;
  };
  rim: { strength: number; power: number };
  fog: { density: number };
  camera: {
    fov: number;
    distance: number;
    side: number;
    height: number;
    lag: number;
    shake: number;
    punch: number;
    /** Extra pull-back per world unit of fighter separation past `farGap`, capped by `maxPullBack`. */
    farGap: number;
    pullBack: number;
    maxPullBack: number;
    /** Look-target smoothing (1/s): higher snaps faster; keeps blink/knockback from whipping the pitch. */
    lookLag: number;
    /** Camera kick distance (world units) on a player hit, along the knockback direction. */
    hitKick: number;
  };
  floor: {
    /** Low-frequency value breakup so the slab is not one flat tone. */
    breakup: number;
    /** How much darker the stone apron beyond the playable disc reads. */
    apron: number;
    /** Accent hairline marking the playable edge. */
    ring: number;
  };
  fx: { particles: boolean; ambient: boolean };
  post: PostSettings;
}

export interface StageDebug {
  /** Draw player/boss collision radii and the player's attack reach. */
  hitboxes: boolean;
  /** Freeze the auto camera so an external controller (orbit) may drive it. */
  freeCamera: boolean;
}

export const DEFAULT_TUNING = (): StageTuning => ({
  lights: { hemisphere: 1.35, key: 3.6, rim: 3.4, fill: 1.5, heroLamp: 14, pool: 320, poolRadius: 9 },
  rim: { strength: 0.85, power: 3.2 },
  fog: { density: 0.022 },
  camera: { fov: 55, distance: 6.8, side: 4.2, height: 4.6, lag: 8, shake: 0.6, punch: 1, farGap: 7, pullBack: 0.28, maxPullBack: 3.2, lookLag: 7, hitKick: 0.45 },
  floor: { breakup: 0.22, apron: 0.38, ring: 0.5 },
  fx: { particles: true, ambient: true },
  post: { ...DEFAULT_POST },
});

export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  ready: Promise<void>;
  tuning: StageTuning;
  debug: StageDebug;
  /** The hand-tuned palette currently applied (derived from the spec's element + accent). */
  palette(): Palette;
  applySpec(spec: NemesisSpec): void;
  /** Fetch the boss model for this spec (arena/player load eagerly; bosses stream in per silhouette). Resolves even if the model fails. */
  preloadBoss(spec: NemesisSpec, onProgress?: (fraction: number) => void): Promise<void>;
  setSky(url: string | null): void;
  /** Portrait used by the `flatline` reward blocks; null clears it. */
  setPortrait(url: string | null): void;
  setMode(mode: "attract" | "fight"): void;
  /** Map a screen-relative stick (x = right, z = forward) into world space using the current camera yaw. Passes through once the arena is flat. */
  cameraRelative(move: Vec2): Vec2;
  /** Inverse of `cameraRelative`: a world-space direction expressed as screen right / screen forward. */
  screenRelative(dir: Vec2): Vec2;
  render(dt: number, state: BattleState, events: readonly BattleEvent[]): void;
  dispose(): void;
}

/** Side-on camera for `flatline` phases. fov 7 at ~90 m reads as orthographic; the elevation keeps floor telegraphs legible. */
const FLAT_CAMERA = {
  fov: 7,
  elevation: 0.36,
  lookHeight: 1.6,
  minHalfHeight: 5.2,
  /** horizontal padding around the two fighters, in world metres */
  margin: 4,
  /** the frame is hung a touch crooked, like a cartridge seated wrong */
  roll: 0.03,
  rampSeconds: 1.6,
  /** the old floor sinks this far so the lane tiles stand proud of it */
  floorDrop: 0.6,
} as const;

const BOSS_HEIGHTS: Record<NemesisSpec["identity"]["silhouette"], number> = {
  colossus: 4.25,
  hound: 2.15,
  seraph: 3.8,
  serpent: 3.25,
  knight: 3.6,
  swarm: 2.8,
};

interface ToonMaterialState {
  material: THREE.MeshToonMaterial;
  emissive: THREE.Color;
}

const clamp01 = (value: number) => THREE.MathUtils.clamp(value, 0, 1);
const easeOut = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
const easeIn = (t: number) => Math.pow(clamp01(t), 3);
const easeInOut = (t: number) => THREE.MathUtils.smoothstep(t, 0, 1);
/** 0 until `hold`, then eases to 1 by t = 1. Used so a pose is held for a beat before returning to rest. */
const holdThenEase = (t: number, hold: number) => easeInOut((clamp01(t) - hold) / (1 - hold));

interface PlayerPose {
  lean: number;
  twist: number;
  lunge: number;
  crouch: number;
  bladeX: number;
  bladeZ: number;
  slash: number;
  charge: number;
}

const REST_POSE: PlayerPose = { lean: 0, twist: 0, lunge: 0, crouch: 0, bladeX: 0, bladeZ: -0.3, slash: 0, charge: 0 };
const LIGHT_WINDUP: PlayerPose = { lean: -0.05, twist: -0.5, lunge: -0.08, crouch: 0.04, bladeX: -0.7, bladeZ: -1.8, slash: 0, charge: 0 };
const LIGHT_STRIKE: PlayerPose = { lean: 0.18, twist: 0.55, lunge: 0.42, crouch: 0.06, bladeX: 0.9, bladeZ: 1.7, slash: 1, charge: 0 };
const HEAVY_WINDUP: PlayerPose = { lean: -0.2, twist: -0.3, lunge: -0.15, crouch: 0.16, bladeX: -2.5, bladeZ: -0.9, slash: 0, charge: 1 };
const HEAVY_STRIKE: PlayerPose = { lean: 0.42, twist: 0.15, lunge: 0.6, crouch: 0.1, bladeX: 1.15, bladeZ: 0.25, slash: 1, charge: 0 };
// Hit 2 answers hit 1 from the other side; hit 3 is a stepping overhead finisher.
const LIGHT2_WINDUP: PlayerPose = { lean: -0.04, twist: 0.5, lunge: -0.05, crouch: 0.05, bladeX: -0.6, bladeZ: 1.7, slash: 0, charge: 0 };
const LIGHT2_STRIKE: PlayerPose = { lean: 0.2, twist: -0.55, lunge: 0.45, crouch: 0.06, bladeX: 0.8, bladeZ: -1.6, slash: 1, charge: 0 };
const LIGHT3_WINDUP: PlayerPose = { lean: -0.16, twist: -0.2, lunge: -0.2, crouch: 0.14, bladeX: -2.2, bladeZ: -0.5, slash: 0, charge: 0.3 };
const LIGHT3_STRIKE: PlayerPose = { lean: 0.38, twist: 0.1, lunge: 0.7, crouch: 0.12, bladeX: 1.05, bladeZ: 0.3, slash: 1, charge: 0 };
const LIGHT_POSES: readonly { windup: PlayerPose; strike: PlayerPose }[] = [
  { windup: LIGHT_WINDUP, strike: LIGHT_STRIKE },
  { windup: LIGHT2_WINDUP, strike: LIGHT2_STRIKE },
  { windup: LIGHT3_WINDUP, strike: LIGHT3_STRIKE },
];
const HURT_POSE: PlayerPose = { lean: -0.35, twist: 0.25, lunge: -0.25, crouch: 0.1, bladeX: -0.4, bladeZ: -1.2, slash: 0, charge: 0 };

const lerpPose = (out: PlayerPose, a: PlayerPose, b: PlayerPose, t: number): PlayerPose => {
  out.lean = THREE.MathUtils.lerp(a.lean, b.lean, t);
  out.twist = THREE.MathUtils.lerp(a.twist, b.twist, t);
  out.lunge = THREE.MathUtils.lerp(a.lunge, b.lunge, t);
  out.crouch = THREE.MathUtils.lerp(a.crouch, b.crouch, t);
  out.bladeX = THREE.MathUtils.lerp(a.bladeX, b.bladeX, t);
  out.bladeZ = THREE.MathUtils.lerp(a.bladeZ, b.bladeZ, t);
  out.slash = THREE.MathUtils.lerp(a.slash, b.slash, t);
  out.charge = THREE.MathUtils.lerp(a.charge, b.charge, t);
  return out;
};

/** Anticipate → snap → hold → settle. The strike snaps in the first half of the active window so the hit reads instantly. */
function attackPose(out: PlayerPose, actionT: number, attack: AttackSpec, windup: PlayerPose, strike: PlayerPose): PlayerPose {
  if (actionT < attack.windupMs) return lerpPose(out, REST_POSE, windup, easeOut(actionT / attack.windupMs));
  const activeT = actionT - attack.windupMs;
  if (activeT < attack.activeMs) return lerpPose(out, windup, strike, easeOut((activeT / attack.activeMs) * 2));
  const recoverT = (activeT - attack.activeMs) / attack.recoverMs;
  lerpPose(out, strike, REST_POSE, holdThenEase(recoverT, 0.3));
  out.slash = 1 - THREE.MathUtils.smoothstep(recoverT, 0, 0.45);
  return out;
}

interface BossPose {
  lean: number;
  lunge: number;
  rise: number;
  stretch: number;
  squash: number;
  glow: number;
  /** Arm pivot angle about X (radians): 0 hangs at rest, -π/2 points forward, -2.3 is raised overhead. */
  swing: number;
  /** Head tilt: negative = reared back, positive = lunging forward/down. Also drives the swarm's contract/burst. */
  headTilt: number;
  /** Body yaw about the facing axis (radians): a sweep winds one way and cuts across the other. */
  twist: number;
}

const BOSS_REST: BossPose = { lean: 0, lunge: 0, rise: 0, stretch: 1, squash: 1, glow: 0, swing: 0, headTilt: 0, twist: 0 };
const BOSS_COIL: BossPose = { lean: -0.3, lunge: -0.35, rise: 0.4, stretch: 1.06, squash: 1.1, glow: 1, swing: -2.3, headTilt: -0.5, twist: 0 };
/** The farthest-reaching strike pose (the thrust); the arena-fit test keeps this over the stone at the rim clamp. */
export const BOSS_MELEE_STRIKE: BossPose = { lean: 0.62, lunge: 1.8, rise: -0.2, stretch: 1.04, squash: 0.92, glow: 0, swing: -1.55, headTilt: 0.7, twist: 0 };
const BOSS_RANGED_STRIKE: BossPose = { lean: 0.22, lunge: 0.25, rise: 0.55, stretch: 1.14, squash: 0.96, glow: 0, swing: -1.45, headTilt: 0.3, twist: 0 };
const BOSS_STAGGER: BossPose = { lean: 0.42, lunge: -0.2, rise: -0.25, stretch: 1.04, squash: 0.9, glow: 0, swing: 0.35, headTilt: 0.6, twist: 0.2 };

interface MovePerformance {
  /** Pose held at the end of the telegraph. */
  coil: BossPose;
  /** Pose snapped to at commit. */
  strike: BossPose;
  /** Pose the strike overshoots into before settling back to rest (melee follow-through). */
  settle: BossPose;
}

/**
 * One coil/strike/settle triplet per move so every attack has its own silhouette:
 * sweep winds across and cuts through, thrust drops low and spears out, nova leaps and slams, charge leans into the run,
 * blink folds in and pops out, volley recoils, ring raises then hammers down, zone rears back and casts.
 */
const MOVE_PERFORMANCE: Record<MoveType, MovePerformance> = {
  sweep: {
    coil: { ...BOSS_COIL, twist: -0.75, swing: -2, lean: -0.2 },
    strike: { ...BOSS_MELEE_STRIKE, twist: 0.7, swing: -1.35, lean: 0.35, lunge: 0.8, rise: -0.1, stretch: 1.1, squash: 0.9 },
    settle: { ...BOSS_REST, twist: 0.35, lean: 0.15, lunge: 0.3, swing: -0.6 },
  },
  thrust: {
    coil: { ...BOSS_COIL, rise: -0.15, lean: -0.15, lunge: -0.7, squash: 0.92, stretch: 1.02, swing: -1.9, headTilt: -0.3 },
    strike: BOSS_MELEE_STRIKE,
    settle: { ...BOSS_REST, lean: 0.25, lunge: 0.9, swing: -1.1, headTilt: 0.3 },
  },
  nova: {
    coil: { ...BOSS_COIL, rise: 0.95, lunge: -0.1, lean: -0.25, squash: 1.18, stretch: 0.96, swing: -2.6, headTilt: -0.6 },
    strike: { ...BOSS_MELEE_STRIKE, lean: 0.3, lunge: 0.2, rise: -0.35, stretch: 1.32, squash: 0.72, swing: -0.4, headTilt: 0.8 },
    settle: { ...BOSS_REST, rise: -0.1, stretch: 1.1, squash: 0.92, swing: -0.2, headTilt: 0.25 },
  },
  charge: {
    coil: { ...BOSS_COIL, lean: -0.42, lunge: -0.5, rise: 0.15, squash: 1.08, swing: -1.6, headTilt: -0.45 },
    strike: { ...BOSS_MELEE_STRIKE, lean: 0.7, lunge: 0.6, rise: -0.05, stretch: 1.06, squash: 0.94, swing: -1.25, headTilt: 0.6 },
    settle: { ...BOSS_REST, lean: 0.3, lunge: 0.4, rise: -0.15, squash: 0.94, stretch: 1.06, swing: -0.7 },
  },
  blink: {
    coil: { ...BOSS_COIL, rise: 0.7, lunge: 0, lean: 0, stretch: 0.78, squash: 1.35, swing: -2.8, headTilt: -0.7 },
    strike: { ...BOSS_RANGED_STRIKE, rise: 0.1, lunge: 0.2, lean: 0.25, stretch: 1.22, squash: 0.86, swing: -1.2, headTilt: 0.5 },
    settle: { ...BOSS_REST, lunge: 0.1, lean: 0.1, swing: -0.4 },
  },
  volley: {
    coil: { ...BOSS_COIL, lunge: -0.5, lean: -0.36, rise: 0.3, swing: -2.4, headTilt: -0.55 },
    strike: { ...BOSS_RANGED_STRIKE, lunge: -0.15, lean: -0.05, rise: 0.4, swing: -1.6, headTilt: 0.2, stretch: 1.08 },
    settle: { ...BOSS_REST, lunge: -0.25, lean: -0.12, swing: -1.2 },
  },
  ring: {
    coil: { ...BOSS_COIL, rise: 0.75, lunge: -0.1, lean: -0.15, squash: 1.16, stretch: 0.98, swing: -2.9, headTilt: -0.5 },
    strike: { ...BOSS_RANGED_STRIKE, rise: -0.3, lunge: 0.3, lean: 0.45, squash: 0.8, stretch: 1.24, swing: -0.3, headTilt: 0.75 },
    settle: { ...BOSS_REST, rise: -0.05, lean: 0.15, squash: 0.94, stretch: 1.06, swing: -0.15, headTilt: 0.2 },
  },
  zone: {
    coil: { ...BOSS_COIL, lean: -0.5, lunge: -0.4, rise: 0.5, swing: -2.7, headTilt: -0.7 },
    strike: { ...BOSS_RANGED_STRIKE, lean: 0.1, lunge: 0.1, rise: 0.6, swing: -1.9, headTilt: 0.15 },
    settle: { ...BOSS_REST, lean: -0.05, rise: 0.15, swing: -1.5, headTilt: -0.1 },
  },
};

const lerpBossPose = (out: BossPose, a: BossPose, b: BossPose, t: number): BossPose => {
  out.lean = THREE.MathUtils.lerp(a.lean, b.lean, t);
  out.lunge = THREE.MathUtils.lerp(a.lunge, b.lunge, t);
  out.rise = THREE.MathUtils.lerp(a.rise, b.rise, t);
  out.stretch = THREE.MathUtils.lerp(a.stretch, b.stretch, t);
  out.squash = THREE.MathUtils.lerp(a.squash, b.squash, t);
  out.glow = THREE.MathUtils.lerp(a.glow, b.glow, t);
  out.swing = THREE.MathUtils.lerp(a.swing, b.swing, t);
  out.headTilt = THREE.MathUtils.lerp(a.headTilt, b.headTilt, t);
  out.twist = THREE.MathUtils.lerp(a.twist, b.twist, t);
  return out;
};

/** Telegraph curve: slow gather for most of the window, then a quick final cock so the commit point is visible. */
const gather = (u: number) => easeIn(u) * 0.55 + easeOut(u) * 0.2 + THREE.MathUtils.smoothstep(u, 0.72, 1) * 0.25;

function bossPose(out: BossPose, boss: BattleState["boss"], timeMs: number, walkSpeed: number): BossPose {
  if (boss.staggerT > 0) {
    const u = 1 - boss.staggerT / BOSS.staggerMs;
    lerpBossPose(out, BOSS_STAGGER, BOSS_REST, THREE.MathUtils.smoothstep(u, 0.7, 1));
    out.lean += Math.sin(timeMs / 70) * 0.05 * (1 - u);
    out.twist += Math.sin(timeMs / 110) * 0.06 * (1 - u);
    return out;
  }
  const current = boss.current;
  if (!current) {
    lerpBossPose(out, BOSS_REST, BOSS_REST, 0);
    // Walking bob: the body dips and leans into the stride so approach reads as weight, not sliding.
    const stride = Math.min(1, walkSpeed / BOSS.walkSpeed);
    out.rise = -Math.abs(Math.sin(timeMs / 190)) * 0.09 * stride;
    out.lean = 0.08 * stride;
    out.twist = Math.sin(timeMs / 190) * 0.05 * stride;
    return out;
  }
  const perf: MovePerformance = MOVE_PERFORMANCE[current.move.type] ?? MOVE_PERFORMANCE.sweep;
  const timing = moveTiming(current.move.type);
  if (current.phase === "telegraph") {
    const u = current.t / current.telegraphMs;
    lerpBossPose(out, BOSS_REST, perf.coil, gather(u));
    const tremble = THREE.MathUtils.smoothstep(u, 0.7, 1) * Math.sin(timeMs / 22) * 0.035;
    out.lean += tremble;
    out.swing += tremble * 2;
    out.glow = u * u;
    return out;
  }
  if (current.phase === "active") {
    const u = timing.activeMs > 0 ? current.t / timing.activeMs : 1;
    lerpBossPose(out, perf.coil, perf.strike, easeOut(Math.min(1, u * 2.2)));
    if (current.move.type === "charge") {
      // Gallop while the run is live.
      out.rise += Math.abs(Math.sin(timeMs / 60)) * 0.18;
      out.squash *= 1 - Math.abs(Math.sin(timeMs / 60)) * 0.05;
    }
    out.glow = 1 - u;
    return out;
  }
  const u = current.t / timing.recoverMs;
  // Ranged moves have no active window, so the strike snaps at the start of recovery.
  if (timing.activeMs === 0) {
    const snap = easeOut(Math.min(1, u * 4));
    lerpBossPose(out, perf.coil, perf.strike, snap);
    if (snap >= 1) lerpBossPose(out, perf.strike, BOSS_REST, holdThenEase(u, 0.4));
    return out;
  }
  // Melee follow-through: overshoot into the settle pose, hang there, then ease back to rest.
  if (u < 0.25) lerpBossPose(out, perf.strike, perf.settle, easeOut(u / 0.25));
  else lerpBossPose(out, perf.settle, BOSS_REST, holdThenEase((u - 0.25) / 0.75, 0.3));
  return out;
}

/**
 * Which authored player clip to layer this frame and where to scrub it. Attacks map the sim's windup/active/
 * recover windows onto the shared attack layout (the strike snaps in the first half of the active window, like
 * the procedural blade); the hit flinch rides the hit-flash timer; death plays once and holds its last frame.
 */
function playerOverlayFor(motion: Locomotion, p: BattleState["player"], deathSeconds: number): Overlay | null {
  if (deathSeconds > 0 && motion.hasClip("death")) return { clip: "death", seconds: deathSeconds };
  if (p.action === "light" || p.action === "heavy") {
    if (!motion.hasClip(p.action)) return null;
    const attack = p.action === "light" ? PLAYER.light : PLAYER.heavy;
    if (p.actionT < attack.windupMs) return { clip: p.action, fraction: attackFraction("windup", p.actionT / attack.windupMs) };
    const activeT = p.actionT - attack.windupMs;
    if (activeT < attack.activeMs) return { clip: p.action, fraction: attackFraction("active", (activeT / attack.activeMs) * 2) };
    return { clip: p.action, fraction: attackFraction("recover", (activeT - attack.activeMs) / attack.recoverMs) };
  }
  if (p.action === "idle" && p.hitFlash > 0 && motion.hasClip("hit")) return { clip: "hit", fraction: 1 - p.hitFlash / 200 };
  return null;
}

/**
 * Boss counterpart: death > stagger (loops) > current move (telegraph/active/recover scrubbed onto the attack
 * layout; ranged moves have no active window so contact snaps at the start of recovery) > hit flinch.
 */
function bossOverlayFor(motion: Locomotion, boss: BattleState["boss"], outcome: BattleState["outcome"], deathSeconds: number): Overlay | null {
  if (outcome === "bossDead" && motion.hasClip("death")) return { clip: "death", seconds: deathSeconds };
  if (boss.staggerT > 0 && motion.hasClip("stagger")) return { clip: "stagger" };
  const current = boss.current;
  if (current) {
    const melee = current.move.type === "sweep" || current.move.type === "thrust" || current.move.type === "nova" || current.move.type === "charge";
    const clip = melee ? "attack_melee" : "attack_ranged";
    if (!motion.hasClip(clip)) return null;
    const timing = moveTiming(current.move.type);
    if (current.phase === "telegraph") return { clip, fraction: attackFraction("windup", current.t / current.telegraphMs) };
    if (current.phase === "active") return { clip, fraction: attackFraction("active", timing.activeMs > 0 ? current.t / timing.activeMs : 1) };
    const u = current.t / timing.recoverMs;
    if (timing.activeMs === 0 && u < 0.25) return { clip, fraction: attackFraction("active", u / 0.25) };
    return { clip, fraction: attackFraction("recover", timing.activeMs === 0 ? (u - 0.25) / 0.75 : u) };
  }
  if (boss.hitFlash > 0 && motion.hasClip("hit")) return { clip: "hit", fraction: 1 - boss.hitFlash / 120 };
  return null;
}

/**
 * Procedural boss rig: the authored GLBs expose `rig_strike` / `rig_head` joints that the idle/move clips
 * animate. Each frame we restore those joints to rest, let the mixer write the authored pose, then add the
 * sim-driven telegraph/active/recover offsets on top so the two never fight. Assets without joints fall back
 * to gathering meshes by name into pivot groups.
 */
interface JointRest {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

interface BossRig {
  strike: THREE.Object3D | null;
  head: THREE.Object3D | null;
  kind: "arm" | "head" | "burst";
  rest: Map<THREE.Object3D, JointRest>;
}

const RIG_RULES: Record<NemesisSpec["identity"]["silhouette"], { strike: RegExp; head: RegExp | null; kind: BossRig["kind"] }> = {
  knight: { strike: /sword|pommel|crossguard|grip|gauntlet|forearm|upper arm/, head: /helm|visor|horn/, kind: "arm" },
  colossus: { strike: /arm|gauntlet|fist|finger|shoulder shard|shoulder mantle/, head: /skull|crown horn|eye/, kind: "arm" },
  seraph: { strike: /sword wing|wing blade|armoured arm|gauntlet/, head: /mask|eye|cheek/, kind: "arm" },
  hound: { strike: /skull|jaw|canine|tooth|maw|amber eye|neck(?! spine)/, head: null, kind: "head" },
  serpent: { strike: /skull|fang|hood|jaw|ember eye|neck/, head: null, kind: "head" },
  swarm: { strike: /shard|splinter/, head: /heart|core/, kind: "burst" },
};

const EMPTY_RIG: BossRig = { strike: null, head: null, kind: "arm", rest: new Map() };

function gatherPivot(visual: THREE.Object3D, pattern: RegExp, anchor: "top" | "bottom" | "centre"): THREE.Group | null {
  const meshes: THREE.Mesh[] = [];
  visual.traverse((object) => {
    if (object instanceof THREE.Mesh && pattern.test(object.name.toLowerCase())) meshes.push(object);
  });
  const first = meshes[0];
  if (!first?.parent) return null;
  visual.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  for (const mesh of meshes) bounds.expandByObject(mesh);
  if (bounds.isEmpty()) return null;
  const pivotWorld = bounds.getCenter(new THREE.Vector3());
  if (anchor === "top") pivotWorld.y = bounds.max.y;
  if (anchor === "bottom") pivotWorld.y = bounds.min.y;
  const parent = first.parent;
  const pivot = new THREE.Group();
  pivot.name = "Procedural pivot";
  parent.add(pivot);
  pivot.position.copy(parent.worldToLocal(pivotWorld));
  pivot.updateMatrixWorld(true);
  for (const mesh of meshes) pivot.attach(mesh);
  return pivot;
}

function buildBossRig(visual: THREE.Object3D, silhouette: NemesisSpec["identity"]["silhouette"]): BossRig {
  const rule = RIG_RULES[silhouette];
  const authored = visual.getObjectByName("rig_strike") ?? null;
  const strike = authored ?? gatherPivot(visual, rule.strike, rule.kind === "arm" ? "top" : rule.kind === "head" ? "bottom" : "centre");
  const head = authored ? (visual.getObjectByName("rig_head") ?? null) : rule.head ? gatherPivot(visual, rule.head, "bottom") : null;
  const rest = new Map<THREE.Object3D, JointRest>();
  for (const joint of [strike, head]) {
    if (joint) rest.set(joint, { position: joint.position.clone(), quaternion: joint.quaternion.clone(), scale: joint.scale.clone() });
  }
  return { strike, head, kind: rule.kind, rest };
}

function resetRig(rig: BossRig): void {
  for (const [joint, rest] of rig.rest) {
    joint.position.copy(rest.position);
    joint.quaternion.copy(rest.quaternion);
    joint.scale.copy(rest.scale);
  }
}

function makeSlashArc(): THREE.Mesh {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 16;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createLinearGradient(0, 0, 128, 0);
    gradient.addColorStop(0, "rgba(255,255,255,0)");
    gradient.addColorStop(0.35, "rgba(255,255,255,1)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 16);
  }
  const texture = new THREE.CanvasTexture(canvas);
  const arc = new THREE.Mesh(
    new THREE.RingGeometry(0.85, 1.55, 28, 1, -1.25, 2.5),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      alphaMap: texture,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  );
  arc.visible = false;
  return arc;
}

function makeImpactRing(): THREE.Mesh {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.72, 1, 40),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  ring.visible = false;
  return ring;
}

function disposeAssetLibrary(library: AssetLibrary): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  for (const gltf of [library.arena, library.player, ...Object.values(library.bosses)]) {
    if (!gltf) continue;
    gltf.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(material);
        const textured = material as THREE.MeshStandardMaterial;
        if (textured.map) textures.add(textured.map);
        if (textured.normalMap) textures.add(textured.normalMap);
      }
    });
  }
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}

function disposeGroup(group: THREE.Group): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    let ancestor: THREE.Object3D | null = object;
    let sharedGeometry = false;
    while (ancestor && ancestor !== group) {
      if (ancestor.userData.assetClone) sharedGeometry = true;
      ancestor = ancestor.parent;
    }
    if (!sharedGeometry) geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  group.clear();
}

function collectToonMaterials(root: THREE.Object3D, cloakOnly = false): ToonMaterialState[] {
  const found = new Map<string, ToonMaterialState>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const role = object.userData.materialRole as string | undefined;
    if (cloakOnly && role !== "cloth" && role !== "cloth_dark") return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!(material instanceof THREE.MeshToonMaterial) || found.has(material.uuid)) continue;
      found.set(material.uuid, { material, emissive: material.emissive.clone() });
    }
  });
  return [...found.values()];
}

function makeShadow(size: number): THREE.Mesh {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(32, 32, 3, 32, 32, 31);
    gradient.addColorStop(0, "rgba(0,0,0,0.62)");
    gradient.addColorStop(0.55, "rgba(0,0,0,0.3)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
  }
  const texture = new THREE.CanvasTexture(canvas);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, opacity: 0.8 }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.035;
  return shadow;
}

export function createStage(canvas: HTMLCanvasElement, tuning: StageTuning = DEFAULT_TUNING()): Stage {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = tuning.post.exposure;
  const debug: StageDebug = { hitboxes: false, freeCamera: false };

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x030309);
  const camera = new THREE.PerspectiveCamera(tuning.camera.fov, 1, 0.1, 240);
  camera.position.set(14, 7, 14);
  camera.lookAt(0, 1, 0);
  let palette: Palette = DEFAULT_PALETTE;
  const accent = new THREE.Color(palette.accent);
  const hot = new THREE.Color(palette.hot);
  const post = createPostFX(renderer, scene, camera, tuning.post);
  const particles = createParticles(camera, accent);
  const rimCollapse = createRimCollapse(particles);
  const pillars = createPillars(particles, accent);
  scene.add(rimCollapse.object, pillars.object);
  scene.add(particles.object);
  const textureLoader = new THREE.TextureLoader().setCrossOrigin("anonymous");
  const prepareSkyTexture = (texture: THREE.Texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    texture.needsUpdate = true;
  };
  const staticSkyTexture = textureLoader.load(skyUrl, prepareSkyTexture);
  prepareSkyTexture(staticSkyTexture);
  let generatedSkyTexture: THREE.Texture | null = null;
  let skyRequest = 0;
  const skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      skyTexture: { value: staticSkyTexture },
      upper: { value: new THREE.Color("#030309") },
      horizon: { value: accent.clone().multiplyScalar(0.16) },
      accent: { value: accent },
    },
    vertexShader: `
      varying float skyHeight;
      varying vec2 skyUv;
      void main() {
        skyHeight = normalize(position).y;
        skyUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D skyTexture;
      uniform vec3 upper;
      uniform vec3 horizon;
      uniform vec3 accent;
      varying float skyHeight;
      varying vec2 skyUv;
      void main() {
        float imageV = skyHeight > 0.0
          ? mix(0.37, 1.0, skyHeight)
          : mix(0.0, 0.37, skyHeight + 1.0);
        vec3 image = texture2D(skyTexture, vec2(skyUv.x, imageV)).rgb;
        float light = dot(image, vec3(0.2126, 0.7152, 0.0722));
        // Wide smoothstep keeps cloud detail instead of crushing it to a two-tone print.
        float clouds = smoothstep(0.04, 1.15, light);
        // The upper sky goes back to near-black so the horizon glow reads as a band, not a wash.
        float zenith = smoothstep(0.12, 0.7, skyHeight);
        float band = exp(-pow((skyHeight + 0.03) * 5.5, 2.0));
        vec3 base = mix(upper, horizon, band * 0.3);
        vec3 tint = accent * mix(0.1, 0.5, light) * (1.0 - zenith * 0.85);
        vec3 sky = mix(base, tint, clouds) + accent * band * 0.12;
        // Sky colours are authored as display values; the composer treats this as linear, so decode.
        gl_FragColor = vec4(pow(max(sky, 0.0), vec3(1.7)), 1.0);
      }
    `,
  });
  const skyDome = new THREE.Mesh(new THREE.SphereGeometry(150, 32, 20), skyMaterial);
  scene.add(skyDome);
  scene.fog = new THREE.FogExp2(0x12091d, 0.018);

  const starPositions = new Float32Array(900 * 3);
  let randomSeed = 4217;
  const random = () => {
    randomSeed = (randomSeed * 16807) % 2147483647;
    return randomSeed / 2147483647;
  };
  for (let i = 0; i < starPositions.length; i += 3) {
    const angle = random() * Math.PI * 2;
    const height = random() * 2 - 1;
    const radius = Math.sqrt(1 - height * height) * 105;
    starPositions[i] = Math.cos(angle) * radius;
    starPositions[i + 1] = height * 105;
    starPositions[i + 2] = Math.sin(angle) * radius;
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
  scene.add(new THREE.Points(starGeometry, new THREE.PointsMaterial({
    color: 0xc6c2d5, size: 0.16, sizeAttenuation: true, transparent: true, opacity: 0.76,
  })));

  const emberPositions = new Float32Array(96 * 3);
  const emberSpeeds = new Float32Array(96);
  for (let i = 0; i < emberPositions.length; i += 3) {
    const angle = random() * Math.PI * 2;
    const radius = 5 + random() * (ARENA_RADIUS * 2 + 2);
    emberPositions[i] = Math.cos(angle) * radius;
    emberPositions[i + 1] = random() * 14 - 3;
    emberPositions[i + 2] = Math.sin(angle) * radius;
    emberSpeeds[i / 3] = 0.15 + random() * 0.45;
  }
  const emberGeometry = new THREE.BufferGeometry();
  emberGeometry.setAttribute("position", new THREE.BufferAttribute(emberPositions, 3));
  const emberMaterial = new THREE.PointsMaterial({
    color: accent, size: 0.12, sizeAttenuation: true, transparent: true, opacity: 0.7,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  scene.add(new THREE.Points(emberGeometry, emberMaterial));

  const hemisphere = new THREE.HemisphereLight(0xaab8df, 0x3a3150, tuning.lights.hemisphere);
  const key = new THREE.DirectionalLight(0xf1e8db, tuning.lights.key);
  key.position.set(2, 11, 8);
  key.target.position.set(0, 1, 0);
  const rim = new THREE.DirectionalLight(accent, tuning.lights.rim);
  rim.position.set(0, 8, -13);
  rim.target.position.set(0, 1, -1);
  // Camera-following fill so the hero is lit from the viewer's side no matter where the fight circles.
  const fill = new THREE.DirectionalLight(0xe4e9ff, tuning.lights.fill);
  fill.target.position.set(0, 1, 0);
  const heroLamp = new THREE.PointLight(0xfff1dc, tuning.lights.heroLamp, 7, 2);
  heroLamp.position.set(0.6, 3.2, -0.4);
  // Warm pool that follows the fight: the floor reads brightest around the fighters and falls into fog beyond them.
  const pool = new THREE.SpotLight(0xffe2c0, tuning.lights.pool, 26, 0.62, 0.85, 1.6);
  pool.position.set(0, 13, 0);
  pool.target.position.set(0, 0, 0);
  scene.add(hemisphere, key, key.target, rim, rim.target, fill, fill.target, pool, pool.target);

  const arenaRoot = new THREE.Group();
  arenaRoot.name = "Arena";
  scene.add(arenaRoot);
  const fallbackPlatform = new THREE.Mesh(
    new THREE.CylinderGeometry(ARENA_FLOOR_RADIUS, ARENA_FLOOR_RADIUS * 0.85, 1.2, 14, 1),
    createToonMaterial(0x14161f, 0x000000, { rim: 0 }),
  );
  fallbackPlatform.position.y = -0.6;
  addOutline(fallbackPlatform, 0.015);
  const fracture = new THREE.Mesh(
    new THREE.TorusGeometry(ARENA_FLOOR_RADIUS, 0.06, 6, 48),
    new THREE.MeshBasicMaterial({
      color: accent,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  );
  fracture.rotation.x = Math.PI / 2;
  fracture.position.y = 0.02;
  arenaRoot.add(fallbackPlatform, fracture);
  // Hairline fractures in the slab glow faintly in the accent colour.
  const floorCrackMaterial = new THREE.MeshBasicMaterial({ color: accent.clone().multiplyScalar(0.5), toneMapped: false });
  // Floor dressing laid over the slab: low-frequency value breakup so the stone is not one flat tone, a darker apron
  // past the playable disc with an accent hairline on the boundary, and a radial vignette that sinks the rim into fog.
  const EDGE_FADE_RADIUS = ARENA_FLOOR_RADIUS * 1.25;
  const edgeFadeUniforms = {
    fogTint: { value: new THREE.Color(0x05040a) },
    accent: { value: accent.clone() },
    playRadius: { value: ARENA_RADIUS / EDGE_FADE_RADIUS },
    worldRadius: { value: EDGE_FADE_RADIUS },
    breakup: { value: tuning.floor.breakup },
    apron: { value: tuning.floor.apron },
    ring: { value: tuning.floor.ring },
    cut: { value: 2 },
  };
  const edgeFadeMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: edgeFadeUniforms,
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: `
      uniform vec3 fogTint;
      uniform vec3 accent;
      uniform float playRadius;
      uniform float worldRadius;
      uniform float breakup;
      uniform float apron;
      uniform float ring;
      uniform float cut;
      varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
      }
      void main() {
        vec2 c = vUv - 0.5;
        float r = length(c) * 2.0;
        vec2 world = c * 2.0 * worldRadius;
        // Two octaves of value noise at ~7 m and ~2.5 m: patches of worn and darker stone.
        float n = vnoise(world / 7.0) * 0.65 + vnoise(world / 2.5 + 13.7) * 0.35;
        float patches = smoothstep(0.35, 0.8, n) * breakup;
        float edge = playRadius;
        float apronDark = smoothstep(edge - 0.004, edge + 0.01, r) * apron;
        float fade = smoothstep(0.62, 1.0, r);
        // cut is where the collapsed rim ends: everything past it has fallen into the void.
        float swallowed = smoothstep(cut - 0.04, cut + 0.015, r);
        float dark = clamp(patches + apronDark + fade * 0.92, 0.0, 0.96);
        dark = max(dark, swallowed * 0.98);
        // Accent hairline exactly on the playable edge, with a soft inner glow so the boundary reads from any angle.
        float d = abs(r - edge) * worldRadius;
        float line = (1.0 - smoothstep(0.0, 0.08, d)) * 0.9 + (1.0 - smoothstep(0.0, 0.9, d)) * 0.22;
        line *= ring * (1.0 - fade) * (1.0 - swallowed);
        vec3 tint = pow(fogTint, vec3(1.7));
        vec3 col = mix(tint, accent * 1.6, clamp(line, 0.0, 1.0));
        gl_FragColor = vec4(col, max(dark, line));
      }
    `,
  });
  const edgeFade = new THREE.Mesh(new THREE.CircleGeometry(EDGE_FADE_RADIUS, 96), edgeFadeMaterial);
  edgeFade.rotation.x = -Math.PI / 2;
  edgeFade.position.y = 0.035;
  edgeFade.renderOrder = 1;
  arenaRoot.add(edgeFade);

  const player = new THREE.Group();
  const playerVisualPivot = new THREE.Group();
  player.add(playerVisualPivot);
  const fallbackCloak = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.9, 7), createToonMaterial(0x4a4c60, 0x141626));
  fallbackCloak.name = "Fallback cloak";
  fallbackCloak.userData.materialRole = "cloth";
  fallbackCloak.position.y = 0.95;
  addOutline(fallbackCloak);
  const fallbackHood = new THREE.Mesh(new THREE.SphereGeometry(0.32, 10, 8), createToonMaterial(0x2a2b3a, 0x141626));
  fallbackHood.name = "Fallback hood";
  fallbackHood.userData.materialRole = "cloth_dark";
  fallbackHood.position.y = 1.95;
  addOutline(fallbackHood);
  const fallbackFace = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), createToonMaterial(0x030308));
  fallbackFace.position.set(0, 1.94, 0.25);
  const fallbackEyes = new THREE.Mesh(
    new THREE.SphereGeometry(0.035, 6, 4),
    new THREE.MeshBasicMaterial({ color: 0xe9e4d8, toneMapped: false }),
  );
  fallbackEyes.position.set(0, 1.96, 0.415);
  const fallbackChain = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.025, 5, 8), createToonMaterial(0x5a5f6e));
  fallbackChain.position.set(0.56, 0.55, 0.12);
  playerVisualPivot.add(fallbackCloak, fallbackHood, fallbackFace, fallbackEyes, fallbackChain);
  player.add(heroLamp);
  const slashArc = makeSlashArc();
  const impactRing = makeImpactRing();
  player.add(slashArc, impactRing);
  scene.add(player);
  let bladePivot: THREE.Group | null = null;
  let bladeMaterial: THREE.MeshToonMaterial | null = null;
  /** Blade parented to the authored `rig_forearm_R` joint: the arm clips carry it, so it stops swinging on its own. */
  let bladeOnHand = false;

  const boss = new THREE.Group();
  const bossVisualPivot = new THREE.Group();
  boss.add(bossVisualPivot);
  boss.position.set(0, 0, -5);
  scene.add(boss);
  const playerShadow = makeShadow(2.3);
  const bossShadow = makeShadow(4.4);
  scene.add(playerShadow, bossShadow);
  const hazards = createHazardView(scene);
  const flatline = createFlatlineSet(DEFAULT_PALETTE);
  scene.add(flatline.group);

  // Debug overlay: collision radii + player reach. Only drawn when debug.hitboxes is on.
  const debugMaterial = new THREE.LineBasicMaterial({ color: 0x4dff88, transparent: true, opacity: 0.9, depthTest: false, toneMapped: false });
  const debugReachMaterial = new THREE.LineBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.9, depthTest: false, toneMapped: false });
  const makeCircle = (radius: number, material: THREE.LineBasicMaterial) => {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= 48; i += 1) {
      const a = (i / 48) * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(a) * radius, 0.05, Math.sin(a) * radius));
    }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material);
    line.renderOrder = 50;
    line.visible = false;
    return line;
  };
  const playerRadiusLine = makeCircle(PLAYER.radius, debugMaterial);
  const bossRadiusLine = makeCircle(BOSS.radius, debugMaterial);
  const meleeRangeLine = makeCircle(BOSS.meleeRange, debugReachMaterial);
  meleeRangeLine.material = new THREE.LineDashedMaterial({ color: 0xffd166, dashSize: 0.3, gapSize: 0.25, transparent: true, opacity: 0.45, depthTest: false, toneMapped: false });
  meleeRangeLine.computeLineDistances();
  const reachLine = makeCircle(1, debugReachMaterial);
  scene.add(playerRadiusLine, bossRadiusLine, meleeRangeLine, reachLine);
  let fovPunch = 0;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let mode: "attract" | "fight" = "attract";
  let disposed = false;
  let elapsed = 0;
  let currentSpec: NemesisSpec | null = null;
  let library: AssetLibrary | null = null;
  let playerMotion: Locomotion | null = null;
  let hero: HFHero | null = null;
  let heroMode = false;
  let codexBoss: CodexBoss | null = null;
  let bossMotion: Locomotion | null = null;
  let playerMaterials: ToonMaterialState[] = [];
  let bossMaterials: ToonMaterialState[] = [];
  let playerSpeed = 0;
  let bossSpeed = 0;
  let bossSpawn = 1;
  let attractAngle = 0;
  let first = true;
  let cameraYaw: number | null = null;
  /** 0..1 blend toward the side-on `flatline` camera; ramps over FLAT_CAMERA.rampSeconds once the sim reports a flat arena. */
  let flat = 0;
  const chaseCamera = new THREE.Vector3();
  const flatCamera = new THREE.Vector3();
  const flatLook = new THREE.Vector3();
  const flatLookBlend = new THREE.Vector3();
  let shake = 0;
  const shakeOffset = new THREE.Vector3();
  const hitKick = new THREE.Vector3();
  let hitKickT = 0;
  const lookGoal = new THREE.Vector3();
  const lookBoss = new THREE.Vector3();
  const toBoss = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const lastPlayerPosition = new THREE.Vector3();
  const lastBossPosition = new THREE.Vector3();
  const pose: PlayerPose = { ...REST_POSE };
  const bossPoseNow: BossPose = { ...BOSS_REST };
  let bossRig: BossRig = EMPTY_RIG;
  const rollAxis = new THREE.Vector3();
  const rollQuaternion = new THREE.Quaternion();
  const poseQuaternion = new THREE.Quaternion();
  const poseEuler = new THREE.Euler();
  const rollCentre = new THREE.Vector3();
  const cameraForward = new THREE.Vector3();
  const lookTarget = new THREE.Vector3();
  const poolFocus = new THREE.Vector3();
  const burstAt = new THREE.Vector3();
  const burstDir = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  let lastActionT = 0;
  let impactT = 1;
  let playerDeathT = 0;
  let bossDeathT = 0;
  let runeGroup: THREE.Group | null = null;
  let sigilMaterial: THREE.MeshBasicMaterial | null = null;
  interface Debris { object: THREE.Object3D; baseY: number; phase: number; spin: THREE.Vector3 }
  let debris: Debris[] = [];
  const debrisEdgeMaterial = new THREE.MeshBasicMaterial({ color: accent.clone().multiplyScalar(0.28), side: THREE.BackSide, toneMapped: false });

  const createBlade = () => {
    const pivot = new THREE.Group();
    pivot.name = "Bone blade attack";
    pivot.position.set(0.47, 0.9, 0.12);
    bladeMaterial = createToonMaterial("#d9d2c3");
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.12, 0.08), bladeMaterial);
    blade.position.y = 0.48;
    addOutline(blade, 0.012);
    pivot.add(blade);
    return pivot;
  };

  bladePivot = createBlade();
  playerVisualPivot.add(bladePivot);
  playerMaterials = collectToonMaterials(playerVisualPivot, true);

  const installArena = () => {
    if (!library) return;
    disposeGroup(arenaRoot);
    const visual = instantiate(library.arena, ["#25212d", accent.getStyle(), "#25212d"], { outline: 0.012 });
    arenaRoot.add(visual);
    visual.updateMatrixWorld(true);
    const runes = new THREE.Group();
    runes.name = "Rotating sigil";
    visual.add(runes);
    const runeMeshes: THREE.Object3D[] = [];
    const debrisList: Debris[] = [];
    sigilMaterial = null;
    visual.traverse((object) => {
      const name = object.name.toLowerCase();
      if (object !== runes && (name.includes("runic") || name.includes("sigil"))) runeMeshes.push(object);
      if (name.includes("sigil") && object instanceof THREE.Mesh && object.material instanceof THREE.MeshBasicMaterial) {
        sigilMaterial = object.material;
      }
      if (!(object instanceof THREE.Mesh)) return;
      // The walkable slab is the one big lit surface; keep it deep blue-grey so the hero and decals carry the light.
      if (name.includes("walkable") || name.includes("floor slab")) {
        const source = object.material instanceof THREE.MeshToonMaterial ? object.material : null;
        object.material = createToonMaterial(palette.floor, 0x04050b, { map: source?.map ?? undefined, normalMap: source?.normalMap ?? undefined, rim: 0 });
        object.userData.materialRole = "floor";
      }
      if (name.includes("hairline floor fracture")) {
        object.material = floorCrackMaterial;
        object.userData.materialRole = "floor_crack";
        object.position.y += 0.01;
      }
      // Floating shards read as deliberate once they drift, turn slowly and carry a faint accent rim.
      if (name.includes("floating debris")) {
        for (const child of object.children) {
          if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial && child.material.side === THREE.BackSide) {
            child.material = debrisEdgeMaterial;
            child.scale.setScalar(1.05);
          }
        }
        debrisList.push({
          object,
          baseY: object.position.y,
          phase: debrisList.length * 1.7,
          spin: new THREE.Vector3(0.05 + (debrisList.length % 3) * 0.03, 0.08 + (debrisList.length % 4) * 0.02, 0.03).multiplyScalar(debrisList.length % 2 ? 1 : -1),
        });
      }
    });
    for (const object of runeMeshes) runes.attach(object);
    runeGroup = runes;
    debris = debrisList;
    arenaRoot.add(edgeFade);
    const meshesNamed = (needle: string) => {
      const found: THREE.Mesh[] = [];
      visual.traverse((object) => {
        if (object instanceof THREE.Mesh && object.name.toLowerCase().includes(needle) && object.material instanceof THREE.MeshToonMaterial) found.push(object);
      });
      return found;
    };
    const columns = meshesNamed("broken obelisk");
    const rubble = meshesNamed("raised fractured floor slab");
    const shards = meshesNamed("floating debris");
    if (columns.length && rubble.length && shards.length) pillars.setTemplates({ columns, rubble, shards });
  };

  // Attract mode (no spec yet) is the default HF vs CODEX bout, so it gets the mascot too.
  const wantsHero = () => (currentSpec ? isCodexBout(currentSpec) : true);

  const installPlayer = () => {
    const useHero = wantsHero();
    if (!useHero && !library) return;
    playerMotion?.stop();
    playerMotion = null;
    hero = null;
    disposeGroup(playerVisualPivot);
    let visual: THREE.Object3D;
    if (useHero) {
      hero = createHFHero();
      visual = hero.root;
    } else {
      visual = instantiate(library!.player, ["#0b0b10", "#e9e4d8", "#3c3e50"], { player: true, outline: 0.016 });
      playerMotion = new Locomotion(visual, library!.player.animations, { referenceSpeed: PLAYER.speed, cycleSeconds: 0.72 });
    }
    heroMode = useHero;
    playerVisualPivot.add(visual);
    bladePivot = createBlade();
    const hand = visual.getObjectByName("rig_forearm_R");
    bladeOnHand = hand !== undefined;
    if (hand) {
      hand.updateWorldMatrix(true, false);
      hand.attach(bladePivot);
      bladePivot.rotation.set(REST_POSE.bladeX, 0, REST_POSE.bladeZ);
    } else {
      playerVisualPivot.add(bladePivot);
    }
    playerMaterials = collectToonMaterials(visual, true);
  };
  installPlayer();

  const installBoss = (spec: NemesisSpec, keepSpawn = false) => {
    const spawnBefore = bossSpawn;
    bossMotion?.stop();
    bossMotion = null;
    disposeGroup(bossVisualPivot);
    bossMaterials = [];
    codexBoss = null;
    const asset = library?.bosses[spec.identity.silhouette];
    if (isCodexBout(spec)) {
      bossRig = EMPTY_RIG;
      codexBoss = createCodexBoss();
      bossVisualPivot.add(codexBoss.root);
      bossMaterials = collectToonMaterials(codexBoss.root);
    } else if (asset) {
      const visual = instantiate(asset, spec.identity.palette, { outline: 0.024 });
      bossVisualPivot.add(visual);
      bossRig = buildBossRig(visual, spec.identity.silhouette);
      bossMaterials = collectToonMaterials(visual);
      bossMotion = new Locomotion(visual, asset.animations, { referenceSpeed: BOSS.walkSpeed, cycleSeconds: 1.3, idleTimeScale: 0.85 });
    } else {
      bossRig = EMPTY_RIG;
      const [, accentHex, deepHex] = spec.identity.palette;
      const height = BOSS_HEIGHTS[spec.identity.silhouette];
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.9, Math.max(0.1, height - 1.8), 6, 10),
        createToonMaterial(deepHex, new THREE.Color(accentHex).multiplyScalar(0.15)),
      );
      body.position.y = height / 2;
      addOutline(body, 0.05);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 8), new THREE.MeshBasicMaterial({ color: accentHex, toneMapped: false }));
      eye.position.set(0, height * 0.8, 0.85);
      bossVisualPivot.add(body, eye);
      bossMaterials = collectToonMaterials(bossVisualPivot);
    }
    bossSpawn = keepSpawn ? spawnBefore : 0;
    if (!keepSpawn) {
      bossVisualPivot.scale.setScalar(0.08);
      bossVisualPivot.position.y = -2.1;
    }
  };

  const preloadBoss = async (spec: NemesisSpec, onProgress?: (fraction: number) => void) => {
    await ready;
    if (!library || disposed || isCodexBout(spec)) return;
    const { silhouette } = spec.identity;
    const hadModel = !!library.bosses[silhouette];
    try {
      await library.loadBoss(silhouette, onProgress);
    } catch (error) {
      console.warn(`Nemesis ${silhouette} model could not be loaded; keeping the procedural stand-in.`, error);
      return;
    }
    // The stand-in may already be on stage; swap the real model in without replaying the spawn.
    if (!disposed && !hadModel && currentSpec?.identity.silhouette === silhouette) installBoss(currentSpec, true);
  };

  const applyAccent = (spec: NemesisSpec) => {
    palette = resolvePalette(spec);
    const color = new THREE.Color(palette.accent);
    accent.copy(color);
    hot.set(palette.hot);
    RIM.color.value.set(palette.rim);
    (skyMaterial.uniforms.accent!.value as THREE.Color).copy(color);
    (skyMaterial.uniforms.horizon!.value as THREE.Color).copy(color).multiplyScalar(0.16);
    (skyMaterial.uniforms.upper!.value as THREE.Color).set(palette.bg);
    if (scene.background instanceof THREE.Color) scene.background.set(palette.bg);
    emberMaterial.color.copy(color);
    rim.color.set(palette.rim);
    pool.color.copy(color).lerp(new THREE.Color(0xffe2c0), 0.6);
    edgeFadeUniforms.accent.value.copy(color);
    const fogColor = new THREE.Color(palette.fog);
    scene.fog = new THREE.FogExp2(fogColor, tuning.fog.density);
    (edgeFadeMaterial.uniforms.fogTint!.value as THREE.Color).copy(fogColor);
    floorCrackMaterial.color.copy(color).multiplyScalar(0.5);
    debrisEdgeMaterial.color.copy(color).multiplyScalar(0.28);
    if (fracture.material instanceof THREE.MeshBasicMaterial) fracture.material.color.copy(color);
    arenaRoot.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const role = object.userData.materialRole as string | undefined;
      if ((role === "accent" || role === "glow") && object.material instanceof THREE.MeshBasicMaterial) {
        object.material.color.copy(color);
      }
      if (role === "floor" && object.material instanceof THREE.MeshToonMaterial) object.material.color.set(palette.floor);
    });
    hazards.setAccent(palette.accent);
    flatline.setPalette(palette);
    hazards.setStyle(isCodexBout(spec) ? "terminal" : "void");
  };

  const applySpec = (spec: NemesisSpec) => {
    currentSpec = spec;
    if (isCodexBout(spec) !== heroMode) installPlayer();
    applyAccent(spec);
    installBoss(spec);
    if (library && !library.bosses[spec.identity.silhouette]) void preloadBoss(spec);
  };

  const setSky = (url: string | null) => {
    const request = ++skyRequest;
    if (generatedSkyTexture) {
      generatedSkyTexture.dispose();
      generatedSkyTexture = null;
    }
    skyMaterial.uniforms.skyTexture!.value = staticSkyTexture;
    if (!url) {
      return;
    }
    textureLoader.load(
      url,
      (texture) => {
        if (disposed || request !== skyRequest) {
          texture.dispose();
          return;
        }
        prepareSkyTexture(texture);
        generatedSkyTexture = texture;
        skyMaterial.uniforms.skyTexture!.value = texture;
      },
      undefined,
      (error) => {
        if (request !== skyRequest) return;
        console.warn("[sky] generated backdrop failed; restoring the static sky", error);
        skyMaterial.uniforms.skyTexture!.value = staticSkyTexture;
      },
    );
  };

  const ready = loadAssetLibrary().then((loaded) => {
    if (disposed) {
      disposeAssetLibrary(loaded);
      return;
    }
    library = loaded;
    installArena();
    installPlayer();
    if (currentSpec) {
      installBoss(currentSpec);
      void preloadBoss(currentSpec);
    }
  }).catch((error: unknown) => {
    console.warn("Nemesis models could not be loaded; using procedural stand-ins.", error);
  });

  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    post.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", resize);
  resize();

  const render = (dt: number, state: BattleState, events: readonly BattleEvent[]) => {
    const step = Math.min(dt, 0.05);
    elapsed += step;
    const p = state.player;
    const b = state.boss;
    player.position.set(p.pos.x, p.y, p.pos.z);
    boss.position.set(b.pos.x, 0, b.pos.z);
    flat = THREE.MathUtils.clamp(flat + Math.sign((state.flat ? 1 : 0) - flat) * step / FLAT_CAMERA.rampSeconds, 0, 1);
    const flatEase = easeInOut(flat);
    flatline.update(flatEase, elapsed);
    post.flatten(flatEase);
    arenaRoot.position.y = -FLAT_CAMERA.floorDrop * flatEase;
    const fxOn = tuning.fx.particles && !reducedMotion.matches;
    for (const event of events) {
      if (event.type === "playerHit") {
        shake = Math.max(shake, 0.35);
        post.pulse(0xff2d4f, 1);
        // Kick the camera along the shove so the hit has a direction, not just a flash.
        hitKick.set(event.dir.x, 0.35, event.dir.z).normalize().multiplyScalar(tuning.camera.hitKick);
        hitKickT = 1;
        if (fxOn) {
          burstAt.set(p.pos.x, 1.1, p.pos.z);
          burstDir.subVectors(player.position, boss.position).setY(0.4).normalize();
          particles.burst(burstAt, { count: 26, color: 0xff3b5c, color2: 0x2a0308, speed: 6, spread: 0.6, dir: burstDir, lifeMs: 520, size: 0.11, gravity: 9, drag: 2.5, stretch: 2.2 });
          particles.burst(burstAt, { count: 18, color: 0x1a1216, color2: 0x000000, speed: 2.2, spread: 1, lifeMs: 900, size: 0.22, gravity: 1.5, drag: 1.2 });
        }
      }
      if (event.type === "bossHit") {
        const finisher = !event.heavy && event.combo === PLAYER.combo.length - 1;
        shake = Math.max(shake, event.heavy ? 0.25 + event.charge * 0.25 : finisher ? 0.18 : 0.1);
        if (event.heavy || finisher) {
          post.whiteFlash(event.heavy ? 0.22 + event.charge * 0.3 : 0.12);
          fovPunch = Math.max(fovPunch, event.heavy ? 1 + event.charge * 0.6 : 0.6);
        }
        if (fxOn) {
          burstAt.copy(player.position).addScaledVector(toBoss, PLAYER.radius + 1.3).setY(1.25);
          burstDir.copy(toBoss).negate().setY(0.55).normalize();
          particles.burst(burstAt, { count: event.heavy ? 46 : 22, color: hot, color2: accent, speed: event.heavy ? 11 : 7.5, spread: 0.45, dir: burstDir, lifeMs: 420, size: 0.07, gravity: 14, drag: 3, stretch: 3.4 });
          particles.burst(burstAt, { count: 8, color: 0xffffff, color2: hot, speed: 1.2, spread: 1, lifeMs: 160, size: event.heavy ? 0.7 : 0.4, drag: 6 });
        }
      }
      if (event.type === "phaseChange") {
        shake = Math.max(shake, 0.6);
        post.whiteFlash(0.5);
        post.pulse(accent, 0.8);
        if (fxOn) {
          burstAt.copy(boss.position).setY(1.4);
          particles.burst(burstAt, { count: 160, color: accent, color2: hot, speed: 9, spread: 1, lifeMs: 1400, size: 0.14, gravity: -1.5, drag: 1.4 });
        }
      }
      if (event.type === "arenaShrink") {
        shake = Math.max(shake, 0.5);
        rimCollapse.collapse(event.from, event.to, event.ms);
      }
      if (event.type === "arenaPulse" && fxOn) {
        burstAt.set(event.at.x, 0.3, event.at.z);
        if (event.mutator === "ember") particles.burst(burstAt, { count: 40, color: 0xff6a2b, color2: 0x3a0a02, speed: 3.5, spread: 0.6, dir: UP, lifeMs: 900, size: 0.16, gravity: -2, drag: 1.2 });
        else if (event.mutator === "tempest") particles.burst(burstAt, { count: 30, color: 0xcfe9ff, color2: accent, speed: 6, spread: 0.5, dir: UP, lifeMs: 500, size: 0.1, gravity: 4, drag: 2.5, stretch: 3 });
        else particles.burst(burstAt, { count: 24, color: 0x8a0a1c, color2: 0x1a0205, speed: 2, spread: 1, lifeMs: 800, size: 0.2, gravity: 6, drag: 2 });
      }
      if (event.type === "obstaclesRaised") shake = Math.max(shake, 0.3);
      if (event.type === "obstacleBroken") shake = Math.max(shake, 0.28);
      if (event.type === "bossStagger" && fxOn) {
        burstAt.copy(boss.position).setY(0.4);
        particles.burst(burstAt, { count: 40, color: 0x8a8578, color2: 0x1b1a1d, speed: 4, spread: 0.8, dir: UP, lifeMs: 800, size: 0.2, gravity: 8, drag: 1.5 });
      }
      if (event.type === "bossDefeat") {
        post.whiteFlash(0.9);
        fovPunch = Math.max(fovPunch, 1.6);
        if (fxOn) {
          burstAt.copy(boss.position).setY(1.6);
          particles.burst(burstAt, { count: 320, color: hot, color2: accent, speed: 12, spread: 1, lifeMs: 2200, size: 0.16, gravity: -0.8, drag: 1.1 });
          particles.burst(burstAt, { count: 160, color: 0x0b0a10, color2: 0x000000, speed: 4, spread: 1, lifeMs: 2600, size: 0.42, gravity: -0.4, drag: 0.9 });
        }
      }
      if (event.type === "playerDeath") post.pulse(0xff2d4f, 1);
      if (event.type === "playerRoll" && event.dodged) {
        post.pulse(accent, event.perfect ? 0.9 : 0.5);
        if (event.perfect) post.whiteFlash(0.18);
        if (fxOn) {
          burstAt.copy(player.position).setY(0.9);
          particles.burst(burstAt, { count: event.perfect ? 60 : 24, color: event.perfect ? 0xffffff : hot, color2: accent, speed: event.perfect ? 6 : 3.5, spread: 1, lifeMs: event.perfect ? 620 : 380, size: 0.09, drag: 4, stretch: event.perfect ? 2.4 : 1.6 });
        }
      }
      if (event.type === "moveActive") {
        if (event.move === "nova" || event.move === "charge") shake = Math.max(shake, 0.2);
        if (fxOn && (event.move === "nova" || event.move === "sweep" || event.move === "blink")) {
          burstAt.copy(boss.position).setY(0.3);
          particles.burst(burstAt, { count: event.move === "nova" ? 90 : 30, color: accent, color2: hot, speed: event.move === "nova" ? 10 : 5, spread: event.move === "nova" ? 0.25 : 0.7, dir: UP, lifeMs: 700, size: 0.12, gravity: 6, drag: 2 });
        }
      }
    }
    player.rotation.y = Math.atan2(p.facing.x, p.facing.z);
    boss.rotation.y = Math.atan2(b.facing.x, b.facing.z);

    playerSpeed = step > 0 ? Math.hypot(player.position.x - lastPlayerPosition.x, player.position.z - lastPlayerPosition.z) / step : 0;
    lastPlayerPosition.copy(player.position);
    bossSpeed = step > 0 ? Math.hypot(boss.position.x - lastBossPosition.x, boss.position.z - lastBossPosition.z) / step : 0;
    lastBossPosition.copy(boss.position);
    const motionStep = step * (reducedMotion.matches ? 0 : 1);
    playerDeathT = state.outcome === "playerDead" ? playerDeathT + step : 0;
    bossDeathT = state.outcome === "bossDead" ? bossDeathT + step : 0;
    const playerOverlay = playerMotion ? playerOverlayFor(playerMotion, p, playerDeathT) : null;
    playerMotion?.update(motionStep, p.action === "idle" ? playerSpeed : 0, playerOverlay);
    const playerAuthored = playerOverlay && playerMotion ? playerMotion.overlayWeight(playerOverlay.clip) : 0;
    resetRig(bossRig);
    const bossOverlay = bossMotion ? bossOverlayFor(bossMotion, b, state.outcome, bossDeathT) : null;
    bossMotion?.update(motionStep, bossSpeed, bossOverlay);
    const bossAuthored = bossOverlay && bossMotion ? bossMotion.overlayWeight(bossOverlay.clip) : 0;

    if (p.action === "light") {
      const stage = LIGHT_POSES[Math.min(p.comboIndex, LIGHT_POSES.length - 1)] ?? LIGHT_POSES[0]!;
      attackPose(pose, p.actionT, attackFor(p), stage.windup, stage.strike);
    } else if (p.action === "heavy") {
      attackPose(pose, p.actionT, PLAYER.heavy, HEAVY_WINDUP, HEAVY_STRIKE);
      if (p.charging || (p.charge > 0 && p.actionT < PLAYER.heavy.windupMs)) {
        // Held at the top of the windup: sink lower, pull the blade further back and shiver as the charge fills.
        const shiver = Math.sin(state.timeMs / 18) * 0.02 * p.charge;
        pose.crouch += p.charge * 0.1;
        pose.lean -= p.charge * 0.12 + shiver;
        pose.bladeX -= p.charge * 0.5;
        pose.charge = 1 + p.charge * 0.8;
      }
    } else if (p.action === "hurt") {
      lerpPose(pose, HURT_POSE, REST_POSE, holdThenEase(clamp01(p.actionT / PLAYER.hurt.stunMs), 0.4));
    } else lerpPose(pose, REST_POSE, REST_POSE, 0);
    const heavyCommit = p.action === "heavy" && !p.charging && lastActionT < PLAYER.heavy.windupMs && p.actionT >= PLAYER.heavy.windupMs;
    if (heavyCommit) impactT = 0;
    lastActionT = p.action === "idle" ? 0 : p.actionT;

    // Authored attack clips already lean and twist the spine, so the whole-body pivot yields to them.
    const moveLean = p.action === "idle" && playerSpeed > 0.1 ? 0.1 : 0;
    poseEuler.set(pose.lean * (1 - playerAuthored) + moveLean, pose.twist * (1 - playerAuthored), 0);
    poseQuaternion.setFromEuler(poseEuler);
    playerVisualPivot.position.set(0, -pose.crouch, pose.lunge);
    if (p.action === "roll") {
      // Tumble around the axis perpendicular to the roll direction, keeping the body centre low through the middle.
      const u = clamp01(p.actionT / PLAYER.roll.durationMs);
      const localX = p.rollDir.x * p.facing.z - p.rollDir.z * p.facing.x;
      const localZ = p.rollDir.x * p.facing.x + p.rollDir.z * p.facing.z;
      rollAxis.set(localZ, 0, -localX);
      if (rollAxis.lengthSq() < 1e-6) rollAxis.set(1, 0, 0);
      rollAxis.normalize();
      rollQuaternion.setFromAxisAngle(rollAxis, easeInOut(u) * Math.PI * 2);
      poseQuaternion.multiply(rollQuaternion);
      const centreHeight = 0.9 - Math.sin(u * Math.PI) * 0.3;
      rollCentre.set(0, 0.9, 0).applyQuaternion(poseQuaternion);
      playerVisualPivot.position.set(-rollCentre.x, centreHeight - rollCentre.y, -rollCentre.z);
    }
    playerVisualPivot.quaternion.copy(poseQuaternion);
    if (bladePivot && !bladeOnHand) bladePivot.rotation.set(pose.bladeX, 0, pose.bladeZ);
    if (bladeMaterial) bladeMaterial.emissive.copy(accent).multiplyScalar(pose.charge * 0.9);
    hero?.update(step, {
      speed: playerSpeed,
      action: p.action,
      actionT: p.actionT,
      hitFlash: p.hitFlash,
      bladeX: pose.bladeX,
      bladeZ: pose.bladeZ,
      charge: pose.charge,
      reducedMotion: reducedMotion.matches,
    });

    const heavy = p.action === "heavy";
    const finisher = p.action === "light" && p.comboIndex === PLAYER.combo.length - 1;
    slashArc.visible = pose.slash > 0.01;
    if (slashArc.visible && slashArc.material instanceof THREE.MeshBasicMaterial) {
      slashArc.material.opacity = pose.slash * 0.95;
      slashArc.material.color.copy(accent).lerp(new THREE.Color(0xffffff), heavy ? 0.55 + p.charge * 0.35 : 0.55);
      const reach = heavy ? 1.35 + p.charge * 0.35 : finisher ? 1.15 : 1;
      slashArc.scale.setScalar(reach * (0.8 + pose.slash * 0.2));
      slashArc.position.set(heavy ? 0.15 : 0.2, heavy ? 1.15 : 1.05, heavy ? 1.2 : 1.0);
      // Light 1: a horizontal cut across; light 2: the return cut; light 3 and heavy: a vertical cleave down the centre line.
      if (heavy || finisher) slashArc.rotation.set(0, -Math.PI / 2 + 0.2, Math.PI / 2 + 0.9);
      else if (p.comboIndex === 1) slashArc.rotation.set(-Math.PI / 2 - 0.45, 0, 0.75 + Math.PI);
      else slashArc.rotation.set(-Math.PI / 2 + 0.45, 0, -0.75);
    }
    impactT = Math.min(1, impactT + step / 0.32);
    impactRing.visible = impactT < 1;
    if (impactRing.visible && impactRing.material instanceof THREE.MeshBasicMaterial) {
      impactRing.material.opacity = (1 - impactT) * 0.9;
      impactRing.material.color.copy(accent).lerp(new THREE.Color(0xffffff), 0.4);
      impactRing.scale.setScalar(0.6 + easeOut(impactT) * 2.4);
      impactRing.position.z = 1.4;
    }

    bossPose(bossPoseNow, b, state.timeMs, bossSpeed);
    if (bossSpawn < 1) bossSpawn = Math.min(1, bossSpawn + step / 0.82);
    const reveal = 1 - Math.pow(1 - bossSpawn, 3);
    const spawnScale = 0.08 + bossSpawn * 0.92;
    bossVisualPivot.scale.set(bossPoseNow.stretch * spawnScale, bossPoseNow.squash * spawnScale, bossPoseNow.stretch * spawnScale);
    // Authored boss clips carry their own torso lean, twist and limb swing; the procedural rig offsets fade out under them.
    bossVisualPivot.rotation.set(bossPoseNow.lean * (1 - bossAuthored), bossPoseNow.twist * (1 - bossAuthored), 0);
    bossPoseNow.swing *= 1 - bossAuthored;
    bossPoseNow.headTilt *= 1 - bossAuthored;
    bossPoseNow.twist *= 1 - bossAuthored;
    bossVisualPivot.position.z = bossPoseNow.lunge;
    bossVisualPivot.position.y = -2.1 * (1 - reveal) + bossPoseNow.rise + (b.invulnerableT > 0 ? Math.sin(state.timeMs / 90) * 0.15 + 0.4 : 0);
    if (bossRig.strike) {
      if (bossRig.kind === "burst") {
        bossRig.strike.scale.multiplyScalar(1 + bossPoseNow.headTilt * 0.9);
        bossRig.strike.rotation.y += state.timeMs / 900 + bossPoseNow.headTilt * 1.5;
      } else if (bossRig.kind === "head") {
        bossRig.strike.rotation.x += bossPoseNow.headTilt * 1.2;
        bossRig.strike.position.z += Math.max(0, bossPoseNow.headTilt) * 0.8;
      } else {
        bossRig.strike.rotation.x += bossPoseNow.swing;
      }
    }
    if (bossRig.head) {
      bossRig.head.rotation.x += bossPoseNow.headTilt * 0.5;
      // The head leads the body through a twist so a sweep reads as looking where it cuts.
      bossRig.head.rotation.y -= bossPoseNow.twist * 0.6;
      if (bossRig.kind === "burst") bossRig.head.scale.multiplyScalar(1 + bossPoseNow.glow * 0.25);
    }

    for (const entry of playerMaterials) {
      entry.material.emissive.copy(entry.emissive);
      if (p.hitFlash > 0) entry.material.emissive.lerp(new THREE.Color(0xffffff), Math.min(1, p.hitFlash / 200));
    }
    for (const entry of bossMaterials) {
      entry.material.emissive.copy(entry.emissive);
      if (bossPoseNow.glow > 0) entry.material.emissive.lerp(accent, bossPoseNow.glow * 0.55);
      if (b.hitFlash > 0) entry.material.emissive.lerp(new THREE.Color(0xffffff), Math.min(1, b.hitFlash / 120));
      if (b.weaknessT > 0) {
        entry.material.emissive.lerp(new THREE.Color(0xffd166), 0.4 + 0.3 * Math.sin(state.timeMs / 60));
      }
    }
    codexBoss?.update(step, {
      timeMs: state.timeMs,
      glow: bossPoseNow.glow,
      headTilt: bossPoseNow.headTilt,
      swing: bossPoseNow.swing,
      twist: bossPoseNow.twist,
      hitFlash: b.hitFlash,
      weakness: b.weaknessT > 0,
      staggered: b.staggerT > 0,
      telegraphing: b.current?.phase === "telegraph",
      moveType: b.current?.move.type ?? null,
      phaseIndex: b.phaseIndex,
      reducedMotion: reducedMotion.matches,
    });

    hazards.sync(state);
    toBoss.subVectors(boss.position, player.position).setY(0);
    const gap = toBoss.length();
    if (mode === "fight") cameraYaw = nextCameraYaw(cameraYaw, toBoss.x, toBoss.z, step, p.action === "roll");
    if (cameraYaw !== null && mode === "fight") toBoss.set(Math.sin(cameraYaw), 0, Math.cos(cameraYaw));
    else toBoss.normalize();
    const right = new THREE.Vector3(-toBoss.z, 0, toBoss.x);

    hemisphere.intensity = tuning.lights.hemisphere;
    key.intensity = tuning.lights.key;
    rim.intensity = tuning.lights.rim;
    fill.intensity = tuning.lights.fill;
    heroLamp.intensity = tuning.lights.heroLamp * (heroMode ? 0.45 : 1);
    pool.intensity = tuning.lights.pool;
    pool.distance = tuning.lights.poolRadius * 2.9;
    poolFocus.set((player.position.x + boss.position.x) / 2, 0, (player.position.z + boss.position.z) / 2);
    pool.target.position.lerp(poolFocus, 1 - Math.exp(-step * 3));
    pool.position.set(pool.target.position.x, 13, pool.target.position.z);
    RIM.strength.value = tuning.rim.strength;
    RIM.power.value = tuning.rim.power;
    edgeFadeUniforms.breakup.value = tuning.floor.breakup;
    edgeFadeUniforms.apron.value = tuning.floor.apron;
    edgeFadeUniforms.ring.value = tuning.floor.ring;
    // The side camera sits ~90 m out; exponential fog would swallow the whole lane, so it thins with the collapse.
    if (scene.fog instanceof THREE.FogExp2) scene.fog.density = tuning.fog.density * (1 - flatEase * 0.97);

    playerRadiusLine.visible = bossRadiusLine.visible = meleeRangeLine.visible = debug.hitboxes;
    if (debug.hitboxes) {
      playerRadiusLine.position.copy(player.position);
      bossRadiusLine.position.copy(boss.position);
      meleeRangeLine.position.copy(boss.position);
      const attack = p.action === "light" || p.action === "heavy" ? attackFor(p) : null;
      reachLine.visible = attack !== null;
      if (attack) {
        const inActive = p.actionT >= attack.windupMs && p.actionT < attack.windupMs + attack.activeMs;
        reachLine.position.copy(player.position);
        reachLine.scale.setScalar(attack.range + BOSS.radius);
        debugReachMaterial.color.set(inActive ? 0xff5a3c : 0xffd166);
      }
    } else {
      reachLine.visible = false;
    }

    fovPunch = Math.max(0, fovPunch - step / 0.22);
    const targetFov = THREE.MathUtils.lerp(tuning.camera.fov, FLAT_CAMERA.fov, flatEase) + easeOut(fovPunch) * 6 * tuning.camera.punch;
    if (Math.abs(camera.fov - targetFov) > 0.01) {
      camera.fov = targetFov;
      camera.updateProjectionMatrix();
    }

    if (debug.freeCamera) {
      // External controller owns the camera; still keep the sky and fill following it.
    } else if (mode === "fight") {
      // Pull back as the fighters separate so a kiting boss never leaves the frame on the big disc.
      const pullBack = THREE.MathUtils.clamp((gap - tuning.camera.farGap) * tuning.camera.pullBack, 0, tuning.camera.maxPullBack);
      desired.copy(player.position)
        .addScaledVector(toBoss, -(tuning.camera.distance + pullBack))
        .addScaledVector(right, tuning.camera.side)
        .setY(tuning.camera.height + pullBack * 0.45);
      const focusHeight = currentSpec
        ? THREE.MathUtils.clamp(BOSS_HEIGHTS[currentSpec.identity.silhouette] * (2 / 3), 1.35, 2.8)
        : 2;
      // Frame both fighters: aim between the hero's chest and the boss's focus point so the hero stays in shot.
      // The boss focus is clamped to a modest height and the whole target is damped, so a blink behind the camera
      // or a knockback swings the pitch over a few frames instead of snapping it.
      lookGoal.set(player.position.x, 1.2, player.position.z)
        .lerp(lookBoss.set(boss.position.x, Math.min(boss.position.y + focusHeight, 2.6), boss.position.z), 0.66);
      if (first) {
        chaseCamera.copy(desired);
        lookTarget.copy(lookGoal);
        first = false;
      } else {
        chaseCamera.lerp(desired, 1 - Math.exp(-step * tuning.camera.lag));
        lookTarget.lerp(lookGoal, 1 - Math.exp(-step * tuning.camera.lookLag));
      }
      if (flat > 0) {
        // Side-on, long lens, slightly raised: a near-orthographic platformer frame that still shows the floor telegraphs.
        const spread = Math.abs(boss.position.x - player.position.x);
        const halfHeight = Math.max(FLAT_CAMERA.minHalfHeight, (spread * 0.5 + FLAT_CAMERA.margin) / camera.aspect);
        const distance = halfHeight / Math.tan(THREE.MathUtils.degToRad(FLAT_CAMERA.fov / 2));
        flatLook.set((player.position.x + boss.position.x) / 2, FLAT_CAMERA.lookHeight, 0);
        flatCamera.copy(flatLook).add(new THREE.Vector3(0, Math.sin(FLAT_CAMERA.elevation) * distance, Math.cos(FLAT_CAMERA.elevation) * distance));
        camera.position.lerpVectors(chaseCamera, flatCamera, flatEase);
        camera.lookAt(flatLookBlend.lerpVectors(lookTarget, flatLook, flatEase));
        camera.rotateZ(FLAT_CAMERA.roll * flatEase);
      } else {
        camera.position.copy(chaseCamera);
        camera.lookAt(lookTarget);
      }
    } else {
      if (!reducedMotion.matches) attractAngle += step * 0.075;
      desired.set(Math.sin(attractAngle) * 15, 7.4, Math.cos(attractAngle) * 15);
      if (first) {
        camera.position.copy(desired);
        first = false;
      } else {
        camera.position.lerp(desired, 1 - Math.exp(-step * 2.4));
      }
      camera.lookAt(0, 1.2, 0);
    }
    shake = Math.max(0, shake - step * 2.2);
    shakeOffset.set((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, 0).multiplyScalar(tuning.camera.shake);
    hitKickT = Math.max(0, hitKickT - step / 0.28);
    if (!debug.freeCamera) {
      camera.position.add(shakeOffset);
      camera.position.addScaledVector(hitKick, easeOut(hitKickT) * (reducedMotion.matches ? 0.3 : 1));
    }
    skyDome.position.copy(camera.position);
    fill.position.copy(camera.position).add(new THREE.Vector3(0, 4, 0)).addScaledVector(right, -2.5);
    fill.target.position.copy(player.position).setY(1);

    const positions = emberGeometry.getAttribute("position") as THREE.BufferAttribute;
    if (!reducedMotion.matches) {
      for (let i = 0; i < positions.count; i += 1) {
        let y = positions.getY(i) + emberSpeeds[i]! * step;
        if (y > 11) y = -3;
        positions.setY(i, y);
      }
      positions.needsUpdate = true;
    }
    if (runeGroup) {
      runeGroup.rotation.y = reducedMotion.matches ? 0 : elapsed * 0.08;
      runeGroup.scale.setScalar(reducedMotion.matches ? 1 : 1 + Math.sin(elapsed * 1.3) * 0.018);
    }
    if (!reducedMotion.matches) {
      for (const shard of debris) {
        shard.object.position.y = shard.baseY + Math.sin(elapsed * 0.45 + shard.phase) * 0.35;
        shard.object.rotation.x += shard.spin.x * step;
        shard.object.rotation.y += shard.spin.y * step;
        shard.object.rotation.z += shard.spin.z * step;
      }
    }
    if (sigilMaterial) sigilMaterial.opacity = reducedMotion.matches ? 0.3 : 0.3 + Math.sin(elapsed * 0.72) * 0.08;
    playerShadow.position.x = player.position.x;
    playerShadow.position.z = player.position.z;
    playerShadow.scale.setScalar(Math.max(0.45, 1 - p.y * 0.3));
    bossShadow.position.x = boss.position.x;
    bossShadow.position.z = boss.position.z;
    if (bossShadow.material instanceof THREE.MeshBasicMaterial) bossShadow.material.opacity = 0.45 + reveal * 0.35;
    const rimScale = (state.arena.radius + (ARENA_FLOOR_RADIUS - ARENA_RADIUS)) / ARENA_FLOOR_RADIUS;
    fracture.scale.setScalar(rimScale);
    edgeFadeUniforms.cut.value = state.arena.radius < ARENA_RADIUS - 1e-3 ? rimScale / 1.25 : 2;
    edgeFadeUniforms.playRadius.value = state.arena.radius / EDGE_FADE_RADIUS;
    rimCollapse.update(reducedMotion.matches ? step * 3 : step);
    pillars.sync(state, step, events);
    particles.ambient(fxOn && tuning.fx.ambient);
    particles.update(step);
    post.render(step);
  };

  return {
    renderer,
    scene,
    camera,
    ready,
    tuning,
    debug,
    palette: () => palette,
    applySpec,
    preloadBoss,
    setSky,
    setPortrait: (url) => flatline.setPortrait(url),
    setMode: (nextMode) => {
      cameraYaw = null;
      mode = nextMode;
    },
    cameraRelative: (move) => {
      if (flat >= 0.5) return { x: move.x, z: move.z };
      camera.getWorldDirection(cameraForward).setY(0);
      if (cameraForward.lengthSq() < 1e-6) return move;
      cameraForward.normalize();
      return {
        x: cameraForward.x * move.z - cameraForward.z * move.x,
        z: cameraForward.z * move.z + cameraForward.x * move.x,
      };
    },
    screenRelative: (dir) => {
      camera.getWorldDirection(cameraForward).setY(0);
      if (cameraForward.lengthSq() < 1e-6) return dir;
      cameraForward.normalize();
      return {
        x: -cameraForward.z * dir.x + cameraForward.x * dir.z,
        z: cameraForward.x * dir.x + cameraForward.z * dir.z,
      };
    },
    render,
    dispose: () => {
      disposed = true;
      skyRequest += 1;
      window.removeEventListener("resize", resize);
      playerMotion?.stop();
      bossMotion?.stop();
      disposeGroup(arenaRoot);
      disposeGroup(player);
      disposeGroup(boss);
      flatline.dispose();
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      const textures = new Set<THREE.Texture>();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
          geometries.add(object.geometry);
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
            materials.add(material);
            const textured = material as THREE.MeshStandardMaterial;
            if (textured.map) textures.add(textured.map);
            if (textured.normalMap) textures.add(textured.normalMap);
          }
        }
      });
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      textures.add(staticSkyTexture);
      if (generatedSkyTexture) textures.add(generatedSkyTexture);
      for (const texture of textures) texture.dispose();
      if (library) disposeAssetLibrary(library);
      rimCollapse.dispose();
      pillars.dispose();
      particles.dispose();
      post.dispose();
      renderer.dispose();
    },
  };
}
