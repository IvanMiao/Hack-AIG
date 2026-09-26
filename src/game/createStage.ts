import * as THREE from "three";
import { addOutline, createToonMaterial } from "./materials";
import { instantiate, loadAssetLibrary, type AssetLibrary } from "./assets";
import type { NemesisSpec } from "../spec";
import skyUrl from "../../blender/art/textures/sky.jpg?url";

export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  player: THREE.Group;
  boss: THREE.Group;
  ready: Promise<void>;
  applySpec(spec: NemesisSpec): void;
  setMode(mode: "attract" | "fight"): void;
  update(dt: number, input: { x: number; z: number }): void;
  dispose(): void;
}

export const ARENA_RADIUS = 9;

function disposeAssetLibrary(library: AssetLibrary): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  for (const gltf of [library.arena, library.player, ...Object.values(library.bosses)]) {
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
  for (const material of materials) {
    material.dispose();
  }
  for (const texture of textures) texture.dispose();
}

function disposeGroup(group: THREE.Group): void {
  const materials = new Set<THREE.Material>();
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    let ancestor: THREE.Object3D | null = object;
    let sharedGeometry = false;
    while (ancestor && ancestor !== group) {
      if (ancestor.userData.assetClone) sharedGeometry = true;
      ancestor = ancestor.parent;
    }
    if (!sharedGeometry) object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  for (const material of materials) material.dispose();
  group.clear();
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

export function createStage(canvas: HTMLCanvasElement): Stage {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x030309);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 240);
  camera.position.set(14, 7, 14);
  camera.lookAt(0, 1, 0);
  const accent = new THREE.Color("#7fdcff");
  const skyTexture = new THREE.TextureLoader().load(skyUrl);
  skyTexture.colorSpace = THREE.SRGBColorSpace;
  skyTexture.wrapS = THREE.RepeatWrapping;
  skyTexture.wrapT = THREE.ClampToEdgeWrapping;
  const skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      skyTexture: { value: skyTexture },
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
        float clouds = smoothstep(0.025, 0.74, light);
        float band = exp(-pow((skyHeight + 0.03) * 5.5, 2.0));
        vec3 base = mix(upper, horizon, band * 0.34);
        vec3 tint = accent * mix(0.14, 0.82, light);
        gl_FragColor = vec4(mix(base, tint, clouds) + accent * band * 0.16, 1.0);
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
  const embers = new THREE.Points(emberGeometry, emberMaterial);
  scene.add(embers);

  const hemisphere = new THREE.HemisphereLight(0x8994c5, 0x100d17, 1.6);
  const key = new THREE.DirectionalLight(0xf1e8db, 2.4);
  key.position.set(6, 12, 4);
  const rim = new THREE.PointLight(accent, 65, 70);
  rim.position.set(0, 7, -8);
  scene.add(hemisphere, key, rim);

  const arenaRoot = new THREE.Group();
  arenaRoot.name = "Arena";
  scene.add(arenaRoot);
  const fallbackPlatform = new THREE.Mesh(
    new THREE.CylinderGeometry(ARENA_RADIUS, ARENA_RADIUS * 0.85, 1.2, 14, 1),
    createToonMaterial(0x14161f),
  );
  fallbackPlatform.position.y = -0.6;
  addOutline(fallbackPlatform, 0.015);
  const fracture = new THREE.Mesh(
    new THREE.TorusGeometry(ARENA_RADIUS, 0.06, 6, 48),
    new THREE.MeshBasicMaterial({ color: accent }),
  );
  fracture.rotation.x = Math.PI / 2;
  fracture.position.y = 0.02;
  arenaRoot.add(fallbackPlatform, fracture);

  const player = new THREE.Group();
  const fallbackCloak = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.9, 7), createToonMaterial(0x1c1c26));
  fallbackCloak.position.y = 0.95;
  addOutline(fallbackCloak);
  const fallbackHood = new THREE.Mesh(new THREE.SphereGeometry(0.32, 10, 8), createToonMaterial(0x0b0b10));
  fallbackHood.position.y = 1.95;
  addOutline(fallbackHood);
  const fallbackFace = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), createToonMaterial(0x030308));
  fallbackFace.position.set(0, 1.94, 0.25);
  const fallbackEyes = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 4), new THREE.MeshBasicMaterial({ color: 0xe9e4d8 }));
  fallbackEyes.position.set(0, 1.96, 0.415);
  const fallbackChain = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.025, 5, 8), createToonMaterial(0x5a5f6e));
  fallbackChain.position.set(0.56, 0.55, 0.12);
  player.add(fallbackCloak, fallbackHood, fallbackFace, fallbackEyes, fallbackChain);
  scene.add(player);

  const boss = new THREE.Group();
  boss.position.set(0, 0, -5);
  scene.add(boss);
  const playerShadow = makeShadow(2.3);
  const bossShadow = makeShadow(4.4);
  scene.add(playerShadow, bossShadow);

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let mode: "attract" | "fight" = "attract";
  let disposed = false;
  let elapsed = 0;
  let currentSpec: NemesisSpec | null = null;
  let library: AssetLibrary | null = null;
  let playerMixer: THREE.AnimationMixer | null = null;
  let bossMixer: THREE.AnimationMixer | null = null;
  let playerLean: THREE.Group | null = null;
  let runeGroup: THREE.Group | null = null;
  let bossSpawn = 1;
  let attractAngle = 0;

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
    visual.traverse((object) => {
      const name = object.name.toLowerCase();
      if (object !== runes && (name.includes("runic") || name.includes("sigil"))) runeMeshes.push(object);
    });
    for (const object of runeMeshes) runes.attach(object);
    runeGroup = runes;
  };

  const installPlayer = () => {
    if (!library) return;
    if (playerMixer) playerMixer.stopAllAction();
    disposeGroup(player);
    const visual = instantiate(library.player, ["#0b0b10", "#e9e4d8", "#1c1c26"], { player: true, outline: 0.016 });
    playerLean = new THREE.Group();
    playerLean.add(visual);
    player.add(playerLean);
    playerMixer = new THREE.AnimationMixer(visual);
    const clip = library.player.animations[0];
    if (clip) playerMixer.clipAction(clip).setLoop(THREE.LoopRepeat, Infinity).play();
  };

  const applyAccent = (spec: NemesisSpec) => {
    const color = new THREE.Color(spec.art.accentHex);
    accent.copy(color);
    (skyMaterial.uniforms.accent!.value as THREE.Color).copy(color);
    (skyMaterial.uniforms.horizon!.value as THREE.Color).copy(color).multiplyScalar(0.16);
    emberMaterial.color.copy(color);
    rim.color.copy(color);
    scene.fog = new THREE.FogExp2(color.clone().lerp(new THREE.Color("#05040a"), 0.86), 0.022);
    if (fracture.material instanceof THREE.MeshBasicMaterial) fracture.material.color.copy(color);
    arenaRoot.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const role = object.userData.materialRole as string | undefined;
      if ((role === "accent" || role === "glow") && object.material instanceof THREE.MeshBasicMaterial) {
        object.material.color.copy(color);
      }
    });
  };

  const applySpec = (spec: NemesisSpec) => {
    currentSpec = spec;
    applyAccent(spec);
    if (!library) {
      disposeGroup(boss);
      const [, accentHex, deepHex] = spec.identity.palette;
      const height = spec.identity.silhouette === "colossus" ? 4.5 : spec.identity.silhouette === "hound" ? 1.6 : 3;
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.9, Math.max(0.1, height - 1.8), 6, 10),
        createToonMaterial(deepHex, new THREE.Color(accentHex).multiplyScalar(0.15)),
      );
      body.position.y = height / 2;
      addOutline(body, 0.05);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 8), new THREE.MeshBasicMaterial({ color: accentHex }));
      eye.position.set(0, height * 0.8, 0.85);
      boss.add(body, eye);
    } else {
      if (bossMixer) bossMixer.stopAllAction();
      disposeGroup(boss);
      const visual = instantiate(library.bosses[spec.identity.silhouette], spec.identity.palette, { outline: 0.024 });
      boss.add(visual);
      bossMixer = new THREE.AnimationMixer(visual);
      const clip = library.bosses[spec.identity.silhouette].animations[0];
      if (clip) bossMixer.clipAction(clip).setLoop(THREE.LoopRepeat, Infinity).play();
    }
    bossSpawn = 0;
    boss.scale.setScalar(0.08);
    boss.position.y = -2.1;
  };

  const ready = loadAssetLibrary().then((loaded) => {
    if (disposed) {
      disposeAssetLibrary(loaded);
      return;
    }
    library = loaded;
    installArena();
    installPlayer();
    if (currentSpec) applySpec(currentSpec);
  }).catch((error: unknown) => {
    console.warn("Nemesis models could not be loaded; using procedural stand-ins.", error);
  });

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
    const step = Math.min(dt, 0.05);
    elapsed += step;
    const drift = reducedMotion.matches ? 0 : step;
    toBoss.subVectors(boss.position, player.position).setY(0);
    const distance = toBoss.length() || 1;
    toBoss.divideScalar(distance);
    const right = new THREE.Vector3(-toBoss.z, 0, toBoss.x);

    if (mode === "fight") {
      player.position.addScaledVector(toBoss, input.z * 6 * step).addScaledVector(right, input.x * 6 * step);
      const radial = Math.hypot(player.position.x, player.position.z);
      if (radial > ARENA_RADIUS - 0.8) player.position.multiplyScalar((ARENA_RADIUS - 0.8) / radial);
    } else if (!reducedMotion.matches) {
      attractAngle += step * 0.075;
    }

    player.rotation.set(0, Math.atan2(toBoss.x, toBoss.z), 0);
    if (playerLean) {
      playerLean.rotation.x = mode === "fight" ? THREE.MathUtils.clamp(input.z * 0.08, -0.12, 0.12) : 0;
    }
    boss.lookAt(player.position.x, 0, player.position.z);

    if (mode === "attract") {
      desired.set(Math.sin(attractAngle) * 15, 7.4, Math.cos(attractAngle) * 15);
      camera.position.lerp(desired, 1 - Math.exp(-step * 2.4));
      camera.lookAt(0, 1.2, 0);
    } else {
      desired.copy(player.position).addScaledVector(toBoss, -4.2).add(right.multiplyScalar(1.2)).setY(2.6);
      camera.position.lerp(desired, 1 - Math.exp(-step * 8));
      camera.lookAt(boss.position.x, 1.8, boss.position.z);
    }
    skyDome.position.copy(camera.position);

    if (bossSpawn < 1) {
      bossSpawn = Math.min(1, bossSpawn + step / 0.82);
      const reveal = 1 - Math.pow(1 - bossSpawn, 3);
      boss.scale.setScalar(0.08 + reveal * 0.92);
      boss.position.y = -2.1 * (1 - reveal);
    }
    playerMixer?.update(step);
    bossMixer?.update(step);
    if (playerMixer) playerMixer.timeScale = input.x || input.z ? 1.45 : 0.78;

    const positions = emberGeometry.getAttribute("position") as THREE.BufferAttribute;
    if (drift) {
      for (let i = 0; i < positions.count; i++) {
        let y = positions.getY(i) + emberSpeeds[i]! * drift;
        if (y > 11) y = -3;
        positions.setY(i, y);
      }
      positions.needsUpdate = true;
    }
    if (runeGroup) {
      runeGroup.rotation.y = reducedMotion.matches ? 0 : elapsed * 0.08;
      runeGroup.scale.setScalar(reducedMotion.matches ? 1 : 1 + Math.sin(elapsed * 1.3) * 0.018);
    }
    playerShadow.position.x = player.position.x;
    playerShadow.position.z = player.position.z;
    bossShadow.position.x = boss.position.x;
    bossShadow.position.z = boss.position.z;
    if (bossShadow.material instanceof THREE.MeshBasicMaterial) bossShadow.material.opacity = 0.45 + bossSpawn * 0.35;
    renderer.render(scene, camera);
  };

  return {
    renderer, scene, camera, player, boss, ready, applySpec,
    setMode: (nextMode) => { mode = nextMode; },
    update,
    dispose: () => {
      disposed = true;
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
      textures.add(skyTexture);
      for (const texture of textures) texture.dispose();
      if (library) disposeAssetLibrary(library);
      renderer.dispose();
    },
  };
}
