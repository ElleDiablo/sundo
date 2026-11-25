import { describe, expect, it } from "vitest";
import { CODE_LETTERS } from "./codes.ts";
import { handleRoute, type RelayDeps, type ServerMessage } from "./relay.ts";
import { FakeStore } from "./fakeStore.ts";

function deps(): RelayDeps & { sent: [string, ServerMessage][]; store: FakeStore } {
  const sent: [string, ServerMessage][] = [];
  const letters = [..."BAHO"].map((ch) => (CODE_LETTERS.indexOf(ch) + 0.5) / CODE_LETTERS.length);
  let i = 0;
  return {
    sent,
    store: new FakeStore(),
    sender: { send: async (id, msg) => void sent.push([id, msg]) },
    now: () => Date.UTC(2026, 10, 25),
    random: () => letters[i++ % letters.length]!,
  };
}

describe("relay", () => {
  it("accepts connections and disconnections", async () => {
    const d = deps();
    expect(await handleRoute("$connect", "c1", undefined, d)).toEqual({ statusCode: 200 });
    expect(await handleRoute("$disconnect", "c1", undefined, d)).toEqual({ statusCode: 200 });
    expect(d.sent).toEqual([]);
  });

  it("create_room makes a room and tells the host its code", async () => {
    const d = deps();
    await handleRoute("create_room", "host-1", '{"action":"create_room"}', d);
    expect(d.sent).toEqual([["host-1", { type: "room_created", code: "BAHO" }]]);
    expect(d.store.items.get("ROOM#BAHO|META")).toMatchObject({ hostConnId: "host-1" });
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
