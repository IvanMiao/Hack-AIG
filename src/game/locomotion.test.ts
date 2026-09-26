import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { gaitTimeScale, Locomotion, selectClips, stepBlend } from "./locomotion";

const track = (node: string, value: number) =>
  new THREE.NumberKeyframeTrack(`${node}.position[y]`, [0, 1], [0, value]);
const clip = (name: string, node: string, value: number) => new THREE.AnimationClip(name, 1, [track(node, value)]);

describe("selectClips", () => {
  it("prefers the authored idle/move clips by name", () => {
    const idle = clip("idle", "root", 1);
    const move = clip("move", "root", 2);
    const other = clip("Cube|Action", "root", 3);
    expect(selectClips([other, move, idle])).toEqual({ idle, move });
  });

  it("falls back to the first clip as idle for legacy single-clip assets", () => {
    const only = clip("Cube|Action", "root", 1);
    expect(selectClips([only])).toEqual({ idle: only, move: null });
    expect(selectClips([])).toEqual({ idle: null, move: null });
  });
});

describe("stepBlend", () => {
  it("approaches the target monotonically and snaps when close", () => {
    let blend = 0;
    const samples: number[] = [];
    for (let i = 0; i < 90; i++) {
      blend = stepBlend(blend, true, 1 / 60);
      samples.push(blend);
    }
    for (let i = 1; i < samples.length; i++) expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1] ?? 0);
    expect(blend).toBe(1);
    expect(stepBlend(1, false, 5)).toBe(0);
  });

  it("is frame-rate independent", () => {
    let fine = 0;
    for (let i = 0; i < 6; i++) fine = stepBlend(fine, true, 0.05);
    const coarse = stepBlend(0, true, 0.3);
    expect(fine).toBeCloseTo(coarse, 6);
  });
});

describe("gaitTimeScale", () => {
  it("plays one clip cycle per cycleSeconds at the reference speed and clamps extremes", () => {
    expect(gaitTimeScale(6, 6, 1.7, 0.85)).toBeCloseTo(2);
    expect(gaitTimeScale(0.1, 6, 1.7, 0.85)).toBeCloseTo(2 * 0.6);
    expect(gaitTimeScale(60, 6, 1.7, 0.85)).toBeCloseTo(2 * 1.6);
  });
});

describe("Locomotion", () => {
  it("crossfades idle and move weights so they always sum to one", () => {
    const root = new THREE.Object3D();
    root.name = "root";
    const motion = new Locomotion(root, [clip("idle", "root", 0), clip("move", "root", 1)], { referenceSpeed: 6, cycleSeconds: 0.7 });
    expect(motion.moveWeight).toBe(0);
    for (let i = 0; i < 120; i++) motion.update(1 / 60, 6);
    expect(motion.moveWeight).toBe(1);
    for (let i = 0; i < 120; i++) motion.update(1 / 60, 0);
    expect(motion.moveWeight).toBe(0);
    motion.stop();
  });

  it("stays on idle when the asset has no move clip", () => {
    const root = new THREE.Object3D();
    root.name = "root";
    const motion = new Locomotion(root, [clip("Cube|Action", "root", 0.5)], { referenceSpeed: 6, cycleSeconds: 0.7 });
    for (let i = 0; i < 60; i++) motion.update(1 / 60, 6);
    expect(motion.moveWeight).toBe(0);
    expect(root.position.y).toBeGreaterThan(0);
  });
});
