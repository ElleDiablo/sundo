/** Tests for the hoofbeat warning (S3-05): silent far away or in ambush, faster and louder nearer. */
import { describe, expect, it } from "vitest";
import { HEARING_TILES, warning } from "./hoofbeats.ts";

describe("warning", () => {
  it("is silent beyond 12 tiles, while waiting and while lying in ambush", () => {
    expect(warning(HEARING_TILES + 0.1, "patrol")).toBeUndefined();
    expect(warning(3, "wait")).toBeUndefined();
    expect(warning(3, "ambush")).toBeUndefined();
  });

  it("gets faster, louder and stronger as it comes nearer", () => {
    const far = warning(11, "patrol")!;
    const near = warning(2, "patrol")!;
    expect(near.intervalMs).toBeLessThan(far.intervalMs);
    expect(near.volume).toBeGreaterThan(far.volume);
    expect(near.ring).toBeGreaterThan(far.ring);
    expect(warning(1, "stalk")).toEqual({ intervalMs: 350, volume: 0.25, ring: 1 });
    expect(warning(12, "stalk")).toMatchObject({ intervalMs: 900, volume: 0, ring: 0 });
  });

  it("gallops during a chase", () => {
    expect(warning(8, "chase")!.intervalMs).toBe(250);
  });
});
