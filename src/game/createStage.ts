import * as THREE from "three";
import { addOutline, createToonMaterial } from "./materials";
import type { NemesisSpec } from "../spec";

export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  player: THREE.Group;
  boss: THREE.Group;
  applySpec(spec: NemesisSpec): void;
  update(dt: number, input: { x: number; z: number }): void;
  dispose(): void;
}

export const ARENA_RADIUS = 9;

export function createStage(canvas: HTMLCanvasElement): Stage {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05060a);
  scene.fog = new THREE.FogExp2(0x05060a, 0.035);

  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);

  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(6, 12, 4);
  scene.add(key, new THREE.AmbientLight(0x404060, 1.2));
  const rim = new THREE.PointLight(0x7fdcff, 40, 60);
  rim.position.set(0, 6, -8);
  scene.add(rim);

  // Shattered platform floating in the void: a low-poly disc with a glowing fracture ring at its edge.
  const platform = new THREE.Mesh(new THREE.CylinderGeometry(ARENA_RADIUS, ARENA_RADIUS * 0.85, 1.2, 14, 1), createToonMaterial(0x14161f));
  platform.position.y = -0.6;
  addOutline(platform, 0.015);
  const fracture = new THREE.Mesh(new THREE.TorusGeometry(ARENA_RADIUS, 0.06, 6, 48), new THREE.MeshBasicMaterial({ color: 0x7fdcff }));
  fracture.rotation.x = Math.PI / 2;
  fracture.position.y = 0.02;
  scene.add(platform, fracture);

  const player = new THREE.Group();
  const cloak = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.9, 7), createToonMaterial(0x1c1c26));
  cloak.position.y = 0.95;
  addOutline(cloak);
  const hood = new THREE.Mesh(new THREE.SphereGeometry(0.32, 10, 8), createToonMaterial(0x0b0b10));
  hood.position.y = 1.95;
  addOutline(hood);
  player.add(cloak, hood);
  scene.add(player);

  const boss = new THREE.Group();
  boss.position.set(0, 0, -5);
  scene.add(boss);

  const applySpec = (spec: NemesisSpec) => {
    boss.clear();
    const [, accent, deep] = spec.identity.palette;
    const height = spec.identity.silhouette === "colossus" ? 4.5 : spec.identity.silhouette === "hound" ? 1.6 : 3;
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.9, height - 1.8, 6, 10), createToonMaterial(deep, new THREE.Color(accent).multiplyScalar(0.15)));
    body.position.y = height / 2;
    addOutline(body, 0.05);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 8), new THREE.MeshBasicMaterial({ color: accent }));
    eye.position.set(0, height * 0.8, 0.85);
    boss.add(body, eye);
    (fracture.material as THREE.MeshBasicMaterial).color.set(accent);
    rim.color.set(accent);
  };

  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", resize);
  resize();

  const toBoss = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const update = (dt: number, input: { x: number; z: number }) => {
    // Camera-relative movement keeps controls readable in an over-the-shoulder lock-on view.
    toBoss.subVectors(boss.position, player.position).setY(0);
    const dist = toBoss.length() || 1;
    toBoss.divideScalar(dist);
    const right = new THREE.Vector3(-toBoss.z, 0, toBoss.x);
    player.position.addScaledVector(toBoss, input.z * 6 * dt).addScaledVector(right, input.x * 6 * dt);
    const radial = player.position.length();
    if (radial > ARENA_RADIUS - 0.8) player.position.multiplyScalar((ARENA_RADIUS - 0.8) / radial);
    player.lookAt(boss.position.x, 0, boss.position.z);
    boss.lookAt(player.position.x, 0, player.position.z);

    desired.copy(player.position).addScaledVector(toBoss, -4.2).add(right.multiplyScalar(1.2)).setY(2.6);
    camera.position.lerp(desired, 1 - Math.exp(-dt * 8));
    camera.lookAt(boss.position.x, 1.8, boss.position.z);
    renderer.render(scene, camera);
  };

  return {
    renderer, scene, camera, player, boss, applySpec, update,
    dispose: () => { window.removeEventListener("resize", resize); renderer.dispose(); },
  };
}
