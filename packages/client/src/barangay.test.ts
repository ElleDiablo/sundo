/**
 * Tests on the real, generated map (public/assets/maps/barangay.tmj), not a hand-drawn test map:
 * the lost children's hiding spots (S2-02) must all be places a player can actually walk to.
 * A spot behind a wall or across the creek with no bridge would make a round impossible to win.
 *
 * If this fails after editing the map (in Tiled or in scripts/make-assets.ts), move the spot.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  findTiledPoint,
  findTiledPoints,
  isWall,
  KID_COUNT,
  mapFromTiled,
  type TiledMap,
} from "@sundo/engine";

const tiled = JSON.parse(
  readFileSync(new URL("../public/assets/maps/barangay.tmj", import.meta.url), "utf8"),
) as TiledMap;
const map = mapFromTiled(tiled);
const spawn = findTiledPoint(tiled, "spawns", "player");
const spots = findTiledPoints(tiled, "spawns", "kid");

/** Every tile reachable on foot from the plaza spawn (a breadth-first search over open tiles). */
function reachable(): Set<string> {
  const key = (x: number, y: number) => `${x},${y}`;
  const seen = new Set([key(spawn.tileX, spawn.tileY)]);
  const queue = [[spawn.tileX, spawn.tileY] as const];
  while (queue.length > 0) {
    const [x, y] = queue.shift()!;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
      if (seen.has(key(nx, ny)) || isWall(map, nx, ny)) continue;
      seen.add(key(nx, ny));
      queue.push([nx, ny]);
    }
  }
  return seen;
}

describe("the barangay map's hiding spots (S2-02)", () => {
  it("has 12 different spots, enough for 5 children", () => {
    expect(spots).toHaveLength(12);
    expect(new Set(spots.map((s) => `${s.tileX},${s.tileY}`)).size).toBe(12);
    expect(spots.length).toBeGreaterThanOrEqual(KID_COUNT);
  });

  it("puts every spot on open ground that can be walked to from the plaza", () => {
    const open = reachable();
    for (const { tileX, tileY } of spots) {
      expect(isWall(map, tileX, tileY), `(${tileX}, ${tileY}) is a wall`).toBe(false);
      expect(open.has(`${tileX},${tileY}`), `(${tileX}, ${tileY}) can't be reached`).toBe(true);
    }
  });
});
