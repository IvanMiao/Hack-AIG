import * as THREE from "three";
import { ARENA_PILLARS, type BattleEvent, type BattleState } from "../../sim";
import { createToonMaterial, type ToonRimMaterial } from "../materials";
import type { ParticleSystem } from "./particles";

const HEIGHT = 3.3;
const SHARD_LIFE = 1.6;
const STONE_DARK = 0x1c1e28;
const COLUMN = 0x1f2129;
const STONE = 0x2a2c38;

/** Source meshes lifted from the arena GLB so raised cover shares its rock texture, fracture style and palette. */
export interface PillarTemplates {
  /** the "Broken obelisk" columns around the platform */
  columns: THREE.Mesh[];
  /** the "Raised fractured floor slab" chunks, used as a rubble collar at the base */
  rubble: THREE.Mesh[];
  /** the "Floating debris" rocks, used as shards when a column shatters */
  shards: THREE.Mesh[];
}

interface Variant {
  geometry: THREE.BufferGeometry;
  map?: THREE.Texture;
  normalMap?: THREE.Texture;
}

interface PillarMesh {
  id: number;
  root: THREE.Group;
  column: THREE.Mesh<THREE.BufferGeometry, ToonRimMaterial>;
  rubble: THREE.Group;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  hp: number;
  flash: { value: number };
  tilt: THREE.Vector3;
  phase: number;
}

interface Shard {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  age: number;
}

export interface PillarView {
  readonly object: THREE.Object3D;
  /** Swap the procedural stand-ins for the arena's own obelisk / slab / debris meshes once the GLB is loaded. */
  setTemplates(templates: PillarTemplates): void;
  sync(state: BattleState, dt: number, events: readonly BattleEvent[]): void;
  dispose(): void;
}

const textures = (mesh: THREE.Mesh): { map?: THREE.Texture; normalMap?: THREE.Texture } => {
  const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshToonMaterial;
  return { map: material.map ?? undefined, normalMap: material.normalMap ?? undefined };
};

/** Re-fit a source mesh so it stands on y=0, centred on the column axis, `height` tall and `radius` wide. */
const fitColumn = (source: THREE.BufferGeometry, radius: number, height: number): THREE.BufferGeometry => {
  const geometry = source.clone();
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const size = box.getSize(new THREE.Vector3());
  geometry.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  const radial = Math.max(size.x, size.z) / 2;
  geometry.scale(radius / radial, height / size.y, radius / radial);
  geometry.computeVertexNormals();
  return geometry;
};

/** Stand-in column when the arena GLB is not available: the same tapered eight-sided profile the obelisks were built from. */
const proceduralColumn = (radius: number, height: number, seed: number): THREE.BufferGeometry => {
  const profile: readonly (readonly [number, number])[] = [[0, 1], [0.12, 0.76], [0.38, 0.68], [0.71, 0.58], [0.9, 0.5], [1, 0.26]];
  const sides = 8;
  let s = seed;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const rings: THREE.Vector3[][] = profile.map(([f, r]) =>
    Array.from({ length: sides }, (_, i) => {
      const a = (i / sides) * Math.PI * 2;
      const jitter = 0.88 + rand() * 0.24;
      return new THREE.Vector3(Math.cos(a) * r * radius * jitter, f * height, Math.sin(a) * r * radius * jitter);
    }),
  );
  const positions: number[] = [];
  const push = (...v: THREE.Vector3[]) => v.forEach((p) => positions.push(p.x, p.y, p.z));
  for (let k = 0; k < rings.length - 1; k += 1) {
    for (let i = 0; i < sides; i += 1) {
      const a = rings[k]![i]!, b = rings[k]![(i + 1) % sides]!, c = rings[k + 1]![(i + 1) % sides]!, d = rings[k + 1]![i]!;
      push(a, b, c, a, c, d);
    }
  }
  const top = rings[rings.length - 1]!;
  const centre = new THREE.Vector3(0, height, 0);
  for (let i = 0; i < sides; i += 1) push(centre, top[i]!, top[(i + 1) % sides]!);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
};

/** Breakable cover that reads as part of the ruin: obelisk columns in the arena's rock, a rubble collar, a faint sigil ring. */
export function createPillars(particles: ParticleSystem, accent: THREE.Color): PillarView {
  const object = new THREE.Group();
  object.name = "Pillars";
  const r = ARENA_PILLARS.radius * 0.92;
  const owned = new Set<THREE.BufferGeometry>();
  const stone = createToonMaterial(STONE, 0x000000, { rim: 0.25 });
  const stoneDark = createToonMaterial(STONE_DARK, 0x000000, { rim: 0.25 });
  const ringGeometry = new THREE.RingGeometry(r * 1.2, r * 1.36, 48);
  ringGeometry.rotateX(-Math.PI / 2);

  let columns: Variant[] = [0, 1, 2, 3].map((i) => {
    const geometry = proceduralColumn(r, HEIGHT, 91 + i * 17);
    owned.add(geometry);
    return { geometry };
  });
  let rubble: { geometry: THREE.BufferGeometry; material: THREE.Material }[] = [0, 1, 2].map((i) => {
    const geometry = new THREE.DodecahedronGeometry(0.34, 0).scale(1.4, 0.36, 1 + i * 0.2);
    owned.add(geometry);
    return { geometry, material: stone };
  });
  let shardPool: { geometry: THREE.BufferGeometry; material: THREE.Material }[] = [0, 1].map((i) => {
    const geometry = new THREE.DodecahedronGeometry(0.3 + i * 0.1, 0);
    owned.add(geometry);
    return { geometry, material: stoneDark };
  });

  const pillars = new Map<number, PillarMesh>();
  const shards: Shard[] = [];
  const at = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  let clock = 0;

  const setTemplates = (templates: PillarTemplates) => {
    for (const g of owned) g.dispose();
    owned.clear();
    columns = templates.columns.map((mesh) => {
      const geometry = fitColumn(mesh.geometry, r, HEIGHT);
      owned.add(geometry);
      return { geometry, ...textures(mesh) };
    });
    rubble = templates.rubble.map((mesh) => {
      const geometry = mesh.geometry.clone().center();
      owned.add(geometry);
      return { geometry, material: Array.isArray(mesh.material) ? mesh.material[0]! : mesh.material };
    });
    shardPool = templates.shards.map((mesh) => {
      const geometry = mesh.geometry.clone().center();
      geometry.computeBoundingSphere();
      geometry.scale(0.36 / (geometry.boundingSphere?.radius ?? 1), 0.36 / (geometry.boundingSphere?.radius ?? 1), 0.36 / (geometry.boundingSphere?.radius ?? 1));
      owned.add(geometry);
      return { geometry, material: Array.isArray(mesh.material) ? mesh.material[0]! : mesh.material };
    });
    // Anything standing gets rebuilt from the new templates on the next sync.
    for (const pillar of [...pillars.values()]) remove(pillar);
  };

  const raise = (id: number, x: number, z: number, hp: number) => {
    const flash = { value: 0 };
    const variant = columns[id % columns.length]!;
    const material = createToonMaterial(COLUMN, 0x000000, { rim: 0.35, flash, map: variant.map, normalMap: variant.normalMap });
    // The fractured GLB shells have no consistent winding, so light both faces and skip the inverted-hull outline.
    material.side = THREE.DoubleSide;
    const column = new THREE.Mesh(variant.geometry, material);
    column.rotation.y = (id * 2.399) % (Math.PI * 2);
    const collar = new THREE.Group();
    for (let i = 0; i < 3; i += 1) {
      const piece = rubble[(id + i) % rubble.length]!;
      const chunk = new THREE.Mesh(piece.geometry, piece.material);
      const a = (i / 3) * Math.PI * 2 + id * 0.9;
      chunk.position.set(Math.cos(a) * r * 1.05, 0.05, Math.sin(a) * r * 1.05);
      chunk.rotation.set((Math.random() - 0.5) * 0.3, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.3);
      chunk.scale.setScalar(0.9 + Math.random() * 0.5);
      collar.add(chunk);
    }
    const ring = new THREE.Mesh(ringGeometry, new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    ring.position.y = 0.035;
    const root = new THREE.Group();
    root.add(column, collar, ring);
    root.position.set(x, 0, z);
    object.add(root);
    pillars.set(id, { id, root, column, rubble: collar, ring, hp, flash, tilt: new THREE.Vector3(), phase: id * 1.3 });
  };

  const remove = (pillar: PillarMesh) => {
    object.remove(pillar.root);
    pillar.column.material.dispose();
    pillar.ring.material.dispose();
    pillars.delete(pillar.id);
  };

  const shatter = (pillar: PillarMesh) => {
    const { x, z } = pillar.root.position;
    for (let i = 0; i < 12; i += 1) {
      const piece = shardPool[(pillar.id + i) % shardPool.length]!;
      const mesh = new THREE.Mesh(piece.geometry, piece.material);
      mesh.position.set(x + (Math.random() - 0.5) * r, 0.4 + Math.random() * HEIGHT * 0.9, z + (Math.random() - 0.5) * r);
      mesh.scale.setScalar(0.55 + Math.random() * 0.9);
      mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      object.add(mesh);
      const angle = Math.random() * Math.PI * 2;
      const speed = 2.5 + Math.random() * 4.5;
      shards.push({
        mesh,
        vel: new THREE.Vector3(Math.cos(angle) * speed, 3 + Math.random() * 4, Math.sin(angle) * speed),
        spin: new THREE.Vector3((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9),
        age: 0,
      });
    }
    at.set(x, 1.2, z);
    particles.burst(at, { count: 50, color: 0x6d6a72, color2: 0x15151c, speed: 4.5, spread: 0.9, dir: up, lifeMs: 1100, size: 0.3, gravity: 7, drag: 1.4 });
    particles.burst(at, { count: 24, color: accent, color2: 0xffffff, speed: 8, spread: 1, lifeMs: 420, size: 0.08, gravity: 12, drag: 3, stretch: 2.5 });
    remove(pillar);
  };

  /** A fresh sim reuses obstacle ids, so a pillar only matches an obstacle at the same spot with no more hp than it last showed. */
  const matches = (pillar: PillarMesh, o: BattleState["arena"]["obstacles"][number]) =>
    pillar.hp >= o.hp && Math.abs(pillar.root.position.x - o.pos.x) < 1e-3 && Math.abs(pillar.root.position.z - o.pos.z) < 1e-3;

  const sync = (state: BattleState, dt: number, events: readonly BattleEvent[]) => {
    clock += dt;
    for (const event of events) {
      if (event.type === "obstacleHit") {
        const pillar = pillars.get(event.id);
        if (!pillar) continue;
        at.copy(pillar.root.position).setY(1.4);
        if (event.hpLeft < pillar.hp) {
          pillar.hp = event.hpLeft;
          pillar.flash.value = 1;
          pillar.tilt.set((Math.random() - 0.5) * 0.14, 0, (Math.random() - 0.5) * 0.14);
          // Cracked stone: the column sinks a little, darkens and lets the accent bleed through the fractures.
          pillar.column.position.y -= 0.14;
          pillar.column.material.color.multiplyScalar(0.8);
          pillar.column.material.emissive.copy(accent).multiplyScalar(0.12);
          particles.burst(at, { count: 30, color: 0x6d6a72, color2: 0x15151c, speed: 3.5, spread: 1, lifeMs: 800, size: 0.22, gravity: 8, drag: 1.6 });
        } else {
          particles.burst(at, { count: 10, color: accent, color2: 0xffffff, speed: 4, spread: 1, lifeMs: 260, size: 0.07, drag: 4, stretch: 2 });
        }
      }
      if (event.type === "obstacleBroken") {
        const pillar = pillars.get(event.id);
        if (pillar) shatter(pillar);
      }
    }
    for (const o of state.arena.obstacles) {
      let pillar = pillars.get(o.id);
      if (pillar && !matches(pillar, o)) {
        remove(pillar);
        pillar = undefined;
      }
      if (!pillar) {
        raise(o.id, o.pos.x, o.pos.z, o.hp);
        pillar = pillars.get(o.id)!;
        if (o.age < ARENA_PILLARS.riseMs * 0.5) {
          at.set(o.pos.x, 0.1, o.pos.z);
          particles.burst(at, { count: 36, color: 0x6d6a72, color2: 0x15151c, speed: 3, spread: 0.8, dir: up, lifeMs: 1000, size: 0.28, gravity: 5, drag: 1.5 });
        }
      }
      const u = Math.min(1, o.age / ARENA_PILLARS.riseMs);
      const rise = 1 - Math.pow(1 - u, 3);
      // The column shoves up through the slab rather than stretching; the rubble collar heaves out in the last third.
      const cracked = ARENA_PILLARS.hp - pillar.hp;
      pillar.column.position.y = -HEIGHT * 1.02 * (1 - rise) - cracked * 0.14;
      pillar.rubble.scale.setScalar(Math.max(0.001, Math.min(1, (u - 0.6) / 0.4)));
      pillar.root.rotation.x = pillar.tilt.x;
      pillar.root.rotation.z = pillar.tilt.z;
      pillar.flash.value = Math.max(0, pillar.flash.value - dt * 5);
      const pulse = 0.22 + 0.06 * Math.sin(clock * 2.4 + pillar.phase) + cracked * 0.18;
      pillar.ring.material.opacity = pulse + (1 - rise) * 0.7;
      pillar.ring.material.color.copy(accent);
    }
    // The sim announces every break it makes; anything else missing belongs to a state that was swapped out, so it just goes.
    for (const pillar of [...pillars.values()]) {
      if (!state.arena.obstacles.some((o) => o.id === pillar.id)) remove(pillar);
    }
    for (let i = shards.length - 1; i >= 0; i -= 1) {
      const s = shards[i]!;
      s.age += dt;
      s.vel.y -= 18 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      if (s.mesh.position.y < 0.12) {
        s.mesh.position.y = 0.12;
        s.vel.y *= -0.25;
        s.vel.x *= 0.6;
        s.vel.z *= 0.6;
        s.spin.multiplyScalar(0.5);
      }
      s.mesh.rotation.x += s.spin.x * dt;
      s.mesh.rotation.y += s.spin.y * dt;
      s.mesh.rotation.z += s.spin.z * dt;
      const fade = Math.max(0, 1 - Math.max(0, s.age - SHARD_LIFE * 0.7) / (SHARD_LIFE * 0.3));
      s.mesh.scale.multiplyScalar(fade > 0 ? 1 - dt * (1 - fade) * 4 : 0);
      if (s.age >= SHARD_LIFE) {
        object.remove(s.mesh);
        shards.splice(i, 1);
      }
    }
  };

  const dispose = () => {
    for (const pillar of [...pillars.values()]) remove(pillar);
    for (const s of shards) object.remove(s.mesh);
    shards.length = 0;
    for (const g of owned) g.dispose();
    owned.clear();
    ringGeometry.dispose();
    stone.dispose();
    stoneDark.dispose();
  };

  return { object, setTemplates, sync, dispose };
}
