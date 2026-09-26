import * as THREE from "three";
import { ARENA_FLOOR_RADIUS } from "../../sim";
import { createToonMaterial } from "../materials";
import type { ParticleSystem } from "./particles";

interface Chunk {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  delay: number;
  age: number;
  vy: number;
  tilt: THREE.Vector3;
  dropped: boolean;
  outward: THREE.Vector3;
}

export interface RimCollapse {
  readonly object: THREE.Object3D;
  /** Break the stone band between `to` and the old edge into wedges that shudder, then drop into the void. */
  collapse(from: number, to: number, ms: number): void;
  update(dt: number): void;
  dispose(): void;
}

const SHUDDER_S = 0.55;
const GRAVITY = 14;
const KILL_Y = -14;

/** A jittered annular sector, extruded downwards so the broken slab shows a lit top and a dark side. */
function wedgeGeometry(a0: number, a1: number, inner: number, outer: number, random: () => number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const steps = 4;
  const jitter = (r: number) => r * (0.97 + random() * 0.06);
  for (let i = 0; i <= steps; i += 1) {
    const a = a0 + ((a1 - a0) * i) / steps;
    const r = jitter(outer);
    if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  for (let i = steps; i >= 0; i -= 1) {
    const a = a0 + ((a1 - a0) * i) / steps;
    const r = jitter(inner);
    shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.9 + random() * 0.5, bevelEnabled: false });
  // Extrude runs along +Z; lay the slab flat with its top face at y = 0.
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

export function createRimCollapse(particles: ParticleSystem): RimCollapse {
  const object = new THREE.Group();
  object.name = "Rim collapse";
  const stone = createToonMaterial(0x14161f, 0x000000, { rim: 0 });
  const chunks: Chunk[] = [];
  let seed = 7;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const dust = new THREE.Vector3();

  const collapse = (from: number, to: number, ms: number) => {
    const inner = to + 1.2;
    const outer = Math.max(inner + 1.5, Math.min(ARENA_FLOOR_RADIUS, from + 2));
    const count = Math.max(10, Math.round((inner + outer) * 0.55));
    const bands = outer - inner > 5 ? 2 : 1;
    for (let band = 0; band < bands; band += 1) {
      const r0 = inner + ((outer - inner) * band) / bands;
      const r1 = inner + ((outer - inner) * (band + 1)) / bands;
      for (let i = 0; i < count; i += 1) {
        const a0 = ((Math.PI * 2) / count) * i + random() * 0.05;
        const a1 = a0 + (Math.PI * 2) / count - 0.02 - random() * 0.05;
        const geometry = wedgeGeometry(a0, a1, r0, r1, random);
        const mesh = new THREE.Mesh(geometry, stone);
        mesh.position.y = -0.02;
        object.add(mesh);
        const mid = (a0 + a1) / 2;
        chunks.push({
          mesh,
          geometry,
          // Outer band goes first, then the shrink eats inward as the sim radius eases down.
          delay: (ms / 1000) * (0.1 + random() * 0.55) * (bands - band) * 0.7 + random() * 0.2,
          age: 0,
          vy: 0,
          tilt: new THREE.Vector3((random() - 0.5) * 0.9, (random() - 0.5) * 0.3, (random() - 0.5) * 0.9),
          dropped: false,
          outward: new THREE.Vector3(Math.cos(mid), 0, Math.sin(mid)),
        });
      }
    }
  };

  const update = (dt: number) => {
    for (let i = chunks.length - 1; i >= 0; i -= 1) {
      const c = chunks[i]!;
      c.age += dt;
      const t = c.age - c.delay;
      if (t < 0) continue;
      if (t < SHUDDER_S) {
        const k = t / SHUDDER_S;
        c.mesh.position.y = -0.02 - k * 0.12 + Math.sin(t * 70) * 0.02 * k;
        c.mesh.rotation.set(c.tilt.x * k * 0.05, 0, c.tilt.z * k * 0.05);
        continue;
      }
      if (!c.dropped) {
        c.dropped = true;
        c.geometry.computeBoundingSphere();
        const centre = c.geometry.boundingSphere?.center;
        if (centre) dust.set(centre.x, 0.2, centre.z);
        particles.burst(dust, { count: 14, color: 0x8a8578, color2: 0x1b1a1d, speed: 3.2, spread: 0.9, dir: new THREE.Vector3(0, 1, 0), lifeMs: 900, size: 0.28, gravity: 6, drag: 1.6 });
      }
      const fall = t - SHUDDER_S;
      c.vy -= GRAVITY * dt;
      c.mesh.position.y += c.vy * dt;
      c.mesh.position.addScaledVector(c.outward, dt * 0.6);
      c.mesh.rotation.x += c.tilt.x * dt * (0.4 + fall);
      c.mesh.rotation.y += c.tilt.y * dt;
      c.mesh.rotation.z += c.tilt.z * dt * (0.4 + fall);
      if (c.mesh.position.y < KILL_Y) {
        object.remove(c.mesh);
        c.geometry.dispose();
        chunks.splice(i, 1);
      }
    }
  };

  const dispose = () => {
    for (const c of chunks) {
      object.remove(c.mesh);
      c.geometry.dispose();
    }
    chunks.length = 0;
    stone.dispose();
  };

  return { object, collapse, update, dispose };
}
