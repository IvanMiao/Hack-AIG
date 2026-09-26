import * as THREE from "three";

export interface BurstOptions {
  count: number;
  color: THREE.ColorRepresentation;
  /** optional second colour lerped per particle */
  color2?: THREE.ColorRepresentation;
  speed: number;
  /** spread 0 = along `dir` only, 1 = full sphere */
  spread?: number;
  dir?: THREE.Vector3;
  lifeMs: number;
  size: number;
  gravity?: number;
  drag?: number;
  /** stretch quads along velocity: sparks */
  stretch?: number;
}

export interface ParticleSystem {
  readonly object: THREE.Object3D;
  burst(at: THREE.Vector3, options: BurstOptions): void;
  update(dt: number): void;
  /** Continuous ambient emitter: a few embers rising from the arena each second. */
  ambient(enabled: boolean): void;
  dispose(): void;
}

const MAX = 1400;

/**
 * One InstancedMesh of camera-facing quads; every hit spark, ash mote and ember lives here.
 * Fixed-size pool, no allocation per frame.
 */
export function createParticles(camera: THREE.Camera, ambientColor: THREE.Color): ParticleSystem {
  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexColors: true,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, MAX);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
  const colors = new Float32Array(MAX * 3);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

  const pos = new Float32Array(MAX * 3);
  const vel = new Float32Array(MAX * 3);
  const life = new Float32Array(MAX);
  const maxLife = new Float32Array(MAX);
  const size = new Float32Array(MAX);
  const grav = new Float32Array(MAX);
  const drag = new Float32Array(MAX);
  const stretch = new Float32Array(MAX);
  const baseColor = new Float32Array(MAX * 3);
  let alive = 0;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const v = new THREE.Vector3();
  const camQ = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const camInverse = new THREE.Quaternion();
  const spin = new THREE.Quaternion();
  const tmpColor = new THREE.Color();
  const tmpColor2 = new THREE.Color();

  const kill = (i: number) => {
    alive -= 1;
    if (i === alive) return;
    pos.copyWithin(i * 3, alive * 3, alive * 3 + 3);
    vel.copyWithin(i * 3, alive * 3, alive * 3 + 3);
    baseColor.copyWithin(i * 3, alive * 3, alive * 3 + 3);
    life[i] = life[alive]!;
    maxLife[i] = maxLife[alive]!;
    size[i] = size[alive]!;
    grav[i] = grav[alive]!;
    drag[i] = drag[alive]!;
    stretch[i] = stretch[alive]!;
  };

  let ambientOn = false;
  let ambientAcc = 0;
  const ambientAt = new THREE.Vector3();

  return {
    object: mesh,
    burst(at, o) {
      tmpColor.set(o.color);
      tmpColor2.set(o.color2 ?? o.color);
      const spread = o.spread ?? 1;
      const dir = o.dir ?? zAxis;
      for (let n = 0; n < o.count && alive < MAX; n += 1) {
        const i = alive;
        alive += 1;
        pos[i * 3] = at.x;
        pos[i * 3 + 1] = at.y;
        pos[i * 3 + 2] = at.z;
        v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
        v.lerp(dir, 1 - spread).normalize().multiplyScalar(o.speed * (0.45 + Math.random() * 0.9));
        vel[i * 3] = v.x;
        vel[i * 3 + 1] = v.y;
        vel[i * 3 + 2] = v.z;
        maxLife[i] = life[i] = (o.lifeMs / 1000) * (0.6 + Math.random() * 0.8);
        size[i] = o.size * (0.6 + Math.random() * 0.8);
        grav[i] = o.gravity ?? 0;
        drag[i] = o.drag ?? 0.9;
        stretch[i] = o.stretch ?? 0;
        const t = Math.random();
        baseColor[i * 3] = THREE.MathUtils.lerp(tmpColor.r, tmpColor2.r, t);
        baseColor[i * 3 + 1] = THREE.MathUtils.lerp(tmpColor.g, tmpColor2.g, t);
        baseColor[i * 3 + 2] = THREE.MathUtils.lerp(tmpColor.b, tmpColor2.b, t);
      }
    },
    ambient(enabled) {
      ambientOn = enabled;
    },
    update(dt) {
      if (ambientOn) {
        ambientAcc += dt * 9;
        while (ambientAcc >= 1) {
          ambientAcc -= 1;
          const a = Math.random() * Math.PI * 2;
          const r = 3 + Math.random() * 9;
          ambientAt.set(Math.cos(a) * r, 0.1 + Math.random() * 0.4, Math.sin(a) * r);
          this.burst(ambientAt, { count: 1, color: ambientColor, speed: 0.35, lifeMs: 4200, size: 0.05, gravity: -0.12, drag: 0.999, spread: 1 });
        }
      }
      camera.getWorldQuaternion(camQ);
      camInverse.copy(camQ).invert();
      for (let i = 0; i < alive; ) {
        life[i] = life[i]! - dt;
        if (life[i]! <= 0) {
          kill(i);
          continue;
        }
        const d = Math.pow(drag[i]!, dt * 60);
        vel[i * 3] = vel[i * 3]! * d;
        vel[i * 3 + 1] = (vel[i * 3 + 1]! - grav[i]! * dt) * d;
        vel[i * 3 + 2] = vel[i * 3 + 2]! * d;
        pos[i * 3] = pos[i * 3]! + vel[i * 3]! * dt;
        pos[i * 3 + 1] = Math.max(0.02, pos[i * 3 + 1]! + vel[i * 3 + 1]! * dt);
        pos[i * 3 + 2] = pos[i * 3 + 2]! + vel[i * 3 + 2]! * dt;
        const k = life[i]! / maxLife[i]!;
        const fade = k < 0.7 ? k / 0.7 : 1;
        p.set(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!);
        const sz = size[i]! * (0.4 + 0.6 * fade);
        if (stretch[i]! > 0) {
          v.set(vel[i * 3]!, vel[i * 3 + 1]!, vel[i * 3 + 2]!);
          const speed = v.length();
          if (speed > 1e-4) {
            // Billboard spun about the view axis so the quad's long side follows the on-screen velocity (sparks read as streaks).
            v.applyQuaternion(camInverse);
            spin.setFromAxisAngle(zAxis, Math.atan2(v.y, v.x));
            q.copy(camQ).multiply(spin);
            s.set(sz + speed * stretch[i]! * 0.06, sz * 0.6, sz);
            m.compose(p, q, s);
          } else m.compose(p, camQ, s.set(sz, sz, sz));
        } else m.compose(p, camQ, s.set(sz, sz, sz));
        mesh.setMatrixAt(i, m);
        colors[i * 3] = baseColor[i * 3]! * fade;
        colors[i * 3 + 1] = baseColor[i * 3 + 1]! * fade;
        colors[i * 3 + 2] = baseColor[i * 3 + 2]! * fade;
        i += 1;
      }
      mesh.count = alive;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
