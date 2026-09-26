import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ARENA_FLOOR_RADIUS, ARENA_RADIUS, BOSS, BOSS_EDGE_MARGIN, PLAYER_EDGE_MARGIN } from "../sim/constants";
import { SILHOUETTES } from "../spec/types";
import { createCodexBoss } from "./codexBoss";
import { BOSS_MELEE_STRIKE } from "./createStage";
import { createHFHero } from "./hfHero";

type Mat4 = number[];
interface GltfNode { name?: string; mesh?: number; children?: number[]; matrix?: Mat4; translation?: number[]; rotation?: number[]; scale?: number[] }
interface Gltf {
  scenes: { nodes: number[] }[];
  nodes: GltfNode[];
  meshes: { primitives: { attributes: { POSITION: number } }[] }[];
  accessors: { bufferView: number; byteOffset?: number; count: number }[];
  bufferViews: { byteOffset?: number; byteStride?: number }[];
}

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const multiply = (a: Mat4, b: Mat4): Mat4 => {
  const out = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r += 1) for (let c = 0; c < 4; c += 1) for (let k = 0; k < 4; k += 1) out[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return out;
};
const localMatrix = (node: GltfNode): Mat4 => {
  if (node.matrix) return node.matrix;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const m: Mat4 = [
    1 - 2 * (y! * y! + z! * z!), 2 * (x! * y! + z! * w!), 2 * (x! * z! - y! * w!), 0,
    2 * (x! * y! - z! * w!), 1 - 2 * (x! * x! + z! * z!), 2 * (y! * z! + x! * w!), 0,
    2 * (x! * z! + y! * w!), 2 * (y! * z! - x! * w!), 1 - 2 * (x! * x! + y! * y!), 0,
    tx!, ty!, tz!, 1,
  ];
  for (let c = 0; c < 3; c += 1) for (let r = 0; r < 3; r += 1) m[c * 4 + r]! *= [sx!, sy!, sz!][c]!;
  return m;
};

/** World-space ground-plane radius of every vertex in a GLB, grouped by node name. */
function groundRadii(file: string): Map<string, number[]> {
  const buffer = readFileSync(fileURLToPath(new URL(file, import.meta.url)));
  const jsonLength = buffer.readUInt32LE(12);
  const gltf = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString()) as Gltf;
  const binStart = 20 + jsonLength + 8;
  const result = new Map<string, number[]>();
  const visit = (index: number, parent: Mat4) => {
    const node = gltf.nodes[index]!;
    const world = multiply(parent, localMatrix(node));
    if (node.mesh !== undefined) {
      const radii: number[] = [];
      for (const primitive of gltf.meshes[node.mesh]!.primitives) {
        const accessor = gltf.accessors[primitive.attributes.POSITION]!;
        const view = gltf.bufferViews[accessor.bufferView]!;
        const offset = binStart + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
        const stride = view.byteStride ?? 12;
        for (let i = 0; i < accessor.count; i += 1) {
          const x = buffer.readFloatLE(offset + i * stride);
          const y = buffer.readFloatLE(offset + i * stride + 4);
          const z = buffer.readFloatLE(offset + i * stride + 8);
          const wx = world[0]! * x + world[4]! * y + world[8]! * z + world[12]!;
          const wz = world[2]! * x + world[6]! * y + world[10]! * z + world[14]!;
          radii.push(Math.hypot(wx, wz));
        }
      }
      result.set(node.name ?? `node ${index}`, radii);
    }
    for (const child of node.children ?? []) visit(child, world);
  };
  for (const scene of gltf.scenes) for (const root of scene.nodes) visit(root, IDENTITY);
  return result;
}

const maxRadius = (radii: Map<string, number[]>) => Math.max(...[...radii.values()].map((list) => Math.max(...list)));

/** Ground-plane radius of a procedural (three.js-built) figure in its rest pose. */
function proceduralRadius(root: THREE.Object3D): number {
  root.updateMatrixWorld(true);
  let max = 0;
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const position = (object.geometry as THREE.BufferGeometry).getAttribute("position");
    const point = new THREE.Vector3();
    for (let i = 0; i < position.count; i += 1) {
      point.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
      max = Math.max(max, Math.hypot(point.x, point.z));
    }
  });
  return max;
}

describe("arena floor vs. fighter clamps", () => {
  const floor = groundRadii("../assets/models/arena.glb").get("Arena carved walkable stone")!;
  const outerRing = Math.max(...floor);
  // The rim is jittered; the tightest point of the outer ring (rings are ~1.45 apart) is the effective floor edge.
  const floorEdge = Math.min(...floor.filter((r) => r > outerRing - 1));

  it("walkable stone matches ARENA_FLOOR_RADIUS", () => {
    expect(outerRing).toBeGreaterThan(ARENA_FLOOR_RADIUS * 0.95);
    expect(outerRing).toBeLessThan(ARENA_FLOOR_RADIUS * 1.05);
    expect(ARENA_FLOOR_RADIUS).toBeGreaterThan(ARENA_RADIUS);
  });

  it("player and HF hero stay on the stone at the clamp", () => {
    const player = maxRadius(groundRadii("../assets/models/player.glb"));
    expect(ARENA_RADIUS - PLAYER_EDGE_MARGIN + player).toBeLessThanOrEqual(floorEdge);
    expect(ARENA_RADIUS - PLAYER_EDGE_MARGIN + proceduralRadius(createHFHero().root)).toBeLessThanOrEqual(floorEdge);
  });

  it("every boss body, at full strike lunge, stays on the stone at the clamp", () => {
    const bossLimit = ARENA_RADIUS - BOSS.radius - BOSS_EDGE_MARGIN;
    for (const silhouette of SILHOUETTES) {
      const body = maxRadius(groundRadii(`../assets/models/boss_${silhouette}.glb`));
      const overhang = (body + BOSS_MELEE_STRIKE.lunge) * BOSS_MELEE_STRIKE.stretch;
      expect(bossLimit + overhang, silhouette).toBeLessThanOrEqual(floorEdge);
    }
    const codex = proceduralRadius(createCodexBoss().root);
    expect(bossLimit + (codex + BOSS_MELEE_STRIKE.lunge) * BOSS_MELEE_STRIKE.stretch, "codex").toBeLessThanOrEqual(floorEdge);
  });
});
