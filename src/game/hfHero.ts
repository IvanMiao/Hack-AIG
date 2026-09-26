import * as THREE from "three";
import { addOutline, createToonMaterial } from "./materials";
import type { PlayerAction } from "../sim";

/**
 * The Hugging Face hero: a round yellow mascot built entirely from Three.js primitives and animated
 * procedurally (idle breathing, blink, walk/run cycle, attack follow-through, roll tuck, hit squash).
 * Faces +Z like every other player visual; the bone blade pivot at (0.47, 0.9, 0.12) sits in its right hand.
 */
export interface HFHero {
  root: THREE.Group;
  update(dt: number, ctx: HFHeroContext): void;
}

export interface HFHeroContext {
  /** world units per second */
  speed: number;
  action: PlayerAction;
  /** ms into the current action */
  actionT: number;
  hitFlash: number;
  /** blade pivot rotation from the stage pose, so the sword arm follows the weapon */
  bladeX: number;
  bladeZ: number;
  charge: number;
  reducedMotion: boolean;
}

export const HF_HERO_COLORS = {
  skin: "#b88a12",
  skinShade: "#9a7208",
  hoodie: "#a85f00",
  hoodieDark: "#874800",
  face: "#2a1a08",
  blush: "#ff8a7a",
  shoe: "#3a2a1c",
  sole: "#f4efe6",
  highlight: "#ffffff",
} as const;

const HEAD_Y = 1.5;
const HEAD_R = 0.42;
const HIP_Y = 0.6;

const damp = (current: number, target: number, lambda: number, dt: number) =>
  THREE.MathUtils.lerp(current, target, 1 - Math.exp(-lambda * dt));

interface Limb {
  upper: THREE.Group;
  lower: THREE.Group;
}

// Albedo is kept well under 1 so the scene lights push it to yellow rather than into bloom.
function part(geometry: THREE.BufferGeometry, color: string, outline = 0.035, role: "cloth" | "cloth_dark" = "cloth"): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, createToonMaterial(color, 0x000000, { rim: 0.45 }));
  mesh.userData.materialRole = role;
  if (outline > 0) addOutline(mesh, outline, 0x1a1006);
  return mesh;
}

function flat(color: string): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, toneMapped: false });
}

function buildArm(side: -1 | 1): Limb {
  const upper = new THREE.Group();
  upper.position.set(side * 0.34, 1.1, 0);
  const shoulder = part(new THREE.SphereGeometry(0.1, 12, 10), HF_HERO_COLORS.hoodie, 0.04, "cloth_dark");
  const upperArm = part(new THREE.CapsuleGeometry(0.075, 0.24, 6, 12), HF_HERO_COLORS.hoodie, 0.04, "cloth_dark");
  upperArm.position.y = -0.17;
  upper.add(shoulder, upperArm);
  const lower = new THREE.Group();
  lower.position.y = -0.32;
  const cuff = part(new THREE.CylinderGeometry(0.085, 0.075, 0.06, 12), HF_HERO_COLORS.hoodieDark, 0.04, "cloth_dark");
  cuff.position.y = -0.02;
  const forearm = part(new THREE.CapsuleGeometry(0.065, 0.16, 6, 12), HF_HERO_COLORS.hoodie, 0.04, "cloth_dark");
  forearm.position.y = -0.14;
  const hand = part(new THREE.SphereGeometry(0.1, 14, 12), HF_HERO_COLORS.skin, 0.04);
  hand.scale.set(1, 0.9, 0.8);
  hand.position.y = -0.28;
  const thumb = part(new THREE.CapsuleGeometry(0.03, 0.05, 4, 8), HF_HERO_COLORS.skin, 0.03);
  thumb.position.set(side * -0.08, -0.25, 0.05);
  thumb.rotation.z = side * 0.9;
  lower.add(cuff, forearm, hand, thumb);
  upper.add(lower);
  return { upper, lower };
}

function buildLeg(side: -1 | 1): Limb {
  const upper = new THREE.Group();
  upper.position.set(side * 0.15, HIP_Y, 0);
  const thigh = part(new THREE.CapsuleGeometry(0.095, 0.16, 6, 12), HF_HERO_COLORS.hoodieDark, 0.04, "cloth_dark");
  thigh.position.y = -0.12;
  upper.add(thigh);
  const lower = new THREE.Group();
  lower.position.y = -0.26;
  const shin = part(new THREE.CapsuleGeometry(0.075, 0.12, 6, 12), HF_HERO_COLORS.skin, 0.04);
  shin.position.y = -0.08;
  const shoe = part(new THREE.SphereGeometry(0.13, 14, 10), HF_HERO_COLORS.shoe, 0.04, "cloth_dark");
  shoe.scale.set(0.95, 0.62, 1.35);
  shoe.position.set(0, -0.22, 0.05);
  const sole = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 10), flat(HF_HERO_COLORS.sole));
  sole.scale.set(0.98, 0.2, 1.38);
  sole.position.set(0, -0.28, 0.05);
  lower.add(shin, shoe, sole);
  upper.add(lower);
  return { upper, lower };
}

export function createHFHero(): HFHero {
  const root = new THREE.Group();
  root.name = "HF hero";

  // Hips carry every bob/squash so feet stay planted relative to the body.
  const hips = new THREE.Group();
  root.add(hips);

  const torso = part(new THREE.CapsuleGeometry(0.3, 0.26, 8, 18), HF_HERO_COLORS.hoodie, 0.04, "cloth_dark");
  torso.position.y = 0.92;
  torso.scale.set(1, 1, 0.86);
  const pocket = part(new THREE.BoxGeometry(0.3, 0.14, 0.08), HF_HERO_COLORS.hoodieDark, 0.03, "cloth_dark");
  pocket.position.set(0, 0.74, 0.25);
  const hoodBack = part(new THREE.SphereGeometry(0.24, 16, 12, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5), HF_HERO_COLORS.hoodieDark, 0.04, "cloth_dark");
  hoodBack.scale.set(1.15, 0.7, 0.9);
  hoodBack.position.set(0, 1.28, -0.1);
  hoodBack.rotation.x = Math.PI;
  const collar = part(new THREE.TorusGeometry(0.2, 0.05, 8, 20), HF_HERO_COLORS.hoodieDark, 0.04, "cloth_dark");
  collar.rotation.x = Math.PI / 2;
  collar.position.y = 1.18;
  for (const side of [-1, 1] as const) {
    const string = new THREE.Mesh(new THREE.CapsuleGeometry(0.014, 0.16, 3, 6), flat(HF_HERO_COLORS.sole));
    string.position.set(side * 0.07, 1.06, 0.29);
    string.rotation.x = 0.15;
    hips.add(string);
  }
  hips.add(torso, pocket, hoodBack, collar);

  const neck = new THREE.Group();
  neck.position.y = 1.2;
  hips.add(neck);
  const head = part(new THREE.SphereGeometry(HEAD_R, 32, 24), HF_HERO_COLORS.skin, 0.03);
  head.position.y = HEAD_Y - 1.2;
  neck.add(head);

  // Hair: a single soft curl on the crown.
  const curl = part(new THREE.TorusGeometry(0.09, 0.028, 8, 20, Math.PI * 1.35), HF_HERO_COLORS.skinShade, 0.03);
  curl.position.set(0.04, HEAD_R + 0.04, -0.02);
  curl.rotation.set(0.2, 0.4, -0.5);
  head.add(curl);

  // Face group sits on the front of the sphere, slightly forward so features never z-fight.
  const face = new THREE.Group();
  face.position.set(0, 0, 0);
  head.add(face);
  const eyes: THREE.Group[] = [];
  const surface = (x: number, y: number) => Math.sqrt(Math.max(0.01, HEAD_R * HEAD_R - x * x - y * y));
  for (const side of [-1, 1] as const) {
    const eye = new THREE.Group();
    const ex = side * 0.16;
    const ey = 0.06;
    eye.position.set(ex, ey, surface(ex, ey) - 0.01);
    eye.lookAt(ex * 2.6, ey * 2.6, 2);
    const iris = new THREE.Mesh(new THREE.SphereGeometry(0.085, 18, 14), flat(HF_HERO_COLORS.face));
    iris.scale.set(1, 1.3, 0.35);
    const shine = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), flat(HF_HERO_COLORS.highlight));
    shine.position.set(side * -0.025, 0.045, 0.028);
    const shineSmall = new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 6), flat(HF_HERO_COLORS.highlight));
    shineSmall.position.set(side * 0.03, -0.03, 0.03);
    eye.add(iris, shine, shineSmall);
    face.add(eye);
    eyes.push(eye);

    const bx = side * 0.29;
    const by = -0.09;
    const blush = new THREE.Mesh(new THREE.CircleGeometry(0.06, 16), new THREE.MeshBasicMaterial({ color: HF_HERO_COLORS.blush, toneMapped: false, transparent: true, opacity: 0.85 }));
    blush.position.set(bx, by, surface(bx, by) + 0.004);
    blush.lookAt(bx * 3, by * 3, 3);
    blush.scale.set(1.25, 0.8, 1);
    face.add(blush);
  }
  const mouth = new THREE.Group();
  mouth.position.set(0, -0.12, surface(0, -0.12) - 0.012);
  const smile = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.022, 8, 24, Math.PI), flat(HF_HERO_COLORS.face));
  smile.rotation.z = Math.PI;
  const grin = new THREE.Mesh(new THREE.CircleGeometry(0.1, 24, Math.PI, Math.PI), flat(HF_HERO_COLORS.face));
  grin.scale.set(1.1, 0.9, 1);
  grin.position.z = -0.004;
  const tongue = new THREE.Mesh(new THREE.CircleGeometry(0.05, 16, Math.PI, Math.PI), flat(HF_HERO_COLORS.blush));
  tongue.position.set(0, -0.005, 0.002);
  tongue.scale.set(1.2, 0.9, 1);
  mouth.add(smile, grin, tongue);
  face.add(mouth);

  const arms: Record<"left" | "right", Limb> = { left: buildArm(-1), right: buildArm(1) };
  const legs: Record<"left" | "right", Limb> = { left: buildLeg(-1), right: buildLeg(1) };
  hips.add(arms.left.upper, arms.right.upper);
  root.add(legs.left.upper, legs.right.upper);

  let time = 0;
  let stride = 0;
  let run = 0;
  let tuck = 0;
  let squash = 0;
  let blinkTimer = 2.4;
  let blink = 0;
  let mouthOpen = 0;
  const swing = { lx: 0, rx: 0, rz: 0, lz: 0, thighL: 0, thighR: 0, kneeL: 0, kneeR: 0 };

  const update = (dt: number, ctx: HFHeroContext) => {
    if (ctx.reducedMotion) dt = 0;
    time += dt;
    const targetRun = THREE.MathUtils.smoothstep(ctx.speed, 0.4, 4.5);
    run = damp(run, targetRun, 10, dt);
    stride += dt * (2.2 + ctx.speed * 1.9);
    const rolling = ctx.action === "roll";
    tuck = damp(tuck, rolling ? 1 : 0, rolling ? 22 : 12, dt);
    const attacking = ctx.action === "light" || ctx.action === "heavy";
    mouthOpen = damp(mouthOpen, attacking ? 1 : 0, 14, dt);

    // Hit reaction: a springy squash that recovers over ~200ms.
    const hitTarget = ctx.hitFlash > 0 ? Math.min(1, ctx.hitFlash / 200) : 0;
    squash = damp(squash, hitTarget, 18, dt);
    hips.scale.set(1 + squash * 0.14, 1 - squash * 0.16, 1 + squash * 0.14);

    // Breathing / run bob.
    const breath = Math.sin(time * 2.4) * 0.012 * (1 - run);
    const bob = Math.abs(Math.sin(stride)) * 0.055 * run;
    hips.position.y = breath + bob - tuck * 0.18;
    hips.rotation.x = run * 0.16 + tuck * 0.5 + ctx.charge * 0.1;
    hips.rotation.z = Math.sin(stride) * 0.04 * run;
    head.rotation.z = Math.sin(time * 1.3) * 0.03 * (1 - run) - Math.sin(stride) * 0.05 * run;
    neck.rotation.x = -run * 0.1 - ctx.charge * 0.18 + tuck * 0.4;
    neck.rotation.y = Math.sin(time * 0.7) * 0.05 * (1 - run);

    // Blink: eyelids are just the eye scaled flat.
    blinkTimer -= dt;
    if (blinkTimer <= 0) {
      blink = 1;
      blinkTimer = 2.2 + Math.random() * 2.4;
    }
    blink = Math.max(0, blink - dt * 9);
    const lidOpen = blink > 0.5 ? (1 - blink) * 2 : blink * 2;
    const eyeScaleY = ctx.hitFlash > 0 ? 0.25 : blink > 0 ? Math.max(0.08, lidOpen) : attacking ? 1.15 : 1;
    for (const eye of eyes) {
      eye.scale.y = damp(eye.scale.y, eyeScaleY, 40, dt);
      eye.scale.x = attacking ? 1.05 : 1;
    }
    mouth.scale.set(1 + mouthOpen * 0.12, 1 + mouthOpen * 0.3, 1);
    grin.visible = mouthOpen > 0.15 || ctx.hitFlash > 0;

    // Limbs: legs alternate, arms counter-swing, everything folds up in a roll.
    const legL = Math.sin(stride);
    const legR = Math.sin(stride + Math.PI);
    swing.thighL = damp(swing.thighL, THREE.MathUtils.lerp(-legL * 0.85 * run, -1.35, tuck), 26, dt);
    swing.thighR = damp(swing.thighR, THREE.MathUtils.lerp(-legR * 0.85 * run, -1.35, tuck), 26, dt);
    swing.kneeL = damp(swing.kneeL, THREE.MathUtils.lerp(Math.max(0, Math.sin(stride + 0.7)) * 1.2 * run, 1.6, tuck), 26, dt);
    swing.kneeR = damp(swing.kneeR, THREE.MathUtils.lerp(Math.max(0, Math.sin(stride + Math.PI + 0.7)) * 1.2 * run, 1.6, tuck), 26, dt);
    legs.left.upper.rotation.x = swing.thighL;
    legs.right.upper.rotation.x = swing.thighR;
    legs.left.lower.rotation.x = swing.kneeL;
    legs.right.lower.rotation.x = swing.kneeR;

    const idleSway = Math.sin(time * 2.4) * 0.05 * (1 - run);
    const leftTarget = THREE.MathUtils.lerp(legR * 0.7 * run + idleSway, -1.4, tuck);
    swing.lx = damp(swing.lx, leftTarget, 22, dt);
    swing.lz = damp(swing.lz, THREE.MathUtils.lerp(0.18 + run * 0.12, 0.9, tuck), 18, dt);
    arms.left.upper.rotation.set(swing.lx, 0, swing.lz);
    arms.left.lower.rotation.x = THREE.MathUtils.lerp(-0.35 - run * 0.7, -1.9, tuck);

    // Sword arm follows the blade pivot so the swing reads from the shoulder, not just the weapon.
    const armX = THREE.MathUtils.lerp(ctx.bladeX * 0.55 - 0.3 + legL * 0.25 * run * (1 - Math.abs(ctx.bladeX)), -1.4, tuck);
    const armZ = THREE.MathUtils.lerp(-0.2 - (ctx.bladeZ + 0.3) * 0.35, -0.9, tuck);
    swing.rx = damp(swing.rx, armX, 30, dt);
    swing.rz = damp(swing.rz, armZ, 30, dt);
    arms.right.upper.rotation.set(swing.rx, 0, swing.rz);
    arms.right.lower.rotation.x = THREE.MathUtils.lerp(-0.6 - Math.abs(ctx.bladeX) * 0.3, -1.9, tuck);
  };

  return { root, update };
}
