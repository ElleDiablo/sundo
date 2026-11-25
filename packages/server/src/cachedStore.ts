/**
 * A RoomStore wrapper that remembers reads that can't change, to make the busy routes faster.
 *
 * Every input from a guest needs two answers: "which room and seat is this connection in?"
 * (CONN#<id> / ROOM) and "who hosts that room?" (ROOM#<code> / META). Asking DynamoDB both
 * questions takes ~20 ms per message, ten times a second. But neither answer ever changes while
 * the connection is open: a connection never moves rooms, and a room never changes host.
 *
 * Lambda reuses a container for many calls in a row, and anything created outside the handler
 * function (like this cache) survives between them. So the first input from a guest pays for the
 * reads, and later inputs handled by the same container get the answers from memory.
 *
 * Only items that were FOUND are kept (a connection not in a room yet may join one a moment later),
 * and each is forgotten after a few minutes so the cache can never be wrong for long, for example
 * once leaving rooms (S1-06) deletes them. Everything else goes straight to the real store.
 */
import type { Item, Key, RoomStore, TransactResult, WriteOp } from "./rooms.ts";

/** How long a remembered item is trusted. */
export const CACHE_TTL_MS = 5 * 60 * 1000;
/** Never hold more than this many items (a container serves many rooms over its life). */
const MAX_ITEMS = 5000;

/** The items that never change once written: a connection's room, and a room's META. */
const isCacheable = (key: Key) =>
  (key.PK.startsWith("CONN#") && key.SK === "ROOM") ||
  (key.PK.startsWith("ROOM#") && key.SK === "META");

export class CachedStore implements RoomStore {
  private readonly cache = new Map<string, { item: Item; until: number }>();

  constructor(
    private readonly inner: RoomStore,
    private readonly now: () => number,
  ) {}

  async get(key: Key): Promise<Item | undefined> {
    if (!isCacheable(key)) return this.inner.get(key);
    const id = `${key.PK}|${key.SK}`;
    const hit = this.cache.get(id);
    if (hit && hit.until > this.now()) return hit.item;

    const item = await this.inner.get(key);
    if (item) {
      // A Map remembers insertion order, so the first key is the oldest: drop it when full.
      if (this.cache.size >= MAX_ITEMS) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(id, { item, until: this.now() + CACHE_TTL_MS });
    } else {
      this.cache.delete(id);
    }
    return item;
  }

  transact(ops: readonly WriteOp[]): Promise<TransactResult> {
    return this.inner.transact(ops);
  }

  query(pk: string, skPrefix: string): Promise<Item[]> {
    // Not cached: the seats in a room change whenever someone joins.
    return this.inner.query(pk, skPrefix);
  }
}
