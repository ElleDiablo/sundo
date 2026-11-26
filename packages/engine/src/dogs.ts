/**
 * The barangay's dogs (S3-08, GDD §4): a second warning besides the hoofbeats.
 *
 * Four dogs (aso) sleep at fixed spots (the map's "dog" points: by houses, the store, the bridge).
 * When the tikbalang passes within 5 tiles of one, it wakes and barks for 3 s, then sleeps again
 * and won't bark for another 5 s (so a tikbalang standing next to it doesn't make it bark forever).
 * Everyone hears it from the dog's direction, which is a clue about where the tikbalang is.
 * The tikbalang doesn't hurt them, and players don't wake them.
 */
import { UNITS_PER_TILE } from "./map.ts";
// Types only (erased when the code runs).
import type { GameEvent, Spot } from "./game.ts";

/** A dog wakes when the tikbalang comes within 5 tiles. */
export const DOG_RANGE = 5000;
/** It barks for 3 s (60 ticks)... */
export const BARK_TICKS = 60;
/** ...then sleeps at least 5 s (100 ticks) before it can bark again. */
export const DOG_REST_TICKS = 100;

export interface DogState {
  readonly id: string; // "d0"…"d3", in the map's order
  readonly x: number; // centre of its tile, in units
  readonly y: number;
  readonly bark: number; // ticks of barking left; 0 = asleep
  readonly rest: number; // ticks before it can wake again
}

/** The map's dog spots as sleeping dogs. */
export function createDogs(spots: readonly Spot[]): DogState[] {
  return spots.map((s, i) => ({
    id: `d${i}`,
    x: s.tileX * UNITS_PER_TILE + 500,
    y: s.tileY * UNITS_PER_TILE + 500,
    bark: 0,
    rest: 0,
  }));
}

/**
 * One tick for every dog, given where the tikbalang is (or null if there is none). Adds a
 * `dog_bark` event for each dog that starts barking. Returns the same array when nothing changes.
 */
export function updateDogs(
  dogs: readonly DogState[],
  tikbalang: { readonly x: number; readonly y: number } | null,
  events: GameEvent[],
): readonly DogState[] {
  let changed = false;
  const next = dogs.map((d) => {
    if (d.bark > 0) {
      changed = true;
      // Barking: count down; when it stops, it rests before it can bark again.
      return d.bark === 1 ? { ...d, bark: 0, rest: DOG_REST_TICKS } : { ...d, bark: d.bark - 1 };
    }
    if (d.rest > 0) {
      changed = true;
      return { ...d, rest: d.rest - 1 };
    }
    if (!tikbalang) return d;
    const dist2 = (tikbalang.x - d.x) ** 2 + (tikbalang.y - d.y) ** 2;
    if (dist2 > DOG_RANGE * DOG_RANGE) return d;
    changed = true;
    events.push({ type: "dog_bark", dog: d.id });
    return { ...d, bark: BARK_TICKS };
  });
  return changed ? next : dogs;
}
