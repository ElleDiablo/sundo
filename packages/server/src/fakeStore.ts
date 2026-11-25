/** In-memory stand-in for DynamoDB with the same "all or nothing, only if new" rule. For tests. */
import type { Item, RoomStore } from "./rooms.ts";

export class FakeStore implements RoomStore {
  readonly items = new Map<string, Item>();
  async putAllIfNew(items: readonly Item[], mustBeNew: Item): Promise<boolean> {
    if (this.items.has(`${mustBeNew.PK}|${mustBeNew.SK}`)) return false;
    for (const item of items) this.items.set(`${item.PK}|${item.SK}`, item);
    return true;
  }
}
