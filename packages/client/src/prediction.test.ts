/**
 * Tests for client-side prediction: the guest moves at once, re-bases on the host's snapshots,
 * replays only what the host hasn't applied yet, and fades small corrections out.
 */
import { describe, expect, it } from "vitest";
import { mapFromRows, PLAYER_SPEED } from "@sundo/engine";
import { Predictor, SMOOTHING_MS, type TickInput } from "./prediction.ts";

// An open 10 × 3 field with walls all round. Tile (1, 1) has its centre at (1500, 1500).
const map = mapFromRows(["##########", "#........#", "##########"]);
const none = { up: false, down: false, left: false, right: false };
const right = { ...none, right: true };
const start = { x: 1500, y: 1500 };

/** A predictor that already knows where it starts (as after the first snapshot). */
function ready(): Predictor {
  const p = new Predictor(map, "p1");
  p.reconcile({ ...start, ackSeq: 0, ackTicks: 0 });
  return p;
}

const walk = (p: Predictor, input: TickInput, ticks: number) => {
  for (let i = 0; i < ticks; i++) p.tick(input);
};

describe("Predictor", () => {
  it("does nothing until the first snapshot says where I am", () => {
    const p = new Predictor(map, "p1");
    p.tick({ seq: 1, keys: right });
    expect(p.ready).toBe(false);
    expect(p.position(1)).toBeUndefined();
  });

  it("moves me on the very next tick, without waiting for the host", () => {
    const p = ready();
    p.tick({ seq: 1, keys: right });
    expect(p.position(1)).toEqual({ x: start.x + PLAYER_SPEED, y: start.y });
    expect(p.position(0.5)).toEqual({ x: start.x + PLAYER_SPEED / 2, y: start.y }); // between ticks
  });

  it("changes nothing visible when the host agrees with the prediction", () => {
    const p = ready();
    walk(p, { seq: 1, keys: right }, 6);
    // The host has applied input #1 for 2 ticks so far: 4 of my ticks are still in flight.
    p.reconcile({ x: start.x + 2 * PLAYER_SPEED, y: start.y, ackSeq: 1, ackTicks: 2 });
    expect(p.pending).toBe(4);
    expect(p.position(1)).toEqual({ x: start.x + 6 * PLAYER_SPEED, y: start.y });
  });

  it("drops every tick of older inputs and replays the newer ones", () => {
    const p = ready();
    walk(p, { seq: 1, keys: right }, 3);
    walk(p, { seq: 2, keys: none }, 2); // I stopped
    // The host has #1 for 3 ticks and #2 for 1 tick: one tick of #2 left to replay.
    p.reconcile({ x: start.x + 3 * PLAYER_SPEED, y: start.y, ackSeq: 2, ackTicks: 1 });
    expect(p.pending).toBe(1);
    expect(p.position(1)).toEqual({ x: start.x + 3 * PLAYER_SPEED, y: start.y });
  });

  it("glides to the host's answer when it disagrees a little, instead of snapping", () => {
    const p = ready();
    walk(p, { seq: 1, keys: right }, 3);
    walk(p, { seq: 2, keys: none }, 2);
    // My "stop" reached the host late: it walked me one tick further than I predicted.
    const host = start.x + 4 * PLAYER_SPEED;
    p.reconcile({ x: host, y: start.y, ackSeq: 1, ackTicks: 4 });
    // Drawn where I was a moment ago (no jump this frame)...
    expect(p.position(1)!.x).toBe(start.x + 3 * PLAYER_SPEED);
    // ...then all the way to the host's answer after ~600 ms (6 smoothing periods).
    for (let i = 0; i < 60; i++) p.decay(SMOOTHING_MS / 10);
    expect(p.position(1)!.x).toBe(host);
  });

  it("snaps when the host disagrees by more than two tiles", () => {
    const p = ready();
    walk(p, { seq: 1, keys: right }, 2);
    p.reconcile({ x: 6500, y: start.y, ackSeq: 1, ackTicks: 2 }); // far away
    expect(p.position(1)).toEqual({ x: 6500, y: start.y });
  });

  it("stops at walls exactly like the host's engine", () => {
    const p = ready();
    walk(p, { seq: 1, keys: right }, 100); // far more than the field is long
    // Wall column 9 starts at 9000; the box is 300 units half-wide → stops at 8700.
    expect(p.position(1)).toEqual({ x: 8700, y: start.y });
  });

  it("predicts nothing new before any input is sent (seq 0 = no keys)", () => {
    const p = ready();
    p.tick(undefined);
    expect(p.position(1)).toEqual(start);
  });
});
