import * as THREE from "three";

/** Five-step gradient shared by every toon material: a deep shadow, a wide mid, a crisp highlight. */
const toonGradient = (() => {
  const data = new Uint8Array([
    22, 22, 22, 255,
    64, 64, 64, 255,
    128, 128, 128, 255,
    196, 196, 196, 255,
    255, 255, 255, 255,
  ]);
  const texture = new THREE.DataTexture(data, 5, 1, THREE.RGBAFormat);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
})();

/** Shared rim uniforms: one accent for the whole scene, tweakable live from the lab. */
export const RIM = {
  color: { value: new THREE.Color(0x7fdcff) },
  strength: { value: 0.85 },
  power: { value: 3.2 },
  /** additive white flash used for hit reactions (0..1) */
  flash: { value: 0 },
};

export interface ToonOptions {
  map?: THREE.Texture;
  normalMap?: THREE.Texture;
  /** 0 disables the rim for this material (floor, props). Default 1. */
  rim?: number;
  /** Per-material flash uniform; defaults to a fresh uniform so meshes can flash independently. */
  flash?: { value: number };
}

export interface ToonRimMaterial extends THREE.MeshToonMaterial {
  userData: { flash: { value: number }; rimScale: { value: number } };
}

const RIM_PARS = /* glsl */ `
uniform vec3 uRimColor;
uniform float uRimStrength;
uniform float uRimPower;
uniform float uRimScale;
uniform float uFlash;
`;

const RIM_APPLY = /* glsl */ `
#include <opaque_fragment>
{
  vec3 viewDir = normalize(vViewPosition);
  float rim = 1.0 - max(dot(viewDir, normalize(normal)), 0.0);
  rim = pow(rim, uRimPower) * uRimStrength * uRimScale;
  // Rim only lights the dark side, so silhouettes read against the background without haloing highlights.
  float shade = 1.0 - clamp(dot(normalize(normal), normalize(vec3(0.4, 1.0, 0.3))), 0.0, 1.0);
  gl_FragColor.rgb += uRimColor * rim * (0.35 + 0.65 * shade);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0), uFlash);
}
`;

/**
 * MeshToonMaterial with an accent-coloured rim and a hit-flash uniform.
 * Uniforms are shared through `RIM`, so the lab can retune every material at once.
 */
export function createToonMaterial(
  color: THREE.ColorRepresentation,
  emissive: THREE.ColorRepresentation = 0x000000,
  options: ToonOptions = {},
): ToonRimMaterial {
  const { map, normalMap } = options;
  if (map) map.colorSpace = THREE.SRGBColorSpace;
  if (normalMap) normalMap.colorSpace = THREE.NoColorSpace;
  const material = new THREE.MeshToonMaterial({
    color,
    emissive,
    gradientMap: toonGradient,
    ...(map ? { map } : {}),
    ...(normalMap ? { normalMap } : {}),
  }) as ToonRimMaterial;
  const flash = options.flash ?? { value: 0 };
  const rimScale = { value: options.rim ?? 1 };
  material.userData = { flash, rimScale };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = RIM.color;
    shader.uniforms.uRimStrength = RIM.strength;
    shader.uniforms.uRimPower = RIM.power;
    shader.uniforms.uRimScale = rimScale;
    shader.uniforms.uFlash = flash;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${RIM_PARS}`)
      .replace("#include <opaque_fragment>", RIM_APPLY);
  };
  material.customProgramCacheKey = () => "toon-rim";
  return material;
}

/** Inverted-hull outline: cheap, no post-processing pass, so it costs nothing at 60fps. */
export function addOutline(mesh: THREE.Mesh, thickness = 0.04, color: THREE.ColorRepresentation = 0x000000): THREE.Mesh {
  const outline = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({ color, side: THREE.BackSide }));
  outline.scale.setScalar(1 + thickness);
  mesh.add(outline);
  return outline;
}

/** Walk a hierarchy and set the flash uniform on every toon-rim material found. */
export function setFlash(root: THREE.Object3D, value: number): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of materials) {
      const flash = (m as ToonRimMaterial).userData?.flash;
      if (flash) flash.value = value;
    }
  });
}
