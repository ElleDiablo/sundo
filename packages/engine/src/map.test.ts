/**
 * Tests for the tile map helpers: building a map from text rows ("#" wall, "." floor), looking up
 * walls (outside the map counts as a wall), and converting engine units to tile numbers.
 */
import { describe, expect, it } from "vitest";
import { isWall, mapFromRows, tileOf } from "./map.ts";

describe("mapFromRows", () => {
  it("reads # as wall and . as floor, row by row", () => {
    const map = mapFromRows(["#.", ".#"]);
    expect(map).toEqual({ width: 2, height: 2, walls: [true, false, false, true] });
  });

  it("rejects empty maps, ragged rows and unknown tiles", () => {
    expect(() => mapFromRows([])).toThrow(RangeError);
    expect(() => mapFromRows(["###", "##"])).toThrow(/row 1/);
    expect(() => mapFromRows(["#x#"])).toThrow(/unknown tile/);
  });
});

describe("isWall", () => {
  const map = mapFromRows(["#.", ".."]);

  it("looks up tiles inside the map", () => {
    expect(isWall(map, 0, 0)).toBe(true);
    expect(isWall(map, 1, 0)).toBe(false);
  });

  it("treats everything outside the map as wall", () => {
    expect(isWall(map, -1, 1)).toBe(true);
    expect(isWall(map, 2, 1)).toBe(true);
    expect(isWall(map, 1, -1)).toBe(true);
    expect(isWall(map, 1, 2)).toBe(true);
  });
});

describe("tileOf", () => {
  // 1 tile = 1000 units: units 0–999 are tile 0, 1000 is tile 1. Negative units (off the map's
  // top or left edge) must round down too, to tile -1, so they count as outside the map.
  it("rounds down to the containing tile, including negatives", () => {
    expect(tileOf(0)).toBe(0);
    expect(tileOf(999)).toBe(0);
    expect(tileOf(1000)).toBe(1);
    expect(tileOf(-1)).toBe(-1);
  });
});
