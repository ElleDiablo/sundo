/**
 * Tests for snapshot interpolation: guests draw one snapshot interval in the past, sliding players
 * between the two snapshots either side of that moment. Times are in ms; one tick is 50 ms, so
 * tick 2 = 100 ms. Most tests pass an explicit delay (100 ms, the Sprint 1 setting) so the maths
 * stays readable; the NET-02 tests at the end check the real defaults (every tick, 50 ms).
 */
import { describe, expect, it } from "vitest";
import {
  INTERPOLATION_DELAY_MS,
  SNAPSHOT_INTERVAL_MS,
  SnapshotBuffer,
  TICKS_PER_SNAPSHOT,
} from "./interpolation.ts";

/** A snapshot with one player p1 at (x, 0). */
const snap = (tick: number, x: number) => ({ tick, players: [{ id: "p1", x, y: 0 }], acks: [] });

describe("SnapshotBuffer", () => {
  it("has nothing to draw before the first snapshot", () => {
    expect(new SnapshotBuffer().sample(0)).toBeUndefined();
  });

  it("draws 100 ms in the past, part-way between two snapshots", () => {
    const b = new SnapshotBuffer(100);
    // Snapshots every 2 ticks (100 ms), each arriving exactly on time (offset 0).
    b.push(snap(0, 0), 0);
    b.push(snap(2, 400), 100);
    b.push(snap(4, 800), 200);
    // At 230 ms the buffer draws host time 130 ms = tick 2.6: 30 % from tick 2 to tick 4.
    expect(b.sample(230)).toEqual([{ id: "p1", x: 520, y: 0 }]);
  });

  it("ignores snapshots that arrive out of order or twice", () => {
    const b = new SnapshotBuffer(100);
    expect(b.push(snap(4, 800), 200)).toBe(true);
    expect(b.push(snap(2, 400), 210)).toBe(false);
    expect(b.push(snap(4, 999), 220)).toBe(false);
    expect(b.latest?.tick).toBe(4);
  });

  it("holds players where they were when the next snapshot is late, instead of guessing", () => {
    const b = new SnapshotBuffer(100);
    b.push(snap(0, 0), 0);
    b.push(snap(2, 400), 100);
    expect(b.sample(900)).toEqual([{ id: "p1", x: 400, y: 0 }]);
  });

  it("smooths out jitter: one late snapshot barely moves the clock estimate", () => {
    const steady = new SnapshotBuffer(100);
    const jittery = new SnapshotBuffer(100);
    for (let i = 0; i <= 10; i++) {
      steady.push(snap(i * 2, i * 400), i * 100);
      // The 10th snapshot is 60 ms late.
      jittery.push(snap(i * 2, i * 400), i * 100 + (i === 10 ? 60 : 0));
    }
    const a = steady.sample(1050)![0]!.x;
    const b = jittery.sample(1050)![0]!.x;
    expect(Math.abs(a - b)).toBeLessThanOrEqual(24); // ≤ 10 % of 60 ms of walking (240 units)
  });

  it("starts the clock over after a long pause on the host", () => {
    const b = new SnapshotBuffer(100);
    b.push(snap(0, 0), 0);
    b.push(snap(2, 400), 100);
    // The host's tab was in the background for 5 s: the next snapshot is tick 4, 5 s later.
    b.push(snap(4, 800), 5200);
    b.push(snap(6, 1200), 5300);
    expect(b.sample(5350)).toEqual([{ id: "p1", x: 1000, y: 0 }]);
  });

  it("draws a player who just joined where the newest snapshot has them", () => {
    const b = new SnapshotBuffer(100);
    b.push(snap(0, 0), 0);
    b.push(
      {
        tick: 2,
        players: [
          { id: "p1", x: 400, y: 0 },
          { id: "p2", x: 7, y: 9 },
        ],
        acks: [],
      },
      100,
    );
    expect(b.sample(150)).toEqual([
      { id: "p1", x: 200, y: 0 },
      { id: "p2", x: 7, y: 9 },
    ]);
  });

  // NET-02: 20 snapshots/s and a 50 ms buffer.
  it("by default expects a snapshot every tick and draws one interval (50 ms) in the past", () => {
    expect(TICKS_PER_SNAPSHOT).toBe(1);
    expect(SNAPSHOT_INTERVAL_MS).toBe(50);
    expect(INTERPOLATION_DELAY_MS).toBe(SNAPSHOT_INTERVAL_MS);

    const b = new SnapshotBuffer(); // the default delay
    // A snapshot every tick (50 ms), each arriving exactly on time.
    for (let tick = 0; tick <= 4; tick++) b.push(snap(tick, tick * 200), tick * 50);
    // At 215 ms the buffer draws host time 165 ms = tick 3.3: 30 % from tick 3 to tick 4.
    expect(b.sample(215)).toEqual([{ id: "p1", x: 660, y: 0 }]);
  });

  it("counts the frames where the next snapshot was late (players held still)", () => {
    const b = new SnapshotBuffer(50);
    expect(b.heldRatio).toBeUndefined();
    b.push(snap(0, 0), 0);
    b.push(snap(1, 200), 50);
    b.sample(60); // host time 10 ms: between ticks 0 and 1, fine
    b.sample(90); // host time 40 ms: still fine
    // Tick 2 should arrive at 100 ms but is late: at 120 ms (host time 70 ms) there's nothing
    // newer than tick 1 to slide towards, so p1 is held at tick 1's position.
    expect(b.sample(120)).toEqual([{ id: "p1", x: 200, y: 0 }]);
    b.sample(140);
    expect(b.heldRatio).toBe(0.5); // 2 of 4 frames held
  });

  it("slides the lost children too (S2-02), and has none before the round", () => {
    const b = new SnapshotBuffer(100);
    b.push(snap(0, 0), 0);
    expect(b.sampleKids(50)).toEqual([]);
    b.push({ ...snap(2, 0), kids: [{ id: "k0", x: 1000, y: 0 }] }, 100);
    b.push({ ...snap(4, 0), kids: [{ id: "k0", x: 2000, y: 0 }] }, 200);
    // 250 ms → tick 3: half-way from tick 2 to tick 4.
    expect(b.sampleKids(250)).toEqual([{ id: "k0", x: 1500, y: 0 }]);
  });
});
