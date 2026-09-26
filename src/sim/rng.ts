/** mulberry32: tiny seeded PRNG so a battle replays identically from (spec, seed, inputs). */
export interface Rng { next(): number; pick<T>(items: readonly T[]): T; range(min: number, max: number): number }

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    pick: (items) => {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error("pick from empty list");
      return item;
    },
    range: (min, max) => min + next() * (max - min),
  };
}
