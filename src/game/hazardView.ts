import * as THREE from "three";
import { MOVE, previewShape, type BattleState, type HazardShape } from "../sim";

const Y = 0.05;
const CRACK_MS = 2000;
const EDGE = 0.14;

// Kinds understood by the decal shader.
const KIND_DISC = 0;
const KIND_QUAD = 1;
const KIND_RING = 2;

// Decal styles: the void's soft glowing sigils, or CODEX's terminal readout.
const STYLE_VOID = 0;
const STYLE_TERMINAL = 1;
export type HazardStyle = "void" | "terminal";

const DECAL_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Ground decal: crisp accent outline along the shape edge, a hollow interior that only glows near the rim,
 * a shrinking ring (discs/arcs) or advancing front (lines) that shows the commit point, and a white flash
 * when the hitbox goes live. Everything is computed from UVs so one material covers every shape.
 */
const DECAL_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uProgress;
  uniform float uFlash;
  uniform float uPulse;
  uniform int uKind;
  uniform float uHalfAngle;
  uniform vec2 uSize;
  uniform float uEdge;
  uniform int uStyle;
  uniform float uTime;
  varying vec2 vUv;

  /*
   * Terminal readout: bracketed corners with dashed edges, the interior a faint cell grid with scanlines,
   * and the commit progress compiled cell by cell (the cell being written blinks like a cursor).
   */
  vec4 terminal(vec2 p, float edgeDist, float sweep) {
    float dashCoord;
    vec2 gridUv;
    bool solid;
    if (uKind == ${KIND_QUAD}) {
      dashCoord = vUv.x * uSize.x + vUv.y * uSize.y;
      gridUv = vUv * uSize;
      vec2 d = min(vUv, 1.0 - vUv) * uSize;
      solid = d.x < 0.7 && d.y < 0.7;
    } else {
      float a = atan(p.y, p.x);
      dashCoord = a * uSize.x;
      gridUv = p * uSize.x * 2.0;
      solid = abs(fract(a / 6.2832 * 4.0 + 0.5) - 0.5) < 0.035;
    }
    float dash = step(0.35, fract(dashCoord * 2.0));
    float outline = (1.0 - smoothstep(uEdge * 0.5, uEdge * 0.85, edgeDist)) * (solid ? 1.0 : dash);
    float grid = step(0.1, fract(gridUv.x * 1.6)) * step(0.1, fract(gridUv.y * 1.6));
    float scan = 0.6 + 0.4 * step(0.5, fract(gridUv.y * 5.0 - uTime * 3.0));
    float cells = 10.0;
    float cellIdx = floor(sweep * cells);
    float frontIdx = floor(uProgress * cells);
    float fill = 0.0;
    float writing = 0.0;
    if (uProgress > 0.0 && uKind != ${KIND_RING}) {
      if (cellIdx < frontIdx) fill = 0.22 * grid * scan;
      else if (cellIdx == frontIdx) {
        writing = step(0.5, fract(uTime * 5.0));
        fill = 0.55 * grid * writing;
      }
    }
    float ambient = grid * (0.04 + uPulse * 0.16) * scan;
    float flicker = 0.9 + 0.1 * step(0.6, fract(sin(floor(uTime * 20.0) * 12.9898) * 43758.5453));
    float alpha = clamp(outline + fill + ambient, 0.0, 1.0) * flicker;
    alpha = max(alpha, uFlash * (0.25 + 0.7 * grid));
    vec3 color = mix(uColor, vec3(1.0), clamp(uFlash * 0.8 + writing * 0.4 + outline * 0.25, 0.0, 1.0));
    return vec4(color, alpha * uOpacity);
  }

  void main() {
    vec2 p = vUv - 0.5;
    float edgeDist;
    float sweep;
    float bandWidth;
    if (uKind == ${KIND_QUAD}) {
      vec2 d = min(vUv, 1.0 - vUv) * uSize;
      edgeDist = min(d.x, d.y);
      sweep = vUv.x;
      bandWidth = uEdge / uSize.x;
    } else {
      float r = length(p) * 2.0;
      float outer = uSize.x;
      edgeDist = (1.0 - r) * outer;
      if (uKind == ${KIND_RING}) edgeDist = min(edgeDist, (r - uSize.y / outer) * outer);
      if (uHalfAngle < 3.1) {
        float a = atan(p.y, p.x);
        edgeDist = min(edgeDist, (uHalfAngle - abs(a)) * max(r, 0.05) * outer);
      }
      sweep = 1.0 - r;
      bandWidth = uEdge / outer;
    }
    if (edgeDist < 0.0) discard;
    if (uStyle == ${STYLE_TERMINAL}) {
      gl_FragColor = terminal(p, edgeDist, sweep);
      return;
    }

    /*
     * Sigil: a double-lined rim notched with rune ticks, an inner weave of spokes or hatching, a smooth
     * commit band that sheds embers over the sealed area, and a textured burst instead of a flat flash.
     */
    float tickCoord;
    vec2 weaveUv;
    float weave;
    if (uKind == ${KIND_QUAD}) {
      tickCoord = vUv.x * uSize.x + vUv.y * uSize.y;
      weaveUv = vUv * uSize;
      weave = step(0.9, fract((weaveUv.x + weaveUv.y) * 1.1)) + step(0.9, fract((weaveUv.x - weaveUv.y) * 1.1));
    } else {
      float a = atan(p.y, p.x);
      float r = length(p) * 2.0;
      tickCoord = a * uSize.x;
      weaveUv = p * uSize.x * 2.0;
      weave = step(0.94, fract(a / 6.2832 * 20.0)) * smoothstep(0.08, 0.3, r) + step(0.92, fract(r * uSize.x * 0.9));
    }
    weave = clamp(weave, 0.0, 1.0);
    float outline = 1.0 - smoothstep(uEdge * 0.45, uEdge * 0.8, edgeDist);
    float inner = 1.0 - smoothstep(uEdge * 0.22, uEdge * 0.42, abs(edgeDist - uEdge * 1.9));
    float tick = step(0.84, fract(tickCoord)) * (1.0 - smoothstep(uEdge * 1.6, uEdge * 3.4, edgeDist));
    float rimGlow = (1.0 - smoothstep(0.0, uEdge * 5.0, edgeDist)) * 0.22;
    float band = 0.0;
    float fill = 0.0;
    float ember = 0.0;
    if (uProgress > 0.0 && uKind != ${KIND_RING}) {
      float front = uProgress;
      band = 1.0 - smoothstep(0.0, bandWidth * 1.6, abs(sweep - front));
      float sealed = 1.0 - step(front, sweep);
      fill = sealed * (0.06 + uProgress * 0.1 + weave * 0.2);
      vec2 cell = floor(weaveUv * 2.5);
      float h = fract(sin(dot(cell, vec2(12.9898, 78.233)) + floor(uTime * 6.0) * 0.37) * 43758.5453);
      ember = sealed * step(0.8, h) * (0.5 + 0.5 * sin(uTime * 14.0 + h * 40.0));
    }
    float pulse = uPulse * (0.08 + weave * 0.18);
    float alpha = clamp(outline + inner * 0.55 + tick * 0.6 + rimGlow + band * 0.9 + fill + ember * 0.6 + pulse, 0.0, 1.0);
    float burst = 0.3 + 0.7 * max(weave, 1.0 - smoothstep(0.0, uEdge * 4.0, edgeDist));
    alpha = max(alpha, uFlash * burst);
    vec3 color = mix(uColor, vec3(1.0), clamp(uFlash * 0.85 + band * 0.45 + ember * 0.5 + outline * 0.2, 0.0, 1.0));
    gl_FragColor = vec4(color, alpha * uOpacity);
  }
`;

function makeDecalMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: DECAL_VERTEX,
    fragmentShader: DECAL_FRAGMENT,
    uniforms: {
      uColor: { value: new THREE.Color(0xff3b5c) },
      uOpacity: { value: 1 },
      uProgress: { value: 0 },
      uFlash: { value: 0 },
      uPulse: { value: 0 },
      uKind: { value: KIND_DISC },
      uHalfAngle: { value: Math.PI },
      uSize: { value: new THREE.Vector2(1, 1) },
      uEdge: { value: EDGE },
      uStyle: { value: STYLE_VOID },
      uTime: { value: 0 },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** Jagged radial cracks, white on transparent, used as an alpha map for landing decals. */
function makeCrackTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d");
  if (context) {
    const centre = size / 2;
    context.strokeStyle = "#ffffff";
    context.lineCap = "round";
    let seed = 7;
    const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    interface Ray { x: number; y: number; angle: number; length: number; width: number; depth: number }
    const pending: Ray[] = [];
    const rays = 9;
    for (let i = 0; i < rays; i += 1) {
      pending.push({ x: centre, y: centre, angle: (i / rays) * Math.PI * 2 + random() * 0.5, length: 70 + random() * 45, width: 3.2, depth: 1 });
    }
    while (pending.length) {
      const ray = pending.pop()!;
      let { x, y, angle } = ray;
      const steps = 6;
      context.lineWidth = ray.width;
      context.beginPath();
      context.moveTo(x, y);
      for (let i = 0; i < steps; i += 1) {
        angle += (random() - 0.5) * 0.9;
        const segment = (ray.length / steps) * (0.7 + random() * 0.6);
        x += Math.cos(angle) * segment;
        y += Math.sin(angle) * segment;
        context.lineTo(x, y);
        if (ray.depth > 0 && random() < 0.45) {
          pending.push({ x, y, angle: angle + (random() < 0.5 ? -0.9 : 0.9), length: ray.length * 0.4, width: ray.width * 0.6, depth: ray.depth - 1 });
        }
      }
      context.stroke();
    }
    context.fillStyle = "#ffffff";
    context.beginPath();
    context.arc(centre, centre, 9, 0, Math.PI * 2);
    context.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  return texture;
}

/** Clusters of dead pixels, white on transparent: the terminal style's landing mark. */
function makeGlitchTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d");
  if (context) {
    let seed = 11;
    const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    context.fillStyle = "#ffffff";
    const cell = 16;
    for (let i = 0; i < 90; i += 1) {
      const angle = random() * Math.PI * 2;
      const distance = Math.pow(random(), 1.6) * 108;
      const x = Math.floor((size / 2 + Math.cos(angle) * distance) / cell) * cell;
      const y = Math.floor((size / 2 + Math.sin(angle) * distance) / cell) * cell;
      const w = cell * (1 + Math.floor(random() * 3));
      context.globalAlpha = 0.45 + random() * 0.55;
      context.fillRect(x, y, w, cell);
    }
    context.globalAlpha = 1;
    context.fillRect(size / 2 - cell * 1.5, size / 2 - cell / 2, cell * 3, cell);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  return texture;
}

interface Crack {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  age: number;
}

/** Draws telegraph decals, live hitboxes, landing cracks and projectiles from sim state. Meshes are pooled per frame. */
export function createHazardView(scene: THREE.Scene) {
  const group = new THREE.Group();
  scene.add(group);
  const pool: { mesh: THREE.Mesh; material: THREE.ShaderMaterial }[] = [];
  let used = 0;
  const accent = new THREE.Color(0xff3b5c);
  const projectileMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const projectileHalo = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const tokenMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const tokenTrail = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const projectiles: THREE.Mesh[] = [];
  let projectilesUsed = 0;
  let style: HazardStyle = "void";
  const unit = {
    disc: new THREE.CircleGeometry(1, 48),
    ring: new THREE.RingGeometry(0.5, 1, 64),
    quad: new THREE.PlaneGeometry(1, 1),
    sphere: new THREE.SphereGeometry(1, 12, 10),
    token: new THREE.BoxGeometry(1, 1, 1),
  };
  const crackTexture = makeCrackTexture();
  const glitchTexture = makeGlitchTexture();
  const cracks: Crack[] = [];
  const seenHazards = new Set<number>();
  let lastTimeMs = 0;

  const take = (geometry: THREE.BufferGeometry): { mesh: THREE.Mesh; material: THREE.ShaderMaterial } => {
    let entry = pool[used];
    if (!entry) {
      const material = makeDecalMaterial();
      const mesh = new THREE.Mesh(unit.disc, material);
      entry = { mesh, material };
      pool.push(entry);
      group.add(mesh);
    }
    used += 1;
    entry.mesh.geometry = geometry;
    entry.mesh.visible = true;
    entry.mesh.rotation.set(-Math.PI / 2, 0, 0);
    entry.mesh.scale.set(1, 1, 1);
    entry.material.uniforms.uColor!.value = accent;
    entry.material.uniforms.uHalfAngle!.value = Math.PI;
    entry.material.uniforms.uEdge!.value = EDGE;
    entry.material.uniforms.uStyle!.value = style === "terminal" ? STYLE_TERMINAL : STYLE_VOID;
    entry.material.uniforms.uTime!.value = lastTimeMs / 1000;
    return entry;
  };

  const place = (shape: HazardShape, progress: number, flash: number, pulse: number, opacity: number) => {
    let entry: { mesh: THREE.Mesh; material: THREE.ShaderMaterial };
    switch (shape.kind) {
      case "circle": {
        entry = take(unit.disc);
        entry.mesh.position.set(shape.center.x, Y, shape.center.z);
        entry.mesh.scale.setScalar(shape.radius);
        entry.material.uniforms.uKind!.value = KIND_DISC;
        (entry.material.uniforms.uSize!.value as THREE.Vector2).set(shape.radius, shape.radius);
        break;
      }
      case "arc": {
        const geometry = new THREE.CircleGeometry(1, 40, -shape.halfAngle, shape.halfAngle * 2);
        entry = take(geometry);
        entry.mesh.position.set(shape.center.x, Y, shape.center.z);
        // CircleGeometry starts at +X; rotate so the arc centre points along dir (x, z) on the ground plane.
        entry.mesh.rotation.z = -Math.atan2(shape.dir.z, shape.dir.x);
        entry.mesh.scale.setScalar(shape.radius);
        entry.mesh.userData.disposable = geometry;
        entry.material.uniforms.uKind!.value = KIND_DISC;
        entry.material.uniforms.uHalfAngle!.value = shape.halfAngle;
        (entry.material.uniforms.uSize!.value as THREE.Vector2).set(shape.radius, shape.radius);
        break;
      }
      case "line": {
        entry = take(unit.quad);
        entry.mesh.position.set(shape.start.x + (shape.dir.x * shape.length) / 2, Y, shape.start.z + (shape.dir.z * shape.length) / 2);
        entry.mesh.rotation.z = -Math.atan2(shape.dir.z, shape.dir.x);
        entry.mesh.scale.set(shape.length, shape.halfWidth * 2, 1);
        entry.material.uniforms.uKind!.value = KIND_QUAD;
        (entry.material.uniforms.uSize!.value as THREE.Vector2).set(shape.length, shape.halfWidth * 2);
        break;
      }
      case "ring": {
        entry = take(unit.ring);
        entry.mesh.position.set(shape.center.x, Y, shape.center.z);
        const outer = shape.radius + shape.thickness / 2;
        const inner = Math.max(0.01, shape.radius - shape.thickness / 2);
        entry.mesh.scale.setScalar(outer);
        entry.material.uniforms.uKind!.value = KIND_RING;
        (entry.material.uniforms.uSize!.value as THREE.Vector2).set(outer, Math.max(inner, outer * 0.5));
        entry.material.uniforms.uEdge!.value = Math.min(EDGE, shape.thickness * 0.3);
        break;
      }
    }
    entry.material.uniforms.uProgress!.value = progress;
    entry.material.uniforms.uFlash!.value = flash;
    entry.material.uniforms.uPulse!.value = pulse;
    entry.material.uniforms.uOpacity!.value = opacity;
  };

  const spawnCrack = (shape: HazardShape) => {
    let crack = cracks.find((c) => !c.mesh.visible);
    if (!crack) {
      const material = new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: crackTexture, transparent: true, depthWrite: false, opacity: 0 });
      const mesh = new THREE.Mesh(unit.disc, material);
      mesh.rotation.x = -Math.PI / 2;
      crack = { mesh, material, age: 0 };
      cracks.push(crack);
      group.add(mesh);
    }
    let x = 0;
    let z = 0;
    let radius = 1;
    switch (shape.kind) {
      case "circle": x = shape.center.x; z = shape.center.z; radius = shape.radius * 0.8; break;
      case "arc": x = shape.center.x + shape.dir.x * shape.radius * 0.45; z = shape.center.z + shape.dir.z * shape.radius * 0.45; radius = shape.radius * 0.55; break;
      case "line": x = shape.start.x + shape.dir.x * shape.length * 0.6; z = shape.start.z + shape.dir.z * shape.length * 0.6; radius = shape.halfWidth * 2.6; break;
      case "ring": return;
    }
    crack.mesh.position.set(x, Y - 0.02, z);
    crack.mesh.rotation.z = style === "terminal" ? 0 : Math.random() * Math.PI * 2;
    crack.mesh.scale.setScalar(radius);
    crack.material.alphaMap = style === "terminal" ? glitchTexture : crackTexture;
    crack.material.needsUpdate = true;
    crack.mesh.visible = true;
    crack.age = 0;
    crack.material.color.copy(accent).lerp(new THREE.Color(0x000000), 0.55);
  };

  const sync = (state: BattleState) => {
    for (const entry of pool) {
      const disposable = entry.mesh.userData.disposable as THREE.BufferGeometry | undefined;
      if (disposable) { disposable.dispose(); delete entry.mesh.userData.disposable; }
    }
    used = 0;
    projectilesUsed = 0;
    const dtMs = state.timeMs >= lastTimeMs ? state.timeMs - lastTimeMs : 0;
    lastTimeMs = state.timeMs;
    if (state.timeMs < 50) seenHazards.clear();

    const current = state.boss.current;
    if (current?.phase === "telegraph") {
      const shape = previewShape(current, state.boss, state.arena.radius);
      if (shape) {
        const u = current.t / current.telegraphMs;
        place(shape, u, 0, 0, 0.55 + 0.45 * u);
      }
    }
    for (const h of state.hazards) {
      if (h.armT > 0) {
        // Arena pulses telegraph like boss moves: a filling decal that only becomes a hazard once armed.
        const u = 1 - h.armT / h.armMs;
        place(h.shape, u, 0, 0, 0.5 + 0.5 * u);
        continue;
      }
      if (!seenHazards.has(h.id)) {
        seenHazards.add(h.id);
        if (h.source !== "ring") spawnCrack(h.shape);
      }
      if (h.repeat) {
        const pulse = 0.5 + 0.5 * Math.sin(state.timeMs / 140);
        const settle = Math.min(1, Math.max(0, MOVE.zone.ttlMs - h.ttl) / 260);
        place(h.shape, 0, 1 - settle, pulse, 0.9);
      } else {
        const life = Math.min(1, h.ttl / 220);
        if (h.source === "ring") place(h.shape, 0, 0.35, 0.5 + 0.5 * Math.sin(state.timeMs / 60), 1);
        else place(h.shape, 0, Math.min(1, life * 1.3), 0, 0.85 + 0.15 * life);
      }
    }
    const terminal = style === "terminal";
    for (const p of state.projectiles) {
      let core = projectiles[projectilesUsed * 2];
      let halo = projectiles[projectilesUsed * 2 + 1];
      if (!core || !halo) {
        core = new THREE.Mesh(unit.sphere, projectileMat);
        halo = new THREE.Mesh(unit.sphere, projectileHalo);
        projectiles.push(core, halo);
        group.add(core, halo);
      }
      projectilesUsed += 1;
      core.visible = halo.visible = true;
      const height = state.flat ? p.y : 1.2;
      core.position.set(p.pos.x, height, p.pos.z);
      if (terminal) {
        // A line of code in flight: a bright token stretched along its velocity with an additive trail behind it.
        const speed = Math.hypot(p.vel.x, p.vel.z) || 1;
        const yaw = Math.atan2(p.vel.x, p.vel.z);
        core.geometry = unit.token;
        core.material = tokenMat;
        core.rotation.set(0, yaw, 0);
        core.scale.set(p.radius * 0.5, p.radius * 0.5, p.radius * 2.4);
        halo.geometry = unit.token;
        halo.material = tokenTrail;
        halo.rotation.set(0, yaw, 0);
        halo.position.set(p.pos.x - (p.vel.x / speed) * p.radius * 2.6, height, p.pos.z - (p.vel.z / speed) * p.radius * 2.6);
        halo.scale.set(p.radius * 0.28, p.radius * 0.28, p.radius * 4.2);
      } else {
        core.geometry = unit.sphere;
        core.material = projectileMat;
        core.rotation.set(0, 0, 0);
        core.scale.setScalar(p.radius * 0.7);
        halo.geometry = unit.sphere;
        halo.material = projectileHalo;
        halo.rotation.set(0, 0, 0);
        halo.position.copy(core.position);
        halo.scale.setScalar(p.radius * 1.5);
      }
    }
    for (let i = projectilesUsed * 2; i < projectiles.length; i += 1) { const m = projectiles[i]; if (m) m.visible = false; }
    for (let i = used; i < pool.length; i += 1) { const entry = pool[i]; if (entry) entry.mesh.visible = false; }

    for (const crack of cracks) {
      if (!crack.mesh.visible) continue;
      crack.age += dtMs;
      const u = crack.age / CRACK_MS;
      if (u >= 1) { crack.mesh.visible = false; continue; }
      crack.material.opacity = (1 - u * u) * 0.9;
    }
  };

  const setAccent = (hex: string) => {
    accent.set(hex);
    projectileHalo.color.copy(accent);
    tokenTrail.color.copy(accent);
    tokenMat.color.copy(accent).lerp(new THREE.Color(0xffffff), 0.6);
  };

  const setStyle = (next: HazardStyle) => {
    style = next;
  };

  return { sync, setAccent, setStyle };
}
