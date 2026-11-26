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
  it("a guest's tab closing frees their seat and tells only the host (S1-06)", async () => {
    const d = deps();
    await handleRoute("create_room", "host", undefined, d);
    await join(d, "g1", "BAHO");
    await join(d, "g2", "BAHO");
    d.sent.length = 0;
    await handleRoute("$disconnect", "g1", undefined, d);
    expect(d.sent).toEqual([["host", { type: "player_left", seat: 1 }]]);
    expect(d.store.items.has("ROOM#BAHO|SEAT#1")).toBe(false);
  });

  it("the host's tab closing ends the room for every guest (S1-06)", async () => {
    const d = deps();
    await handleRoute("create_room", "host", undefined, d);
    await join(d, "g1", "BAHO");
    await join(d, "g2", "BAHO");
    d.sent.length = 0;
    await handleRoute("$disconnect", "host", undefined, d);
    expect(d.sent).toEqual([
      ["g1", { type: "host_left" }],
      ["g2", { type: "host_left" }],
    ]);
    d.sent.length = 0;
    await join(d, "late", "BAHO");
    expect(d.sent).toEqual([
      ["late", expect.objectContaining({ type: "join_error", reason: "ended" })],
    ]);
  });

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

  describe("input and snapshot (S1-05)", () => {
    /** A room BAHO with the host on "host" and guests on "g1" (seat 1) and "g2" (seat 2). */
    async function room() {
      const d = deps();
      await handleRoute("create_room", "host", undefined, d);
      await join(d, "g1", "BAHO");
      await join(d, "g2", "BAHO");
      d.sent.length = 0;
      return d;
    }
    const keys = { up: true, down: false, left: false, right: true };
    const snapshot = { tick: 40, players: [{ id: "p0", x: 1500, y: 2500 }], acks: [0, 3, 0] };

    it("passes a guest's input to the host, stamped with the guest's real seat", async () => {
      const d = await room();
      // g2 claims to be seat 1: the relay ignores that and uses the seat it stored for g2.
      const body = JSON.stringify({ action: "input", seq: 5, seat: 1, ...keys });
      await handleRoute("input", "g2", body, d);
      expect(d.sent).toEqual([["host", { type: "input", seat: 2, seq: 5, ...keys }]]);
    });

    it("passes the host's snapshot to every guest, and nobody else", async () => {
      const d = await room();
      await handleRoute("snapshot", "host", JSON.stringify({ action: "snapshot", ...snapshot }), d);
      expect(d.sent).toEqual([
        ["g1", { type: "snapshot", ...snapshot }],
        ["g2", { type: "snapshot", ...snapshot }],
      ]);
    });

    it("drops snapshots from guests, input from the host, and anything from outside a room", async () => {
      const d = await room();
      await handleRoute("snapshot", "g1", JSON.stringify({ action: "snapshot", ...snapshot }), d);
      await handleRoute("input", "host", JSON.stringify({ action: "input", seq: 1, ...keys }), d);
      await handleRoute(
        "input",
        "stranger",
        JSON.stringify({ action: "input", seq: 1, ...keys }),
        d,
      );
      expect(d.sent).toEqual([]);
      expect(d.logs).toHaveLength(3);
    });

    it("drops broken messages without replying", async () => {
      const d = await room();
      await handleRoute("input", "g1", '{"action":"input","seq":-1}', d);
      await handleRoute("snapshot", "host", '{"action":"snapshot","tick":"soon"}', d);
      expect(d.sent).toEqual([]);
      expect(d.logs).toEqual([
        expect.stringMatching(/dropped input/),
        expect.stringMatching(/dropped snapshot/),
      ]);
    });

    it("keeps sending to the other guests when one has closed their tab", async () => {
      const d = await room();
      const realSend = d.sender.send;
      d.sender.send = async (id, msg) => {
        if (id === "g1") throw new Error("GoneException");
        return realSend(id, msg);
      };
      await handleRoute("snapshot", "host", JSON.stringify({ action: "snapshot", ...snapshot }), d);
      expect(d.sent.map(([id]) => id)).toEqual(["g2"]);
      expect(d.logs[0]).toMatch(/could not send snapshot to g1/);
    });
  });
});
