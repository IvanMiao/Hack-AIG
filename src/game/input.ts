import type { PlayerInput } from "../sim";

/** Keyboard + mouse → sim input. Attack/roll/jump are edge-triggered so a held key fires once per press. Space is roll in 3D and jump on the lane; the sim picks. */
export function createCombatInput(canvas: HTMLCanvasElement): { read(): PlayerInput; dispose(): void } {
  const held = new Set<string>();
  const pressed = new Set<string>();
  const down = (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (["Space", "ShiftLeft", "ShiftRight", "Tab"].includes(e.code)) e.preventDefault();
    held.add(e.code);
    pressed.add(e.code);
  };
  const up = (e: KeyboardEvent) => held.delete(e.code);
  const mouse = (e: MouseEvent) => {
    e.preventDefault();
    pressed.add(e.button === 2 ? "MouseHeavy" : "MouseLight");
  };
  const noMenu = (e: Event) => e.preventDefault();
  window.addEventListener("keydown", down);
  window.addEventListener("keyup", up);
  canvas.addEventListener("mousedown", mouse);
  canvas.addEventListener("contextmenu", noMenu);
  const has = (...codes: string[]) => codes.some((c) => held.has(c));
  const take = (...codes: string[]) => {
    const hit = codes.some((c) => pressed.has(c));
    for (const c of codes) pressed.delete(c);
    return hit;
  };
  return {
    read: () => {
      const space = take("Space");
      return {
        move: {
          x: (has("KeyD", "ArrowRight") ? 1 : 0) - (has("KeyA", "ArrowLeft") ? 1 : 0),
          z: (has("KeyW", "ArrowUp") ? 1 : 0) - (has("KeyS", "ArrowDown") ? 1 : 0),
        },
        light: take("KeyJ", "MouseLight"),
        heavy: take("KeyK", "MouseHeavy"),
        roll: space || take("ShiftLeft", "ShiftRight"),
        jump: space || take("KeyW", "ArrowUp"),
      };
    },
    dispose: () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      canvas.removeEventListener("mousedown", mouse);
      canvas.removeEventListener("contextmenu", noMenu);
    },
  };
}
