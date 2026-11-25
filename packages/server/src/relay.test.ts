/**
 * Tests for the relay's routes, with a fake store and a fake Sender that records every message
 * instead of sending it, so each test can check exactly who was told what.
 */
import { describe, expect, it } from "vitest";
import { CODE_LETTERS } from "./codes.ts";
import { FakeStore } from "./fakeStore.ts";
import { handleRoute, type RelayDeps, type ServerMessage } from "./relay.ts";

/** Relay dependencies with fakes; room codes always come out as BAHO. */
function deps(): RelayDeps & { sent: [string, ServerMessage][]; store: FakeStore; logs: string[] } {
  const sent: [string, ServerMessage][] = [];
  const logs: string[] = [];
  const letters = [..."BAHO"].map((ch) => (CODE_LETTERS.indexOf(ch) + 0.5) / CODE_LETTERS.length);
  let i = 0;
  return {
    sent,
    logs,
    store: new FakeStore(),
    sender: { send: async (id, msg) => void sent.push([id, msg]) },
    now: () => Date.UTC(2026, 10, 25),
    random: () => letters[i++ % letters.length]!,
    log: (m) => void logs.push(m),
  };
}

/** Sends a join_room message from `connectionId`. */
const join = (d: RelayDeps, connectionId: string, code: string) =>
  handleRoute("join_room", connectionId, JSON.stringify({ action: "join_room", code }), d);

describe("relay", () => {
  it("accepts connections and disconnections", async () => {
    const d = deps();
    expect(await handleRoute("$connect", "c1", undefined, d)).toEqual({ statusCode: 200 });
    expect(await handleRoute("$disconnect", "c1", undefined, d)).toEqual({ statusCode: 200 });
    expect(d.sent).toEqual([]);
  });

  it("create_room makes a room and tells the host its code", async () => {
    const d = deps();
    await handleRoute("create_room", "host", '{"action":"create_room"}', d);
    expect(d.sent).toEqual([["host", { type: "room_created", code: "BAHO" }]]);
    expect(d.store.items.get("ROOM#BAHO|META")).toMatchObject({ hostConnId: "host" });
  });

  it("join_room seats the guest and tells both the guest and the host", async () => {
    const d = deps();
    await handleRoute("create_room", "host", undefined, d);
    d.sent.length = 0;
    await join(d, "guest", "baho");
    expect(d.sent).toEqual([
      ["guest", { type: "room_joined", code: "BAHO", seat: 1 }],
      ["host", { type: "player_joined", seat: 1 }],
    ]);
  });

  it("a wrong code or a full room gets a friendly join_error, and the host hears nothing", async () => {
    const d = deps();
    await handleRoute("create_room", "host", undefined, d);
    for (const g of ["g1", "g2", "g3"]) await join(d, g, "BAHO");
    d.sent.length = 0;
    await join(d, "g4", "BAHO");
    await join(d, "g5", "TANA");
    expect(d.sent).toEqual([
      ["g4", { type: "join_error", reason: "full", message: "That room already has 4 players." }],
      [
        "g5",
        { type: "join_error", reason: "not_found", message: expect.stringContaining("No room") },
      ],
    ]);
  });

  it("still seats the guest if the host can't be reached, and logs it", async () => {
    const d = deps();
    await handleRoute("create_room", "host", undefined, d);
    const realSend = d.sender.send;
    d.sender.send = async (id, msg) => {
      if (id === "host") throw new Error("GoneException");
      return realSend(id, msg);
    };
    await join(d, "guest", "BAHO");
    expect(d.store.items.get("ROOM#BAHO|SEAT#1")).toBeDefined();
    expect(d.logs[0]).toMatch(/could not notify host/);
  });

  it("answers unknown or broken messages with a helpful error", async () => {
    const d = deps();
    await handleRoute("$default", "c1", '{"action":"dance"}', d);
    await handleRoute("$default", "c1", "not json", d);
    expect(d.sent).toEqual([
      ["c1", { type: "error", message: 'unknown action "dance"' }],
      ["c1", { type: "error", message: 'send JSON like {"action":"create_room"}' }],
    ]);
  });
});
