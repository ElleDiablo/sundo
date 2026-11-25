/**
 * Tests for the fixed timestep: whatever the screen's frame rate, the engine must tick exactly 20
 * times a second, and a long pause must not make the game try to catch up all at once.
 */
import { describe, expect, it } from "vitest";
import { advance, createFixedStep } from "./fixedStep.ts";

describe("fixed timestep", () => {
  it("banks short frames until a whole tick is ready", () => {
    const clock = createFixedStep(50);
    expect(advance(clock, 16).ticks).toBe(0);
    expect(advance(clock, 16).ticks).toBe(0);
    expect(advance(clock, 16).ticks).toBe(0);
    const r = advance(clock, 16); // 64 ms banked
    expect(r.ticks).toBe(1);
    expect(r.alpha).toBeCloseTo(14 / 50);
  });

  // Simulate 10 seconds at 30, 60 and 144 frames per second: always ~200 ticks (20 per second).
  // 199 is allowed because the last partial tick may still be in the bank.
  it("runs 20 ticks per second whatever the frame rate", () => {
    for (const fps of [30, 60, 144]) {
      const clock = createFixedStep(50);
      let ticks = 0;
      for (let i = 0; i < fps * 10; i++) ticks += advance(clock, 1000 / fps).ticks;
      expect(ticks).toBeGreaterThanOrEqual(199);
      expect(ticks).toBeLessThanOrEqual(200);
    }
  });

  it("runs several ticks after a slow frame", () => {
    const clock = createFixedStep(50);
    expect(advance(clock, 160)).toEqual({ ticks: 3, alpha: 10 / 50 });
  });

  // A 10-second pause (hidden tab) owes 200 ticks; only 5 run, and the rest is dropped.
  it("caps catch-up after a long pause instead of freezing", () => {
    const clock = createFixedStep(50, 5);
    expect(advance(clock, 10_000)).toEqual({ ticks: 5, alpha: 0 });
    expect(advance(clock, 16).ticks).toBe(0);
  });

  it("ignores negative frame times", () => {
    const clock = createFixedStep(50);
    expect(advance(clock, -100)).toEqual({ ticks: 0, alpha: 0 });
  });
});
