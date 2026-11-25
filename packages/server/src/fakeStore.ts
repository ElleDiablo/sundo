/**
 * An in-memory stand-in for DynamoDB, for tests.
 *
 * It follows the same rules as the real table for the operations the relay uses: `get` reads one
 * item, `transact` checks every condition first and then writes everything or nothing, and
 * `query` returns one partition's items whose sort key starts with a prefix, sorted by sort key.
 * That way the room logic is tested against the behaviour it relies on, without AWS.
 */
import type { Item, Key, RoomStore, TransactResult, WriteOp } from "./rooms.ts";

export class FakeStore implements RoomStore {
  /** Every item, keyed by "PK|SK" so tests can look items up directly. */
  readonly items = new Map<string, Item>();

  async get(key: Key): Promise<Item | undefined> {
    return this.items.get(id(key));
  }

  async transact(ops: readonly WriteOp[]): Promise<TransactResult> {
    // Phase 1: check every condition without writing anything.
    const failed: number[] = [];
    ops.forEach((op, i) => {
      if (op.kind === "mustExist" && !this.items.has(id(op.key))) failed.push(i);
      if (op.kind === "put" && op.onlyIfNew && this.items.has(id(op.item))) failed.push(i);
    });
    if (failed.length > 0) return { ok: false, failed };
    // Phase 2: all conditions passed, so write every item.
    for (const op of ops) if (op.kind === "put") this.items.set(id(op.item), op.item);
    return { ok: true };
  }

  async query(pk: string, skPrefix: string): Promise<Item[]> {
    // DynamoDB returns a partition's items sorted by SK; do the same.
    return [...this.items.values()]
      .filter((item) => item.PK === pk && item.SK.startsWith(skPrefix))
      .sort((a, b) => (a.SK < b.SK ? -1 : a.SK > b.SK ? 1 : 0));
  }
}

/** The map key for an item. */
const id = (key: Key) => `${key.PK}|${key.SK}`;
