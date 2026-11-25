/**
 * Tests for the game rules: creating a game, adding players, and step() (speed, walls, sliding,
 * determinism). Small hand-drawn maps keep each case easy to picture.
 */
import { describe, expect, it } from "vitest";
import {
  addPlayer,
  createGame,
  PLAYER_DIAGONAL_SPEED,
  PLAYER_HALF_SIZE,
  PLAYER_SPEED,
  step,
  type GameState,
  type Inputs,
  type MoveInput,
} from "./game.ts";
import { mapFromRows, UNITS_PER_TILE } from "./map.ts";
import { createRng } from "./rng.ts";
import { TICKS_PER_SECOND } from "./index.ts";

const NONE: MoveInput = { up: false, down: false, left: false, right: false };
const hold = (keys: Partial<MoveInput>): MoveInput => ({ ...NONE, ...keys });

/** Runs `ticks` steps with the same inputs every tick. */
function run(state: GameState, inputs: Inputs, ticks: number): GameState {
  for (let i = 0; i < ticks; i++) state = step(state, inputs).state;
  return state;
}

function player(state: GameState, id = "a") {
  const p = state.players.find((pl) => pl.id === id);
  if (!p) throw new Error(`no player ${id}`);
  return p;
}

// A 12 × 12 room: walls all round, open floor inside.
const ROOM = mapFromRows([
  "############",
  ...Array.from({ length: 10 }, () => "#..........#"),
  "############",
]);

describe("createGame", () => {
  it("places players at the centre of their spawn tile, at tick 0", () => {
    const game = createGame(ROOM, [{ id: "a", tileX: 3, tileY: 4 }]);
    expect(game.tick).toBe(0);
    expect(player(game)).toEqual({ id: "a", x: 3500, y: 4500 });
  });

  it("refuses to spawn a player inside a wall", () => {
    expect(() => createGame(ROOM, [{ id: "a", tileX: 0, tileY: 0 }])).toThrow(/inside a wall/);
  });
});

describe("addPlayer", () => {
  it("puts a newcomer on the spawn tile if it's free", () => {
    const game = addPlayer(createGame(ROOM, []), { id: "p1", tileX: 5, tileY: 5 });
    expect(player(game, "p1")).toEqual({ id: "p1", x: 5500, y: 5500 });
  });

  it("moves newcomers to a free neighbouring tile so nobody stands on someone else", () => {
    let game = createGame(ROOM, [{ id: "p0", tileX: 5, tileY: 5 }]);
    game = addPlayer(game, { id: "p1", tileX: 5, tileY: 5 });
    game = addPlayer(game, { id: "p2", tileX: 5, tileY: 5 });
    expect(player(game, "p1")).toMatchObject({ x: 6500, y: 5500 }); // to the right
    expect(player(game, "p2")).toMatchObject({ x: 4500, y: 5500 }); // to the left
  });

  it("skips walls when looking for a free tile", () => {
    // Spawn at (1, 1) in the room's corner: right is free, left is the wall.
    let game = createGame(ROOM, [{ id: "p0", tileX: 1, tileY: 1 }]);
    game = addPlayer(game, { id: "p1", tileX: 1, tileY: 1 });
    game = addPlayer(game, { id: "p2", tileX: 1, tileY: 1 });
    expect(player(game, "p1")).toMatchObject({ x: 2500, y: 1500 });
    expect(player(game, "p2")).toMatchObject({ x: 1500, y: 2500 }); // below, not into the wall
  });

  it("ignores a player who is already in the game, and never changes the old state", () => {
    const before = createGame(ROOM, [{ id: "p0", tileX: 5, tileY: 5 }]);
    expect(addPlayer(before, { id: "p0", tileX: 2, tileY: 2 })).toBe(before);
    addPlayer(before, { id: "p1", tileX: 5, tileY: 5 });
    expect(before.players).toHaveLength(1);
  });
});

describe("step: speed", () => {
  it("moves 4 tiles in one second (20 ticks) when holding a direction", () => {
    const start = createGame(ROOM, [{ id: "a", tileX: 2, tileY: 5 }]);
    const end = run(start, { a: hold({ right: true }) }, TICKS_PER_SECOND);
    expect(player(end).x - player(start).x).toBe(4 * UNITS_PER_TILE);
    expect(player(end).y).toBe(player(start).y);
    expect(end.tick).toBe(TICKS_PER_SECOND);
  });

  it("moves the same distance in all four directions", () => {
    const start = createGame(ROOM, [{ id: "a", tileX: 5, tileY: 5 }]);
    const { x, y } = player(start);
    const go = (keys: Partial<MoveInput>) => player(step(start, { a: hold(keys) }).state);
    expect(go({ up: true })).toMatchObject({ x, y: y - PLAYER_SPEED });
    expect(go({ down: true })).toMatchObject({ x, y: y + PLAYER_SPEED });
    expect(go({ left: true })).toMatchObject({ x: x - PLAYER_SPEED, y });
    expect(go({ right: true })).toMatchObject({ x: x + PLAYER_SPEED, y });
  });

  it("is not faster diagonally than straight", () => {
    const start = createGame(ROOM, [{ id: "a", tileX: 2, tileY: 8 }]);
    const after = player(step(start, { a: hold({ up: true, right: true }) }).state);
    const dx = after.x - player(start).x;
    const dy = player(start).y - after.y;
    expect(dx).toBe(PLAYER_DIAGONAL_SPEED);
    expect(dy).toBe(PLAYER_DIAGONAL_SPEED);
    expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(PLAYER_SPEED);
  });

  it("stands still with no keys, opposite keys, or no input at all", () => {
    const start = createGame(ROOM, [{ id: "a", tileX: 5, tileY: 5 }]);
    expect(player(step(start, { a: NONE }).state)).toEqual(player(start));
    expect(player(step(start, { a: hold({ left: true, right: true }) }).state)).toEqual(
      player(start),
    );
    expect(player(step(start, {}).state)).toEqual(player(start));
  });

  it("moves each player by their own input", () => {
    const start = createGame(ROOM, [
      { id: "a", tileX: 3, tileY: 3 },
      { id: "b", tileX: 6, tileY: 6 },
    ]);
    const next = step(start, { a: hold({ right: true }), b: hold({ up: true }) }).state;
    expect(player(next, "a")).toMatchObject({ x: 3500 + PLAYER_SPEED, y: 3500 });
    expect(player(next, "b")).toMatchObject({ x: 6500, y: 6500 - PLAYER_SPEED });
  });
});

describe("step: walls", () => {
  it("stops flush against a wall and never enters it", () => {
    // Wall column at tile x = 11. Walk right for 3 seconds: far more than the 9 tiles available.
    const start = createGame(ROOM, [{ id: "a", tileX: 2, tileY: 5 }]);
    const end = run(start, { a: hold({ right: true }) }, 3 * TICKS_PER_SECOND);
    expect(player(end).x).toBe(11 * UNITS_PER_TILE - PLAYER_HALF_SIZE);
  });

  it("stops at walls in every direction", () => {
    const start = createGame(ROOM, [{ id: "a", tileX: 5, tileY: 5 }]);
    const far = 3 * TICKS_PER_SECOND;
    expect(player(run(start, { a: hold({ up: true }) }, far)).y).toBe(1300);
    expect(player(run(start, { a: hold({ down: true }) }, far)).y).toBe(10_700);
    expect(player(run(start, { a: hold({ left: true }) }, far)).x).toBe(1300);
    expect(player(run(start, { a: hold({ right: true }) }, far)).x).toBe(10_700);
  });

  it("slides along a wall when moving diagonally into it", () => {
    const start = createGame(ROOM, [{ id: "a", tileX: 10, tileY: 8 }]);
    // Up-right: the wall on the right blocks x, but y keeps going.
    const end = run(start, { a: hold({ up: true, right: true }) }, 10);
    expect(player(end).x).toBe(11 * UNITS_PER_TILE - PLAYER_HALF_SIZE);
    expect(player(end).y).toBe(player(start).y - 10 * PLAYER_DIAGONAL_SPEED);
  });

  it("does not snag on the wall it is sliding along", () => {
    // Pressed flush against the top wall, walk up-left across the room.
    const start = run(
      createGame(ROOM, [{ id: "a", tileX: 10, tileY: 1 }]),
      { a: hold({ up: true }) },
      5,
    );
    const ticks = 10;
    const end = run(start, { a: hold({ left: true, up: true }) }, ticks);
    // Still pressed against the wall, and x moved every single tick (no stopping on tile edges).
    expect(player(end)).toMatchObject({
      x: player(start).x - ticks * PLAYER_DIAGONAL_SPEED,
      y: 1300,
    });
    // Keep going and it reaches the far corner.
    expect(
      player(run(end, { a: hold({ left: true, up: true }) }, 5 * TICKS_PER_SECOND)),
    ).toMatchObject({
      x: 1300,
      y: 1300,
    });
  });

  it("fits through a one-tile gap", () => {
    const map = mapFromRows([
      "#######", //
      "#.....#",
      "###.###",
      "#.....#",
      "#######",
    ]);
    const start = createGame(map, [{ id: "a", tileX: 3, tileY: 1 }]);
    const end = run(start, { a: hold({ down: true }) }, TICKS_PER_SECOND);
    expect(player(end).y).toBe(4 * UNITS_PER_TILE - PLAYER_HALF_SIZE);
  });

  it("treats the map edge as a wall even with no border tiles", () => {
    const start = createGame(mapFromRows(["..."]), [{ id: "a", tileX: 1, tileY: 0 }]);
    const end = run(start, { a: hold({ left: true, up: true }) }, TICKS_PER_SECOND);
    expect(player(end)).toMatchObject({ x: PLAYER_HALF_SIZE, y: PLAYER_HALF_SIZE });
  });
});

describe("step: determinism and purity", () => {
  /** Plays 30 seconds of random key presses chosen by a seeded RNG. */
  function replay(seed: number): GameState {
    const rng = createRng(seed);
    let state = createGame(ROOM, [
      { id: "a", tileX: 2, tileY: 2 },
      { id: "b", tileX: 9, tileY: 9 },
    ]);
    const randomKeys = (): MoveInput => ({
      up: rng.next() < 0.5,
      down: rng.next() < 0.5,
      left: rng.next() < 0.5,
      right: rng.next() < 0.5,
    });
    for (let i = 0; i < 30 * TICKS_PER_SECOND; i++) {
      state = step(state, { a: randomKeys(), b: randomKeys() }).state;
    }
    return state;
  }

  it("gives exactly the same state from the same seed and inputs", () => {
    expect(replay(2026)).toEqual(replay(2026));
  });

  it("only ever uses whole-number positions", () => {
    for (const p of replay(7).players) {
      expect(Number.isInteger(p.x)).toBe(true);
      expect(Number.isInteger(p.y)).toBe(true);
    }
  });

  it("never changes the state it was given", () => {
    const start = createGame(ROOM, [{ id: "a", tileX: 5, tileY: 5 }]);
    const copy = JSON.parse(JSON.stringify(start)) as GameState;
    step(start, { a: hold({ right: true, down: true }) });
    expect(start).toEqual(copy);
  });

  it("returns no events yet", () => {
    const start = createGame(ROOM, [{ id: "a", tileX: 5, tileY: 5 }]);
    expect(step(start, {}).events).toEqual([]);
  });
});
