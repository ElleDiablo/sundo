/**
 * Tests for the game rules: creating a game, adding players, and step() (speed, walls, sliding,
 * determinism), plus the lobby (S2-01): looks, the host's Start and the full-room countdown, and
 * the lost children (S2-02): 5 of the map's hiding spots, chosen with the seeded generator, and
 * escorting them (S2-03): calling with E, the trailing line, escort speed, and taking them home
 * (S2-04): a following child at their own doorway goes inside, and the end of a round (S2-05):
 * the dawn timer, winning and losing, the team score and going back to the lobby; and emotes
 * (S2-06): shown for 2 s, at most one a second; and the flashlight (S3-01): facing, battery,
 * safe zones.
 * Small hand-drawn maps keep each case easy to picture.
 */
import { describe, expect, it } from "vitest";
import {
  addPlayer,
  BATTERY_MAX,
  BATTERY_RECHARGE,
  createGame,
  CALL_RANGE,
  EMOTE_COOLDOWN_TICKS,
  EMOTE_COUNT,
  EMOTE_TICKS,
  ESCORT_SPEED,
  FOLLOW_GAP,
  FULL_ROOM,
  HAT_COUNT,
  HOME_RANGE,
  KID_COUNT,
  kidHome,
  MAX_ESCORT,
  PLAYER_DIAGONAL_SPEED,
  PLAYER_HALF_SIZE,
  PLAYER_SPEED,
  removePlayer,
  returnToLobby,
  ROUND_TICKS,
  secondsLeft,
  SHIRT_COUNT,
  START_COUNTDOWN_TICKS,
  startRound,
  step,
  teamScore,
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
  it("places players at the centre of their spawn tile, at tick 0, in the lobby", () => {
    const game = createGame(ROOM, [{ id: "a", tileX: 3, tileY: 4 }]);
    expect(game.tick).toBe(0);
    expect(game.phase).toBe("lobby");
    expect(game.countdown).toBeNull();
    // No look given: hat 0, shirt 0.
    expect(player(game)).toEqual({
      id: "a",
      x: 3500,
      y: 4500,
      hat: 0,
      shirt: 0,
      emote: null,
      emoteAt: null,
      faceX: 0,
      faceY: 1,
      light: false,
      battery: BATTERY_MAX,
      baliktad: 0,
      baliktadCooldown: 0,
    });
  });

  it("refuses to spawn a player inside a wall", () => {
    expect(() => createGame(ROOM, [{ id: "a", tileX: 0, tileY: 0 }])).toThrow(/inside a wall/);
  });
});

describe("addPlayer", () => {
  it("puts a newcomer on the spawn tile if it's free", () => {
    const game = addPlayer(createGame(ROOM, []), { id: "p1", tileX: 5, tileY: 5 });
    expect(player(game, "p1")).toEqual({
      id: "p1",
      x: 5500,
      y: 5500,
      hat: 0,
      shirt: 0,
      emote: null,
      emoteAt: null,
      faceX: 0,
      faceY: 1,
      light: false,
      battery: BATTERY_MAX,
      baliktad: 0,
      baliktadCooldown: 0,
    });
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

describe("removePlayer", () => {
  it("takes the player out and keeps everyone else in order", () => {
    let game = createGame(ROOM, [{ id: "p0", tileX: 5, tileY: 5 }]);
    game = addPlayer(game, { id: "p1", tileX: 5, tileY: 5 });
    game = addPlayer(game, { id: "p2", tileX: 5, tileY: 5 });
    const after = removePlayer(game, "p1");
    expect(after.players.map((p) => p.id)).toEqual(["p0", "p2"]);
    expect(game.players).toHaveLength(3); // the old state is untouched
  });

  it("ignores someone who isn't in the game", () => {
    const game = createGame(ROOM, [{ id: "p0", tileX: 5, tileY: 5 }]);
    expect(removePlayer(game, "p3")).toBe(game);
  });

  it("frees their tile, so someone rejoining lands on it again", () => {
    let game = createGame(ROOM, [{ id: "p0", tileX: 5, tileY: 5 }]);
    game = addPlayer(game, { id: "p1", tileX: 5, tileY: 5 });
    game = addPlayer(removePlayer(game, "p1"), { id: "p1", tileX: 5, tileY: 5 });
    expect(player(game, "p1")).toMatchObject({ x: 6500, y: 5500 });
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

describe("lobby: looks (S2-01)", () => {
  const lobby = () => createGame(ROOM, [{ id: "a", tileX: 3, tileY: 3, shirt: 2 }]);

  it("starts a player in the look their spawn asked for", () => {
    expect(player(lobby())).toMatchObject({ hat: 0, shirt: 2 });
    const joined = addPlayer(lobby(), { id: "b", tileX: 6, tileY: 6, hat: 1, shirt: 3 });
    expect(player(joined, "b")).toMatchObject({ hat: 1, shirt: 3 });
  });

  it("changes hat and shirt from an input in the lobby, while still walking", () => {
    const next = step(lobby(), { a: { ...hold({ right: true }), hat: 2, shirt: 5 } }).state;
    expect(player(next)).toMatchObject({ x: 3500 + PLAYER_SPEED, hat: 2, shirt: 5 });
  });

  it("keeps the look when an input doesn't mention it", () => {
    const changed = step(lobby(), { a: { ...NONE, hat: 1 } }).state;
    const next = step(changed, { a: NONE }).state;
    expect(player(next)).toMatchObject({ hat: 1, shirt: 2 });
  });

  it("ignores looks that are out of range or not whole numbers", () => {
    for (const bad of [-1, HAT_COUNT, 1.5, NaN]) {
      expect(player(step(lobby(), { a: { ...NONE, hat: bad } }).state).hat).toBe(0);
    }
    expect(player(step(lobby(), { a: { ...NONE, shirt: SHIRT_COUNT } }).state).shirt).toBe(2);
  });

  it("freezes looks once the round has started", () => {
    const next = step(startRound(lobby()), { a: { ...hold({ down: true }), hat: 3 } }).state;
    expect(player(next)).toMatchObject({ y: 3500 + PLAYER_SPEED, hat: 0 }); // moved, same hat
  });
});

describe("lobby: starting the round (S2-01)", () => {
  /** A lobby with `n` players on separate tiles. */
  const lobbyOf = (n: number) =>
    createGame(
      ROOM,
      Array.from({ length: n }, (_, i) => ({ id: `p${i}`, tileX: 2 + i * 2, tileY: 5 })),
    );

  it("starts the round when the host calls startRound, and only once", () => {
    const started = startRound(lobbyOf(1));
    expect(started.phase).toBe("round");
    expect(startRound(started)).toBe(started); // already started: same state back
  });

  it("runs no countdown while the room isn't full", () => {
    const state = run(lobbyOf(FULL_ROOM - 1), {}, 300);
    expect(state.phase).toBe("lobby");
    expect(state.countdown).toBeNull();
  });

  it("counts down 10 s once the room is full, then starts the round with an event", () => {
    let state = step(lobbyOf(FULL_ROOM), {}).state;
    expect(state.countdown).toBe(START_COUNTDOWN_TICKS - 1);
    state = run(state, {}, START_COUNTDOWN_TICKS - 2);
    expect(state.phase).toBe("lobby");
    expect(state.countdown).toBe(1);
    const last = step(state, {});
    expect(last.state.phase).toBe("round");
    expect(last.state.countdown).toBeNull();
    expect(last.events).toEqual([{ type: "round_started" }]);
    expect(START_COUNTDOWN_TICKS / TICKS_PER_SECOND).toBe(10);
  });

  it("stops the countdown when someone leaves, and starts over when the room fills again", () => {
    const counting = run(lobbyOf(FULL_ROOM), {}, 100);
    expect(counting.countdown).toBe(START_COUNTDOWN_TICKS - 100);
    const left = step(removePlayer(counting, "p3"), {}).state;
    expect(left.countdown).toBeNull();
    const back = step(addPlayer(left, { id: "p3", tileX: 8, tileY: 8 }), {}).state;
    expect(back.countdown).toBe(START_COUNTDOWN_TICKS - 1);
  });
});

describe("lost children (S2-02)", () => {
  // 12 hiding spots along row 2 and row 8 of the room.
  const SPOTS = Array.from({ length: 12 }, (_, i) => ({
    tileX: 1 + (i % 6),
    tileY: i < 6 ? 2 : 8,
  }));
  const game = (seed: number) =>
    createGame(ROOM, [{ id: "p0", tileX: 5, tileY: 5 }], { seed, kidSpots: SPOTS });
  const tiles = (state: GameState) =>
    state.kids.map((k) => `${(k.x - 500) / UNITS_PER_TILE},${(k.y - 500) / UNITS_PER_TILE}`);

  it("has no children in the lobby", () => {
    expect(game(7).kids).toEqual([]);
  });

  it("puts 5 children on 5 different hiding spots when the round starts", () => {
    const kids = startRound(game(7)).kids;
    expect(kids.map((k) => k.id)).toEqual(["k0", "k1", "k2", "k3", "k4"]);
    expect(KID_COUNT).toBe(5);
    const spots = tiles(startRound(game(7)));
    expect(new Set(spots).size).toBe(5); // no two on the same spot
    const allowed = new Set(SPOTS.map((s) => `${s.tileX},${s.tileY}`));
    for (const spot of spots) expect(allowed.has(spot)).toBe(true);
  });

  it("chooses the same spots for the same seed, and different ones for another seed", () => {
    expect(tiles(startRound(game(7)))).toEqual(tiles(startRound(game(7))));
    const seeds = [1, 2, 3, 4, 5].map((seed) => tiles(startRound(game(seed))).join(" "));
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });

  it("uses every spot over many rounds (no spot is never chosen)", () => {
    const used = new Set<string>();
    for (let seed = 0; seed < 200; seed++)
      tiles(startRound(game(seed))).forEach((t) => used.add(t));
    expect(used.size).toBe(12);
  });

  it("also places them when the full-room countdown starts the round", () => {
    const full = createGame(
      ROOM,
      [0, 1, 2, 3].map((i) => ({ id: `p${i}`, tileX: 2 + i * 2, tileY: 5 })),
      { seed: 7, kidSpots: SPOTS },
    );
    expect(run(full, {}, START_COUNTDOWN_TICKS).kids).toHaveLength(KID_COUNT);
    expect(tiles(run(full, {}, START_COUNTDOWN_TICKS))).toEqual(tiles(startRound(game(7))));
  });

  it("advances the random generator, so the next random choice is a new one", () => {
    expect(startRound(game(7)).rngState).not.toBe(game(7).rngState);
  });

  it("refuses a hiding spot inside a wall", () => {
    expect(() => createGame(ROOM, [], { kidSpots: [{ tileX: 0, tileY: 0 }] })).toThrow(/wall/);
  });
});

describe("escorting children (S2-03)", () => {
  // A started round in the 12 × 12 room with kids placed by hand: k0 next to the player,
  // k1 a little further, k2 far away.
  const round = (kids: [number, number][], players = [{ id: "p0", tileX: 5, tileY: 5 }]) => ({
    ...startRound(createGame(ROOM, players)),
    kids: kids.map(([x, y], i) => ({ id: `k${i}`, x, y, following: null })),
  });
  const E = { ...NONE, call: true };
  const kid = (state: GameState, id: string) => state.kids.find((k) => k.id === id)!;

  it("calls the nearest lost child within 1.5 tiles when E is held, with an event", () => {
    const start = round([
      [5500 + 1000, 5500], // 1 tile away
      [5500 + 1400, 5500], // 1.4 tiles: also in range, but further
    ]);
    const { state, events } = step(start, { p0: E });
    expect(kid(state, "k0").following).toBe("p0");
    expect(kid(state, "k1").following).toBeNull();
    expect(events).toEqual([{ type: "kid_called", kid: "k0", player: "p0" }]);
  });

  it("ignores E when no child is in range, and children who are already following", () => {
    const far = round([[5500 + CALL_RANGE + 1, 5500]]);
    expect(step(far, { p0: E }).state.kids[0]!.following).toBeNull();
    const taken = step(round([[6500, 5500]]), { p0: E }).state;
    expect(step(taken, { p0: E }).events).toEqual([]); // nothing new to call
  });

  it("leads at most 2: holding E calls one child a tick, then stops", () => {
    let state: GameState = round([
      [6000, 5500],
      [5000, 5500],
      [5500, 6200],
    ]);
    state = run(state, { p0: E }, 5);
    expect(state.kids.filter((k) => k.following === "p0")).toHaveLength(MAX_ESCORT);
    expect(state.kids.filter((k) => k.following === null)).toHaveLength(1);
  });

  it("walks at escort speed (2.5 tiles/s) while leading a child", () => {
    const leading = step(round([[5500, 6300]]), { p0: E }).state;
    const moved = step(leading, { p0: hold({ right: true }) }).state;
    expect(player(moved, "p0").x - player(leading, "p0").x).toBe(ESCORT_SPEED);
    expect(ESCORT_SPEED * TICKS_PER_SECOND).toBe(2500); // 2.5 tiles a second
  });

  it("keeps children in a line behind the player, about FOLLOW_GAP apart", () => {
    let state: GameState = round([
      [6000, 5500],
      [5000, 5500],
    ]);
    state = run(state, { p0: E }, 2); // both following: k0 first, then k1
    expect(state.kids.map((k) => k.id)).toEqual(["k0", "k1"]); // line order
    state = run(state, { p0: hold({ down: true }) }, 30); // walk down 3.75 tiles
    const p = player(state, "p0");
    const first = kid(state, "k0");
    const second = kid(state, "k1");
    const gap = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
    expect(gap(p, first)).toBeLessThanOrEqual(FOLLOW_GAP + 1);
    expect(gap(first, second)).toBeLessThanOrEqual(FOLLOW_GAP + 1);
    expect(first.y).toBeLessThan(p.y); // behind (above) the player, who walked down
    expect(second.y).toBeLessThan(first.y);
  });

  it("doesn't let a following child walk through walls", () => {
    let state: GameState = round([[5500, 4500]]); // k0 one tile above the player
    state = step(state, { p0: E }).state;
    state = run(state, { p0: hold({ up: true }) }, 80); // walk into the top wall and stay
    for (const k of state.kids) expect(k.y).toBeGreaterThanOrEqual(1300); // never in row 0
  });

  it("gives the first player in order a child both reach for", () => {
    const players = [
      { id: "p0", tileX: 4, tileY: 5 },
      { id: "p1", tileX: 6, tileY: 5 },
    ];
    const state = step(round([[5500, 5500]], players), { p0: E, p1: E }).state;
    expect(state.kids[0]!.following).toBe("p0");
  });

  it("leaves children lost where they stand when their player leaves", () => {
    const state = step(round([[6500, 5500]]), { p0: E }).state;
    const left = removePlayer(state, "p0");
    expect(left.kids[0]).toEqual({ ...state.kids[0], following: null });
  });

  it("is deterministic: the same inputs give the same line", () => {
    const go = () =>
      run(
        run(
          round([
            [6000, 5500],
            [5000, 5500],
          ]),
          { p0: E },
          2,
        ),
        { p0: hold({ down: true, right: true }) },
        25,
      );
    expect(go().kids).toEqual(go().kids);
  });
});

describe("taking a child home (S2-04)", () => {
  // The 12 × 12 room with two "houses": k0 lives at tile (8, 2), k1 at (2, 8). A started round
  // with the children placed by hand, like the escort tests. p0 stands at tile (8, 3), centre
  // (8500, 3500): children placed less than FOLLOW_GAP from there don't move on the next tick.
  const homes = [
    { tileX: 8, tileY: 2 },
    { tileX: 2, tileY: 8 },
  ];
  const round = (kids: [number, number, string | null][]) => ({
    ...startRound(createGame(ROOM, [{ id: "p0", tileX: 8, tileY: 3 }], { homes })),
    kids: kids.map(([x, y, following], i) => ({ id: `k${i}`, x, y, following })),
  });

  it("knows which house is whose: k<n> lives at homes[n]", () => {
    expect(kidHome(homes, "k0")).toEqual({ tileX: 8, tileY: 2 });
    expect(kidHome(homes, "k1")).toEqual({ tileX: 2, tileY: 8 });
    expect(kidHome(homes, "k2")).toBeUndefined(); // no third house on this map
    expect(kidHome(homes, "kx")).toBeUndefined();
  });

  it("starts every round with nobody home", () => {
    const game = createGame(ROOM, [{ id: "p0", tileX: 8, tileY: 4 }], { homes });
    expect(game.home).toEqual([]);
    expect(game.homes).toEqual(homes);
  });

  it("takes a following child inside at their doorway, with an event", () => {
    // k0 follows p0 and stands 0.9 tiles below their doorway's centre (8500, 2500). k1 is still
    // lost far away, so this isn't the last child (that would also end the round: S2-05).
    const start = round([
      [8500, 2500 + 900, "p0"],
      [2500, 9500, null],
    ]);
    const { state, events } = step(start, {});
    expect(state.kids.map((k) => k.id)).toEqual(["k1"]);
    expect(state.home).toEqual(["k0"]);
    expect(events).toEqual([{ type: "kid_home", kid: "k0", player: "p0" }]);
  });

  it("doesn't take a child in just outside HOME_RANGE", () => {
    const start = round([[8500, 2500 + HOME_RANGE + 1, "p0"]]);
    // k0 is 1 unit from p0, well within FOLLOW_GAP, so it doesn't move.
    const { state, events } = step(start, {});
    expect(state.kids).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it("only takes a child into THEIR house, not someone else's", () => {
    // k1 (who lives at (2, 8)) is led to k0's doorway.
    const start = round([
      [0, 0, null], // k0, lost somewhere else (a placeholder so the next one is k1)
      [8500, 2500 + 500, "p0"],
    ]);
    expect(step(start, {}).state.home).toEqual([]);
  });

  it("leaves a lost child near their own house where they are: someone has to bring them", () => {
    const start = round([[8500, 2500 + 500, null]]);
    const { state } = step(start, {});
    expect(state.kids).toHaveLength(1);
    expect(state.home).toEqual([]);
  });

  it("works end to end: call a child with E, walk them to the doorway, they go in", () => {
    // p0 at (8, 3); k0 a tile below. Call, walk up to the doorway at (8, 2), and keep going.
    let state: GameState = round([[8500, 4500, null]]);
    state = step(state, { p0: { ...NONE, call: true } }).state;
    expect(state.kids[0]!.following).toBe("p0");
    let homeAt: number | undefined;
    for (let t = 0; t < 60 && homeAt === undefined; t++) {
      const result = step(state, { p0: hold({ up: true }) });
      state = result.state;
      if (result.events.some((e) => e.type === "kid_home")) homeAt = t;
    }
    expect(homeAt).toBeDefined();
    expect(state.home).toEqual(["k0"]);
  });

  it("refuses a doorway inside a wall", () => {
    const bad = () =>
      createGame(ROOM, [{ id: "p0", tileX: 5, tileY: 5 }], { homes: [{ tileX: 0, tileY: 0 }] });
    expect(bad).toThrow(RangeError);
  });

  it("clears last round's children when a new round starts", () => {
    const done = { ...round([]), home: ["k0"], phase: "lobby" as const };
    expect(startRound(done).home).toEqual([]);
  });
});

describe("dawn, winning and losing (S2-05)", () => {
  // k0 lives at (8, 2); p0 stands at (8, 3), right below the doorway (same room as S2-04's tests).
  const homes = [{ tileX: 8, tileY: 2 }];
  const round = (kids: [number, number, string | null][]) => ({
    ...startRound(createGame(ROOM, [{ id: "p0", tileX: 8, tileY: 3 }], { homes })),
    kids: kids.map(([x, y, following], i) => ({ id: `k${i}`, x, y, following })),
  });

  it("starts the round with 6:00 on the dawn timer and counts down one tick at a time", () => {
    const start = round([[2500, 9500, null]]);
    expect(start.dawn).toBe(ROUND_TICKS);
    expect(secondsLeft(ROUND_TICKS)).toBe(360);
    expect(run(start, {}, 20).dawn).toBe(ROUND_TICKS - 20);
  });

  it("has no timer in the lobby", () => {
    const lobby = createGame(ROOM, [{ id: "p0", tileX: 8, tileY: 3 }]);
    expect(lobby.dawn).toBe(0);
    expect(run(lobby, {}, 5).dawn).toBe(0);
    expect(run(lobby, {}, 5).phase).toBe("lobby");
  });

  it("is lost when the timer reaches 0 first, with a dawn event and the score", () => {
    // Two children: one home already, one still lost. One tick of dawn left.
    const start = { ...round([[2500, 9500, null]]), home: ["k9"], dawn: 1 };
    const { state, events } = step(start, {});
    expect(state.phase).toBe("lost");
    expect(state.dawn).toBe(0);
    expect(events).toEqual([{ type: "dawn", score: 100 }]); // 1 saved × 100, 0 s left
  });

  it("is won when the last child gets home, with the score at that moment", () => {
    // 4 already home; the last one (k0) is at their doorway; 100 s + 5 ticks left.
    const start = { ...round([[8500, 2500 + 500, "p0"]]), home: ["a", "b", "c", "d"], dawn: 2005 };
    const { state, events } = step(start, {});
    expect(state.phase).toBe("won");
    expect(state.home).toHaveLength(5);
    // 5 × 100 + 100 s × 2 (2004 ticks = 100.2 s → 100) = 700
    expect(events).toContainEqual({ type: "round_won", score: 700 });
  });

  it("counts a win on the very last tick as a win, not a loss", () => {
    const start = { ...round([[8500, 2500 + 500, "p0"]]), dawn: 1 };
    expect(step(start, {}).state.phase).toBe("won");
  });

  it("stops the timer and the children once the round has ended, but players still walk", () => {
    const lost = { ...round([[8500, 4500, null]]), phase: "lost" as const, dawn: 0 };
    const after = run(lost, { p0: { ...NONE, call: true, down: true } }, 10);
    expect(after.phase).toBe("lost");
    expect(after.dawn).toBe(0);
    expect(after.kids[0]!.following).toBeNull(); // E does nothing after the round
    expect(player(after, "p0").y).toBeGreaterThan(player(lost, "p0").y);
  });

  it("scores children × 100 + seconds left × 2 − times lost × 25", () => {
    expect(teamScore({ saved: 5, dawn: 120 * 20, timesLost: 0 })).toBe(740);
    expect(teamScore({ saved: 3, dawn: 0, timesLost: 2 })).toBe(250);
    expect(teamScore({ saved: 0, dawn: 0, timesLost: 0 })).toBe(0);
    expect(teamScore({ saved: 2, dawn: 19, timesLost: 0 })).toBe(200); // under a second: 0 s
  });

  it("returns everyone to the lobby at the spawn after a round, keeping their looks", () => {
    const players = [
      { id: "p0", tileX: 3, tileY: 3, hat: 2, shirt: 4 },
      { id: "p1", tileX: 9, tileY: 9, hat: 1, shirt: 1 },
    ];
    const won = { ...startRound(createGame(ROOM, players)), phase: "won" as const, home: ["k0"] };
    const lobby = returnToLobby(won, { tileX: 5, tileY: 5 });
    expect(lobby.phase).toBe("lobby");
    expect(lobby.kids).toEqual([]);
    expect(lobby.home).toEqual([]);
    expect(lobby.dawn).toBe(0);
    expect(lobby.players.map((p) => [p.id, p.hat, p.shirt])).toEqual([
      ["p0", 2, 4],
      ["p1", 1, 1],
    ]);
    // Both near the spawn, on different tiles.
    expect(player(lobby, "p0")).toMatchObject({ x: 5500, y: 5500 });
    expect(player(lobby, "p1")).toMatchObject({ x: 6500, y: 5500 });
  });

  it("only returns to the lobby once the round is over", () => {
    const playing = round([[2500, 9500, null]]);
    expect(returnToLobby(playing, { tileX: 5, tileY: 5 })).toBe(playing);
  });

  it("can play a second round after the first: new spots, full timer", () => {
    const spots = Array.from({ length: 10 }, (_, i) => ({ tileX: i + 1, tileY: 8 }));
    const first = startRound(
      createGame(ROOM, [{ id: "p0", tileX: 5, tileY: 5 }], { kidSpots: spots }),
    );
    const again = startRound(returnToLobby({ ...first, phase: "lost" }, { tileX: 5, tileY: 5 }));
    expect(again.phase).toBe("round");
    expect(again.dawn).toBe(ROUND_TICKS);
    expect(again.kids).toHaveLength(KID_COUNT);
    expect(again.kids.map((k) => k.x)).not.toEqual(first.kids.map((k) => k.x));
  });
});

describe("emotes (S2-06)", () => {
  const start = () => createGame(ROOM, [{ id: "p0", tileX: 5, tileY: 5 }]);
  const say = (emote: number) => ({ p0: { ...NONE, emote } });

  it("shows an emote at once, with an event", () => {
    const { state, events } = step(start(), say(2));
    expect(player(state, "p0")).toMatchObject({ emote: 2, emoteAt: 1 });
    expect(events).toEqual([{ type: "emote", player: "p0", emote: 2 }]);
  });

  it("clears it after 2 s", () => {
    let state = step(start(), say(0)).state;
    state = run(state, {}, EMOTE_TICKS - 1);
    expect(player(state, "p0").emote).toBe(0); // its 40th tick: still showing
    state = run(state, {}, 1);
    expect(player(state, "p0").emote).toBeNull();
    expect(EMOTE_TICKS / TICKS_PER_SECOND).toBe(2);
  });

  it("allows at most one emote a second, even with different keys", () => {
    let state = step(start(), say(0)).state;
    const tooSoon = run(state, say(1), EMOTE_COOLDOWN_TICKS - 1);
    expect(player(tooSoon, "p0").emote).toBe(0); // the second one was ignored
    state = step(tooSoon, say(1)).state; // a full second after the first
    expect(player(state, "p0")).toMatchObject({ emote: 1, emoteAt: EMOTE_COOLDOWN_TICKS + 1 });
  });

  it("repeats a held emote once a second, never faster", () => {
    let events = 0;
    let state = start();
    for (let t = 0; t < 3 * TICKS_PER_SECOND; t++) {
      const result = step(state, say(3));
      state = result.state;
      events += result.events.filter((e) => e.type === "emote").length;
    }
    expect(events).toBe(3);
  });

  it("ignores emotes out of range", () => {
    for (const bad of [-1, EMOTE_COUNT, 1.5]) {
      expect(player(step(start(), say(bad)).state, "p0").emote).toBeNull();
    }
  });

  it("works in the lobby, the round and after it", () => {
    const lobby = start();
    const round = startRound(lobby);
    const lost = { ...round, phase: "lost" as const };
    for (const state of [lobby, round, lost]) {
      expect(player(step(state, say(1)).state, "p0").emote).toBe(1);
    }
  });

  it("doesn't stop the player walking", () => {
    const state = step(start(), { p0: { ...NONE, right: true, emote: 0 } }).state;
    expect(player(state, "p0").x).toBe(5500 + PLAYER_SPEED);
  });
});

describe("the flashlight and safe zones (S3-01)", () => {
  // A safe zone over the room's left half (columns 1–5); p0 starts at (8, 5), outside it.
  const safeZones = [{ tileX: 1, tileY: 1, width: 5, height: 10 }];
  const round = () =>
    startRound(createGame(ROOM, [{ id: "p0", tileX: 8, tileY: 5 }], { safeZones }));
  const LIGHT = { p0: { ...NONE, light: true } };

  it("faces the way the player last walked, even after stopping", () => {
    let state = step(round(), { p0: hold({ left: true, up: true }) }).state;
    expect(player(state, "p0")).toMatchObject({ faceX: -1, faceY: -1 });
    state = step(state, {}).state;
    expect(player(state, "p0")).toMatchObject({ faceX: -1, faceY: -1 });
  });

  it("turns the light on while Space is held, and drains one tick of battery per tick", () => {
    const state = run(round(), LIGHT, 20);
    expect(player(state, "p0")).toMatchObject({ light: true, battery: BATTERY_MAX - 20 });
    expect(player(step(state, {}).state, "p0").light).toBe(false);
  });

  it("runs out after 90 s of light, then stays off", () => {
    const start = round();
    const empty = { ...start, players: start.players.map((p) => ({ ...p, battery: 1 })) };
    const state = run(empty, LIGHT, 3);
    expect(player(state, "p0")).toMatchObject({ light: false, battery: 0 });
    expect(BATTERY_MAX / TICKS_PER_SECOND).toBe(90);
  });

  it("recharges inside a safe zone, even with the light on, up to full", () => {
    const start = round();
    const inside = {
      ...start,
      players: start.players.map((p) => ({ ...p, x: 3500, battery: 100 })),
    };
    expect(player(step(inside, LIGHT).state, "p0").battery).toBe(100 + BATTERY_RECHARGE);
    expect(player(run(inside, {}, 400), "p0").battery).toBe(BATTERY_MAX);
  });

  it("doesn't drain in the lobby", () => {
    const lobby = createGame(ROOM, [{ id: "p0", tileX: 8, tileY: 5 }], { safeZones });
    expect(player(run(lobby, LIGHT, 10), "p0")).toMatchObject({
      light: true,
      battery: BATTERY_MAX,
    });
  });

  it("gives everyone a full battery when a round starts", () => {
    const lobby = createGame(ROOM, [{ id: "p0", tileX: 8, tileY: 5 }]);
    const used = { ...lobby, players: lobby.players.map((p) => ({ ...p, battery: 5 })) };
    expect(player(startRound(used), "p0").battery).toBe(BATTERY_MAX);
  });
});
