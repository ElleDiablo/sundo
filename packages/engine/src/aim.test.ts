/**
 * Tests for aim.ts (look pass): the 32 flashlight directions.
 */
import { describe, expect, it } from "vitest";
import { AIM_STEPS, AIM_VECTORS, aimOfAngle, aimOfKeys, angleOfAim, isAim } from "./aim.ts";

describe("aim", () => {
  it("has one vector about 1000 long per step, matching its angle", () => {
    expect(AIM_VECTORS).toHaveLength(AIM_STEPS);
    AIM_VECTORS.forEach(([x, y], aim) => {
      expect(Math.hypot(x, y)).toBeCloseTo(1000, -1); // within ±5 of 1000
      expect(x).toBeCloseTo(Math.cos(angleOfAim(aim)) * 1000, -1);
      expect(y).toBeCloseTo(Math.sin(angleOfAim(aim)) * 1000, -1);
    });
  });

  it("maps the 8 key directions to every 4th step", () => {
    expect(aimOfKeys(1, 0)).toBe(0); // right
    expect(aimOfKeys(1, 1)).toBe(4); // down-right
    expect(aimOfKeys(0, 1)).toBe(8); // down
    expect(aimOfKeys(-1, 0)).toBe(16); // left
    expect(aimOfKeys(0, -1)).toBe(24); // up
    expect(aimOfKeys(1, -1)).toBe(28); // up-right
  });

  it("rounds an angle to the nearest step and wraps around", () => {
    expect(aimOfAngle(0)).toBe(0);
    expect(aimOfAngle(Math.PI / 2)).toBe(8);
    expect(aimOfAngle(-Math.PI / 2)).toBe(24); // atan2 gives negatives for "up"
    expect(aimOfAngle(2 * Math.PI - 0.01)).toBe(0);
  });

  it("accepts only whole numbers 0 … 31", () => {
    expect([0, 31].every(isAim)).toBe(true);
    expect([-1, 32, 1.5, "3", undefined].some(isAim)).toBe(false);
  });
});
