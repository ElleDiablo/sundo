/**
 * Rooms in the `sundo-live` DynamoDB table (architecture §5).
 *
 *   PK            SK               what
 *   ROOM#BAHO     META             the room: host connection, status, created time, ttl
 *   ROOM#BAHO     SEAT#0 … SEAT#3  one item per taken seat (0 = host); claiming one is how a
 *                                  player gets in, so two people can never get the same seat
 *   ROOM#BAHO     CONN#<connId>    a player in the room and their seat
 *   CONN#<connId> ROOM             which room a connection is in (to clean up on disconnect)
 *
 * The keys match the only questions the relay asks: "who's in room X?" (query PK = ROOM#X),
 * "which room is connection Y in?" (get PK = CONN#Y) and "is seat N free?" (get SEAT#N).
 * That's how DynamoDB tables are designed: around the lookups, not around the data.
 */
import { generateCode, isAllowedCode } from "./codes.ts";

/** Rooms disappear 2 hours after creation (DynamoDB TTL deletes them; no clean-up job needed). */
export const ROOM_TTL_SECONDS = 2 * 60 * 60;
/** 1–4 players per round (GDD §2): the host plus up to 3 friends. */
export const MAX_PLAYERS = 4;

/** The two keys that identify an item. */
export interface Key {
  readonly PK: string;
  readonly SK: string;
}

/** A stored item: its keys plus any other attributes. */
export interface Item extends Key {
  readonly [attribute: string]: unknown;
}

/** One step of an all-or-nothing write (a DynamoDB transaction). */
export type WriteOp =
  /** Write an item. With `onlyIfNew`, the whole transaction fails if those keys already exist. */
  | { readonly kind: "put"; readonly item: Item; readonly onlyIfNew?: boolean }
  /** Write nothing, but fail the whole transaction unless this item exists. */
  | { readonly kind: "mustExist"; readonly key: Key };

/** Result of a transaction: written, or not written because some steps' conditions failed. */
export type TransactResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** indexes (into the ops list) of the steps whose condition failed */ readonly failed: readonly number[];
    };

/** The storage the room logic needs. The real one is DynamoDB; tests use an in-memory fake. */
export interface RoomStore {
  /** Reads one item, or undefined if it doesn't exist. */
  get(key: Key): Promise<Item | undefined>;
  /** Applies every step or none. Never partly written. */
  transact(ops: readonly WriteOp[]): Promise<TransactResult>;
}

export interface CreatedRoom {
  readonly code: string;
}

/**
 * Creates a room with a fresh code and makes `connectionId` its host (seat 0).
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
    const result = await store.transact([
      // Step 0: the room itself. If this code is already an open room, the whole write fails.
      {
        kind: "put",
        onlyIfNew: true,
        item: {
          PK: `ROOM#${code}`,
          SK: "META",
          hostConnId: connectionId,
          status: "lobby",
          createdAt,
          ttl,
        },
      },
      ...seatOps(code, 0, connectionId, "host", createdAt, ttl),
    ]);
    if (result.ok) return { code };
    // A connection that already hosts or joined a room can't create another.
    if (result.failed.includes(3)) throw new RoomError("already_in_room");
  }
  throw new Error("could not find a free room code");
}

/** Why joining (or creating) didn't work; each has a friendly message for the player. */
export type RoomErrorReason = "bad_code" | "not_found" | "full" | "already_in_room";

export const ROOM_ERROR_MESSAGES: Record<RoomErrorReason, string> = {
  bad_code: "Room codes are 4 letters, like BAHO.",
  not_found: "No room with that code. Check the letters with your host.",
  full: "That room already has 4 players.",
  already_in_room: "You're already in a room.",
};

export class RoomError extends Error {
  readonly reason: RoomErrorReason;
  constructor(reason: RoomErrorReason) {
    super(ROOM_ERROR_MESSAGES[reason]);
    this.reason = reason;
  }
}

export interface JoinedRoom {
  readonly code: string;
  /** 1, 2 or 3 (0 is the host). */
  readonly seat: number;
  /** The host's connection, so the relay can tell the host who arrived. */
  readonly hostConnId: string;
}

/**
 * Puts `connectionId` in the room with this code, in the first free seat.
 * Throws a RoomError for a malformed code, a room that doesn't exist, or a full room.
 */
export async function joinRoom(
  store: RoomStore,
  connectionId: string,
  rawCode: string,
  nowMs: number,
): Promise<JoinedRoom> {
  // Players may type "baho " or "Baho": compare in the same shape the codes are stored in.
  const code = rawCode.trim().toUpperCase();
  if (!isAllowedCode(code)) throw new RoomError("bad_code");

  const meta = await store.get({ PK: `ROOM#${code}`, SK: "META" });
  if (!meta) throw new RoomError("not_found");
  const hostConnId = String(meta["hostConnId"]);
  // Joined items expire with the room, not later.
  const ttl = Number(meta["ttl"]);
  const joinedAt = Math.floor(nowMs / 1000);

  // Try seats 1, 2, 3 in order. Claiming a seat is a conditional write, so if two friends join at
  // the same moment, one gets seat 1 and the other's write fails and moves on to seat 2.
  for (let seat = 1; seat < MAX_PLAYERS; seat++) {
    const result = await store.transact([
      // Step 0: the room must still exist (it may have expired since the read above).
      { kind: "mustExist", key: { PK: `ROOM#${code}`, SK: "META" } },
      ...seatOps(code, seat, connectionId, "guest", joinedAt, ttl),
    ]);
    if (result.ok) return { code, seat, hostConnId };
    if (result.failed.includes(0)) throw new RoomError("not_found");
    if (result.failed.includes(3)) throw new RoomError("already_in_room");
    // Otherwise step 1 failed: this seat is taken. Try the next one.
  }
  throw new RoomError("full");
}

/**
 * The three writes that put a connection in a seat (steps 1–3 of a transaction):
 * claim SEAT#n (only if free), record the player in the room, and record which room the
 * connection is in (only if it isn't in one already).
 */
function seatOps(
  code: string,
  seat: number,
  connectionId: string,
  role: "host" | "guest",
  joinedAt: number,
  ttl: number,
): WriteOp[] {
  return [
    {
      kind: "put",
      onlyIfNew: true,
      item: { PK: `ROOM#${code}`, SK: `SEAT#${seat}`, connId: connectionId, ttl },
    },
    {
      kind: "put",
      item: { PK: `ROOM#${code}`, SK: `CONN#${connectionId}`, seat, role, joinedAt, ttl },
    },
    {
      kind: "put",
      onlyIfNew: true,
      item: { PK: `CONN#${connectionId}`, SK: "ROOM", room: code, seat, ttl },
    },
  ];
}
