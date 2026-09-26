import * as THREE from "three";
import { addOutline, createToonMaterial } from "./materials";
import { createHazardView } from "./hazardView";
import type { NemesisSpec } from "../spec";
import { ARENA_RADIUS, type BattleEvent, type BattleState } from "../sim";

export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  applySpec(spec: NemesisSpec): void;
  /** Swap the void for a generated equirectangular sky; null restores the flat void. */
  setSky(url: string | null): void;
  /** Mirror sim state into the scene, react to this frame's events, and render. */
  render(dt: number, state: BattleState, events: readonly BattleEvent[]): void;
  dispose(): void;
}

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
  const cloakMat = createToonMaterial(0x1c1c26);
  const cloak = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.9, 7), cloakMat);
  cloak.position.y = 0.95;
  addOutline(cloak);
  const hood = new THREE.Mesh(new THREE.SphereGeometry(0.32, 10, 8), createToonMaterial(0x0b0b10));
  hood.position.y = 1.95;
  addOutline(hood);
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.6, 0.16), new THREE.MeshBasicMaterial({ color: 0xe9e4d8 }));
  blade.position.set(0.5, 1.2, 0.3);
  blade.rotation.z = -0.3;
  player.add(cloak, hood, blade);
  scene.add(player);

  const boss = new THREE.Group();
  scene.add(boss);
  let bossBodyMat: THREE.MeshToonMaterial | null = null;
  let bossBaseEmissive = new THREE.Color(0);
  let bossHeight = 3;
  let accent = new THREE.Color(0x7fdcff);

  const hazards = createHazardView(scene);

  const voidColor = new THREE.Color(0x05060a);
  const textureLoader = new THREE.TextureLoader().setCrossOrigin("anonymous");
  let skyTexture: THREE.Texture | null = null;
  const setSky = (url: string | null) => {
    skyTexture?.dispose();
    skyTexture = null;
    if (!url) { scene.background = voidColor; return; }
    textureLoader.load(url, (texture) => {
      texture.mapping = THREE.EquirectangularReflectionMapping;
      texture.colorSpace = THREE.SRGBColorSpace;
      skyTexture = texture;
      scene.background = texture;
      scene.backgroundIntensity = 0.8;
    });
  };

  const applySpec = (spec: NemesisSpec) => {
    boss.clear();
    const [, accentHex, deep] = spec.identity.palette;
    accent = new THREE.Color(accentHex);
    bossHeight = spec.identity.silhouette === "colossus" ? 4.5 : spec.identity.silhouette === "hound" ? 1.6 : 3;
    bossBaseEmissive = accent.clone().multiplyScalar(0.15);
    bossBodyMat = createToonMaterial(deep, bossBaseEmissive);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.9, bossHeight - 1.8, 6, 10), bossBodyMat);
    body.position.y = bossHeight / 2;
    addOutline(body, 0.05);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 8), new THREE.MeshBasicMaterial({ color: accent }));
    eye.position.set(0, bossHeight * 0.8, 0.85);
    boss.add(body, eye);
    fracture.material.color.copy(accent);
    rim.color.copy(accent);
    hazards.setAccent(accentHex);
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
  const shakeOffset = new THREE.Vector3();
  let shake = 0;
  let first = true;

  const render = (dt: number, state: BattleState, events: readonly BattleEvent[]) => {
    for (const e of events) {
      if (e.type === "playerHit") shake = Math.max(shake, 0.35);
      if (e.type === "bossHit") shake = Math.max(shake, e.heavy ? 0.25 : 0.1);
      if (e.type === "phaseChange") shake = Math.max(shake, 0.6);
      if (e.type === "moveActive" && (e.move === "nova" || e.move === "charge")) shake = Math.max(shake, 0.2);
    }

    const p = state.player;
    const b = state.boss;
    player.position.set(p.pos.x, 0, p.pos.z);
    boss.position.set(b.pos.x, 0, b.pos.z);
    player.rotation.y = Math.atan2(p.facing.x, p.facing.z);
    boss.rotation.y = Math.atan2(b.facing.x, b.facing.z);

    // Body language from sim timing: rolls tilt the cloak, attacks swing the blade, telegraphs rear the boss back.
    cloak.rotation.x = p.action === "roll" ? Math.sin((p.actionT / 400) * Math.PI) * 0.8 : 0;
    const attackT = p.action === "light" || p.action === "heavy" ? p.actionT / (p.action === "heavy" ? 1060 : 480) : 0;
    blade.rotation.x = attackT > 0 ? -1.4 + Math.sin(attackT * Math.PI) * 2.6 : 0;
    const telegraphT = b.current?.phase === "telegraph" ? b.current.t / b.current.telegraphMs : 0;
    boss.scale.setScalar(b.staggerT > 0 ? 0.92 : 1 + telegraphT * 0.12);
    boss.rotation.x = b.staggerT > 0 ? 0.35 : -telegraphT * 0.25;
    boss.position.y = b.invulnerableT > 0 ? Math.sin(state.timeMs / 90) * 0.15 + 0.4 : 0;

    cloakMat.emissive.setRGB(p.hitFlash / 200, 0.05 * (p.hitFlash / 200), 0.08 * (p.hitFlash / 200));
    if (bossBodyMat) {
      bossBodyMat.emissive.copy(bossBaseEmissive);
      if (b.hitFlash > 0) bossBodyMat.emissive.lerp(new THREE.Color(0xffffff), b.hitFlash / 120);
      if (b.weaknessT > 0) bossBodyMat.emissive.lerp(new THREE.Color(0xffd166), 0.4 + 0.3 * Math.sin(state.timeMs / 60));
    }

    hazards.sync(state);

    toBoss.subVectors(boss.position, player.position).setY(0);
    const dist = toBoss.length() || 1;
    toBoss.divideScalar(dist);
    const right = new THREE.Vector3(-toBoss.z, 0, toBoss.x);
    desired.copy(player.position).addScaledVector(toBoss, -4.6).addScaledVector(right, 1.3).setY(2.8);
    if (first) { camera.position.copy(desired); first = false; }
    camera.position.lerp(desired, 1 - Math.exp(-dt * 7));
    shake = Math.max(0, shake - dt * 2.2);
    shakeOffset.set((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, 0).multiplyScalar(0.6);
    camera.position.add(shakeOffset);
    camera.lookAt(boss.position.x, Math.min(bossHeight * 0.55, 2.2), boss.position.z);
    renderer.render(scene, camera);
  };

  return {
    renderer, scene, camera, applySpec, setSky, render,
    dispose: () => { window.removeEventListener("resize", resize); renderer.dispose(); },
  };
}
