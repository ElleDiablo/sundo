/**
 * Tests for the tikbalang (S3-02): grace period, patrol, what it can see (range, light, walls,
 * safe zones), stalk → chase, catching, losing sight, ambush, being slowed by a flashlight, and
 * determinism; getting caught (S3-03): naligaw in the grove, scattered children, the score; and
 * baliktad (S3-04): invisible for 5 s, 30 s cooldown. A 20 × 12 room with one wall segment keeps each case easy to picture:
 *
 *   x: 0         10        19
 *      ####################   y 0
 *      #..................#
 *      #.....#............#   a wall at x = 6, y 2–5
 *      #.....#............#
 *      #.....#............#
 *      #.....#............#
 *      #..................#
 *      …                      y 11 = wall
 */
import { describe, expect, it } from "vitest";
import {
  BALIKTAD_COOLDOWN,
  BALIKTAD_TICKS,
  createGame,
  startRound,
  step,
  teamScore,
  type GameState,
  type Inputs,
} from "./game.ts";
import { mapFromRows } from "./map.ts";
import {
  AMBUSH_RANGE,
  CATCH_RANGE,
  GRACE_TICKS,
  LOSE_SIGHT_TICKS,
  SIGHT_DARK,
  TIK_SPEED,
  type TikbalangState,
} from "./tikbalang.ts";

const rows = Array.from({ length: 12 }, (_, y) =>
  y === 0 || y === 11
    ? "#".repeat(20)
    : y >= 2 && y <= 5
      ? "#.....#............#"
      : "#..................#",
);
const ROOM = mapFromRows(rows);
const NONE = { up: false, down: false, left: false, right: false };

/** A started round: p0 at tile (px, py), the tikbalang placed by hand (mode etc. overridable). */
function round(
  tik: Partial<TikbalangState> & { x: number; y: number },
  px = 15,
  py = 8,
  options: Parameters<typeof createGame>[2] = {},
): GameState {
  const game = startRound(
    createGame(ROOM, [{ id: "p0", tileX: px, tileY: py }], {
      tikSpawn: { tileX: 1, tileY: 1 },
      patrol: [
        { tileX: 2, tileY: 9 },
        { tileX: 17, tileY: 9 },
      ],
      ...options,
    }),
  );
  return { ...game, tikbalang: { ...game.tikbalang!, mode: "patrol", timer: 0, ...tik } };
}
function run(state: GameState, inputs: Inputs, ticks: number) {
  const events = [];
  for (let i = 0; i < ticks; i++) {
    const r = step(state, inputs);
    state = r.state;
    events.push(...r.events);
  }
  return { state, events };
}
const tik = (s: GameState) => s.tikbalang!;

describe("the tikbalang (S3-02)", () => {
  it("appears at its spawn when the round starts and waits out a 10 s grace period", () => {
    const game = startRound(
      createGame(ROOM, [{ id: "p0", tileX: 15, tileY: 8 }], { tikSpawn: { tileX: 1, tileY: 1 } }),
    );
    expect(tik(game)).toMatchObject({ x: 1500, y: 1500, mode: "wait", timer: GRACE_TICKS });
    expect(tik(run(game, {}, GRACE_TICKS - 1).state).mode).toBe("wait");
    expect(tik(run(game, {}, GRACE_TICKS).state).mode).toBe("patrol");
  });

  it("isn't there in the lobby", () => {
    const lobby = createGame(ROOM, [{ id: "p0", tileX: 15, tileY: 8 }], {
      tikSpawn: { tileX: 1, tileY: 1 },
    });
    expect(lobby.tikbalang).toBeNull();
  });

  it("walks to a patrol point around walls at 3 tiles/s", () => {
    // From (1, 3), west of the wall, to patrol point 1 at (17, 9). Player far away (and hidden).
    let state = round({ x: 1500, y: 3500, goal: 1 }, 1, 10);
    state = { ...state, players: [] };
    const before = tik(state);
    state = step(state, {}).state;
    const moved = Math.hypot(tik(state).x - before.x, tik(state).y - before.y);
    expect(moved).toBeCloseTo(TIK_SPEED, 0);
    state = run(state, {}, 200).state;
    // It got there (and has picked a new goal or an ambush) without ever being in a wall.
    expect(tik(state).mode === "patrol" || tik(state).mode === "ambush").toBe(true);
  });

  it("sees a player within 5 tiles in the dark and starts stalking", () => {
    const state = round({ x: 10500, y: 8500 }, 14, 8); // 4 tiles away
    const { state: after, events } = run(state, {}, 1);
    expect(tik(after)).toMatchObject({ mode: "stalk", target: "p0" });
    expect(events).toContainEqual({ type: "tikbalang", mode: "stalk", player: "p0" });
  });

  it("doesn't see a player 7 tiles away in the dark, but does if their flashlight is on", () => {
    const state = round({ x: 8500, y: 8500 }, 15, 8);
    expect(tik(run(state, {}, 1).state).mode).toBe("patrol");
    const lit = run(state, { p0: { ...NONE, light: true } }, 1).state;
    expect(tik(lit).mode).toBe("stalk");
    expect(7000).toBeGreaterThan(SIGHT_DARK);
  });

  it("can't see through a wall", () => {
    // Tikbalang at (4, 3), player at (8, 3): the wall at x = 6 is between them.
    const state = round({ x: 4500, y: 3500 }, 8, 3);
    expect(tik(run(state, {}, 1).state).mode).toBe("patrol");
  });

  it("can't see a player in a safe zone, and never walks into one", () => {
    const safeZones = [{ tileX: 13, tileY: 6, width: 5, height: 4 }]; // around the player
    const state = round({ x: 10500, y: 8500, mode: "chase", target: "p0" }, 15, 8, {
      safeZones,
    });
    const after = run(state, {}, 80).state;
    expect(tik(after).mode).not.toBe("chase"); // lost sight → patrol
    for (const { state: s } of [run(state, {}, 40)]) {
      expect(s.tikbalang!.x).toBeLessThan(13000); // stayed out of the zone
    }
  });

  it("chases a lone player it has stalked for 2 s, and catches them", () => {
    // 4 tiles away, alone: 1 tick to notice, 40 ticks of pressure, then ~22 ticks to close the
    // 3.3 tiles at 3 tiles/s.
    const state = round({ x: 11500, y: 8500 }, 15, 8);
    const { state: after, events } = run(state, {}, 70);
    expect(events).toContainEqual({ type: "tikbalang", mode: "chase", player: "p0" });
    expect(events).toContainEqual({ type: "caught", player: "p0" });
    expect(tik(after).mode).toBe("wait"); // resting after the catch
  });

  it("doesn't rush a player who has company, at first", () => {
    const state = startRound(
      createGame(
        ROOM,
        [
          { id: "p0", tileX: 15, tileY: 8 },
          { id: "p1", tileX: 16, tileY: 8 },
        ],
        { tikSpawn: { tileX: 1, tileY: 1 } },
      ),
    );
    const s = {
      ...state,
      tikbalang: { ...tik(state), x: 11500, y: 8500, mode: "patrol" as const, timer: 0 },
    };
    expect(tik(run(s, {}, 60).state).mode).toBe("stalk"); // still only stalking
  });

  it("gives up after 3 s without seeing its target", () => {
    // Chasing a player who is now behind the wall and out of range.
    const state = round({ x: 4500, y: 3500, mode: "chase", target: "p0" }, 18, 3);
    const after = run(state, {}, LOSE_SIGHT_TICKS + 1).state;
    expect(tik(after).mode).toBe("patrol");
  });

  it("charges from an ambush point when a player comes within 4 tiles", () => {
    const ambush = [{ tileX: 10, tileY: 8 }];
    const waiting = round({ x: 10500, y: 8500, mode: "ambush", goal: 0, timer: 300 }, 16, 8, {
      ambush,
    });
    expect(tik(step(waiting, {}).state).mode).toBe("ambush"); // 6 tiles: keeps still
    const close = round({ x: 10500, y: 8500, mode: "ambush", goal: 0, timer: 300 }, 13, 8, {
      ambush,
    });
    expect(tik(step(close, {}).state).mode).toBe("chase");
    expect(3000).toBeLessThan(AMBUSH_RANGE);
  });

  it("is slowed to half speed by a flashlight shone at it", () => {
    // Chasing p0, who faces left (towards it) with the light on.
    const state = round({ x: 10500, y: 8500, mode: "chase", target: "p0" }, 15, 8);
    const facing = {
      ...state,
      players: state.players.map((p) => ({ ...p, faceX: -1, faceY: 0 })),
    };
    const dark = step(facing, {}).state;
    const lit = step(facing, { p0: { ...NONE, light: true } }).state;
    expect(tik(dark).x - 10500).toBe(TIK_SPEED);
    expect(tik(lit).x - 10500).toBe(TIK_SPEED / 2);
  });

  it("is deterministic: the same seed and inputs give the same tikbalang", () => {
    const go = () => {
      const game = startRound(
        createGame(ROOM, [{ id: "p0", tileX: 15, tileY: 8 }], {
          seed: 42,
          tikSpawn: { tileX: 1, tileY: 1 },
          patrol: [
            { tileX: 2, tileY: 9 },
            { tileX: 17, tileY: 9 },
            { tileX: 10, tileY: 1 },
          ],
          ambush: [{ tileX: 12, tileY: 4 }],
        }),
      );
      return run(game, { p0: { ...NONE, left: true } }, 600).state.tikbalang;
    };
    expect(go()).toEqual(go());
  });

  it("catches within 0.7 tiles", () => {
    expect(CATCH_RANGE).toBe(700);
  });
});

describe("getting caught: naligaw (S3-03)", () => {
  const grove = [{ tileX: 2, tileY: 9 }];
  const kidSpots = [
    { tileX: 17, tileY: 1 },
    { tileX: 13, tileY: 9 },
    { tileX: 12, tileY: 9 },
  ];
  // The tikbalang one step from catching p0, who leads two children.
  const caughtSoon = () => {
    const state = round({ x: 14500 - 800, y: 8500, mode: "chase", target: "p0" }, 14, 8, {
      grove,
      kidSpots,
    });
    return {
      ...state,
      kids: [
        { id: "k0", x: 14500, y: 7700, following: "p0" },
        { id: "k1", x: 14500, y: 6900, following: "p0" },
        { id: "k2", x: 12500, y: 9500, following: null }, // lost, on spot (12, 9)
      ],
    };
  };

  it("drops the caught player in the bamboo grove and counts a time lost", () => {
    const { state, events } = run(caughtSoon(), {}, 1);
    expect(events).toContainEqual({ type: "caught", player: "p0" });
    expect(state.players[0]).toMatchObject({ x: 2500, y: 9500 });
    expect(state.timesLost).toBe(1);
    expect(state.lastCaught).toEqual({ player: "p0", tick: 1 }); // the tick it happened on
  });

  it("scatters their children to the nearest free hiding spots", () => {
    const { state } = run(caughtSoon(), {}, 1);
    const k0 = state.kids.find((k) => k.id === "k0")!;
    const k1 = state.kids.find((k) => k.id === "k1")!;
    expect(k0).toMatchObject({ following: null, x: 13500, y: 9500 }); // (13, 9): (12, 9) is taken
    expect(k1).toMatchObject({ following: null, x: 17500, y: 1500 }); // the next free one
  });

  it("costs 25 points in the team score", () => {
    const { state } = run(caughtSoon(), {}, 1);
    expect(teamScore({ saved: 0, dawn: 0, timesLost: state.timesLost })).toBe(-25);
  });
});

describe("baliktad (S3-04)", () => {
  const Q = { p0: { ...NONE, baliktad: true } };

  it("hides me from the tikbalang for 5 s, with an event", () => {
    const state = round({ x: 11500, y: 8500 }, 14, 8); // 3 tiles away: it would see me
    const { state: after, events } = run(state, Q, 1);
    expect(events).toContainEqual({ type: "baliktad", player: "p0" });
    expect(after.players[0]).toMatchObject({
      baliktad: BALIKTAD_TICKS,
      baliktadCooldown: BALIKTAD_COOLDOWN,
    });
    expect(tik(after).mode).toBe("patrol"); // didn't see me
    const later = run(after, {}, BALIKTAD_TICKS).state; // 5 s on: visible again
    expect(later.players[0]!.baliktad).toBe(0);
  });

  it("ends a chase on me at once", () => {
    const state = round({ x: 11500, y: 8500, mode: "chase", target: "p0" }, 14, 8);
    expect(tik(run(state, Q, 1).state)).toMatchObject({ mode: "patrol", target: null });
  });

  it("needs 30 s before it works again, and only works in the round", () => {
    const used = run(round({ x: 1500, y: 9500 }, 14, 8), Q, 1).state;
    const again = run(used, Q, 200).state; // holding Q (or pressing again) during the cooldown
    expect(again.players[0]!.baliktad).toBe(0);
    expect(again.players[0]!.baliktadCooldown).toBe(BALIKTAD_COOLDOWN - 200);
    const lobby = createGame(ROOM, [{ id: "p0", tileX: 14, tileY: 8 }]);
    expect(run(lobby, Q, 1).state.players[0]!.baliktad).toBe(0);
  });
});
