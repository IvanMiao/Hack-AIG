import * as THREE from "three";

/**
 * Authored clips exported from blender/build_assets.py: every asset carries a looping `idle` and a shorter
 * `move` gait. Older single-clip assets fall back to their first clip as the idle. Any other named clip is an
 * overlay the caller can layer on top of the gait (attacks, hit flinch, stagger, death).
 */
export interface ClipSet {
  idle: THREE.AnimationClip | null;
  move: THREE.AnimationClip | null;
  overlays: ReadonlyMap<string, THREE.AnimationClip>;
}

export function selectClips(animations: readonly THREE.AnimationClip[]): ClipSet {
  const byName = (name: string) => animations.find((clip) => clip.name === name) ?? null;
  const idle = byName("idle") ?? animations[0] ?? null;
  const move = byName("move");
  const overlays = new Map<string, THREE.AnimationClip>();
  for (const clip of animations) {
    if (clip !== idle && clip !== move && clip.name !== "idle" && clip.name !== "move") overlays.set(clip.name, clip);
  }
  return { idle, move: move === idle ? null : move, overlays };
}

/** Exponential approach of the idle→move blend so the crossfade is frame-rate independent. */
export function stepBlend(current: number, moving: boolean, dt: number, fadeSeconds = 0.18): number {
  const target = moving ? 1 : 0;
  const k = 1 - Math.exp(-Math.max(0, dt) / fadeSeconds);
  const next = current + (target - current) * k;
  return Math.abs(next - target) < 1e-3 ? target : next;
}

/** Play-rate for the gait so stride frequency tracks ground speed instead of sliding. */
export function gaitTimeScale(speed: number, referenceSpeed: number, clipSeconds: number, cycleSeconds: number): number {
  const ratio = THREE.MathUtils.clamp(speed / referenceSpeed, 0.6, 1.6);
  return (clipSeconds / cycleSeconds) * ratio;
}

/**
 * Attack clips are authored on a fixed layout (see WINDUP/STRIKE/HOLD in blender/build_assets.py): rest →
 * anticipation at `windup`, contact at `strike`, held, then recovery back to rest by 1. The sim's windup /
 * active / recover windows have their own durations, so each phase is scrubbed onto its span of the clip.
 */
export const ATTACK_LAYOUT = { windup: 1 / 3, strike: 1 / 2 } as const;

export type AttackPhase = "windup" | "active" | "recover";

export function attackFraction(phase: AttackPhase, progress: number): number {
  const t = THREE.MathUtils.clamp(progress, 0, 1);
  if (phase === "windup") return t * ATTACK_LAYOUT.windup;
  if (phase === "active") return ATTACK_LAYOUT.windup + t * (ATTACK_LAYOUT.strike - ATTACK_LAYOUT.windup);
  return ATTACK_LAYOUT.strike + t * (1 - ATTACK_LAYOUT.strike);
}

/**
 * What to layer over the gait this frame. `fraction` (0..1 of the clip) or `seconds` scrub a one-shot to the
 * sim's own timing so contact frames line up with hit windows; with neither the clip loops (stagger).
 */
export interface Overlay {
  clip: string;
  fraction?: number;
  seconds?: number;
}

export interface LocomotionOptions {
  /** Ground speed (m/s) at which the gait plays at its authored stride rate. */
  referenceSpeed: number;
  /** Real-time seconds one gait cycle should take at `referenceSpeed`. */
  cycleSeconds: number;
  /** Idle playback rate; heavy bosses breathe slower than the hero. */
  idleTimeScale?: number;
}

const OVERLAY_FADE_SECONDS = 0.07;

interface OverlayAction {
  action: THREE.AnimationAction;
  duration: number;
  weight: number;
  playing: boolean;
}

/**
 * Idle/move crossfade plus one overlay slot on a single mixer. Gait actions stay running with complementary
 * weights so joints never snap; an overlay fades in over the gait (which yields weight to it) and back out
 * when the caller stops requesting it. Joints an overlay doesn't key ease toward rest while it holds weight.
 */
export class Locomotion {
  readonly mixer: THREE.AnimationMixer;
  private readonly idle: THREE.AnimationAction | null;
  private readonly move: THREE.AnimationAction | null;
  private readonly moveDuration: number;
  private readonly overlays = new Map<string, OverlayAction>();
  private blend = 0;

  constructor(root: THREE.Object3D, animations: readonly THREE.AnimationClip[], private readonly options: LocomotionOptions) {
    this.mixer = new THREE.AnimationMixer(root);
    const clips = selectClips(animations);
    this.idle = clips.idle ? this.mixer.clipAction(clips.idle).setLoop(THREE.LoopRepeat, Infinity) : null;
    this.move = clips.move ? this.mixer.clipAction(clips.move).setLoop(THREE.LoopRepeat, Infinity) : null;
    this.moveDuration = clips.move?.duration ?? 1;
    if (this.idle) {
      this.idle.timeScale = options.idleTimeScale ?? 1;
      this.idle.setEffectiveWeight(1).play();
    }
    if (this.move) this.move.setEffectiveWeight(0).play();
    for (const [name, clip] of clips.overlays) {
      const action = this.mixer.clipAction(clip);
      action.clampWhenFinished = true;
      this.overlays.set(name, { action, duration: clip.duration, weight: 0, playing: false });
    }
  }

  get moveWeight(): number {
    return this.blend;
  }

  hasClip(name: string): boolean {
    return this.overlays.has(name);
  }

  /** Blend weight of the named overlay this frame (0 when absent). */
  overlayWeight(name: string): number {
    return this.overlays.get(name)?.weight ?? 0;
  }

  update(dt: number, speed: number, overlay: Overlay | null = null): void {
    const moving = this.move !== null && speed > this.options.referenceSpeed * 0.15;
    this.blend = stepBlend(this.blend, moving, dt);

    let overlayTotal = 0;
    for (const [name, entry] of this.overlays) {
      const requested = overlay !== null && overlay.clip === name;
      entry.weight = stepBlend(entry.weight, requested, dt, OVERLAY_FADE_SECONDS);
      if (requested) {
        const scrubbed = overlay.fraction !== undefined || overlay.seconds !== undefined;
        if (!entry.playing) {
          entry.action.setLoop(scrubbed ? THREE.LoopOnce : THREE.LoopRepeat, Infinity).reset().play();
          entry.playing = true;
        }
        if (scrubbed) {
          const seconds = overlay.seconds ?? (overlay.fraction ?? 0) * entry.duration;
          entry.action.paused = true;
          entry.action.time = THREE.MathUtils.clamp(seconds, 0, entry.duration - 1e-4);
        } else {
          entry.action.paused = false;
        }
      } else if (entry.playing && entry.weight === 0) {
        entry.action.stop();
        entry.playing = false;
      }
      entry.action.setEffectiveWeight(entry.weight);
      overlayTotal += entry.weight;
    }

    const gait = 1 - Math.min(1, overlayTotal);
    if (this.idle) this.idle.setEffectiveWeight(gait * (1 - this.blend));
    if (this.move) {
      this.move.setEffectiveWeight(gait * this.blend);
      if (moving) this.move.timeScale = gaitTimeScale(speed, this.options.referenceSpeed, this.moveDuration, this.options.cycleSeconds);
    }
    this.mixer.update(dt);
  }

  stop(): void {
    this.mixer.stopAllAction();
  }
}
