import * as THREE from "three";

/** 3-step gradient shared by every toon material: the cel look that separates Nemesis from PBR boss fights. */
const toonGradient = (() => {
  const data = new Uint8Array([40, 40, 40, 255, 140, 140, 140, 255, 255, 255, 255, 255]);
  const texture = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
})();

export const createToonMaterial = (color: THREE.ColorRepresentation, emissive: THREE.ColorRepresentation = 0x000000) =>
  new THREE.MeshToonMaterial({ color, emissive, gradientMap: toonGradient });

/** Inverted-hull outline: cheap, no post-processing pass, so it costs nothing at 60fps. */
export function addOutline(mesh: THREE.Mesh, thickness = 0.04, color: THREE.ColorRepresentation = 0x000000): THREE.Mesh {
  const outline = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({ color, side: THREE.BackSide }));
  outline.scale.setScalar(1 + thickness);
  mesh.add(outline);
  return outline;
}
