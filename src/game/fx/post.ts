import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

/** Live-tunable post settings. The lab binds lil-gui straight onto this object. */
export interface PostSettings {
  enabled: boolean;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  vignette: number;
  grain: number;
  aberration: number;
  /** -1..1, negative desaturates */
  saturation: number;
  exposure: number;
  /** screen pixels per output pixel; 1 = off. `flatten()` raises it during 2D phases */
  pixelate: number;
  /** colour levels per channel; 0 = off */
  posterize: number;
}

export const DEFAULT_POST: PostSettings = {
  enabled: true,
  bloomStrength: 0.55,
  bloomRadius: 0.35,
  bloomThreshold: 0.85,
  vignette: 0.42,
  grain: 0.045,
  aberration: 0.0006,
  saturation: 0.05,
  exposure: 1.2,
  pixelate: 1,
  posterize: 0,
};

/** Look of a fully collapsed `flatline` phase: chunky pixels, few colours, washed out, a little too much bleed. */
const FLAT_LOOK = { pixelate: 6, posterize: 6, saturation: -0.3, grain: -0.03, aberration: 0.0012 };

const GRADE_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uResolution;
uniform float uTime;
uniform float uVignette;
uniform float uGrain;
uniform float uAberration;
uniform float uSaturation;
uniform float uPulse;
uniform vec3 uPulseColor;
uniform float uWhite;
uniform float uPixelate;
uniform float uPosterize;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime) * 43758.5453); }

void main() {
  vec2 uv = vUv;
  if (uPixelate > 1.0) {
    vec2 cell = vec2(uPixelate) / uResolution;
    uv = (floor(uv / cell) + 0.5) * cell;
  }
  vec2 toCenter = uv - 0.5;
  float r = length(toCenter);
  // Chromatic aberration grows toward the edge and spikes with hit pulses.
  float ab = (uAberration + uPulse * 0.012) * (0.4 + r * 2.0);
  vec2 dir = normalize(toCenter + 1e-5);
  vec3 col;
  col.r = texture2D(tDiffuse, uv + dir * ab).r;
  col.g = texture2D(tDiffuse, uv).g;
  col.b = texture2D(tDiffuse, uv - dir * ab).b;

  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, 1.0 + uSaturation - uPulse * 0.45);

  float vig = smoothstep(0.95, 0.25, r * (1.0 + uVignette * 0.6));
  col *= mix(1.0, vig, uVignette);
  col = mix(col, col + uPulseColor * (r * r * 1.4), uPulse * 0.55);

  float g = (hash(uv * uResolution) - 0.5) * uGrain;
  col += g * (0.6 + 0.4 * (1.0 - luma));
  // Posterize last so grain and vignette snap to the same few colour steps instead of speckling over them.
  if (uPosterize > 0.5) col = floor(col * uPosterize + 0.5) / uPosterize;
  col = mix(col, vec3(1.0), uWhite);
  gl_FragColor = vec4(col, 1.0);
}
`;

const GRADE_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

export interface PostFX {
  readonly settings: PostSettings;
  setSize(width: number, height: number): void;
  /** Colour pulse (hit vignette / desaturation), decays over ~350ms. */
  pulse(color: THREE.ColorRepresentation, strength?: number): void;
  /** Full-frame white flash, decays over ~120ms. */
  whiteFlash(strength?: number): void;
  /** 0..1 blend toward the pixelated, posterized `flatline` look; 0 restores the grade in `settings`. */
  flatten(amount: number): void;
  render(dt: number): void;
  dispose(): void;
}

export function createPostFX(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, settings: PostSettings = { ...DEFAULT_POST }): PostFX {
  const size = renderer.getSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(size.clone(), settings.bloomStrength, settings.bloomRadius, settings.bloomThreshold);
  composer.addPass(bloom);
  const u = {
    tDiffuse: { value: null as THREE.Texture | null },
    uResolution: { value: size.clone() },
    uTime: { value: 0 },
    uVignette: { value: settings.vignette },
    uGrain: { value: settings.grain },
    uAberration: { value: settings.aberration },
    uSaturation: { value: settings.saturation },
    uPulse: { value: 0 },
    uPulseColor: { value: new THREE.Color(0xff2d4f) },
    uWhite: { value: 0 },
    uPixelate: { value: 1 },
    uPosterize: { value: 0 },
  };
  const grade = new ShaderPass(new THREE.ShaderMaterial({ uniforms: u, vertexShader: GRADE_VERT, fragmentShader: GRADE_FRAG }));
  composer.addPass(grade);
  composer.addPass(new OutputPass());

  let pulse = 0;
  let white = 0;
  let time = 0;
  let flat = 0;

  return {
    settings,
    setSize(width, height) {
      composer.setSize(width, height);
      bloom.setSize(width, height);
      u.uResolution.value.set(width, height);
    },
    pulse(color, strength = 1) {
      pulse = Math.max(pulse, strength);
      u.uPulseColor.value.set(color);
    },
    whiteFlash(strength = 0.6) {
      white = Math.max(white, strength);
    },
    flatten(amount) {
      flat = THREE.MathUtils.clamp(amount, 0, 1);
    },
    render(dt) {
      time += dt;
      pulse = Math.max(0, pulse - dt / 0.35);
      white = Math.max(0, white - dt / 0.12);
      renderer.toneMappingExposure = settings.exposure;
      if (!settings.enabled) {
        renderer.render(scene, camera);
        return;
      }
      bloom.strength = settings.bloomStrength;
      bloom.radius = settings.bloomRadius;
      bloom.threshold = settings.bloomThreshold;
      u.uTime.value = time;
      u.uVignette.value = settings.vignette;
      u.uGrain.value = Math.max(0, settings.grain + FLAT_LOOK.grain * flat);
      u.uAberration.value = settings.aberration + FLAT_LOOK.aberration * flat;
      u.uSaturation.value = settings.saturation + FLAT_LOOK.saturation * flat;
      u.uPulse.value = pulse * pulse;
      u.uWhite.value = white;
      // Pixels snap in whole steps so the collapse reads as a resolution downgrade, not a blur.
      u.uPixelate.value = Math.max(settings.pixelate, 1 + Math.floor(flat * (FLAT_LOOK.pixelate - 1) + 0.001));
      u.uPosterize.value = settings.posterize > 0 ? settings.posterize : flat > 0.35 ? FLAT_LOOK.posterize : 0;
      composer.render(dt);
    },
    dispose() {
      composer.dispose();
      bloom.dispose();
      grade.dispose();
      target.dispose();
    },
  };
}
