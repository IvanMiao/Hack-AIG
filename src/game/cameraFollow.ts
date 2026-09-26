const HOLD_DISTANCE = 1.6;
const MAX_TURN_RADIANS_PER_SECOND = 2.4;

/** Keep the fight camera from flipping when the player crosses through the boss. */
export function nextCameraYaw(current: number | null, dx: number, dz: number, dt: number, rolling = false): number {
  const distance = Math.hypot(dx, dz);
  if (current === null) return distance > 0.001 ? Math.atan2(dx, dz) : 0;
  if (rolling || distance < HOLD_DISTANCE) return current;

  const target = Math.atan2(dx, dz);
  const difference = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  const maxTurn = MAX_TURN_RADIANS_PER_SECOND * dt;
  return current + Math.max(-maxTurn, Math.min(maxTurn, difference));
}
