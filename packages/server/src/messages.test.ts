/**
 * Tests for reading messages off the network: known shapes come through, anything else is ignored
 * (never trusted, never a crash).
 */
import { describe, expect, it } from "vitest";
import { parseServerMessage, readInputBody, readJoinCode, readSnapshotBody } from "./messages.ts";

describe("parseServerMessage", () => {
  it("reads every message the relay sends", () => {
    expect(parseServerMessage('{"type":"room_created","code":"BAHO"}')).toEqual({
      type: "room_created",
      code: "BAHO",
    });
    expect(parseServerMessage('{"type":"room_joined","code":"BAHO","seat":2}')).toEqual({
      type: "room_joined",
      code: "BAHO",
      seat: 2,
    });
    expect(parseServerMessage('{"type":"player_joined","seat":1}')).toEqual({
      type: "player_joined",
      seat: 1,
    });
    expect(parseServerMessage('{"type":"join_error","reason":"full","message":"Full."}')).toEqual({
      type: "join_error",
      reason: "full",
      message: "Full.",
    });
    expect(parseServerMessage('{"type":"player_left","seat":2}')).toEqual({
      type: "player_left",
      seat: 2,
    });
    expect(parseServerMessage('{"type":"host_left"}')).toEqual({ type: "host_left" });
    expect(parseServerMessage('{"type":"join_error","reason":"ended","message":"Over."}')).toEqual({
      type: "join_error",
      reason: "ended",
      message: "Over.",
    });
    expect(parseServerMessage('{"type":"error","message":"nope"}')).toEqual({
      type: "error",
      message: "nope",
    });
  });

  it("ignores anything else instead of crashing", () => {
    for (const data of [
      "",
      "not json",
      "null",
      "42",
      '{"type":"room_created"}',
      '{"type":"party"}',
      '{"type":"room_joined","code":"BAHO","seat":"2"}',
      '{"type":"player_joined","seat":1.5}',
      '{"type":"join_error","reason":"bored","message":"x"}',
    ]) {
      expect(parseServerMessage(data), data).toBeUndefined();
    }
  });
});

describe("readJoinCode", () => {
  it("reads the code and cuts off anything absurdly long", () => {
    expect(readJoinCode('{"action":"join_room","code":"BAHO"}')).toBe("BAHO");
    expect(readJoinCode(`{"code":"${"A".repeat(500)}"}`)).toHaveLength(10);
  });

  it("returns undefined without a code", () => {
    expect(readJoinCode('{"action":"join_room"}')).toBeUndefined();
    expect(readJoinCode("not json")).toBeUndefined();
    expect(readJoinCode(undefined)).toBeUndefined();
  });
});

describe("input and snapshot messages", () => {
  const snapshot = {
    tick: 40,
    players: [{ id: "p0", x: 1500, y: -20 }],
    acks: [0, 3],
    ackTicks: [0, 12],
  };

  it("reads valid ones, both from a browser and from the relay", () => {
    const input = { seq: 7, up: true, down: false, left: false, right: false };
    expect(readInputBody(JSON.stringify({ action: "input", ...input }))).toEqual(input);
    expect(parseServerMessage(JSON.stringify({ type: "input", seat: 2, ...input }))).toEqual({
      type: "input",
      seat: 2,
      ...input,
    });
    expect(readSnapshotBody(JSON.stringify({ action: "snapshot", ...snapshot }))).toEqual(snapshot);
    expect(parseServerMessage(JSON.stringify({ type: "snapshot", ...snapshot }))).toEqual({
      type: "snapshot",
      ...snapshot,
    });
  });

  it("still reads a snapshot without ackTicks (from a host that predates NET-01)", () => {
    const older = { tick: snapshot.tick, players: snapshot.players, acks: snapshot.acks };
    expect(readSnapshotBody(JSON.stringify(older))).toEqual(older);
  });

  it("drops fields it doesn't know instead of passing them on", () => {
    const sneaky = { ...snapshot, players: [{ id: "p0", x: 1, y: 2, admin: true }], extra: "x" };
    expect(readSnapshotBody(JSON.stringify(sneaky))).toEqual({
      ...snapshot,
      players: [{ id: "p0", x: 1, y: 2 }],
    });
  });

  it("rejects missing, wrong-typed or absurd values", () => {
    for (const body of [
      '{"seq":1,"up":true,"down":false,"left":false}', // a key missing
      '{"seq":1.5,"up":true,"down":false,"left":false,"right":false}',
      '{"seq":-1,"up":true,"down":false,"left":false,"right":false}',
      '{"seq":1,"up":"yes","down":false,"left":false,"right":false}',
      '{"seq":1,"up":true,"down":false,"left":false,"right":false,"hat":-1}',
      '{"seq":1,"up":true,"down":false,"left":false,"right":false,"shirt":2.5}',
      '{"seq":1,"up":true,"down":false,"left":false,"right":false,"call":"yes"}',
      "[]",
    ]) {
      expect(readInputBody(body), body).toBeUndefined();
    }
    const five = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, x: 0, y: 0 }));
    for (const bad of [
      { ...snapshot, tick: -1 },
      { ...snapshot, players: five }, // more players than seats
      { ...snapshot, players: [{ id: "p0", x: 1e12, y: 0 }] },
      { ...snapshot, players: [{ id: "a-very-long-id", x: 0, y: 0 }] },
      { ...snapshot, acks: [1, 2, 3, 4, 5] },
      { ...snapshot, acks: "none" },
      { ...snapshot, ackTicks: [1, -2] },
      { ...snapshot, ackTicks: "lots" },
      { ...snapshot, phase: "party" },
      { ...snapshot, countdown: -5 },
      { ...snapshot, players: [{ id: "p0", x: 0, y: 0, hat: 99 }] },
      { ...snapshot, players: [{ id: "p0", x: 0, y: 0, shirt: "red" }] },
      { ...snapshot, kids: "five" },
      { ...snapshot, kids: Array.from({ length: 9 }, (_, i) => ({ id: `k${i}`, x: 0, y: 0 })) },
      { ...snapshot, kids: [{ id: "k0", x: "here", y: 0 }] },
      { ...snapshot, kids: [{ id: "k0", x: 0, y: 0, following: 3 }] },
      { ...snapshot, home: "k0" },
      { ...snapshot, home: [3] },
      { ...snapshot, home: ["a-very-long-id"] },
      { ...snapshot, home: Array.from({ length: 9 }, (_, i) => `k${i}`) },
      { ...snapshot, phase: "draw" },
      { ...snapshot, players: [{ id: "p0", x: 0, y: 0, emote: "hi" }] },
      { ...snapshot, dawn: -1 },
      { ...snapshot, dawn: 1.5 },
      { ...snapshot, timesLost: "none" },
    ]) {
      expect(readSnapshotBody(JSON.stringify(bad)), JSON.stringify(bad)).toBeUndefined();
    }
  });

  // S2-01: looks in inputs and snapshots, and the lobby phase. All optional.
  it("passes on hat, shirt, phase and countdown when they're valid", () => {
    const input = { seq: 8, up: false, down: false, left: false, right: false, hat: 2, shirt: 5 };
    expect(readInputBody(JSON.stringify({ action: "input", ...input }))).toEqual(input);
    const lobby = {
      ...snapshot,
      players: [{ id: "p0", x: 1, y: 2, hat: 1, shirt: 3 }],
      phase: "lobby",
      countdown: 120,
    };
    expect(readSnapshotBody(JSON.stringify(lobby))).toEqual(lobby);
  });

  it("passes on the lost children (S2-02), dropping unknown fields", () => {
    const round = { ...snapshot, phase: "round", kids: [{ id: "k0", x: 2500, y: 3500, x2: 1 }] };
    expect(readSnapshotBody(JSON.stringify(round))).toEqual({
      ...round,
      kids: [{ id: "k0", x: 2500, y: 3500 }],
    });
  });

  it("passes on E (call) in inputs and who each child follows (S2-03)", () => {
    const input = { seq: 9, up: false, down: false, left: false, right: true, call: true };
    expect(readInputBody(JSON.stringify(input))).toEqual(input);
    const kids = [
      { id: "k0", x: 1, y: 2, following: "p1" },
      { id: "k1", x: 3, y: 4 },
    ];
    expect(readSnapshotBody(JSON.stringify({ ...snapshot, kids }))).toEqual({ ...snapshot, kids });
  });

  it("passes on which children are home (S2-04)", () => {
    const round = { ...snapshot, phase: "round", kids: [], home: ["k3", "k0"] };
    expect(readSnapshotBody(JSON.stringify(round))).toEqual(round);
  });

  it("passes on how a round ended, the dawn timer and times lost (S2-05)", () => {
    for (const phase of ["won", "lost"]) {
      const ended = { ...snapshot, phase, kids: [], home: ["k0"], dawn: 1234, timesLost: 2 };
      expect(readSnapshotBody(JSON.stringify(ended))).toEqual(ended);
    }
  });

  it("passes on emotes in inputs and snapshots (S2-06), refusing bad ones", () => {
    const input = { seq: 10, up: false, down: false, left: false, right: false, emote: 3 };
    expect(readInputBody(JSON.stringify(input))).toEqual(input);
    expect(readInputBody(JSON.stringify({ ...input, emote: -1 }))).toBeUndefined();
    const talking = { ...snapshot, players: [{ id: "p0", x: 1, y: 2, emote: 0 }] };
    expect(readSnapshotBody(JSON.stringify(talking))).toEqual(talking);
  });

  it("passes on the flashlight in inputs and snapshots (S3-01), refusing bad values", () => {
    const input = { seq: 11, up: false, down: false, left: false, right: false, light: true };
    expect(readInputBody(JSON.stringify(input))).toEqual(input);
    expect(readInputBody(JSON.stringify({ ...input, light: "on" }))).toBeUndefined();
    const lit = {
      ...snapshot,
      players: [{ id: "p0", x: 1, y: 2, face: 5, light: true, battery: 900 }],
    };
    expect(readSnapshotBody(JSON.stringify(lit))).toEqual(lit);
    for (const bad of [{ face: 9 }, { light: 1 }, { battery: -1 }]) {
      const players = [{ id: "p0", x: 1, y: 2, ...bad }];
      expect(readSnapshotBody(JSON.stringify({ ...snapshot, players }))).toBeUndefined();
    }
  });
});
