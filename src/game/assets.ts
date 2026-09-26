import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import arenaUrl from "../assets/models/arena.glb?url";
import playerUrl from "../assets/models/player.glb?url";
import colossusUrl from "../assets/models/boss_colossus.glb?url";
import houndUrl from "../assets/models/boss_hound.glb?url";
import seraphUrl from "../assets/models/boss_seraph.glb?url";
import serpentUrl from "../assets/models/boss_serpent.glb?url";
import knightUrl from "../assets/models/boss_knight.glb?url";
import swarmUrl from "../assets/models/boss_swarm.glb?url";
import { addOutline, createToonMaterial } from "./materials";
import { repairBlankTextures } from "./textureRepair";
import type { Silhouette } from "../spec/types";

export type MaterialRole =
  | "deep" | "shade" | "accent" | "bone" | "stone" | "stone_dark"
  | "cloth" | "cloth_dark" | "metal" | "glow";

const roles = new Set<MaterialRole>([
  "deep", "shade", "accent", "bone", "stone", "stone_dark",
  "cloth", "cloth_dark", "metal", "glow",
]);

export function materialRole(name: string): MaterialRole | null {
  const candidate = name.replace(/\.\d+$/, "");
  return roles.has(candidate as MaterialRole) ? candidate as MaterialRole : null;
}

export const BOSS_MODEL_URLS: Record<Silhouette, string> = {
  colossus: colossusUrl,
  hound: houndUrl,
  seraph: seraphUrl,
  serpent: serpentUrl,
  knight: knightUrl,
  swarm: swarmUrl,
};

export interface AssetLibrary {
  arena: GLTF;
  player: GLTF;
  /** Boss models arrive on demand; only silhouettes that have been summoned are present. */
  bosses: Partial<Record<Silhouette, GLTF>>;
  loadBoss(silhouette: Silhouette, onProgress?: (fraction: number) => void): Promise<GLTF>;
}

/** Arena and player block first paint; each boss GLB is fetched the first time its silhouette is summoned. */
export async function loadAssetLibrary(): Promise<AssetLibrary> {
  const loader = new GLTFLoader();
  const [arena, player] = await Promise.all([loader.loadAsync(arenaUrl), loader.loadAsync(playerUrl)]);
  repairBlankTextures(arena);
  repairBlankTextures(player);
  const bosses: Partial<Record<Silhouette, GLTF>> = {};
  const pending = new Map<Silhouette, Promise<GLTF>>();
  const loadBoss = (silhouette: Silhouette, onProgress?: (fraction: number) => void): Promise<GLTF> => {
    const cached = bosses[silhouette];
    if (cached) {
      onProgress?.(1);
      return Promise.resolve(cached);
    }
    let request = pending.get(silhouette);
    if (!request) {
      request = loader
        .loadAsync(BOSS_MODEL_URLS[silhouette], (event) => {
          if (event.lengthComputable && event.total > 0) onProgress?.(Math.min(1, event.loaded / event.total));
        })
        .then((gltf) => {
          repairBlankTextures(gltf);
          bosses[silhouette] = gltf;
          pending.delete(silhouette);
          onProgress?.(1);
          return gltf;
        }, (error: unknown) => {
          pending.delete(silhouette);
          throw error;
        });
      pending.set(silhouette, request);
    }
    return request;
  };
  return { arena, player, bosses, loadBoss };
}

export function instantiate(
  template: GLTF,
  palette: readonly string[],
  options: { outline?: number; player?: boolean } = {},
): THREE.Object3D {
  const clone = template.scene.clone(true);
  clone.userData.assetClone = true;
  const [, accentHex = "#e9e4d8", deepHex = "#25212d"] = palette;
  const accent = new THREE.Color(options.player ? "#e9e4d8" : accentHex);
  const deep = new THREE.Color(deepHex);
  const shade = deep.clone().multiplyScalar(0.36);
  const colors: Record<MaterialRole, THREE.Color> = {
    deep,
    shade,
    accent,
    bone: new THREE.Color("#d9d2c3"),
    stone: new THREE.Color("#2a2c38"),
    stone_dark: new THREE.Color("#14161f"),
    cloth: new THREE.Color(options.player ? "#4a4c60" : "#1c1c26"),
    cloth_dark: new THREE.Color(options.player ? "#2a2b3a" : "#0b0b10"),
    metal: new THREE.Color(options.player ? "#8d93a6" : "#5a5f6e"),
    glow: accent.clone(),
  };
  const playerEmissive = new THREE.Color("#141626");
  const shared = new Map<string, THREE.Material>();
  const outlineMaterial = new THREE.MeshBasicMaterial({ color: 0x030308, side: THREE.BackSide });
  clone.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const source = Array.isArray(object.material) ? object.material[0] : object.material;
    const textured = source as THREE.MeshStandardMaterial;
    const map = textured.map ?? undefined;
    const normalMap = textured.normalMap ?? undefined;
    const role = materialRole(source.name);
    if (!role) return;
    object.userData.materialRole = role;
    const isSigil = role === "glow" && object.name.toLowerCase().includes("sigil") && !!map;
    const isFracture = role === "glow" && object.name.toLowerCase().includes("fracture");
    const materialKey = `${role}:${isSigil ? "sigil" : isFracture ? "fracture" : ""}`;
    let mapped = shared.get(materialKey);
    if (!mapped) {
      if (role === "accent" || role === "glow") {
        if (isSigil && map) {
          map.colorSpace = THREE.NoColorSpace;
          mapped = new THREE.MeshBasicMaterial({
            color: colors.glow,
            alphaMap: map,
            transparent: true,
            opacity: 0.3,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            toneMapped: false,
          });
        } else {
          if (map) map.colorSpace = THREE.SRGBColorSpace;
          mapped = new THREE.MeshBasicMaterial({
            color: colors[role],
            ...(map ? { map } : {}),
            fog: role !== "glow",
            transparent: isFracture,
            opacity: isFracture ? 0.14 : 1,
            depthWrite: !isFracture,
            blending: isFracture ? THREE.AdditiveBlending : THREE.NormalBlending,
            toneMapped: false,
          });
        }
      } else {
        mapped = createToonMaterial(colors[role], options.player ? playerEmissive : 0x000000, { map, normalMap });
      }
      shared.set(materialKey, mapped);
    }
    object.material = mapped;
    if (role !== "accent" && role !== "glow" && options.outline !== 0 && !object.name.toLowerCase().includes("shard")) {
      if (!object.geometry.boundingSphere) object.geometry.computeBoundingSphere();
      const scale = Math.max(Math.abs(object.scale.x), Math.abs(object.scale.y), Math.abs(object.scale.z));
      if ((object.geometry.boundingSphere?.radius ?? 0) * scale >= 0.15) {
        const thickness = map || normalMap ? Math.min(options.outline ?? 0.024, 0.03) : options.outline ?? 0.024;
        const outline = addOutline(object, thickness, 0x030308);
        (outline.material as THREE.Material).dispose();
        outline.material = outlineMaterial;
      }
    }
  });
  clone.userData.sharedMaterials = [...shared.values(), outlineMaterial];
  return clone;
}
