const HOLD_DISTANCE = 1.6;
const MAX_TURN_RADIANS_PER_SECOND = 2.4;
/** Past this separation the boss is a distant target (blink/charge/kiting), so the lock-on may re-frame it briskly. */
const FAR_DISTANCE = 8;
const FAR_TURN_RADIANS_PER_SECOND = 5.2;

/**
 * Keep the fight camera from flipping when the player crosses through the boss: hold through close crossings and rolls,
 * turn gradually at melee range, and only turn quickly when the boss is far enough that whipping cannot disorient.
 */
export function nextCameraYaw(current: number | null, dx: number, dz: number, dt: number, rolling = false): number {
  const distance = Math.hypot(dx, dz);
  if (current === null) return distance > 0.001 ? Math.atan2(dx, dz) : 0;
  if (rolling || distance < HOLD_DISTANCE) return current;

  const target = Math.atan2(dx, dz);
  const difference = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  const rate = distance > FAR_DISTANCE ? FAR_TURN_RADIANS_PER_SECOND : MAX_TURN_RADIANS_PER_SECOND;
  const maxTurn = rate * dt;
  return current + Math.max(-maxTurn, Math.min(maxTurn, difference));
}
