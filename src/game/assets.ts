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
import { SILHOUETTES, type Silhouette } from "../spec/types";

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
  bosses: Record<Silhouette, GLTF>;
}

export async function loadAssetLibrary(): Promise<AssetLibrary> {
  const loader = new GLTFLoader();
  const [arena, player, ...bosses] = await Promise.all([
    loader.loadAsync(arenaUrl),
    loader.loadAsync(playerUrl),
    ...SILHOUETTES.map((silhouette) => loader.loadAsync(BOSS_MODEL_URLS[silhouette])),
  ]);
  if (!arena || !player || bosses.length !== SILHOUETTES.length) {
    throw new Error("The model library is incomplete.");
  }
  return {
    arena,
    player,
    bosses: Object.fromEntries(SILHOUETTES.map((silhouette, index) => [silhouette, bosses[index]!])) as Record<Silhouette, GLTF>,
  };
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
    cloth: new THREE.Color("#1c1c26"),
    cloth_dark: new THREE.Color("#0b0b10"),
    metal: new THREE.Color("#5a5f6e"),
    glow: accent.clone(),
  };
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
            opacity: 0.82,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            toneMapped: false,
          });
        } else {
          if (map) map.colorSpace = THREE.SRGBColorSpace;
          mapped = new THREE.MeshBasicMaterial({
            color: colors[role],
            map,
            fog: role !== "glow",
            transparent: isFracture,
            opacity: isFracture ? 0.24 : 1,
            depthWrite: !isFracture,
            blending: isFracture ? THREE.AdditiveBlending : THREE.NormalBlending,
            toneMapped: role === "glow",
          });
        }
      } else {
        mapped = createToonMaterial(colors[role], 0x000000, { map, normalMap });
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
