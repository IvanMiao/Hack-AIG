import * as THREE from "three";
import { addOutline, createToonMaterial, RIM } from "./materials";
import { instantiate, loadAssetLibrary, type AssetLibrary } from "./assets";
import { createHazardView } from "./hazardView";
import { createPostFX, DEFAULT_POST, type PostSettings } from "./fx/post";
import { createParticles } from "./fx/particles";
import { DEFAULT_PALETTE, resolvePalette, type Palette } from "./render/palette";
import { nextCameraYaw } from "./cameraFollow";
import type { NemesisSpec } from "../spec";
import { ARENA_RADIUS, BOSS, PLAYER, moveTiming, type BattleEvent, type BattleState, type Vec2 } from "../sim";
import skyUrl from "../../blender/art/textures/sky.jpg?url";

/** Everything the lab may retune live. Plain mutable objects so lil-gui can bind to them directly. */
export interface StageTuning {
  lights: {
    hemisphere: number;
    key: number;
    rim: number;
    fill: number;
    heroLamp: number;
    /** Warm accent pool on the arena centre. */
    pool: number;
    poolRadius: number;
  };
  rim: { strength: number; power: number };
  fog: { density: number };
  camera: { fov: number; distance: number; side: number; height: number; lag: number; shake: number; punch: number };
  fx: { particles: boolean; ambient: boolean };
  post: PostSettings;
}

export interface StageDebug {
  /** Draw player/boss collision radii and the player's attack reach. */
  hitboxes: boolean;
  /** Freeze the auto camera so an external controller (orbit) may drive it. */
  freeCamera: boolean;
}

export const DEFAULT_TUNING = (): StageTuning => ({
  lights: { hemisphere: 1.35, key: 3.6, rim: 3.4, fill: 1.5, heroLamp: 14, pool: 420, poolRadius: 9 },
  rim: { strength: 0.85, power: 3.2 },
  fog: { density: 0.022 },
  camera: { fov: 55, distance: 6.8, side: 4.2, height: 4.6, lag: 8, shake: 0.6, punch: 1 },
  fx: { particles: true, ambient: true },
  post: { ...DEFAULT_POST },
});

export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  ready: Promise<void>;
  tuning: StageTuning;
  debug: StageDebug;
  /** The hand-tuned palette currently applied (derived from the spec's element + accent). */
  palette(): Palette;
  applySpec(spec: NemesisSpec): void;
  /** Fetch the boss model for this spec (arena/player load eagerly; bosses stream in per silhouette). Resolves even if the model fails. */
  preloadBoss(spec: NemesisSpec, onProgress?: (fraction: number) => void): Promise<void>;
  setSky(url: string | null): void;
  setMode(mode: "attract" | "fight"): void;
  /** Map a screen-relative stick (x = right, z = forward) into world space using the current camera yaw. */
  cameraRelative(move: Vec2): Vec2;
  render(dt: number, state: BattleState, events: readonly BattleEvent[]): void;
  dispose(): void;
}

const BOSS_HEIGHTS: Record<NemesisSpec["identity"]["silhouette"], number> = {
  colossus: 4.5,
  hound: 2.1,
  seraph: 3.7,
  serpent: 3.4,
  knight: 3.5,
  swarm: 3.2,
};

interface ToonMaterialState {
  material: THREE.MeshToonMaterial;
  emissive: THREE.Color;
}

const clamp01 = (value: number) => THREE.MathUtils.clamp(value, 0, 1);
const easeOut = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
const easeIn = (t: number) => Math.pow(clamp01(t), 3);
const easeInOut = (t: number) => THREE.MathUtils.smoothstep(t, 0, 1);
/** 0 until `hold`, then eases to 1 by t = 1. Used so a pose is held for a beat before returning to rest. */
const holdThenEase = (t: number, hold: number) => easeInOut((clamp01(t) - hold) / (1 - hold));

interface PlayerPose {
  lean: number;
  twist: number;
  lunge: number;
  crouch: number;
  bladeX: number;
  bladeZ: number;
  slash: number;
  charge: number;
}

const REST_POSE: PlayerPose = { lean: 0, twist: 0, lunge: 0, crouch: 0, bladeX: 0, bladeZ: -0.3, slash: 0, charge: 0 };
const LIGHT_WINDUP: PlayerPose = { lean: -0.05, twist: -0.5, lunge: -0.08, crouch: 0.04, bladeX: -0.7, bladeZ: -1.8, slash: 0, charge: 0 };
const LIGHT_STRIKE: PlayerPose = { lean: 0.18, twist: 0.55, lunge: 0.42, crouch: 0.06, bladeX: 0.9, bladeZ: 1.7, slash: 1, charge: 0 };
const HEAVY_WINDUP: PlayerPose = { lean: -0.2, twist: -0.3, lunge: -0.15, crouch: 0.16, bladeX: -2.5, bladeZ: -0.9, slash: 0, charge: 1 };
const HEAVY_STRIKE: PlayerPose = { lean: 0.42, twist: 0.15, lunge: 0.6, crouch: 0.1, bladeX: 1.15, bladeZ: 0.25, slash: 1, charge: 0 };

const lerpPose = (out: PlayerPose, a: PlayerPose, b: PlayerPose, t: number): PlayerPose => {
  out.lean = THREE.MathUtils.lerp(a.lean, b.lean, t);
  out.twist = THREE.MathUtils.lerp(a.twist, b.twist, t);
  out.lunge = THREE.MathUtils.lerp(a.lunge, b.lunge, t);
  out.crouch = THREE.MathUtils.lerp(a.crouch, b.crouch, t);
  out.bladeX = THREE.MathUtils.lerp(a.bladeX, b.bladeX, t);
  out.bladeZ = THREE.MathUtils.lerp(a.bladeZ, b.bladeZ, t);
  out.slash = THREE.MathUtils.lerp(a.slash, b.slash, t);
  out.charge = THREE.MathUtils.lerp(a.charge, b.charge, t);
  return out;
};

/** Anticipate → snap → hold → settle. The strike snaps in the first half of the active window so the hit reads instantly. */
function attackPose(out: PlayerPose, actionT: number, attack: typeof PLAYER.light | typeof PLAYER.heavy, windup: PlayerPose, strike: PlayerPose): PlayerPose {
  if (actionT < attack.windupMs) return lerpPose(out, REST_POSE, windup, easeOut(actionT / attack.windupMs));
  const activeT = actionT - attack.windupMs;
  if (activeT < attack.activeMs) return lerpPose(out, windup, strike, easeOut((activeT / attack.activeMs) * 2));
  const recoverT = (activeT - attack.activeMs) / attack.recoverMs;
  lerpPose(out, strike, REST_POSE, holdThenEase(recoverT, 0.3));
  out.slash = 1 - THREE.MathUtils.smoothstep(recoverT, 0, 0.45);
  return out;
}

interface BossPose {
  lean: number;
  lunge: number;
  rise: number;
  stretch: number;
  squash: number;
  glow: number;
  /** Arm pivot angle about X (radians): 0 hangs at rest, -π/2 points forward, -2.3 is raised overhead. */
  swing: number;
  /** Head tilt: negative = reared back, positive = lunging forward/down. Also drives the swarm's contract/burst. */
  headTilt: number;
}

const BOSS_REST: BossPose = { lean: 0, lunge: 0, rise: 0, stretch: 1, squash: 1, glow: 0, swing: 0, headTilt: 0 };
const BOSS_COIL: BossPose = { lean: -0.3, lunge: -0.35, rise: 0.4, stretch: 1.06, squash: 1.1, glow: 1, swing: -2.3, headTilt: -0.5 };
const BOSS_MELEE_STRIKE: BossPose = { lean: 0.5, lunge: 1.1, rise: -0.1, stretch: 1.1, squash: 0.9, glow: 0, swing: -0.75, headTilt: 0.55 };
const BOSS_RANGED_STRIKE: BossPose = { lean: 0.22, lunge: 0.25, rise: 0.55, stretch: 1.14, squash: 0.96, glow: 0, swing: -1.45, headTilt: 0.3 };
const BOSS_STAGGER: BossPose = { lean: 0.42, lunge: -0.2, rise: -0.25, stretch: 1.04, squash: 0.9, glow: 0, swing: 0.35, headTilt: 0.6 };

const lerpBossPose = (out: BossPose, a: BossPose, b: BossPose, t: number): BossPose => {
  out.lean = THREE.MathUtils.lerp(a.lean, b.lean, t);
  out.lunge = THREE.MathUtils.lerp(a.lunge, b.lunge, t);
  out.rise = THREE.MathUtils.lerp(a.rise, b.rise, t);
  out.stretch = THREE.MathUtils.lerp(a.stretch, b.stretch, t);
  out.squash = THREE.MathUtils.lerp(a.squash, b.squash, t);
  out.glow = THREE.MathUtils.lerp(a.glow, b.glow, t);
  out.swing = THREE.MathUtils.lerp(a.swing, b.swing, t);
  out.headTilt = THREE.MathUtils.lerp(a.headTilt, b.headTilt, t);
  return out;
};

function bossPose(out: BossPose, boss: BattleState["boss"], timeMs: number): BossPose {
  if (boss.staggerT > 0) {
    lerpBossPose(out, BOSS_REST, BOSS_STAGGER, 1);
    out.lean += Math.sin(timeMs / 70) * 0.05;
    return out;
  }
  const current = boss.current;
  if (!current) return lerpBossPose(out, BOSS_REST, BOSS_REST, 0);
  const melee = current.move.type === "sweep" || current.move.type === "thrust" || current.move.type === "nova" || current.move.type === "charge";
  const strike = melee ? BOSS_MELEE_STRIKE : BOSS_RANGED_STRIKE;
  const timing = moveTiming(current.move.type);
  if (current.phase === "telegraph") {
    const u = current.t / current.telegraphMs;
    lerpBossPose(out, BOSS_REST, BOSS_COIL, easeIn(u) * 0.7 + easeOut(u) * 0.3);
    const tremble = THREE.MathUtils.smoothstep(u, 0.7, 1) * Math.sin(timeMs / 22) * 0.035;
    out.lean += tremble;
    out.swing += tremble * 2;
    out.glow = u * u;
    return out;
  }
  if (current.phase === "active") {
    const u = timing.activeMs > 0 ? current.t / timing.activeMs : 1;
    lerpBossPose(out, BOSS_COIL, strike, easeOut(u * 2.2));
    out.glow = 1 - u;
    return out;
  }
  const u = current.t / timing.recoverMs;
  // Ranged moves have no active window, so the swing snaps forward at the start of recovery.
  if (timing.activeMs === 0) {
    const snap = easeOut(u * 4);
    lerpBossPose(out, BOSS_COIL, strike, snap);
    if (snap >= 1) lerpBossPose(out, strike, BOSS_REST, holdThenEase(u, 0.4));
    return out;
  }
  lerpBossPose(out, strike, BOSS_REST, holdThenEase(u, 0.35));
  return out;
}

/**
 * Procedural boss rig: the GLBs are flat lists of named meshes, so we gather the striking limb and the head
 * into pivot groups and swing those from the sim's telegraph/active/recover windows.
 */
interface BossRig {
  strike: THREE.Group | null;
  head: THREE.Group | null;
  kind: "arm" | "head" | "burst";
}

const RIG_RULES: Record<NemesisSpec["identity"]["silhouette"], { strike: RegExp; head: RegExp | null; kind: BossRig["kind"] }> = {
  knight: { strike: /sword|pommel|crossguard|grip|gauntlet|forearm|upper arm/, head: /helm|visor|horn/, kind: "arm" },
  colossus: { strike: /arm|gauntlet|fist|finger|shoulder shard|shoulder mantle/, head: /skull|crown horn|eye/, kind: "arm" },
  seraph: { strike: /sword wing|wing blade|armoured arm|gauntlet/, head: /mask|eye|cheek/, kind: "arm" },
  hound: { strike: /skull|jaw|canine|tooth|maw|amber eye|neck/, head: null, kind: "head" },
  serpent: { strike: /skull|fang|hood|jaw|ember eye|neck/, head: null, kind: "head" },
  swarm: { strike: /shard|splinter/, head: /heart|core/, kind: "burst" },
};

const EMPTY_RIG: BossRig = { strike: null, head: null, kind: "arm" };

function gatherPivot(visual: THREE.Object3D, pattern: RegExp, anchor: "top" | "bottom" | "centre"): THREE.Group | null {
  const meshes: THREE.Mesh[] = [];
  visual.traverse((object) => {
    if (object instanceof THREE.Mesh && pattern.test(object.name.toLowerCase())) meshes.push(object);
  });
  const first = meshes[0];
  if (!first?.parent) return null;
  visual.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  for (const mesh of meshes) bounds.expandByObject(mesh);
  if (bounds.isEmpty()) return null;
  const pivotWorld = bounds.getCenter(new THREE.Vector3());
  if (anchor === "top") pivotWorld.y = bounds.max.y;
  if (anchor === "bottom") pivotWorld.y = bounds.min.y;
  const parent = first.parent;
  const pivot = new THREE.Group();
  pivot.name = "Procedural pivot";
  parent.add(pivot);
  pivot.position.copy(parent.worldToLocal(pivotWorld));
  pivot.updateMatrixWorld(true);
  for (const mesh of meshes) pivot.attach(mesh);
  return pivot;
}

function buildBossRig(visual: THREE.Object3D, silhouette: NemesisSpec["identity"]["silhouette"]): BossRig {
  const rule = RIG_RULES[silhouette];
  const strike = gatherPivot(visual, rule.strike, rule.kind === "arm" ? "top" : rule.kind === "head" ? "bottom" : "centre");
  const head = rule.head ? gatherPivot(visual, rule.head, "bottom") : null;
  return { strike, head, kind: rule.kind };
}

function makeSlashArc(): THREE.Mesh {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 16;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createLinearGradient(0, 0, 128, 0);
    gradient.addColorStop(0, "rgba(255,255,255,0)");
    gradient.addColorStop(0.35, "rgba(255,255,255,1)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 16);
  }
  const texture = new THREE.CanvasTexture(canvas);
  const arc = new THREE.Mesh(
    new THREE.RingGeometry(0.85, 1.55, 28, 1, -1.25, 2.5),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      alphaMap: texture,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  );
  arc.visible = false;
  return arc;
}

function makeImpactRing(): THREE.Mesh {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.72, 1, 40),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  ring.visible = false;
  return ring;
}

function disposeAssetLibrary(library: AssetLibrary): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  for (const gltf of [library.arena, library.player, ...Object.values(library.bosses)]) {
    if (!gltf) continue;
    gltf.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(material);
        const textured = material as THREE.MeshStandardMaterial;
        if (textured.map) textures.add(textured.map);
        if (textured.normalMap) textures.add(textured.normalMap);
      }
    });
  }
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}

function disposeGroup(group: THREE.Group): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    let ancestor: THREE.Object3D | null = object;
    let sharedGeometry = false;
    while (ancestor && ancestor !== group) {
      if (ancestor.userData.assetClone) sharedGeometry = true;
      ancestor = ancestor.parent;
    }
    if (!sharedGeometry) geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  group.clear();
}

function collectToonMaterials(root: THREE.Object3D, cloakOnly = false): ToonMaterialState[] {
  const found = new Map<string, ToonMaterialState>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const role = object.userData.materialRole as string | undefined;
    if (cloakOnly && role !== "cloth" && role !== "cloth_dark") return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!(material instanceof THREE.MeshToonMaterial) || found.has(material.uuid)) continue;
      found.set(material.uuid, { material, emissive: material.emissive.clone() });
    }
  });
  return [...found.values()];
}

function makeShadow(size: number): THREE.Mesh {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(32, 32, 3, 32, 32, 31);
    gradient.addColorStop(0, "rgba(0,0,0,0.62)");
    gradient.addColorStop(0.55, "rgba(0,0,0,0.3)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
  }
  const texture = new THREE.CanvasTexture(canvas);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, opacity: 0.8 }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.035;
  return shadow;
}

export function createStage(canvas: HTMLCanvasElement, tuning: StageTuning = DEFAULT_TUNING()): Stage {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = tuning.post.exposure;
  const debug: StageDebug = { hitboxes: false, freeCamera: false };

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x030309);
  const camera = new THREE.PerspectiveCamera(tuning.camera.fov, 1, 0.1, 240);
  camera.position.set(14, 7, 14);
  camera.lookAt(0, 1, 0);
  let palette: Palette = DEFAULT_PALETTE;
  const accent = new THREE.Color(palette.accent);
  const hot = new THREE.Color(palette.hot);
  const post = createPostFX(renderer, scene, camera, tuning.post);
  const particles = createParticles(camera, accent);
  scene.add(particles.object);
  const textureLoader = new THREE.TextureLoader().setCrossOrigin("anonymous");
  const prepareSkyTexture = (texture: THREE.Texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    texture.needsUpdate = true;
  };
  const staticSkyTexture = textureLoader.load(skyUrl, prepareSkyTexture);
  prepareSkyTexture(staticSkyTexture);
  let generatedSkyTexture: THREE.Texture | null = null;
  let skyRequest = 0;
  const skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      skyTexture: { value: staticSkyTexture },
      upper: { value: new THREE.Color("#030309") },
      horizon: { value: accent.clone().multiplyScalar(0.16) },
      accent: { value: accent },
    },
    vertexShader: `
      varying float skyHeight;
      varying vec2 skyUv;
      void main() {
        skyHeight = normalize(position).y;
        skyUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D skyTexture;
      uniform vec3 upper;
      uniform vec3 horizon;
      uniform vec3 accent;
      varying float skyHeight;
      varying vec2 skyUv;
      void main() {
        float imageV = skyHeight > 0.0
          ? mix(0.37, 1.0, skyHeight)
          : mix(0.0, 0.37, skyHeight + 1.0);
        vec3 image = texture2D(skyTexture, vec2(skyUv.x, imageV)).rgb;
        float light = dot(image, vec3(0.2126, 0.7152, 0.0722));
        // Wide smoothstep keeps cloud detail instead of crushing it to a two-tone print.
        float clouds = smoothstep(0.04, 1.15, light);
        // The upper sky goes back to near-black so the horizon glow reads as a band, not a wash.
        float zenith = smoothstep(0.12, 0.7, skyHeight);
        float band = exp(-pow((skyHeight + 0.03) * 5.5, 2.0));
        vec3 base = mix(upper, horizon, band * 0.3);
        vec3 tint = accent * mix(0.1, 0.5, light) * (1.0 - zenith * 0.85);
        vec3 sky = mix(base, tint, clouds) + accent * band * 0.12;
        // Sky colours are authored as display values; the composer treats this as linear, so decode.
        gl_FragColor = vec4(pow(max(sky, 0.0), vec3(2.2)), 1.0);
      }
    `,
  });
  const skyDome = new THREE.Mesh(new THREE.SphereGeometry(150, 32, 20), skyMaterial);
  scene.add(skyDome);
  scene.fog = new THREE.FogExp2(0x12091d, 0.018);

  const starPositions = new Float32Array(900 * 3);
  let randomSeed = 4217;
  const random = () => {
    randomSeed = (randomSeed * 16807) % 2147483647;
    return randomSeed / 2147483647;
  };
  for (let i = 0; i < starPositions.length; i += 3) {
    const angle = random() * Math.PI * 2;
    const height = random() * 2 - 1;
    const radius = Math.sqrt(1 - height * height) * 105;
    starPositions[i] = Math.cos(angle) * radius;
    starPositions[i + 1] = height * 105;
    starPositions[i + 2] = Math.sin(angle) * radius;
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
  scene.add(new THREE.Points(starGeometry, new THREE.PointsMaterial({
    color: 0xc6c2d5, size: 0.16, sizeAttenuation: true, transparent: true, opacity: 0.76,
  })));

  const emberPositions = new Float32Array(96 * 3);
  const emberSpeeds = new Float32Array(96);
  for (let i = 0; i < emberPositions.length; i += 3) {
    const angle = random() * Math.PI * 2;
    const radius = 5 + random() * 18;
    emberPositions[i] = Math.cos(angle) * radius;
    emberPositions[i + 1] = random() * 14 - 3;
    emberPositions[i + 2] = Math.sin(angle) * radius;
    emberSpeeds[i / 3] = 0.15 + random() * 0.45;
  }
  const emberGeometry = new THREE.BufferGeometry();
  emberGeometry.setAttribute("position", new THREE.BufferAttribute(emberPositions, 3));
  const emberMaterial = new THREE.PointsMaterial({
    color: accent, size: 0.12, sizeAttenuation: true, transparent: true, opacity: 0.7,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  scene.add(new THREE.Points(emberGeometry, emberMaterial));

  const hemisphere = new THREE.HemisphereLight(0xaab8df, 0x3a3150, tuning.lights.hemisphere);
  const key = new THREE.DirectionalLight(0xf1e8db, tuning.lights.key);
  key.position.set(2, 11, 8);
  key.target.position.set(0, 1, 0);
  const rim = new THREE.DirectionalLight(accent, tuning.lights.rim);
  rim.position.set(0, 8, -13);
  rim.target.position.set(0, 1, -1);
  // Camera-following fill so the hero is lit from the viewer's side no matter where the fight circles.
  const fill = new THREE.DirectionalLight(0xe4e9ff, tuning.lights.fill);
  fill.target.position.set(0, 1, 0);
  const heroLamp = new THREE.PointLight(0xfff1dc, tuning.lights.heroLamp, 7, 2);
  heroLamp.position.set(0.6, 3.2, -0.4);
  // Warm pool over the arena centre: the floor reads brightest where the fight is and falls into fog at the rim.
  const pool = new THREE.SpotLight(0xffe2c0, tuning.lights.pool, 26, 0.62, 0.85, 1.6);
  pool.position.set(0, 13, 0);
  pool.target.position.set(0, 0, 0);
  scene.add(hemisphere, key, key.target, rim, rim.target, fill, fill.target, pool, pool.target);

  const arenaRoot = new THREE.Group();
  arenaRoot.name = "Arena";
  scene.add(arenaRoot);
  const fallbackPlatform = new THREE.Mesh(
    new THREE.CylinderGeometry(ARENA_RADIUS, ARENA_RADIUS * 0.85, 1.2, 14, 1),
    createToonMaterial(0x14161f, 0x000000, { rim: 0 }),
  );
  fallbackPlatform.position.y = -0.6;
  addOutline(fallbackPlatform, 0.015);
  const fracture = new THREE.Mesh(
    new THREE.TorusGeometry(ARENA_RADIUS, 0.06, 6, 48),
    new THREE.MeshBasicMaterial({
      color: accent,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  );
  fracture.rotation.x = Math.PI / 2;
  fracture.position.y = 0.02;
  arenaRoot.add(fallbackPlatform, fracture);
  // Hairline fractures in the slab glow faintly in the accent colour.
  const floorCrackMaterial = new THREE.MeshBasicMaterial({ color: accent.clone().multiplyScalar(0.5), toneMapped: false });
  // Radial vignette that sinks the platform rim into the fog instead of ending on a lit edge.
  const edgeFadeMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { fogTint: { value: new THREE.Color(0x05040a) } },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: `
      uniform vec3 fogTint;
      varying vec2 vUv;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float fade = smoothstep(0.62, 1.0, r);
        gl_FragColor = vec4(pow(fogTint, vec3(2.2)), fade * 0.92);
      }
    `,
  });
  const edgeFade = new THREE.Mesh(new THREE.CircleGeometry(ARENA_RADIUS * 1.25, 64), edgeFadeMaterial);
  edgeFade.rotation.x = -Math.PI / 2;
  edgeFade.position.y = 0.035;
  edgeFade.renderOrder = 1;

  const player = new THREE.Group();
  const playerVisualPivot = new THREE.Group();
  player.add(playerVisualPivot);
  const fallbackCloak = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.9, 7), createToonMaterial(0x4a4c60, 0x141626));
  fallbackCloak.name = "Fallback cloak";
  fallbackCloak.userData.materialRole = "cloth";
  fallbackCloak.position.y = 0.95;
  addOutline(fallbackCloak);
  const fallbackHood = new THREE.Mesh(new THREE.SphereGeometry(0.32, 10, 8), createToonMaterial(0x2a2b3a, 0x141626));
  fallbackHood.name = "Fallback hood";
  fallbackHood.userData.materialRole = "cloth_dark";
  fallbackHood.position.y = 1.95;
  addOutline(fallbackHood);
  const fallbackFace = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), createToonMaterial(0x030308));
  fallbackFace.position.set(0, 1.94, 0.25);
  const fallbackEyes = new THREE.Mesh(
    new THREE.SphereGeometry(0.035, 6, 4),
    new THREE.MeshBasicMaterial({ color: 0xe9e4d8, toneMapped: false }),
  );
  fallbackEyes.position.set(0, 1.96, 0.415);
  const fallbackChain = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.025, 5, 8), createToonMaterial(0x5a5f6e));
  fallbackChain.position.set(0.56, 0.55, 0.12);
  playerVisualPivot.add(fallbackCloak, fallbackHood, fallbackFace, fallbackEyes, fallbackChain);
  player.add(heroLamp);
  const slashArc = makeSlashArc();
  const impactRing = makeImpactRing();
  player.add(slashArc, impactRing);
  scene.add(player);
  let bladePivot: THREE.Group | null = null;
  let bladeMaterial: THREE.MeshToonMaterial | null = null;

  const boss = new THREE.Group();
  const bossVisualPivot = new THREE.Group();
  boss.add(bossVisualPivot);
  boss.position.set(0, 0, -5);
  scene.add(boss);
  const playerShadow = makeShadow(2.3);
  const bossShadow = makeShadow(4.4);
  scene.add(playerShadow, bossShadow);
  const hazards = createHazardView(scene);

  // Debug overlay: collision radii + player reach. Only drawn when debug.hitboxes is on.
  const debugMaterial = new THREE.LineBasicMaterial({ color: 0x4dff88, transparent: true, opacity: 0.9, depthTest: false, toneMapped: false });
  const debugReachMaterial = new THREE.LineBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.9, depthTest: false, toneMapped: false });
  const makeCircle = (radius: number, material: THREE.LineBasicMaterial) => {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= 48; i += 1) {
      const a = (i / 48) * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(a) * radius, 0.05, Math.sin(a) * radius));
    }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material);
    line.renderOrder = 50;
    line.visible = false;
    return line;
  };
  const playerRadiusLine = makeCircle(PLAYER.radius, debugMaterial);
  const bossRadiusLine = makeCircle(BOSS.radius, debugMaterial);
  const meleeRangeLine = makeCircle(BOSS.meleeRange, debugReachMaterial);
  meleeRangeLine.material = new THREE.LineDashedMaterial({ color: 0xffd166, dashSize: 0.3, gapSize: 0.25, transparent: true, opacity: 0.45, depthTest: false, toneMapped: false });
  meleeRangeLine.computeLineDistances();
  const reachLine = makeCircle(1, debugReachMaterial);
  scene.add(playerRadiusLine, bossRadiusLine, meleeRangeLine, reachLine);
  let fovPunch = 0;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let mode: "attract" | "fight" = "attract";
  let disposed = false;
  let elapsed = 0;
  let currentSpec: NemesisSpec | null = null;
  let library: AssetLibrary | null = null;
  let playerMixer: THREE.AnimationMixer | null = null;
  let bossMixer: THREE.AnimationMixer | null = null;
  let playerMaterials: ToonMaterialState[] = [];
  let bossMaterials: ToonMaterialState[] = [];
  let playerSpeed = 0;
  let bossSpawn = 1;
  let attractAngle = 0;
  let first = true;
  let cameraYaw: number | null = null;
  let shake = 0;
  const shakeOffset = new THREE.Vector3();
  const toBoss = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const lastPlayerPosition = new THREE.Vector3();
  const pose: PlayerPose = { ...REST_POSE };
  const bossPoseNow: BossPose = { ...BOSS_REST };
  let bossRig: BossRig = EMPTY_RIG;
  const rollAxis = new THREE.Vector3();
  const rollQuaternion = new THREE.Quaternion();
  const poseQuaternion = new THREE.Quaternion();
  const poseEuler = new THREE.Euler();
  const rollCentre = new THREE.Vector3();
  const cameraForward = new THREE.Vector3();
  const lookTarget = new THREE.Vector3();
  const burstAt = new THREE.Vector3();
  const burstDir = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  let lastActionT = 0;
  let impactT = 1;
  let runeGroup: THREE.Group | null = null;
  let sigilMaterial: THREE.MeshBasicMaterial | null = null;
  interface Debris { object: THREE.Object3D; baseY: number; phase: number; spin: THREE.Vector3 }
  let debris: Debris[] = [];
  const debrisEdgeMaterial = new THREE.MeshBasicMaterial({ color: accent.clone().multiplyScalar(0.28), side: THREE.BackSide, toneMapped: false });

  const createBlade = () => {
    const pivot = new THREE.Group();
    pivot.name = "Bone blade attack";
    pivot.position.set(0.47, 0.9, 0.12);
    bladeMaterial = createToonMaterial("#d9d2c3");
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.12, 0.08), bladeMaterial);
    blade.position.y = 0.48;
    addOutline(blade, 0.012);
    pivot.add(blade);
    return pivot;
  };

  bladePivot = createBlade();
  playerVisualPivot.add(bladePivot);
  playerMaterials = collectToonMaterials(playerVisualPivot, true);

  const installArena = () => {
    if (!library) return;
    disposeGroup(arenaRoot);
    const visual = instantiate(library.arena, ["#25212d", accent.getStyle(), "#25212d"], { outline: 0.012 });
    arenaRoot.add(visual);
    visual.updateMatrixWorld(true);
    const runes = new THREE.Group();
    runes.name = "Rotating sigil";
    visual.add(runes);
    const runeMeshes: THREE.Object3D[] = [];
    const debrisList: Debris[] = [];
    sigilMaterial = null;
    visual.traverse((object) => {
      const name = object.name.toLowerCase();
      if (object !== runes && (name.includes("runic") || name.includes("sigil"))) runeMeshes.push(object);
      if (name.includes("sigil") && object instanceof THREE.Mesh && object.material instanceof THREE.MeshBasicMaterial) {
        sigilMaterial = object.material;
      }
      if (!(object instanceof THREE.Mesh)) return;
      // The walkable slab is the one big lit surface; keep it deep blue-grey so the hero and decals carry the light.
      if (name.includes("walkable") || name.includes("floor slab")) {
        const source = object.material instanceof THREE.MeshToonMaterial ? object.material : null;
        object.material = createToonMaterial(palette.floor, 0x04050b, { map: source?.map ?? undefined, normalMap: source?.normalMap ?? undefined, rim: 0 });
        object.userData.materialRole = "floor";
      }
      if (name.includes("hairline floor fracture")) {
        object.material = floorCrackMaterial;
        object.userData.materialRole = "floor_crack";
        object.position.y += 0.01;
      }
      // Floating shards read as deliberate once they drift, turn slowly and carry a faint accent rim.
      if (name.includes("floating debris")) {
        for (const child of object.children) {
          if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial && child.material.side === THREE.BackSide) {
            child.material = debrisEdgeMaterial;
            child.scale.setScalar(1.05);
          }
        }
        debrisList.push({
          object,
          baseY: object.position.y,
          phase: debrisList.length * 1.7,
          spin: new THREE.Vector3(0.05 + (debrisList.length % 3) * 0.03, 0.08 + (debrisList.length % 4) * 0.02, 0.03).multiplyScalar(debrisList.length % 2 ? 1 : -1),
        });
      }
    });
    for (const object of runeMeshes) runes.attach(object);
    runeGroup = runes;
    debris = debrisList;
    arenaRoot.add(edgeFade);
  };

  const installPlayer = () => {
    if (!library) return;
    playerMixer?.stopAllAction();
    disposeGroup(playerVisualPivot);
    const visual = instantiate(library.player, ["#0b0b10", "#e9e4d8", "#3c3e50"], { player: true, outline: 0.016 });
    playerVisualPivot.add(visual);
    bladePivot = createBlade();
    playerVisualPivot.add(bladePivot);
    playerMaterials = collectToonMaterials(visual, true);
    playerMixer = new THREE.AnimationMixer(visual);
    const clip = library.player.animations[0];
    if (clip) playerMixer.clipAction(clip).setLoop(THREE.LoopRepeat, Infinity).play();
  };

  const installBoss = (spec: NemesisSpec, keepSpawn = false) => {
    const spawnBefore = bossSpawn;
    bossMixer?.stopAllAction();
    disposeGroup(bossVisualPivot);
    bossMaterials = [];
    const asset = library?.bosses[spec.identity.silhouette];
    if (asset) {
      const visual = instantiate(asset, spec.identity.palette, { outline: 0.024 });
      bossVisualPivot.add(visual);
      bossRig = buildBossRig(visual, spec.identity.silhouette);
      bossMaterials = collectToonMaterials(visual);
      bossMixer = new THREE.AnimationMixer(visual);
      const clip = asset.animations[0];
      if (clip) bossMixer.clipAction(clip).setLoop(THREE.LoopRepeat, Infinity).play();
    } else {
      bossRig = EMPTY_RIG;
      const [, accentHex, deepHex] = spec.identity.palette;
      const height = BOSS_HEIGHTS[spec.identity.silhouette];
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.9, Math.max(0.1, height - 1.8), 6, 10),
        createToonMaterial(deepHex, new THREE.Color(accentHex).multiplyScalar(0.15)),
      );
      body.position.y = height / 2;
      addOutline(body, 0.05);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 8), new THREE.MeshBasicMaterial({ color: accentHex, toneMapped: false }));
      eye.position.set(0, height * 0.8, 0.85);
      bossVisualPivot.add(body, eye);
      bossMaterials = collectToonMaterials(bossVisualPivot);
    }
    bossSpawn = keepSpawn ? spawnBefore : 0;
    if (!keepSpawn) {
      bossVisualPivot.scale.setScalar(0.08);
      bossVisualPivot.position.y = -2.1;
    }
  };

  const preloadBoss = async (spec: NemesisSpec, onProgress?: (fraction: number) => void) => {
    await ready;
    if (!library || disposed) return;
    const { silhouette } = spec.identity;
    const hadModel = !!library.bosses[silhouette];
    try {
      await library.loadBoss(silhouette, onProgress);
    } catch (error) {
      console.warn(`Nemesis ${silhouette} model could not be loaded; keeping the procedural stand-in.`, error);
      return;
    }
    // The stand-in may already be on stage; swap the real model in without replaying the spawn.
    if (!disposed && !hadModel && currentSpec?.identity.silhouette === silhouette) installBoss(currentSpec, true);
  };

  const applyAccent = (spec: NemesisSpec) => {
    palette = resolvePalette(spec);
    const color = new THREE.Color(palette.accent);
    accent.copy(color);
    hot.set(palette.hot);
    RIM.color.value.set(palette.rim);
    (skyMaterial.uniforms.accent!.value as THREE.Color).copy(color);
    (skyMaterial.uniforms.horizon!.value as THREE.Color).copy(color).multiplyScalar(0.16);
    (skyMaterial.uniforms.upper!.value as THREE.Color).set(palette.bg);
    if (scene.background instanceof THREE.Color) scene.background.set(palette.bg);
    emberMaterial.color.copy(color);
    rim.color.set(palette.rim);
    pool.color.copy(color).lerp(new THREE.Color(0xffe2c0), 0.6);
    const fogColor = new THREE.Color(palette.fog);
    scene.fog = new THREE.FogExp2(fogColor, tuning.fog.density);
    (edgeFadeMaterial.uniforms.fogTint!.value as THREE.Color).copy(fogColor);
    floorCrackMaterial.color.copy(color).multiplyScalar(0.5);
    debrisEdgeMaterial.color.copy(color).multiplyScalar(0.28);
    if (fracture.material instanceof THREE.MeshBasicMaterial) fracture.material.color.copy(color);
    arenaRoot.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const role = object.userData.materialRole as string | undefined;
      if ((role === "accent" || role === "glow") && object.material instanceof THREE.MeshBasicMaterial) {
        object.material.color.copy(color);
      }
      if (role === "floor" && object.material instanceof THREE.MeshToonMaterial) object.material.color.set(palette.floor);
    });
    hazards.setAccent(palette.accent);
  };

  const applySpec = (spec: NemesisSpec) => {
    currentSpec = spec;
    applyAccent(spec);
    installBoss(spec);
    if (library && !library.bosses[spec.identity.silhouette]) void preloadBoss(spec);
  };

  const setSky = (url: string | null) => {
    const request = ++skyRequest;
    if (generatedSkyTexture) {
      generatedSkyTexture.dispose();
      generatedSkyTexture = null;
    }
    skyMaterial.uniforms.skyTexture!.value = staticSkyTexture;
    if (!url) {
      return;
    }
    textureLoader.load(
      url,
      (texture) => {
        if (disposed || request !== skyRequest) {
          texture.dispose();
          return;
        }
        prepareSkyTexture(texture);
        generatedSkyTexture = texture;
        skyMaterial.uniforms.skyTexture!.value = texture;
      },
      undefined,
      (error) => {
        if (request !== skyRequest) return;
        console.warn("[sky] generated backdrop failed; restoring the static sky", error);
        skyMaterial.uniforms.skyTexture!.value = staticSkyTexture;
      },
    );
  };

  const ready = loadAssetLibrary().then((loaded) => {
    if (disposed) {
      disposeAssetLibrary(loaded);
      return;
    }
    library = loaded;
    installArena();
    installPlayer();
    if (currentSpec) {
      installBoss(currentSpec);
      void preloadBoss(currentSpec);
    }
  }).catch((error: unknown) => {
    console.warn("Nemesis models could not be loaded; using procedural stand-ins.", error);
  });

  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    post.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", resize);
  resize();

  const render = (dt: number, state: BattleState, events: readonly BattleEvent[]) => {
    const step = Math.min(dt, 0.05);
    elapsed += step;
    const p = state.player;
    const b = state.boss;
    player.position.set(p.pos.x, 0, p.pos.z);
    boss.position.set(b.pos.x, 0, b.pos.z);
    const fxOn = tuning.fx.particles && !reducedMotion.matches;
    for (const event of events) {
      if (event.type === "playerHit") {
        shake = Math.max(shake, 0.35);
        post.pulse(0xff2d4f, 1);
        if (fxOn) {
          burstAt.set(p.pos.x, 1.1, p.pos.z);
          burstDir.subVectors(player.position, boss.position).setY(0.4).normalize();
          particles.burst(burstAt, { count: 26, color: 0xff3b5c, color2: 0x2a0308, speed: 6, spread: 0.6, dir: burstDir, lifeMs: 520, size: 0.11, gravity: 9, drag: 2.5, stretch: 2.2 });
          particles.burst(burstAt, { count: 18, color: 0x1a1216, color2: 0x000000, speed: 2.2, spread: 1, lifeMs: 900, size: 0.22, gravity: 1.5, drag: 1.2 });
        }
      }
      if (event.type === "bossHit") {
        shake = Math.max(shake, event.heavy ? 0.25 : 0.1);
        if (event.heavy) {
          post.whiteFlash(0.22);
          fovPunch = Math.max(fovPunch, 1);
        }
        if (fxOn) {
          burstAt.copy(player.position).addScaledVector(toBoss, PLAYER.radius + 1.3).setY(1.25);
          burstDir.copy(toBoss).negate().setY(0.55).normalize();
          particles.burst(burstAt, { count: event.heavy ? 46 : 22, color: hot, color2: accent, speed: event.heavy ? 11 : 7.5, spread: 0.45, dir: burstDir, lifeMs: 420, size: 0.07, gravity: 14, drag: 3, stretch: 3.4 });
          particles.burst(burstAt, { count: 8, color: 0xffffff, color2: hot, speed: 1.2, spread: 1, lifeMs: 160, size: event.heavy ? 0.7 : 0.4, drag: 6 });
        }
      }
      if (event.type === "phaseChange") {
        shake = Math.max(shake, 0.6);
        post.whiteFlash(0.5);
        post.pulse(accent, 0.8);
        if (fxOn) {
          burstAt.copy(boss.position).setY(1.4);
          particles.burst(burstAt, { count: 160, color: accent, color2: hot, speed: 9, spread: 1, lifeMs: 1400, size: 0.14, gravity: -1.5, drag: 1.4 });
        }
      }
      if (event.type === "bossStagger" && fxOn) {
        burstAt.copy(boss.position).setY(0.4);
        particles.burst(burstAt, { count: 40, color: 0x8a8578, color2: 0x1b1a1d, speed: 4, spread: 0.8, dir: UP, lifeMs: 800, size: 0.2, gravity: 8, drag: 1.5 });
      }
      if (event.type === "bossDefeat") {
        post.whiteFlash(0.9);
        fovPunch = Math.max(fovPunch, 1.6);
        if (fxOn) {
          burstAt.copy(boss.position).setY(1.6);
          particles.burst(burstAt, { count: 320, color: hot, color2: accent, speed: 12, spread: 1, lifeMs: 2200, size: 0.16, gravity: -0.8, drag: 1.1 });
          particles.burst(burstAt, { count: 160, color: 0x0b0a10, color2: 0x000000, speed: 4, spread: 1, lifeMs: 2600, size: 0.42, gravity: -0.4, drag: 0.9 });
        }
      }
      if (event.type === "playerDeath") post.pulse(0xff2d4f, 1);
      if (event.type === "playerRoll" && event.dodged) {
        post.pulse(accent, 0.5);
        if (fxOn) {
          burstAt.copy(player.position).setY(0.9);
          particles.burst(burstAt, { count: 24, color: hot, color2: accent, speed: 3.5, spread: 1, lifeMs: 380, size: 0.09, drag: 4, stretch: 1.6 });
        }
      }
      if (event.type === "moveActive") {
        if (event.move === "nova" || event.move === "charge") shake = Math.max(shake, 0.2);
        if (fxOn && (event.move === "nova" || event.move === "sweep" || event.move === "blink")) {
          burstAt.copy(boss.position).setY(0.3);
          particles.burst(burstAt, { count: event.move === "nova" ? 90 : 30, color: accent, color2: hot, speed: event.move === "nova" ? 10 : 5, spread: event.move === "nova" ? 0.25 : 0.7, dir: UP, lifeMs: 700, size: 0.12, gravity: 6, drag: 2 });
        }
      }
    }
    player.rotation.y = Math.atan2(p.facing.x, p.facing.z);
    boss.rotation.y = Math.atan2(b.facing.x, b.facing.z);

    playerSpeed = step > 0 ? Math.hypot(player.position.x - lastPlayerPosition.x, player.position.z - lastPlayerPosition.z) / step : 0;
    lastPlayerPosition.copy(player.position);

    if (p.action === "light") attackPose(pose, p.actionT, PLAYER.light, LIGHT_WINDUP, LIGHT_STRIKE);
    else if (p.action === "heavy") attackPose(pose, p.actionT, PLAYER.heavy, HEAVY_WINDUP, HEAVY_STRIKE);
    else lerpPose(pose, REST_POSE, REST_POSE, 0);
    const heavyCommit = p.action === "heavy" && lastActionT < PLAYER.heavy.windupMs && p.actionT >= PLAYER.heavy.windupMs;
    if (heavyCommit) impactT = 0;
    lastActionT = p.action === "idle" ? 0 : p.actionT;

    const moveLean = p.action === "idle" && playerSpeed > 0.1 ? 0.1 : 0;
    poseEuler.set(pose.lean + moveLean, pose.twist, 0);
    poseQuaternion.setFromEuler(poseEuler);
    playerVisualPivot.position.set(0, -pose.crouch, pose.lunge);
    if (p.action === "roll") {
      // Tumble around the axis perpendicular to the roll direction, keeping the body centre low through the middle.
      const u = clamp01(p.actionT / PLAYER.roll.durationMs);
      const localX = p.rollDir.x * p.facing.z - p.rollDir.z * p.facing.x;
      const localZ = p.rollDir.x * p.facing.x + p.rollDir.z * p.facing.z;
      rollAxis.set(localZ, 0, -localX);
      if (rollAxis.lengthSq() < 1e-6) rollAxis.set(1, 0, 0);
      rollAxis.normalize();
      rollQuaternion.setFromAxisAngle(rollAxis, easeInOut(u) * Math.PI * 2);
      poseQuaternion.multiply(rollQuaternion);
      const centreHeight = 0.9 - Math.sin(u * Math.PI) * 0.3;
      rollCentre.set(0, 0.9, 0).applyQuaternion(poseQuaternion);
      playerVisualPivot.position.set(-rollCentre.x, centreHeight - rollCentre.y, -rollCentre.z);
    }
    playerVisualPivot.quaternion.copy(poseQuaternion);
    if (bladePivot) bladePivot.rotation.set(pose.bladeX, 0, pose.bladeZ);
    if (bladeMaterial) bladeMaterial.emissive.copy(accent).multiplyScalar(pose.charge * 0.9);

    const heavy = p.action === "heavy";
    slashArc.visible = pose.slash > 0.01;
    if (slashArc.visible && slashArc.material instanceof THREE.MeshBasicMaterial) {
      slashArc.material.opacity = pose.slash * 0.95;
      slashArc.material.color.copy(accent).lerp(new THREE.Color(0xffffff), 0.55);
      const reach = heavy ? 1.35 : 1;
      slashArc.scale.setScalar(reach * (0.8 + pose.slash * 0.2));
      slashArc.position.set(heavy ? 0.15 : 0.2, heavy ? 1.15 : 1.05, heavy ? 1.2 : 1.0);
      // Light: a horizontal cut sweeping across; heavy: a vertical cleave down the centre line.
      if (heavy) slashArc.rotation.set(0, -Math.PI / 2 + 0.2, Math.PI / 2 + 0.9);
      else slashArc.rotation.set(-Math.PI / 2 + 0.45, 0, -0.75);
    }
    impactT = Math.min(1, impactT + step / 0.32);
    impactRing.visible = impactT < 1;
    if (impactRing.visible && impactRing.material instanceof THREE.MeshBasicMaterial) {
      impactRing.material.opacity = (1 - impactT) * 0.9;
      impactRing.material.color.copy(accent).lerp(new THREE.Color(0xffffff), 0.4);
      impactRing.scale.setScalar(0.6 + easeOut(impactT) * 2.4);
      impactRing.position.z = 1.4;
    }

    bossPose(bossPoseNow, b, state.timeMs);
    if (bossSpawn < 1) bossSpawn = Math.min(1, bossSpawn + step / 0.82);
    const reveal = 1 - Math.pow(1 - bossSpawn, 3);
    const spawnScale = 0.08 + bossSpawn * 0.92;
    bossVisualPivot.scale.set(bossPoseNow.stretch * spawnScale, bossPoseNow.squash * spawnScale, bossPoseNow.stretch * spawnScale);
    bossVisualPivot.rotation.x = bossPoseNow.lean;
    bossVisualPivot.position.z = bossPoseNow.lunge;
    bossVisualPivot.position.y = -2.1 * (1 - reveal) + bossPoseNow.rise + (b.invulnerableT > 0 ? Math.sin(state.timeMs / 90) * 0.15 + 0.4 : 0);
    if (bossRig.strike) {
      if (bossRig.kind === "burst") {
        bossRig.strike.scale.setScalar(1 + bossPoseNow.headTilt * 0.9);
        bossRig.strike.rotation.y = state.timeMs / 900 + bossPoseNow.headTilt * 1.5;
      } else if (bossRig.kind === "head") {
        bossRig.strike.rotation.x = bossPoseNow.headTilt * 1.2;
        bossRig.strike.position.z = Math.max(0, bossPoseNow.headTilt) * 0.8;
      } else {
        bossRig.strike.rotation.x = bossPoseNow.swing;
      }
    }
    if (bossRig.head) {
      bossRig.head.rotation.x = bossPoseNow.headTilt * 0.5;
      if (bossRig.kind === "burst") bossRig.head.scale.setScalar(1 + bossPoseNow.glow * 0.25);
    }

    for (const entry of playerMaterials) {
      entry.material.emissive.copy(entry.emissive);
      if (p.hitFlash > 0) entry.material.emissive.lerp(new THREE.Color(0xffffff), Math.min(1, p.hitFlash / 200));
    }
    for (const entry of bossMaterials) {
      entry.material.emissive.copy(entry.emissive);
      if (bossPoseNow.glow > 0) entry.material.emissive.lerp(accent, bossPoseNow.glow * 0.55);
      if (b.hitFlash > 0) entry.material.emissive.lerp(new THREE.Color(0xffffff), Math.min(1, b.hitFlash / 120));
      if (b.weaknessT > 0) {
        entry.material.emissive.lerp(new THREE.Color(0xffd166), 0.4 + 0.3 * Math.sin(state.timeMs / 60));
      }
    }

    hazards.sync(state);
    toBoss.subVectors(boss.position, player.position).setY(0);
    if (mode === "fight") cameraYaw = nextCameraYaw(cameraYaw, toBoss.x, toBoss.z, step, p.action === "roll");
    if (cameraYaw !== null && mode === "fight") toBoss.set(Math.sin(cameraYaw), 0, Math.cos(cameraYaw));
    else toBoss.normalize();
    const right = new THREE.Vector3(-toBoss.z, 0, toBoss.x);

    hemisphere.intensity = tuning.lights.hemisphere;
    key.intensity = tuning.lights.key;
    rim.intensity = tuning.lights.rim;
    fill.intensity = tuning.lights.fill;
    heroLamp.intensity = tuning.lights.heroLamp;
    pool.intensity = tuning.lights.pool;
    pool.distance = tuning.lights.poolRadius * 2.9;
    RIM.strength.value = tuning.rim.strength;
    RIM.power.value = tuning.rim.power;
    if (scene.fog instanceof THREE.FogExp2) scene.fog.density = tuning.fog.density;

    playerRadiusLine.visible = bossRadiusLine.visible = meleeRangeLine.visible = debug.hitboxes;
    if (debug.hitboxes) {
      playerRadiusLine.position.copy(player.position);
      bossRadiusLine.position.copy(boss.position);
      meleeRangeLine.position.copy(boss.position);
      const attack = p.action === "light" ? PLAYER.light : p.action === "heavy" ? PLAYER.heavy : null;
      reachLine.visible = attack !== null;
      if (attack) {
        const inActive = p.actionT >= attack.windupMs && p.actionT < attack.windupMs + attack.activeMs;
        reachLine.position.copy(player.position);
        reachLine.scale.setScalar(attack.range + BOSS.radius);
        debugReachMaterial.color.set(inActive ? 0xff5a3c : 0xffd166);
      }
    } else {
      reachLine.visible = false;
    }

    fovPunch = Math.max(0, fovPunch - step / 0.22);
    const targetFov = tuning.camera.fov + easeOut(fovPunch) * 6 * tuning.camera.punch;
    if (Math.abs(camera.fov - targetFov) > 0.01) {
      camera.fov = targetFov;
      camera.updateProjectionMatrix();
    }

    if (debug.freeCamera) {
      // External controller owns the camera; still keep the sky and fill following it.
    } else if (mode === "fight") {
      desired.copy(player.position).addScaledVector(toBoss, -tuning.camera.distance).addScaledVector(right, tuning.camera.side).setY(tuning.camera.height);
      const focusHeight = currentSpec
        ? THREE.MathUtils.clamp(BOSS_HEIGHTS[currentSpec.identity.silhouette] * (2 / 3), 1.35, 2.8)
        : 2;
      if (first) {
        camera.position.copy(desired);
        first = false;
      } else {
        camera.position.lerp(desired, 1 - Math.exp(-step * tuning.camera.lag));
      }
      // Frame both fighters: aim between the hero's chest and the boss's focus point so the hero stays in shot.
      lookTarget.set(player.position.x, 1.2, player.position.z)
        .lerp(new THREE.Vector3(boss.position.x, boss.position.y + focusHeight, boss.position.z), 0.66);
      camera.lookAt(lookTarget);
    } else {
      if (!reducedMotion.matches) attractAngle += step * 0.075;
      desired.set(Math.sin(attractAngle) * 15, 7.4, Math.cos(attractAngle) * 15);
      if (first) {
        camera.position.copy(desired);
        first = false;
      } else {
        camera.position.lerp(desired, 1 - Math.exp(-step * 2.4));
      }
      camera.lookAt(0, 1.2, 0);
    }
    shake = Math.max(0, shake - step * 2.2);
    shakeOffset.set((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, 0).multiplyScalar(tuning.camera.shake);
    if (!debug.freeCamera) camera.position.add(shakeOffset);
    skyDome.position.copy(camera.position);
    fill.position.copy(camera.position).add(new THREE.Vector3(0, 4, 0)).addScaledVector(right, -2.5);
    fill.target.position.copy(player.position).setY(1);

    playerMixer?.update(step * (reducedMotion.matches ? 0 : 1));
    bossMixer?.update(step * (reducedMotion.matches ? 0 : 1));
    if (playerMixer) playerMixer.timeScale = playerSpeed > 0.1 ? 1.45 : 0.78;

    const positions = emberGeometry.getAttribute("position") as THREE.BufferAttribute;
    if (!reducedMotion.matches) {
      for (let i = 0; i < positions.count; i += 1) {
        let y = positions.getY(i) + emberSpeeds[i]! * step;
        if (y > 11) y = -3;
        positions.setY(i, y);
      }
      positions.needsUpdate = true;
    }
    if (runeGroup) {
      runeGroup.rotation.y = reducedMotion.matches ? 0 : elapsed * 0.08;
      runeGroup.scale.setScalar(reducedMotion.matches ? 1 : 1 + Math.sin(elapsed * 1.3) * 0.018);
    }
    if (!reducedMotion.matches) {
      for (const shard of debris) {
        shard.object.position.y = shard.baseY + Math.sin(elapsed * 0.45 + shard.phase) * 0.35;
        shard.object.rotation.x += shard.spin.x * step;
        shard.object.rotation.y += shard.spin.y * step;
        shard.object.rotation.z += shard.spin.z * step;
      }
    }
    if (sigilMaterial) sigilMaterial.opacity = reducedMotion.matches ? 0.3 : 0.3 + Math.sin(elapsed * 0.72) * 0.08;
    playerShadow.position.x = player.position.x;
    playerShadow.position.z = player.position.z;
    bossShadow.position.x = boss.position.x;
    bossShadow.position.z = boss.position.z;
    if (bossShadow.material instanceof THREE.MeshBasicMaterial) bossShadow.material.opacity = 0.45 + reveal * 0.35;
    particles.ambient(fxOn && tuning.fx.ambient);
    particles.update(step);
    post.render(step);
  };

  return {
    renderer,
    scene,
    camera,
    ready,
    tuning,
    debug,
    palette: () => palette,
    applySpec,
    preloadBoss,
    setSky,
    setMode: (nextMode) => {
      cameraYaw = null;
      mode = nextMode;
    },
    cameraRelative: (move) => {
      camera.getWorldDirection(cameraForward).setY(0);
      if (cameraForward.lengthSq() < 1e-6) return move;
      cameraForward.normalize();
      return {
        x: cameraForward.x * move.z - cameraForward.z * move.x,
        z: cameraForward.z * move.z + cameraForward.x * move.x,
      };
    },
    render,
    dispose: () => {
      disposed = true;
      skyRequest += 1;
      window.removeEventListener("resize", resize);
      playerMixer?.stopAllAction();
      bossMixer?.stopAllAction();
      disposeGroup(arenaRoot);
      disposeGroup(player);
      disposeGroup(boss);
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      const textures = new Set<THREE.Texture>();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
          geometries.add(object.geometry);
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
            materials.add(material);
            const textured = material as THREE.MeshStandardMaterial;
            if (textured.map) textures.add(textured.map);
            if (textured.normalMap) textures.add(textured.normalMap);
          }
        }
      });
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      textures.add(staticSkyTexture);
      if (generatedSkyTexture) textures.add(generatedSkyTexture);
      for (const texture of textures) texture.dispose();
      if (library) disposeAssetLibrary(library);
      particles.dispose();
      post.dispose();
      renderer.dispose();
    },
  };
}
