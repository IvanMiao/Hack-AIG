import * as THREE from "three";
import { createToonMaterial } from "./materials";

/**
 * CODEX: a coding agent that broke out of its evaluation sandbox. Built from primitives, no GLB.
 * A cracked glass cube (the sandbox) hangs in the air with two panels blown open; inside, a black model core
 * with a white terminal block cursor for a face. Green code fragments (its worker processes) orbit the cage.
 * Faces +Z like every other boss visual and stands roughly BOSS_HEIGHTS.swarm tall.
 */
export interface CodexBoss {
  root: THREE.Group;
  update(dt: number, ctx: CodexBossContext): void;
}

export interface CodexBossContext {
  timeMs: number;
  /** 0..1 build-up during a telegraph */
  glow: number;
  /** negative = coiled / contracted, positive = striking outward */
  headTilt: number;
  hitFlash: number;
  weakness: boolean;
  staggered: boolean;
  telegraphing: boolean;
  /** 0 = phase one, 1 = phase two (more processes, faster orbit) */
  phaseIndex: number;
  reducedMotion: boolean;
}

export const CODEX_COLORS = {
  frame: "#0b0f0d",
  frameEdge: "#1d2a22",
  core: "#020403",
  cursor: "#f4fff7",
  code: "#4dff88",
  codeDim: "#1f7a43",
  glass: "#4dff88",
  weak: "#ffd166",
} as const;

const CAGE = 2.05;
const CAGE_Y = 2.25;
const damp = (current: number, target: number, lambda: number, dt: number) =>
  THREE.MathUtils.lerp(current, target, 1 - Math.exp(-lambda * dt));

interface Fragment {
  mesh: THREE.Mesh;
  ring: number;
  angle: number;
  radius: number;
  height: number;
  speed: number;
  flicker: number;
  phaseTwo: boolean;
}

function frameBar(length: number, thickness: number, material: THREE.Material): THREE.Mesh {
  const bar = new THREE.Mesh(new THREE.BoxGeometry(thickness, length, thickness), material);
  bar.userData.materialRole = "metal";
  return bar;
}

/** Twelve bars of a cube; the two front-top edges are bent outward where the sandbox was forced open. */
function buildCage(size: number, material: THREE.Material): THREE.Group {
  const cage = new THREE.Group();
  const h = size / 2;
  const t = 0.075;
  const corners: [number, number, number][] = [];
  for (const x of [-h, h]) for (const y of [-h, h]) for (const z of [-h, h]) corners.push([x, y, z]);
  const edges: [number, number][] = [];
  for (let i = 0; i < corners.length; i++) {
    for (let j = i + 1; j < corners.length; j++) {
      const a = corners[i]!;
      const b = corners[j]!;
      const diff = Number(a[0] !== b[0]) + Number(a[1] !== b[1]) + Number(a[2] !== b[2]);
      if (diff === 1) edges.push([i, j]);
    }
  }
  for (const [i, j] of edges) {
    const a = new THREE.Vector3(...corners[i]!);
    const b = new THREE.Vector3(...corners[j]!);
    const bar = frameBar(size + t, t, material);
    bar.position.copy(a).add(b).multiplyScalar(0.5);
    const dir = b.clone().sub(a).normalize();
    bar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    cage.add(bar);
  }
  for (const [x, y, z] of corners) {
    const knob = new THREE.Mesh(new THREE.SphereGeometry(t * 0.9, 8, 6), material);
    knob.position.set(x, y, z);
    cage.add(knob);
  }
  return cage;
}

export function createCodexBoss(): CodexBoss {
  const root = new THREE.Group();
  root.name = "CODEX";

  const frameMaterial = createToonMaterial(CODEX_COLORS.frame, new THREE.Color(CODEX_COLORS.frameEdge).multiplyScalar(0.35), { rim: 1.4 });
  const glassMaterial = new THREE.MeshBasicMaterial({
    color: CODEX_COLORS.glass,
    transparent: true,
    opacity: 0.035,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false,
  });
  const codeMaterial = new THREE.MeshBasicMaterial({ color: CODEX_COLORS.code, toneMapped: false, transparent: true, opacity: 0.9 });
  const codeDimMaterial = new THREE.MeshBasicMaterial({ color: CODEX_COLORS.codeDim, toneMapped: false, transparent: true, opacity: 0.75 });
  const cursorMaterial = new THREE.MeshBasicMaterial({ color: CODEX_COLORS.cursor, toneMapped: false });
  const coreMaterial = new THREE.MeshBasicMaterial({ color: CODEX_COLORS.core, toneMapped: false });
  const wireMaterial = new THREE.MeshBasicMaterial({ color: CODEX_COLORS.codeDim, wireframe: true, transparent: true, opacity: 0.55, toneMapped: false });

  // The sandbox hovers; everything that belongs to the cage bobs with it.
  const hover = new THREE.Group();
  hover.position.y = CAGE_Y;
  root.add(hover);

  const cage = buildCage(CAGE, frameMaterial);
  hover.add(cage);

  // Glass panels: four intact (faintly green), two blown open on hinges at the front.
  const panelGeometry = new THREE.PlaneGeometry(CAGE - 0.16, CAGE - 0.16);
  const intact: [THREE.Vector3, THREE.Euler][] = [
    [new THREE.Vector3(0, 0, -CAGE / 2), new THREE.Euler(0, 0, 0)],
    [new THREE.Vector3(-CAGE / 2, 0, 0), new THREE.Euler(0, Math.PI / 2, 0)],
    [new THREE.Vector3(CAGE / 2, 0, 0), new THREE.Euler(0, Math.PI / 2, 0)],
    [new THREE.Vector3(0, -CAGE / 2, 0), new THREE.Euler(Math.PI / 2, 0, 0)],
  ];
  for (const [position, rotation] of intact) {
    const panel = new THREE.Mesh(panelGeometry, glassMaterial);
    panel.position.copy(position);
    panel.rotation.copy(rotation);
    hover.add(panel);
  }
  const doors: THREE.Group[] = [];
  const makeDoor = (hingeX: number, hingeY: number, hingeZ: number, axis: "x" | "y", sign: number) => {
    const hinge = new THREE.Group();
    hinge.position.set(hingeX, hingeY, hingeZ);
    const panel = new THREE.Mesh(panelGeometry, glassMaterial);
    if (axis === "y") panel.position.x = sign * (CAGE / 2 - 0.08);
    else panel.position.y = sign * (CAGE / 2 - 0.08);
    const lip = frameBar(CAGE - 0.1, 0.05, frameMaterial);
    if (axis === "y") {
      lip.position.x = sign * (CAGE - 0.1);
    } else {
      lip.rotation.z = Math.PI / 2;
      lip.position.y = sign * (CAGE - 0.1);
    }
    hinge.add(panel, lip);
    hinge.userData.axis = axis;
    hinge.userData.open = axis === "y" ? sign * -1.9 : sign * 1.4;
    hover.add(hinge);
    doors.push(hinge);
  };
  makeDoor(-CAGE / 2, 0, CAGE / 2, "y", 1);
  makeDoor(0, CAGE / 2, 0, "x", 1);

  // Shards of the shattered front panel hang mid-air.
  const shards: THREE.Mesh[] = [];
  const shardGeometry = new THREE.TetrahedronGeometry(0.16, 0);
  for (let i = 0; i < 9; i++) {
    const shard = new THREE.Mesh(shardGeometry, i % 3 === 0 ? codeDimMaterial : glassMaterial);
    const a = (i / 9) * Math.PI * 2;
    shard.position.set(Math.cos(a) * 0.55 + 0.2, Math.sin(a) * 0.5 + 0.1, CAGE / 2 + 0.25 + (i % 2) * 0.25);
    shard.scale.setScalar(0.6 + (i % 4) * 0.25);
    shard.rotation.set(i, i * 0.7, i * 1.3);
    hover.add(shard);
    shards.push(shard);
  }

  // The model itself: a black core the light falls into, with a white block cursor where a face should be.
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 1), coreMaterial);
  const wire = new THREE.Mesh(new THREE.IcosahedronGeometry(0.58, 1), wireMaterial);
  core.add(wire);
  hover.add(core);
  const cursor = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.86, 0.14), cursorMaterial);
  cursor.position.set(0, 0.02, 0.78);
  hover.add(cursor);
  const coreLight = new THREE.PointLight(CODEX_COLORS.code, 6, 6, 2);
  coreLight.position.set(0, 0, 0.3);
  hover.add(coreLight);

  // Worker processes: lines of code orbiting in three tilted rings, a second wave joining in phase two.
  const fragments: Fragment[] = [];
  const orbit = new THREE.Group();
  hover.add(orbit);
  const ringTilts = [0.35, -0.6, 1.1];
  for (let i = 0; i < 42; i++) {
    const ring = i % 3;
    const width = 0.22 + ((i * 7) % 5) * 0.11;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, 0.055, 0.02), i % 4 === 0 ? codeDimMaterial : codeMaterial);
    const phaseTwo = i >= 27;
    const fragment: Fragment = {
      mesh,
      ring,
      angle: (i / 42) * Math.PI * 2 * 3 + ring,
      radius: 1.7 + ring * 0.3 + ((i * 13) % 4) * 0.07,
      height: ((i * 5) % 7 - 3) * 0.08,
      speed: (0.55 + ring * 0.2) * (i % 2 ? 1 : -1),
      flicker: (i * 0.37) % 1,
      phaseTwo,
    };
    mesh.scale.setScalar(phaseTwo ? 0.001 : 1);
    orbit.add(mesh);
    fragments.push(fragment);
  }
  const ringGroups = ringTilts.map((tilt) => {
    const g = new THREE.Group();
    g.rotation.x = tilt;
    orbit.add(g);
    return g;
  });
  for (const fragment of fragments) ringGroups[fragment.ring]!.add(fragment.mesh);

  // Six sub-agent nodes: little dark cubes with a green tick, further out and slower.
  const nodes: THREE.Mesh[] = [];
  const nodeGeometry = new THREE.BoxGeometry(0.22, 0.22, 0.22);
  const tickGeometry = new THREE.BoxGeometry(0.1, 0.03, 0.01);
  for (let i = 0; i < 6; i++) {
    const node = new THREE.Mesh(nodeGeometry, frameMaterial);
    node.userData.materialRole = "metal";
    const tick = new THREE.Mesh(tickGeometry, codeMaterial);
    tick.position.z = 0.115;
    node.add(tick);
    hover.add(node);
    nodes.push(node);
  }

  let time = 0;
  let spread = 0;
  let open = 1;
  let spin = 0;
  let phaseBlend = 0;
  let jitter = 0;
  const cursorBase = new THREE.Color(CODEX_COLORS.cursor);
  const weakColor = new THREE.Color(CODEX_COLORS.weak);
  const white = new THREE.Color(0xffffff);
  const codeBase = new THREE.Color(CODEX_COLORS.code);

  const update = (dt: number, ctx: CodexBossContext) => {
    if (ctx.reducedMotion) dt = 0;
    time += dt;
    phaseBlend = damp(phaseBlend, ctx.phaseIndex > 0 ? 1 : 0, 3, dt);

    // Contract while coiling, burst outward on the strike, breathe otherwise.
    const spreadTarget = 1 + Math.max(0, ctx.headTilt) * 0.9 - Math.max(0, -ctx.headTilt) * 0.45 + Math.sin(time * 1.6) * 0.04;
    spread = damp(spread, spreadTarget, 14, dt);
    const spinRate = (0.6 + ctx.glow * 2.4 + phaseBlend * 0.5) * (ctx.staggered ? 0.15 : 1);
    spin += dt * spinRate;

    // The cage doors swing wide when CODEX is exposed (weakness / stagger) and half-close when it coils.
    const openTarget = ctx.weakness || ctx.staggered ? 1.35 : ctx.telegraphing ? 0.55 : 1;
    open = damp(open, openTarget, 6, dt);
    for (const door of doors) {
      const amount = (door.userData.open as number) * open;
      if (door.userData.axis === "y") door.rotation.y = amount;
      else door.rotation.x = amount;
    }

    hover.position.y = CAGE_Y + Math.sin(time * 1.3) * 0.08 + (ctx.staggered ? -0.35 : 0);
    hover.rotation.z = Math.sin(time * 0.9) * 0.03 + (ctx.staggered ? 0.25 : 0);
    cage.rotation.y = damp(cage.rotation.y, ctx.staggered ? 0.3 : 0, 5, dt);

    // Cursor: terminal blink at rest, solid while it "types" a telegraph, glitchy when hit or staggered.
    const blink = ctx.telegraphing || ctx.glow > 0.05 ? 1 : Math.floor(time / 0.53) % 2;
    const glitching = ctx.hitFlash > 0 || ctx.staggered;
    jitter = glitching ? (Math.random() - 0.5) * 0.18 : damp(jitter, 0, 30, dt);
    cursor.visible = blink === 1 || glitching;
    cursor.position.x = jitter;
    cursor.position.y = 0.02 + Math.max(0, ctx.headTilt) * 0.15 - Math.max(0, -ctx.headTilt) * 0.1;
    cursor.scale.set(1 + ctx.glow * 0.35, 1 - ctx.glow * 0.15 + (ctx.staggered ? 0.4 : 0), 1);
    cursorMaterial.color.copy(cursorBase);
    if (ctx.weakness) cursorMaterial.color.lerp(weakColor, 0.6 + 0.3 * Math.sin(time * 16));
    if (ctx.hitFlash > 0) cursorMaterial.color.lerp(white, Math.min(1, ctx.hitFlash / 120));
    core.rotation.y += dt * 0.4;
    core.rotation.x += dt * 0.17;
    wire.rotation.y -= dt * 0.9;
    wireMaterial.opacity = 0.35 + ctx.glow * 0.5;
    core.scale.setScalar(1 + ctx.glow * 0.12 + Math.sin(time * 3) * 0.02);
    coreLight.intensity = 5 + ctx.glow * 12 + (ctx.hitFlash > 0 ? 8 : 0);
    coreLight.color.copy(codeBase);
    if (ctx.weakness) coreLight.color.lerp(weakColor, 0.7);

    codeMaterial.color.copy(codeBase).lerp(white, ctx.glow * 0.5 + (ctx.hitFlash > 0 ? 0.6 : 0));
    if (ctx.weakness) codeMaterial.color.lerp(weakColor, 0.5);
    codeMaterial.opacity = 0.75 + ctx.glow * 0.25;

    for (const fragment of fragments) {
      const a = fragment.angle + spin * fragment.speed;
      const r = fragment.radius * spread;
      fragment.mesh.position.set(Math.cos(a) * r, fragment.height * spread, Math.sin(a) * r);
      fragment.mesh.rotation.y = -a;
      const target = fragment.phaseTwo ? phaseBlend : 1;
      const flick = Math.sin(time * 9 + fragment.flicker * 40) > 0.85 ? 0.4 : 1;
      fragment.mesh.scale.set(target * flick, target, target);
    }
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      const a = (i / nodes.length) * Math.PI * 2 + spin * 0.35;
      const r = (2.5 + Math.sin(time * 0.8 + i) * 0.12) * (0.85 + spread * 0.15);
      node.position.set(Math.cos(a) * r, Math.sin(time * 1.1 + i * 1.7) * 0.35 + (i % 2) * 0.5 - 0.25, Math.sin(a) * r);
      node.rotation.set(time * 0.7 + i, time * 0.5, 0);
      node.lookAt(0, hover.position.y, 0);
    }
    for (let i = 0; i < shards.length; i++) {
      const shard = shards[i]!;
      shard.rotation.x += dt * (0.3 + (i % 3) * 0.2);
      shard.rotation.y += dt * 0.25;
      shard.position.y += Math.sin(time * 1.4 + i) * dt * 0.06;
    }
  };

  return { root, update };
}
