/**
 * Tests for light and sight (S3-01): safe zones, line of sight past walls and the flashlight cone.
 */
import { describe, expect, it } from "vitest";
import { inCone, inZone, LIGHT_RANGE, lineOfSight, tileInZone } from "./light.ts";
import { mapFromRows } from "./map.ts";

// 10 × 5: a wall column at x = 5 with a gap in row 1.
const MAP = mapFromRows(["##########", "#........#", "#....#...#", "#....#...#", "##########"]);

describe("safe zones", () => {
  const zones = [{ tileX: 2, tileY: 1, width: 3, height: 2 }]; // tiles x 2–4, y 1–2

  it("contains points on its tiles and nothing outside", () => {
    expect(inZone(zones, 2000, 1000)).toBe(true); // top-left corner
    expect(inZone(zones, 4999, 2999)).toBe(true); // bottom-right corner
    expect(inZone(zones, 5000, 1500)).toBe(false); // just right of it
    expect(inZone(zones, 1999, 1500)).toBe(false); // just left of it
    expect(tileInZone(zones, 4, 2)).toBe(true);
    expect(tileInZone(zones, 4, 3)).toBe(false);
  });
});

describe("lineOfSight", () => {
  it("sees along open floor and is blocked by a wall", () => {
    expect(lineOfSight(MAP, 1500, 3500, 4500, 3500)).toBe(true);
    expect(lineOfSight(MAP, 1500, 3500, 7500, 3500)).toBe(false); // through the wall at x = 5
  });

  it("sees through a gap in the wall", () => {
    expect(lineOfSight(MAP, 1500, 1500, 8500, 1500)).toBe(true);
  });

  it("is the same both ways", () => {
    expect(lineOfSight(MAP, 7500, 3500, 1500, 3500)).toBe(lineOfSight(MAP, 1500, 3500, 7500, 3500));
  });
});

describe("inCone (35° either side, 5 tiles)", () => {
  it("lights what's straight ahead within range, not behind", () => {
    expect(inCone(0, 0, 0, 3000, 0)).toBe(true);
    expect(inCone(0, 0, 0, LIGHT_RANGE + 1, 0)).toBe(false);
    expect(inCone(0, 0, 0, -1000, 0)).toBe(false);
  });

  it("lights up to about 35° off the direction", () => {
    expect(inCone(0, 0, 0, 2000, 1300)).toBe(true); // 33°
    expect(inCone(0, 0, 0, 2000, 1500)).toBe(false); // 37°
  });

  it("works for any of the 32 aims", () => {
    expect(inCone(0, 0, 8, 0, 3000)).toBe(true); // aim 8 = straight down
    expect(inCone(0, 0, 2, 3000, 1300)).toBe(true); // aim 2 = 22.5°; the point is at 23°
    expect(inCone(0, 0, 24, 0, 3000)).toBe(false); // aim 24 = up; the point is below
  });

  it("works on diagonals", () => {
    expect(inCone(0, 0, 4, 2000, 2000)).toBe(true); // straight down the diagonal
    expect(inCone(0, 0, 4, 3000, 0)).toBe(false); // 45° off
  });
});
