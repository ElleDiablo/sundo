import { describe, expect, it } from "vitest";
import { CODE_LETTERS } from "./codes.ts";
import { FakeStore } from "./fakeStore.ts";
import { createRoom, ROOM_TTL_SECONDS } from "./rooms.ts";

const letters = (code: string) =>
  [...code].map((ch) => (CODE_LETTERS.indexOf(ch) + 0.5) / CODE_LETTERS.length);
const sequence = (values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);

describe("createRoom", () => {
  it("stores the room, the host's seat and the connection lookup, all with a TTL", async () => {
    const store = new FakeStore();
    const room = await createRoom(store, "conn-1", NOW, sequence(letters("BAHA")));

    expect(room.code).toBe("BAHA");
    const ttl = NOW / 1000 + ROOM_TTL_SECONDS;
    expect(store.items.get("ROOM#BAHA|META")).toMatchObject({
      hostConnId: "conn-1",
      status: "lobby",
      ttl,
    });
    expect(store.items.get("ROOM#BAHA|CONN#conn-1")).toMatchObject({ seat: 0, role: "host", ttl });
    expect(store.items.get("CONN#conn-1|ROOM")).toMatchObject({ room: "BAHA", ttl });
  });

  it("expires rooms 2 hours after creation", () => {
    expect(ROOM_TTL_SECONDS).toBe(7200);
  });

  it("never reuses the code of an open room", async () => {
    const store = new FakeStore();
    await createRoom(store, "conn-1", NOW, sequence(letters("BAHA")));
    // The second host's first draw is BAHA again (taken), so it must move on to TANA.
    const second = await createRoom(store, "conn-2", NOW, sequence(letters("BAHATANA")));
    expect(second.code).toBe("TANA");
    expect(store.items.get("ROOM#BAHA|META")).toMatchObject({ hostConnId: "conn-1" });
  });

  it("gives up after a few collisions instead of looping forever", async () => {
    const store = new FakeStore();
    await createRoom(store, "conn-1", NOW, sequence(letters("BAHA")));
    await expect(createRoom(store, "conn-2", NOW, sequence(letters("BAHA")))).rejects.toThrow(
      /free room code/,
    );
  });
});
