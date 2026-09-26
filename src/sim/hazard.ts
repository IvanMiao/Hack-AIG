import type { Hazard, HazardShape, Vec2 } from "./types";
import { dist, dot, sub } from "./vec";

/** Does a circle (player) overlap this hazard shape? Pure geometry, no state. */
export function overlaps(shape: HazardShape, p: Vec2, r: number): boolean {
  switch (shape.kind) {
    case "circle":
      return dist(shape.center, p) <= shape.radius + r;
    case "arc": {
      const d = sub(p, shape.center);
      const l = Math.hypot(d.x, d.z);
      if (l > shape.radius + r) return false;
      if (l < 1e-6) return true;
      const cos = dot(d, shape.dir) / l;
      return Math.acos(Math.min(1, Math.max(-1, cos))) <= shape.halfAngle + Math.asin(Math.min(1, r / Math.max(l, r)));
    }
    case "line": {
      const d = sub(p, shape.start);
      const along = dot(d, shape.dir);
      if (along < -r || along > shape.length + r) return false;
      const side = Math.abs(d.x * shape.dir.z - d.z * shape.dir.x);
      return side <= shape.halfWidth + r;
    }
    case "ring": {
      const l = dist(shape.center, p);
      return Math.abs(l - shape.radius) <= shape.thickness / 2 + r;
    }
  }
}

export function advanceHazard(h: Hazard, dtMs: number): Hazard {
  const shape = h.shape.kind === "ring"
    ? { ...h.shape, radius: h.shape.radius + (h.shape.growth * dtMs) / 1000 }
    : h.shape;
  const expired = shape.kind === "ring" && shape.radius > shape.maxRadius;
  return { ...h, shape, ttl: expired ? 0 : Math.max(0, h.ttl - dtMs), cooldown: Math.max(0, h.cooldown - dtMs), armT: Math.max(0, h.armT - dtMs) };
}
