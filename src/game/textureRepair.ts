import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import armorUrl from "../../blender/art/textures/armor.jpg?url";
import armorNormalUrl from "../../blender/art/textures/armor_n.jpg?url";
import boneUrl from "../../blender/art/textures/bone.jpg?url";
import boneNormalUrl from "../../blender/art/textures/bone_n.jpg?url";
import clothUrl from "../../blender/art/textures/cloth.jpg?url";
import clothNormalUrl from "../../blender/art/textures/cloth_n.jpg?url";
import hideUrl from "../../blender/art/textures/hide.jpg?url";
import hideNormalUrl from "../../blender/art/textures/hide_n.jpg?url";
import rockUrl from "../../blender/art/textures/rock.jpg?url";
import rockNormalUrl from "../../blender/art/textures/rock_n.jpg?url";
import sigilUrl from "../../blender/art/textures/sigil.jpg?url";
import stoneFloorUrl from "../../blender/art/textures/stone_floor.jpg?url";
import stoneFloorNormalUrl from "../../blender/art/textures/stone_floor_n.jpg?url";

/**
 * Source textures keyed by the image name Blender gives them. Downsampled copies made inside
 * Blender (`<name>_512`) are exported as solid black by the glTF exporter unless they are packed,
 * so GLBs built before that fix ship blank textures; this map lets the runtime swap them for the originals.
 */
const SOURCES: Record<string, string> = {
  armor: armorUrl,
  armor_n: armorNormalUrl,
  bone: boneUrl,
  bone_n: boneNormalUrl,
  cloth: clothUrl,
  cloth_n: clothNormalUrl,
  hide: hideUrl,
  hide_n: hideNormalUrl,
  rock: rockUrl,
  rock_n: rockNormalUrl,
  sigil: sigilUrl,
  stone_floor: stoneFloorUrl,
  stone_floor_n: stoneFloorNormalUrl,
};

const SAMPLE = 8;
const probe = typeof document === "undefined" ? null : document.createElement("canvas");
if (probe) probe.width = probe.height = SAMPLE;
const probeContext = probe?.getContext("2d", { willReadFrequently: true }) ?? null;

type Drawable = Exclude<CanvasImageSource, SVGImageElement | VideoFrame>;

function isBlank(texture: THREE.Texture): boolean {
  if (!probeContext) return false;
  const image = texture.image as Drawable | null | undefined;
  if (!image || !("width" in image) || !image.width) return false;
  try {
    probeContext.clearRect(0, 0, SAMPLE, SAMPLE);
    probeContext.drawImage(image, 0, 0, SAMPLE, SAMPLE);
  } catch {
    return false;
  }
  const data = probeContext.getImageData(0, 0, SAMPLE, SAMPLE).data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i]! > 3 || data[i + 1]! > 3 || data[i + 2]! > 3) return false;
  }
  return true;
}

function sourceFor(texture: THREE.Texture): string | null {
  const name = texture.name || (texture.image as { name?: string } | undefined)?.name || "";
  const base = name.replace(/_\d+$/, "");
  return SOURCES[base] ?? null;
}

const loader = new THREE.TextureLoader();
const repaired = new Map<string, THREE.Texture>();

function replacement(texture: THREE.Texture, url: string, colorSpace: string): THREE.Texture {
  const key = `${url}:${colorSpace}`;
  let fixed = repaired.get(key);
  if (!fixed) {
    fixed = loader.load(url);
    fixed.name = texture.name;
    fixed.flipY = false;
    fixed.wrapS = texture.wrapS;
    fixed.wrapT = texture.wrapT;
    fixed.colorSpace = colorSpace;
    fixed.anisotropy = 4;
    repaired.set(key, fixed);
  }
  return fixed;
}

/** Replace any all-black map/normalMap in a loaded GLB with the matching source texture. Returns how many were swapped. */
export function repairBlankTextures(gltf: GLTF): number {
  let count = 0;
  const seen = new Set<THREE.Material>();
  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (seen.has(material)) continue;
      seen.add(material);
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      if (material.map && isBlank(material.map)) {
        const url = sourceFor(material.map);
        if (url) {
          material.map = replacement(material.map, url, THREE.SRGBColorSpace);
          material.needsUpdate = true;
          count += 1;
        }
      }
      if (material.normalMap && isBlank(material.normalMap)) {
        const url = sourceFor(material.normalMap);
        if (url) {
          material.normalMap = replacement(material.normalMap, url, THREE.NoColorSpace);
          material.needsUpdate = true;
          count += 1;
        }
      }
    }
  });
  return count;
}
