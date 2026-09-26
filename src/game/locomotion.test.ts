import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { ATTACK_LAYOUT, attackFraction, gaitTimeScale, Locomotion, selectClips, stepBlend } from "./locomotion";

const track = (node: string, value: number) =>
  new THREE.NumberKeyframeTrack(`${node}.position[y]`, [0, 1], [0, value]);
const clip = (name: string, node: string, value: number) => new THREE.AnimationClip(name, 1, [track(node, value)]);

describe("selectClips", () => {
  it("prefers the authored idle/move clips by name", () => {
    const idle = clip("idle", "root", 1);
    const move = clip("move", "root", 2);
    const other = clip("Cube|Action", "root", 3);
    expect(selectClips([other, move, idle])).toEqual({ idle, move, overlays: new Map([["Cube|Action", other]]) });
  });

  it("falls back to the first clip as idle for legacy single-clip assets", () => {
    const only = clip("Cube|Action", "root", 1);
    expect(selectClips([only])).toEqual({ idle: only, move: null, overlays: new Map() });
    expect(selectClips([])).toEqual({ idle: null, move: null, overlays: new Map() });
  });

  it("exposes every other named clip as an overlay", () => {
    const light = clip("light", "root", 1);
    const death = clip("death", "root", 2);
    const { overlays } = selectClips([clip("idle", "root", 0), light, clip("move", "root", 0), death]);
    expect([...overlays.keys()]).toEqual(["light", "death"]);
    expect(overlays.get("death")).toBe(death);
  });
});

describe("attackFraction", () => {
  it("maps windup/active/recover onto contiguous spans of the shared attack layout", () => {
    expect(attackFraction("windup", 0)).toBe(0);
    expect(attackFraction("windup", 1)).toBeCloseTo(ATTACK_LAYOUT.windup);
    expect(attackFraction("active", 0)).toBeCloseTo(ATTACK_LAYOUT.windup);
    expect(attackFraction("active", 1)).toBeCloseTo(ATTACK_LAYOUT.strike);
    expect(attackFraction("recover", 0)).toBeCloseTo(ATTACK_LAYOUT.strike);
    expect(attackFraction("recover", 1)).toBe(1);
    expect(attackFraction("active", 3)).toBeCloseTo(ATTACK_LAYOUT.strike);
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

  it("scrubs a requested overlay to the sim's fraction, takes weight from the gait, then fades back", () => {
    const root = new THREE.Object3D();
    root.name = "root";
    // idle keeps the root at y=0; light lifts it to y=2 by the end of the clip.
    const idle = new THREE.AnimationClip("idle", 1, [new THREE.NumberKeyframeTrack("root.position[y]", [0, 1], [0, 0])]);
    const light = clip("light", "root", 2);
    const motion = new Locomotion(root, [idle, light], { referenceSpeed: 6, cycleSeconds: 0.7 });
    expect(motion.hasClip("light")).toBe(true);
    expect(motion.hasClip("heavy")).toBe(false);
    for (let i = 0; i < 60; i++) motion.update(1 / 60, 0, { clip: "light", fraction: 0.5 });
    expect(motion.overlayWeight("light")).toBe(1);
    expect(root.position.y).toBeCloseTo(1, 5);
    motion.update(1 / 60, 0, { clip: "light", fraction: 0.75 });
    expect(root.position.y).toBeCloseTo(1.5, 5);
    for (let i = 0; i < 60; i++) motion.update(1 / 60, 0);
    expect(motion.overlayWeight("light")).toBe(0);
    expect(root.position.y).toBeCloseTo(0, 5);
  });

  it("loops an overlay requested without a scrub time and ignores unknown clips", () => {
    const root = new THREE.Object3D();
    root.name = "root";
    const motion = new Locomotion(root, [clip("idle", "root", 0), clip("stagger", "root", 1)], { referenceSpeed: 6, cycleSeconds: 0.7 });
    for (let i = 0; i < 30; i++) motion.update(1 / 60, 0, { clip: "stagger" });
    const early = root.position.y;
    for (let i = 0; i < 30; i++) motion.update(1 / 60, 0, { clip: "stagger" });
    expect(root.position.y).not.toBeCloseTo(early, 3);
    for (let i = 0; i < 30; i++) motion.update(1 / 60, 0, { clip: "missing" });
    expect(motion.overlayWeight("stagger")).toBe(0);
    expect(motion.overlayWeight("missing")).toBe(0);
  });
});
