import * as THREE from "three";

/**
 * Authored clips exported from blender/build_assets.py: every asset carries a looping `idle` and a shorter
 * `move` gait. Older single-clip assets fall back to their first clip as the idle.
 */
export interface ClipSet {
  idle: THREE.AnimationClip | null;
  move: THREE.AnimationClip | null;
}

export function selectClips(animations: readonly THREE.AnimationClip[]): ClipSet {
  const byName = (name: string) => animations.find((clip) => clip.name === name) ?? null;
  const idle = byName("idle") ?? animations[0] ?? null;
  const move = byName("move");
  return { idle, move: move === idle ? null : move };
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

export interface LocomotionOptions {
  /** Ground speed (m/s) at which the gait plays at its authored stride rate. */
  referenceSpeed: number;
  /** Real-time seconds one gait cycle should take at `referenceSpeed`. */
  cycleSeconds: number;
  /** Idle playback rate; heavy bosses breathe slower than the hero. */
  idleTimeScale?: number;
}

/**
 * Idle/move crossfade on a single mixer. Both actions stay running with complementary weights so joints never
 * snap; the caller feeds the measured ground speed every frame.
 */
export class Locomotion {
  readonly mixer: THREE.AnimationMixer;
  private readonly idle: THREE.AnimationAction | null;
  private readonly move: THREE.AnimationAction | null;
  private readonly moveDuration: number;
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
  }

  get moveWeight(): number {
    return this.blend;
  }

  update(dt: number, speed: number): void {
    const moving = this.move !== null && speed > this.options.referenceSpeed * 0.15;
    this.blend = stepBlend(this.blend, moving, dt);
    if (this.idle) this.idle.setEffectiveWeight(1 - this.blend);
    if (this.move) {
      this.move.setEffectiveWeight(this.blend);
      if (moving) this.move.timeScale = gaitTimeScale(speed, this.options.referenceSpeed, this.moveDuration, this.options.cycleSeconds);
    }
    this.mixer.update(dt);
  }

  stop(): void {
    this.mixer.stopAllAction();
  }
}
