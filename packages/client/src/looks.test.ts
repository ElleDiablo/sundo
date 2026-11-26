/**
 * Tests for the look lists (S2-01): they must match the engine's counts, or a pick could point at
 * a spritesheet row that doesn't exist (or a valid engine number would have no picture).
 */
import { describe, expect, it } from "vitest";
import { HAT_COUNT, SHIRT_COUNT } from "@sundo/engine";
import { defaultShirt, HATS, lookRow, SHIRTS } from "./looks.ts";

describe("looks", () => {
  it("has exactly as many hats and shirts as the engine allows", () => {
    expect(HATS.length).toBe(HAT_COUNT);
    expect(SHIRTS.length).toBe(SHIRT_COUNT);
  });

  it("gives every look its own spritesheet row", () => {
    const rows = new Set<number>();
    for (let h = 0; h < HAT_COUNT; h++)
      for (let s = 0; s < SHIRT_COUNT; s++) rows.add(lookRow(h, s));
    expect(rows.size).toBe(HAT_COUNT * SHIRT_COUNT);
    expect(Math.max(...rows)).toBe(HAT_COUNT * SHIRT_COUNT - 1);
  });

  it("starts the four seats in four different shirts", () => {
    expect(new Set([0, 1, 2, 3].map(defaultShirt)).size).toBe(4);
  });
});
