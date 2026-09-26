import * as THREE from "three";
import { ARENA_PILLARS, type BattleEvent, type BattleState } from "../../sim";
import { addOutline, createToonMaterial } from "../materials";
import type { ParticleSystem } from "./particles";

const HEIGHT = 3.4;
const SHARD_LIFE = 1.5;

interface PillarMesh {
  id: number;
  root: THREE.Group;
  body: THREE.Mesh<THREE.BufferGeometry, THREE.MeshToonMaterial>;
  band: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  hp: number;
  flash: { value: number };
  tilt: THREE.Vector3;
}

interface Shard {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  age: number;
}

export interface PillarView {
  readonly object: THREE.Object3D;
  sync(state: BattleState, dt: number, events: readonly BattleEvent[]): void;
  dispose(): void;
}

/** Procedural breakable cover: a faceted stone column with an accent band that rises, cracks and shatters into shards. */
export function createPillars(particles: ParticleSystem, accent: THREE.Color): PillarView {
  const object = new THREE.Group();
  object.name = "Pillars";
  const r = ARENA_PILLARS.radius;
  const bodyGeometry = new THREE.CylinderGeometry(r * 0.78, r * 1.05, HEIGHT, 7, 1);
  bodyGeometry.translate(0, HEIGHT / 2, 0);
  const bandGeometry = new THREE.TorusGeometry(r * 0.86, 0.06, 6, 24);
  const shardGeometry = new THREE.DodecahedronGeometry(r * 0.32, 0);
  const stoneMaterial = createToonMaterial(0x2a2733, 0x000000, { rim: 0.6 });
  const pillars = new Map<number, PillarMesh>();
  const shards: Shard[] = [];
  const at = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  const raise = (id: number, x: number, z: number, hp: number) => {
    const flash = { value: 0 };
    const material = createToonMaterial(0x2a2733, 0x000000, { rim: 0.6, flash });
    const body = new THREE.Mesh(bodyGeometry, material);
    addOutline(body, 0.02);
    const band = new THREE.Mesh(bandGeometry, new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    band.rotation.x = Math.PI / 2;
    band.position.y = HEIGHT * 0.82;
    const root = new THREE.Group();
    root.add(body, band);
    root.position.set(x, 0, z);
    root.rotation.y = Math.random() * Math.PI * 2;
    object.add(root);
    pillars.set(id, { id, root, body, band, hp, flash, tilt: new THREE.Vector3() });
  };

  const shatter = (pillar: PillarMesh) => {
    const { x, z } = pillar.root.position;
    for (let i = 0; i < 11; i += 1) {
      const mesh = new THREE.Mesh(shardGeometry, stoneMaterial);
      mesh.position.set(x + (Math.random() - 0.5) * r, 0.4 + Math.random() * HEIGHT * 0.9, z + (Math.random() - 0.5) * r);
      mesh.scale.set(0.5 + Math.random() * 0.8, 0.4 + Math.random() * 1.1, 0.5 + Math.random() * 0.8);
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
    particles.burst(at, { count: 50, color: 0x8a8578, color2: 0x1b1a1d, speed: 4.5, spread: 0.9, dir: up, lifeMs: 1100, size: 0.3, gravity: 7, drag: 1.4 });
    particles.burst(at, { count: 24, color: accent, color2: 0xffffff, speed: 8, spread: 1, lifeMs: 420, size: 0.08, gravity: 12, drag: 3, stretch: 2.5 });
    object.remove(pillar.root);
    pillar.body.material.dispose();
    pillar.band.material.dispose();
    pillars.delete(pillar.id);
  };

  const sync = (state: BattleState, dt: number, events: readonly BattleEvent[]) => {
    for (const event of events) {
      if (event.type === "obstacleHit") {
        const pillar = pillars.get(event.id);
        if (!pillar) continue;
        at.copy(pillar.root.position).setY(1.4);
        if (event.hpLeft < pillar.hp) {
          pillar.hp = event.hpLeft;
          pillar.flash.value = 1;
          pillar.tilt.set((Math.random() - 0.5) * 0.16, 0, (Math.random() - 0.5) * 0.16);
          pillar.body.material.color.multiplyScalar(0.72);
          particles.burst(at, { count: 30, color: 0x8a8578, color2: 0x1b1a1d, speed: 3.5, spread: 1, lifeMs: 800, size: 0.22, gravity: 8, drag: 1.6 });
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
      if (!pillar) {
        raise(o.id, o.pos.x, o.pos.z, o.hp);
        pillar = pillars.get(o.id)!;
        if (o.age < ARENA_PILLARS.riseMs * 0.5) {
          at.set(o.pos.x, 0.1, o.pos.z);
          particles.burst(at, { count: 36, color: 0x8a8578, color2: 0x1b1a1d, speed: 3, spread: 0.8, dir: up, lifeMs: 1000, size: 0.28, gravity: 5, drag: 1.5 });
        }
      }
      const u = Math.min(1, o.age / ARENA_PILLARS.riseMs);
      const rise = 1 - Math.pow(1 - u, 3);
      pillar.root.scale.set(1, 0.04 + rise * 0.96, 1);
      pillar.root.rotation.x = pillar.tilt.x;
      pillar.root.rotation.z = pillar.tilt.z;
      pillar.flash.value = Math.max(0, pillar.flash.value - dt * 5);
      pillar.band.material.color.copy(accent);
    }
    for (const pillar of [...pillars.values()]) {
      if (!state.arena.obstacles.some((o) => o.id === pillar.id)) shatter(pillar);
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
    for (const pillar of pillars.values()) {
      pillar.body.material.dispose();
      pillar.band.material.dispose();
    }
    pillars.clear();
    for (const s of shards) object.remove(s.mesh);
    shards.length = 0;
    bodyGeometry.dispose();
    bandGeometry.dispose();
    shardGeometry.dispose();
    stoneMaterial.dispose();
  };

  return { object, sync, dispose };
}
