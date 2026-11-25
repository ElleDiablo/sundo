/**
 * Tests for creating and joining rooms, run against the in-memory FakeStore.
 * Random codes are made predictable by feeding `createRoom` the numbers that pick chosen letters.
 */
import { describe, expect, it } from "vitest";
import { CODE_LETTERS } from "./codes.ts";
import { FakeStore } from "./fakeStore.ts";
import { createRoom, joinRoom, MAX_PLAYERS, ROOM_TTL_SECONDS, RoomError } from "./rooms.ts";

/** Random numbers that make generateCode produce exactly these letters. */
const letters = (code: string) =>
  [...code].map((ch) => (CODE_LETTERS.indexOf(ch) + 0.5) / CODE_LETTERS.length);
/** A fake random source that returns the given values in order, then repeats. */
const sequence = (values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const TTL = NOW / 1000 + ROOM_TTL_SECONDS;

/** Expects `promise` to fail with a RoomError for `reason`. */
async function expectRoomError(promise: Promise<unknown>, reason: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RoomError);
  expect((error as RoomError).reason).toBe(reason);
}

describe("createRoom", () => {
  it("stores the room, seat 0 for the host and the connection lookup, all with a TTL", async () => {
    const store = new FakeStore();
    const room = await createRoom(store, "host", NOW, sequence(letters("BAHA")));

    expect(room.code).toBe("BAHA");
    expect(store.items.get("ROOM#BAHA|META")).toMatchObject({
      hostConnId: "host",
      status: "lobby",
      ttl: TTL,
    });
    expect(store.items.get("ROOM#BAHA|SEAT#0")).toMatchObject({ connId: "host", ttl: TTL });
    expect(store.items.get("ROOM#BAHA|CONN#host")).toMatchObject({
      seat: 0,
      role: "host",
      ttl: TTL,
    });
    expect(store.items.get("CONN#host|ROOM")).toMatchObject({ room: "BAHA", seat: 0, ttl: TTL });
  });

  it("expires rooms 2 hours after creation", () => {
    expect(ROOM_TTL_SECONDS).toBe(7200);
  });

  it("never reuses the code of an open room", async () => {
    const store = new FakeStore();
    await createRoom(store, "host-1", NOW, sequence(letters("BAHA")));
    // The second host's first draw is BAHA again (taken), so it must move on to TANA.
    const second = await createRoom(store, "host-2", NOW, sequence(letters("BAHATANA")));
    expect(second.code).toBe("TANA");
    expect(store.items.get("ROOM#BAHA|META")).toMatchObject({ hostConnId: "host-1" });
  });

  it("gives up after a few collisions instead of looping forever", async () => {
    const store = new FakeStore();
    await createRoom(store, "host-1", NOW, sequence(letters("BAHA")));
    await expect(createRoom(store, "host-2", NOW, sequence(letters("BAHA")))).rejects.toThrow(
      /free room code/,
    );
  });

  it("refuses a second room from the same connection", async () => {
    const store = new FakeStore();
    await createRoom(store, "host", NOW, sequence(letters("BAHA")));
    await expectRoomError(
      createRoom(store, "host", NOW, sequence(letters("TANA"))),
      "already_in_room",
    );
  });
});

describe("joinRoom", () => {
  /** A store with room BAHA hosted by "host". */
  async function withRoom() {
    const store = new FakeStore();
    await createRoom(store, "host", NOW, sequence(letters("BAHA")));
    return store;
  }

  it("puts the first guest in seat 1 and returns the host to notify", async () => {
    const store = await withRoom();
    const joined = await joinRoom(store, "guest-1", "BAHA", NOW + 5000);
    expect(joined).toEqual({ code: "BAHA", seat: 1, hostConnId: "host" });
    expect(store.items.get("ROOM#BAHA|SEAT#1")).toMatchObject({ connId: "guest-1" });
    expect(store.items.get("ROOM#BAHA|CONN#guest-1")).toMatchObject({ seat: 1, role: "guest" });
    expect(store.items.get("CONN#guest-1|ROOM")).toMatchObject({ room: "BAHA", seat: 1 });
  });

  it("expires joined players with the room, not later", async () => {
    const store = await withRoom();
    await joinRoom(store, "guest-1", "BAHA", NOW + 60 * 60 * 1000); // an hour later
    expect(store.items.get("ROOM#BAHA|CONN#guest-1")).toMatchObject({ ttl: TTL });
  });

  it("accepts codes typed in lowercase or with spaces", async () => {
    const store = await withRoom();
    expect((await joinRoom(store, "guest-1", " baha ", NOW)).code).toBe("BAHA");
  });

  it("fills seats 1, 2, 3 in order, then refuses a 5th player", async () => {
    const store = await withRoom();
    const seats = [];
    for (let i = 1; i < MAX_PLAYERS; i++)
      seats.push((await joinRoom(store, `guest-${i}`, "BAHA", NOW)).seat);
    expect(seats).toEqual([1, 2, 3]);
    await expectRoomError(joinRoom(store, "guest-4", "BAHA", NOW), "full");
  });

  it("gives two guests joining at the same moment different seats", async () => {
    const store = await withRoom();
    const [a, b] = await Promise.all([
      joinRoom(store, "a", "BAHA", NOW),
      joinRoom(store, "b", "BAHA", NOW),
    ]);
    expect(new Set([a.seat, b.seat])).toEqual(new Set([1, 2]));
  });

  it("explains malformed codes, unknown rooms and joining twice", async () => {
    const store = await withRoom();
    await expectRoomError(joinRoom(store, "g", "BAH", NOW), "bad_code");
    await expectRoomError(joinRoom(store, "g", "B4H0", NOW), "bad_code");
    await expectRoomError(joinRoom(store, "g", "TANA", NOW), "not_found");
    await joinRoom(store, "g", "BAHA", NOW);
    await expectRoomError(joinRoom(store, "g", "BAHA", NOW), "already_in_room");
    await expectRoomError(joinRoom(store, "host", "BAHA", NOW), "already_in_room");
  });

  it("reports a room that expired between the lookup and the join as not found", async () => {
    const store = await withRoom();
    const realGet = store.get.bind(store);
    // Read the room, then delete it before the join's transaction runs (like TTL would).
    store.get = async (key) => {
      const item = await realGet(key);
      store.items.delete("ROOM#BAHA|META");
      return item;
    };
    await expectRoomError(joinRoom(store, "g", "BAHA", NOW), "not_found");
  });
});
