import * as THREE from "three";
import { addOutline, createToonMaterial } from "./materials";
import type { Palette } from "./render/palette";
import { ARENA_RADIUS, FLAT } from "../sim";

/** Lane tiles run the whole arena width; four-high walls cap both ends where the ring used to be. */
const TILE_SPAN = Math.ceil(ARENA_RADIUS) + 1;
const WALL_HEIGHT = 4;
/** Reward blocks hang just above the jump apex, so they are always a hair out of reach. */
const BLOCK_X = [-14, -8, -2, 5, 11, 17];
const BLOCK_Y = FLAT.jumpVelocity ** 2 / (2 * FLAT.gravity) + 1.7;

const easeInOut = (t: number) => t * t * (3 - 2 * t);

export interface FlatlineSet {
  readonly group: THREE.Group;
  setPalette(palette: Palette): void;
  /** Portrait of the bound nightmare for the reward blocks; null falls back to a plain question mark. */
  setPortrait(url: string | null): void;
  /** `amount` is the 0..1 collapse blend; tiles rise from below the floor as it grows. */
  update(amount: number, elapsed: number): void;
  dispose(): void;
}

function drawBlockFace(canvas: HTMLCanvasElement, palette: Palette, portrait: HTMLImageElement | null): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  const size = canvas.width;
  context.imageSmoothingEnabled = false;
  context.fillStyle = palette.deep;
  context.fillRect(0, 0, size, size);
  if (portrait) {
    // Downsample hard so the portrait reads as a 16px sprite of the boss, not a photo.
    const tiny = document.createElement("canvas");
    tiny.width = tiny.height = 16;
    const tinyContext = tiny.getContext("2d");
    if (tinyContext) {
      tinyContext.drawImage(portrait, 0, 0, 16, 16);
      context.globalAlpha = 0.75;
      context.drawImage(tiny, 4, 4, size - 8, size - 8);
      context.globalAlpha = 1;
    }
  }
  context.strokeStyle = palette.accent;
  context.lineWidth = 4;
  context.strokeRect(2, 2, size - 4, size - 4);
  context.fillStyle = palette.hot;
  context.font = `bold ${Math.round(size * 0.7)}px "IBM Plex Mono", monospace`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("?", size / 2, size / 2 + size * 0.04);
}

export function createFlatlineSet(initial: Palette): FlatlineSet {
  const group = new THREE.Group();
  group.name = "Flatline";
  group.visible = false;

  const tileGeometry = new THREE.BoxGeometry(1, 1, 1);
  const tileMaterial = createToonMaterial(initial.floor, initial.deep, { rim: 0.5 });
  const outlineMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide });
  const slots: { x: number; y: number; delay: number }[] = [];
  for (let x = -TILE_SPAN; x <= TILE_SPAN; x += 1) slots.push({ x, y: -0.5, delay: Math.abs(x) / TILE_SPAN });
  for (let level = 0; level < WALL_HEIGHT; level += 1) {
    slots.push({ x: -TILE_SPAN, y: level + 0.5, delay: 1 + level * 0.12 }, { x: TILE_SPAN, y: level + 0.5, delay: 1 + level * 0.12 });
  }
  const tiles = new THREE.InstancedMesh(tileGeometry, tileMaterial, slots.length);
  const tileOutlines = new THREE.InstancedMesh(tileGeometry, outlineMaterial, slots.length);
  tiles.frustumCulled = tileOutlines.frustumCulled = false;
  group.add(tiles, tileOutlines);

  const faceCanvas = document.createElement("canvas");
  faceCanvas.width = faceCanvas.height = 64;
  const faceTexture = new THREE.CanvasTexture(faceCanvas);
  faceTexture.colorSpace = THREE.SRGBColorSpace;
  faceTexture.magFilter = faceTexture.minFilter = THREE.NearestFilter;
  faceTexture.generateMipmaps = false;
  const blockMaterial = new THREE.MeshBasicMaterial({ map: faceTexture, toneMapped: false });
  const blockGeometry = new THREE.BoxGeometry(1.1, 1.1, 1.1);
  const blocks = BLOCK_X.map((x, i) => {
    const block = new THREE.Mesh(blockGeometry, blockMaterial);
    block.position.set(x, BLOCK_Y, 0);
    block.userData.phase = i * 1.3;
    addOutline(block, 0.06);
    group.add(block);
    return block;
  });

  let palette = initial;
  let portrait: HTMLImageElement | null = null;
  let portraitRequest = 0;
  const redraw = () => {
    drawBlockFace(faceCanvas, palette, portrait);
    faceTexture.needsUpdate = true;
  };
  redraw();

  const matrix = new THREE.Matrix4();
  const outlineScale = new THREE.Vector3(1.05, 1.05, 1.05);
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const unit = new THREE.Vector3(1, 1, 1);
  let lastAmount = -1;

  return {
    group,
    setPalette(next) {
      palette = next;
      tileMaterial.color.set(next.floor);
      tileMaterial.emissive.set(next.deep);
      redraw();
    },
    setPortrait(url) {
      const request = ++portraitRequest;
      portrait = null;
      redraw();
      if (!url) return;
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.onload = () => {
        if (request !== portraitRequest) return;
        portrait = image;
        redraw();
      };
      image.src = url;
    },
    update(amount, elapsed) {
      group.visible = amount > 0.001;
      if (!group.visible) {
        lastAmount = -1;
        return;
      }
      if (amount !== lastAmount) {
        lastAmount = amount;
        slots.forEach((slot, i) => {
          const rise = easeInOut(THREE.MathUtils.clamp(amount * 2.2 - slot.delay * 0.9, 0, 1));
          position.set(slot.x, slot.y - (1 - rise) * 4, 0);
          tiles.setMatrixAt(i, matrix.compose(position, rotation, unit));
          tileOutlines.setMatrixAt(i, matrix.compose(position, rotation, outlineScale));
        });
        tiles.instanceMatrix.needsUpdate = tileOutlines.instanceMatrix.needsUpdate = true;
      }
      const drop = (1 - easeInOut(amount)) * 6;
      for (const block of blocks) {
        const phase = block.userData.phase as number;
        block.position.y = BLOCK_Y + drop + Math.sin(elapsed * 1.1 + phase) * 0.12;
        block.rotation.y = amount >= 1 ? Math.floor(elapsed * 0.5 + phase) * (Math.PI / 2) : 0;
      }
    },
    dispose() {
      tileGeometry.dispose();
      blockGeometry.dispose();
      tileMaterial.dispose();
      outlineMaterial.dispose();
      blockMaterial.dispose();
      faceTexture.dispose();
      for (const block of blocks) {
        for (const child of block.children) {
          if (child instanceof THREE.Mesh && child.material instanceof THREE.Material) child.material.dispose();
        }
      }
    },
  };
}
