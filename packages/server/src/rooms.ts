/**
 * Rooms in the `sundo-live` DynamoDB table (architecture §5).
 *
 *   PK            SK               what
 *   ROOM#BAHO     META             the room: host connection, status, created time, ttl
 *   ROOM#BAHO     CONN#<connId>    a player in the room (the host is seat 0)
 *   CONN#<connId> ROOM             which room a connection is in (to clean up on disconnect)
 *
 * The keys match the only two questions the relay asks: "who's in room X?" (query PK = ROOM#X)
 * and "which room is connection Y in?" (get PK = CONN#Y). That's how DynamoDB tables are designed:
 * around the lookups, not around the data.
 */
import { generateCode } from "./codes.ts";

/** Rooms disappear 2 hours after creation (DynamoDB TTL deletes them; no clean-up job needed). */
export const ROOM_TTL_SECONDS = 2 * 60 * 60;

export interface Item {
  readonly PK: string;
  readonly SK: string;
  readonly [attribute: string]: unknown;
}

/** The storage the room logic needs. The real one is DynamoDB; tests use an in-memory fake. */
export interface RoomStore {
  /**
   * Writes all items at once, or none (a transaction). Fails with `false` instead of writing if an
   * item with the same keys as `mustBeNew` already exists.
   */
  putAllIfNew(items: readonly Item[], mustBeNew: Item): Promise<boolean>;
}

export interface CreatedRoom {
  readonly code: string;
  readonly items: readonly Item[];
}

/**
 * Creates a room with a fresh code and makes `connectionId` its host.
 * If the code is already taken by an open room, tries another; codes never collide.
 */
export async function createRoom(
  store: RoomStore,
  connectionId: string,
  nowMs: number,
  random: () => number,
): Promise<CreatedRoom> {
  const createdAt = Math.floor(nowMs / 1000);
  const ttl = createdAt + ROOM_TTL_SECONDS; // DynamoDB TTL wants seconds since 1970

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode(random);
    const meta: Item = {
      PK: `ROOM#${code}`,
      SK: "META",
      hostConnId: connectionId,
      status: "lobby",
      createdAt,
      ttl,
    };
    const items: Item[] = [
      meta,
      {
        PK: `ROOM#${code}`,
        SK: `CONN#${connectionId}`,
        seat: 0,
        role: "host",
        joinedAt: createdAt,
        ttl,
      },
      { PK: `CONN#${connectionId}`, SK: "ROOM", room: code, ttl },
    ];
    if (await store.putAllIfNew(items, meta)) return { code, items };
  }
  throw new Error("could not find a free room code");
}
