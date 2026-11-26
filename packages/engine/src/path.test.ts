/** Tests for path-finding (S3-02): shortest first steps around walls, and unreachable goals. */
import { describe, expect, it } from "vitest";
import { mapFromRows, isWall, type TileMap } from "./map.ts";
import { nextStep } from "./path.ts";

// A wall down the middle (x = 4) with a gap at the bottom (y = 4).
const MAP = mapFromRows([
  "#########",
  "#...#...#",
  "#...#...#",
  "#...#...#",
  "#.......#",
  "#########",
]);
const walls = (map: TileMap) => (tx: number, ty: number) => isWall(map, tx, ty);

/** Follows nextStep until the goal (or gives up), returning every tile visited. */
function walk(from: { tx: number; ty: number }, to: { tx: number; ty: number }) {
  const tiles = [from];
  let at = from;
  for (let i = 0; i < 50 && (at.tx !== to.tx || at.ty !== to.ty); i++) {
    at = nextStep(MAP, walls(MAP), at, to)!;
    tiles.push(at);
  }
  return tiles;
}

describe("nextStep", () => {
  it("stays put when already at the goal", () => {
    expect(nextStep(MAP, walls(MAP), { tx: 2, ty: 2 }, { tx: 2, ty: 2 })).toEqual({ tx: 2, ty: 2 });
  });

  it("goes round a wall by the shortest way (through the gap)", () => {
    const tiles = walk({ tx: 2, ty: 1 }, { tx: 6, ty: 1 });
    expect(tiles.at(-1)).toEqual({ tx: 6, ty: 1 });
    expect(tiles).toContainEqual({ tx: 4, ty: 4 }); // the gap
    expect(tiles).toHaveLength(11); // the start + 10 steps: 3 down, 4 across, 3 up
    for (const t of tiles) expect(isWall(MAP, t.tx, t.ty)).toBe(false);
  });

  it("only ever steps to a neighbouring tile (no diagonals)", () => {
    const tiles = walk({ tx: 1, ty: 1 }, { tx: 7, ty: 3 });
    for (let i = 1; i < tiles.length; i++) {
      const d =
        Math.abs(tiles[i]!.tx - tiles[i - 1]!.tx) + Math.abs(tiles[i]!.ty - tiles[i - 1]!.ty);
      expect(d).toBe(1);
    }
  });

  it("returns undefined for a goal that's a wall or can't be reached", () => {
    expect(nextStep(MAP, walls(MAP), { tx: 1, ty: 1 }, { tx: 4, ty: 1 })).toBeUndefined();
    const closed = (tx: number, ty: number) => isWall(MAP, tx, ty) || (tx === 4 && ty === 4);
    expect(nextStep(MAP, closed, { tx: 1, ty: 1 }, { tx: 6, ty: 1 })).toBeUndefined();
  });

  it("avoids extra blocked tiles (the tikbalang's safe zones)", () => {
    const blocked = (tx: number, ty: number) => isWall(MAP, tx, ty) || (tx === 2 && ty === 2);
    const step = nextStep(MAP, blocked, { tx: 2, ty: 1 }, { tx: 2, ty: 3 });
    expect(step).not.toEqual({ tx: 2, ty: 2 });
  });
});
