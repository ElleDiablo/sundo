/** Tests for the dogs (S3-08): wake within 5 tiles, bark 3 s, rest 5 s, ignore a far tikbalang. */
import { describe, expect, it } from "vitest";
import {
  BARK_TICKS,
  createDogs,
  DOG_RANGE,
  DOG_REST_TICKS,
  updateDogs,
  type DogState,
} from "./dogs.ts";
import type { GameEvent } from "./game.ts";

const [DOG] = createDogs([{ tileX: 5, tileY: 5 }]); // at (5500, 5500)

/** Runs `ticks` updates with the tikbalang at `at`, collecting events. */
function run(dogs: readonly DogState[], at: { x: number; y: number } | null, ticks: number) {
  const events: GameEvent[] = [];
  for (let i = 0; i < ticks; i++) dogs = updateDogs(dogs, at, events);
  return { dogs, events };
}

describe("dogs", () => {
  it("start asleep, one per spot, named d0, d1, …", () => {
    expect(DOG).toEqual({ id: "d0", x: 5500, y: 5500, bark: 0, rest: 0 });
  });

  it("wake and bark when the tikbalang comes within 5 tiles, with an event", () => {
    const { dogs, events } = run([DOG!], { x: 5500 + DOG_RANGE, y: 5500 }, 1);
    expect(dogs[0]!.bark).toBe(BARK_TICKS);
    expect(events).toEqual([{ type: "dog_bark", dog: "d0" }]);
  });

  it("sleep through a tikbalang further away, or none at all", () => {
    expect(run([DOG!], { x: 5500 + DOG_RANGE + 1, y: 5500 }, 5).events).toEqual([]);
    expect(run([DOG!], null, 5).events).toEqual([]);
  });

  it("bark for 3 s, then rest 5 s before barking again, even with the tikbalang still there", () => {
    const near = { x: 6500, y: 5500 };
    const { dogs, events } = run([DOG!], near, 1 + BARK_TICKS + DOG_REST_TICKS);
    expect(events).toHaveLength(1);
    expect(dogs[0]).toMatchObject({ bark: 0, rest: 0 });
    expect(run(dogs, near, 1).events).toHaveLength(1); // and again
    expect(BARK_TICKS / 20).toBe(3);
    expect(DOG_REST_TICKS / 20).toBe(5);
  });
});
