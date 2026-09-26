import { describe, expect, it } from "vitest";
import { nextCameraYaw } from "./cameraFollow";

describe("fight camera follow", () => {
  it("holds its direction through a close-range boss crossing", () => {
    const initial = nextCameraYaw(null, 0, -4, 1 / 60);
    expect(nextCameraYaw(initial, 0, -0.1, 1 / 60)).toBe(initial);
    expect(nextCameraYaw(initial, 0, 0.1, 1 / 60)).toBe(initial);
    expect(nextCameraYaw(initial, 4, 0, 1 / 60, true)).toBe(initial);
  });

  it("turns toward the boss gradually after the crossing", () => {
    const initial = nextCameraYaw(null, 0, -4, 1 / 60);
    const next = nextCameraYaw(initial, 0, 4, 1 / 60);
    expect(Math.abs(next - initial)).toBeLessThanOrEqual(2.4 / 60 + 1e-10);
    let yaw = next;
    for (let i = 0; i < 120; i += 1) yaw = nextCameraYaw(yaw, 0, 4, 1 / 60);
    expect(Math.cos(yaw)).toBeGreaterThan(0.99);
  });

  it("re-frames a distant boss faster than a melee-range one, but still not instantly", () => {
    const initial = nextCameraYaw(null, 0, -4, 1 / 60);
    const near = Math.abs(nextCameraYaw(initial, 4, 0, 1 / 60) - initial);
    const far = Math.abs(nextCameraYaw(initial, 14, 0, 1 / 60) - initial);
    expect(far).toBeGreaterThan(near);
    expect(far).toBeLessThan(Math.PI / 2);
  });
});
