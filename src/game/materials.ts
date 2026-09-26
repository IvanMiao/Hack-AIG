import * as THREE from "three";

/** Four-step gradient shared by every toon material. */
const toonGradient = (() => {
  const data = new Uint8Array([
    30, 30, 30, 255,
    90, 90, 90, 255,
    170, 170, 170, 255,
    255, 255, 255, 255,
  ]);
  const texture = new THREE.DataTexture(data, 4, 1, THREE.RGBAFormat);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
})();

export function createToonMaterial(
  color: THREE.ColorRepresentation,
  emissive: THREE.ColorRepresentation = 0x000000,
  options: { map?: THREE.Texture; normalMap?: THREE.Texture } = {},
): THREE.MeshToonMaterial {
  const { map, normalMap } = options;
  if (map) map.colorSpace = THREE.SRGBColorSpace;
  if (normalMap) normalMap.colorSpace = THREE.NoColorSpace;
  return new THREE.MeshToonMaterial({
    color,
    emissive,
    gradientMap: toonGradient,
    ...(map ? { map } : {}),
    ...(normalMap ? { normalMap } : {}),
  });
}

/** Inverted-hull outline: cheap, no post-processing pass, so it costs nothing at 60fps. */
export function addOutline(mesh: THREE.Mesh, thickness = 0.04, color: THREE.ColorRepresentation = 0x000000): THREE.Mesh {
  const outline = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({ color, side: THREE.BackSide }));
  outline.scale.setScalar(1 + thickness);
  mesh.add(outline);
  return outline;
}
