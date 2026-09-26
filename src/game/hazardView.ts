import * as THREE from "three";
import { previewShape, type BattleState, type HazardShape } from "../sim";

const Y = 0.05;

/** Draws telegraph decals, live hitboxes and projectiles from sim state. Meshes are pooled per frame. */
export function createHazardView(scene: THREE.Scene) {
  const group = new THREE.Group();
  scene.add(group);
  const pool: THREE.Mesh[] = [];
  let used = 0;
  const telegraphMat = new THREE.MeshBasicMaterial({ color: 0xff3b5c, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false });
  const activeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false });
  const zoneMat = new THREE.MeshBasicMaterial({ color: 0xff3b5c, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false });
  const projectileMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const unit = {
    disc: new THREE.CircleGeometry(1, 40),
    ring: new THREE.RingGeometry(0.5, 1, 48),
    quad: new THREE.PlaneGeometry(1, 1),
    sphere: new THREE.SphereGeometry(1, 10, 8),
  };

  const take = (geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh => {
    let mesh = pool[used];
    if (!mesh) { mesh = new THREE.Mesh(); pool.push(mesh); group.add(mesh); }
    used += 1;
    mesh.geometry = geometry;
    mesh.material = material;
    mesh.visible = true;
    mesh.rotation.set(0, 0, 0);
    mesh.scale.set(1, 1, 1);
    return mesh;
  };

  const place = (shape: HazardShape, material: THREE.Material) => {
    switch (shape.kind) {
      case "circle": {
        const m = take(unit.disc, material);
        m.position.set(shape.center.x, Y, shape.center.z);
        m.rotation.x = -Math.PI / 2;
        m.scale.setScalar(shape.radius);
        break;
      }
      case "arc": {
        const geometry = new THREE.CircleGeometry(1, 32, -shape.halfAngle, shape.halfAngle * 2);
        const m = take(geometry, material);
        m.position.set(shape.center.x, Y, shape.center.z);
        m.rotation.x = -Math.PI / 2;
        // CircleGeometry starts at +X; rotate so the arc centre points along dir (x, z) on the ground plane.
        m.rotation.z = -Math.atan2(shape.dir.z, shape.dir.x);
        m.scale.setScalar(shape.radius);
        m.userData.disposable = geometry;
        break;
      }
      case "line": {
        const m = take(unit.quad, material);
        m.position.set(shape.start.x + (shape.dir.x * shape.length) / 2, Y, shape.start.z + (shape.dir.z * shape.length) / 2);
        m.rotation.x = -Math.PI / 2;
        m.rotation.z = -Math.atan2(shape.dir.z, shape.dir.x);
        m.scale.set(shape.length, shape.halfWidth * 2, 1);
        break;
      }
      case "ring": {
        const m = take(unit.ring, material);
        m.position.set(shape.center.x, Y, shape.center.z);
        m.rotation.x = -Math.PI / 2;
        const outer = shape.radius + shape.thickness / 2;
        const inner = Math.max(0.01, shape.radius - shape.thickness / 2);
        // unit ring spans 0.5..1; scale so outer=outer, and the inner edge lands roughly at inner.
        m.scale.setScalar(outer);
        m.scale.z = 1;
        m.userData.inner = inner;
        break;
      }
    }
  };

  const sync = (state: BattleState) => {
    for (const mesh of pool) {
      const disposable = mesh.userData.disposable as THREE.BufferGeometry | undefined;
      if (disposable) { disposable.dispose(); delete mesh.userData.disposable; }
    }
    used = 0;
    const current = state.boss.current;
    if (current?.phase === "telegraph") {
      const shape = previewShape(current, state.boss);
      if (shape) {
        telegraphMat.opacity = 0.18 + 0.25 * (current.t / current.telegraphMs);
        place(shape, telegraphMat);
      }
    }
    for (const h of state.hazards) place(h.shape, h.repeat ? zoneMat : activeMat);
    for (const p of state.projectiles) {
      const m = take(unit.sphere, projectileMat);
      m.position.set(p.pos.x, 1.2, p.pos.z);
      m.scale.setScalar(p.radius);
    }
    for (let i = used; i < pool.length; i += 1) { const m = pool[i]; if (m) m.visible = false; }
  };

  const setAccent = (hex: string) => {
    telegraphMat.color.set(hex);
    zoneMat.color.set(hex);
  };

  return { sync, setAccent };
}
