/**
 * Seeded random number generator (mulberry32).
 *
 * The engine never calls Math.random(): every "random" choice (where kids spawn, which ambush
 * point the tikbalang picks) comes from this generator. Same seed → same sequence, so a round
 * can be replayed exactly from its seed + inputs (ADR-0004).
 */
export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max] (both inclusive). */
  int(min: number, max: number): number;
  /** Picks one item from a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** Current internal state, so a game state can be saved and resumed. */
  readonly state: number;
}

export function createRng(seed: number): Rng {
  let s = seed >>> 0;

  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    int(min, max) {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
        throw new RangeError(`int(${min}, ${max}): need integers with min <= max`);
      }
      return min + Math.floor(next() * (max - min + 1));
    },
    pick(items) {
      if (items.length === 0) throw new RangeError("pick() from an empty array");
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    get state() {
      return s;
    },
  };
}
