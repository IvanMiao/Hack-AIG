export interface MoveInput { x: number; z: number }

export function createKeyboardInput(): { read(): MoveInput; dispose(): void } {
  const held = new Set<string>();
  const down = (e: KeyboardEvent) => held.add(e.code);
  const up = (e: KeyboardEvent) => held.delete(e.code);
  window.addEventListener("keydown", down);
  window.addEventListener("keyup", up);
  return {
    read: () => ({
      x: (held.has("KeyD") || held.has("ArrowRight") ? 1 : 0) - (held.has("KeyA") || held.has("ArrowLeft") ? 1 : 0),
      z: (held.has("KeyW") || held.has("ArrowUp") ? 1 : 0) - (held.has("KeyS") || held.has("ArrowDown") ? 1 : 0),
    }),
    dispose: () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); },
  };
}
