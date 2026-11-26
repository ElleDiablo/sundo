/**
 * Tests for the read cache: unchanging items are read from DynamoDB once, everything else always.
 */
import { describe, expect, it } from "vitest";
import { CACHE_TTL_MS, CachedStore } from "./cachedStore.ts";
import { FakeStore } from "./fakeStore.ts";
import type { Key } from "./rooms.ts";

/** A FakeStore that counts how many times `get` reached it. */
function counting() {
  const inner = new FakeStore();
  let reads = 0;
  const realGet = inner.get.bind(inner);
  inner.get = async (key: Key) => {
    reads += 1;
    return realGet(key);
  };
  return { inner, reads: () => reads };
}

describe("CachedStore", () => {
  const conn = { PK: "CONN#c1", SK: "ROOM" };

  it("reads a connection's room once, then from memory", async () => {
    const { inner, reads } = counting();
    inner.items.set("CONN#c1|ROOM", { ...conn, room: "BAHO", seat: 1 });
    const store = new CachedStore(inner, () => 0);
    await store.get(conn);
    expect(await store.get(conn)).toMatchObject({ room: "BAHO" });
    expect(reads()).toBe(1);
  });

  it("doesn't remember a missing item: the connection may join a room a moment later", async () => {
    const { inner, reads } = counting();
    const store = new CachedStore(inner, () => 0);
    expect(await store.get(conn)).toBeUndefined();
    inner.items.set("CONN#c1|ROOM", { ...conn, room: "BAHO", seat: 1 });
    expect(await store.get(conn)).toMatchObject({ room: "BAHO" });
    expect(reads()).toBe(2);
  });

  it("forgets an item this container deletes or overwrites (leaving a room, S1-06)", async () => {
    const { inner, reads } = counting();
    inner.items.set("CONN#c1|ROOM", { ...conn, room: "BAHO", seat: 1 });
    const store = new CachedStore(inner, () => 0);
    await store.get(conn);
    await store.transact([{ kind: "delete", key: conn }]);
    expect(await store.get(conn)).toBeUndefined();
    expect(reads()).toBe(2);
  });

  it("forgets items after the cache TTL", async () => {
    const { inner, reads } = counting();
    inner.items.set("CONN#c1|ROOM", { ...conn, room: "BAHO", seat: 1 });
    let now = 0;
    const store = new CachedStore(inner, () => now);
    await store.get(conn);
    now = CACHE_TTL_MS + 1;
    await store.get(conn);
    expect(reads()).toBe(2);
  });

  it("never caches items that change, like seats", async () => {
    const { inner, reads } = counting();
    inner.items.set("ROOM#BAHO|SEAT#1", { PK: "ROOM#BAHO", SK: "SEAT#1", connId: "c1" });
    const store = new CachedStore(inner, () => 0);
    await store.get({ PK: "ROOM#BAHO", SK: "SEAT#1" });
    await store.get({ PK: "ROOM#BAHO", SK: "SEAT#1" });
    expect(reads()).toBe(2);
  });
});
