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
  it("rounds down to the containing tile, including negatives", () => {
    expect(tileOf(0)).toBe(0);
    expect(tileOf(999)).toBe(0);
    expect(tileOf(1000)).toBe(1);
    expect(tileOf(-1)).toBe(-1);
  });
});
