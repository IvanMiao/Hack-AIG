import type { Vec2 } from "./types";

export const vec = (x = 0, z = 0): Vec2 => ({ x, z });
export const add = (a: Vec2, b: Vec2, s = 1): Vec2 => ({ x: a.x + b.x * s, z: a.z + b.z * s });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, z: a.z - b.z });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, z: a.z * s });
export const len = (a: Vec2): number => Math.hypot(a.x, a.z);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z);
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.z * b.z;
export const perp = (a: Vec2): Vec2 => ({ x: -a.z, z: a.x });
export const norm = (a: Vec2, fallback: Vec2 = { x: 0, z: 1 }): Vec2 => {
  const l = len(a);
  return l < 1e-6 ? { ...fallback } : { x: a.x / l, z: a.z / l };
};
export const rotate = (a: Vec2, angle: number): Vec2 => {
  const c = Math.cos(angle), s = Math.sin(angle);
  return { x: a.x * c - a.z * s, z: a.x * s + a.z * c };
};
export const clampToDisc = (p: Vec2, radius: number): Vec2 => {
  const l = len(p);
  return l > radius ? scale(p, radius / l) : p;
};
