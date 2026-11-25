/**
 * Tests for reading messages off the network: known shapes come through, anything else is ignored
 * (never trusted, never a crash).
 */
import { describe, expect, it } from "vitest";
import { parseServerMessage, readJoinCode } from "./messages.ts";

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
