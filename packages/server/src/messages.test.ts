import { describe, expect, it } from "vitest";
import { parseServerMessage } from "./messages.ts";

describe("parseServerMessage", () => {
  it("reads the messages the relay sends", () => {
    expect(parseServerMessage('{"type":"room_created","code":"BAHO"}')).toEqual({
      type: "room_created",
      code: "BAHO",
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
    ]) {
      expect(parseServerMessage(data), data).toBeUndefined();
    }
  });
});
