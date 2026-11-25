import { describe, expect, it } from "vitest";
import { createRng } from "./rng.ts";

describe("createRng", () => {
  it("gives the same sequence for the same seed (replays work)", () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 100 }, () => a.next());
    const seqB = Array.from({ length: 100 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("gives different sequences for different seeds", () => {
    const a = createRng(1);
    const b = createRng(2);
    expect(a.next()).not.toEqual(b.next());
  });

  it("keeps next() within [0, 1)", () => {
    const rng = createRng(7);
    for (let i = 0; i < 10_000; i++) {
      const x = rng.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("int() covers both ends of the range and nothing outside it", () => {
    const rng = createRng(123);
    const seen = new Set<number>();
    for (let i = 0; i < 1_000; i++) seen.add(rng.int(1, 5));
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("int() rejects bad ranges", () => {
    const rng = createRng(1);
    expect(() => rng.int(5, 1)).toThrow(RangeError);
    expect(() => rng.int(0.5, 2)).toThrow(RangeError);
  });

  it("pick() only returns items from the array, and rejects empty arrays", () => {
    const rng = createRng(9);
    const spots = ["kapilya", "tindahan", "tulay"] as const;
    for (let i = 0; i < 100; i++) expect(spots).toContain(rng.pick(spots));
    expect(() => rng.pick([])).toThrow(RangeError);
  });

  it("can resume from a saved state", () => {
    const rng = createRng(2026);
    rng.next();
    rng.next();
    const resumed = createRng(rng.state);
    expect(resumed.next()).toEqual(rng.next());
  });
});
