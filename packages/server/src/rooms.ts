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
 * Leaving (S1-06): when a connection closes, its own SEAT#n, ROOM#…/CONN#… and CONN#…/ROOM items are
 * deleted. The room's META stays until its TTL, so a code whose host has left can be told apart
 * from a code that never existed ("That room has ended" vs "No room with that code").
 *
 * The keys match the only questions the relay asks: "who's in room X?" (query SEAT# items of ROOM#X),
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
  | { readonly kind: "mustExist"; readonly key: Key }
  /**
   * Delete an item (deleting one that isn't there is fine). With `onlyIfConnId`, the whole
   * transaction fails unless the item's `connId` is that value: a seat is only ever freed by the
   * connection that holds it.
   */
  | { readonly kind: "delete"; readonly key: Key; readonly onlyIfConnId?: string };

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
  /** Every item with this PK whose SK starts with `skPrefix`, e.g. all SEAT# items of a room. */
  query(pk: string, skPrefix: string): Promise<Item[]>;
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
export type RoomErrorReason = "bad_code" | "not_found" | "ended" | "full" | "already_in_room";

export const ROOM_ERROR_MESSAGES: Record<RoomErrorReason, string> = {
  bad_code: "Room codes are 4 letters, like BAHO.",
  not_found: "No room with that code. Check the letters with your host.",
  ended: "That room has ended: the host left. Ask them for a new code.",
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
      // Step 1: the host must still be in it. Only the host's browser runs the game, so a room
      // without one is dead: joining it would show an empty world (S1-06). Checked inside the
      // transaction, so it's always DynamoDB's current answer, never a cached one.
      { kind: "mustExist", key: { PK: `ROOM#${code}`, SK: "SEAT#0" } },
      ...seatOps(code, seat, connectionId, "guest", joinedAt, ttl),
    ]);
    if (result.ok) return { code, seat, hostConnId };
    if (result.failed.includes(0)) throw new RoomError("not_found");
    if (result.failed.includes(1)) throw new RoomError("ended");
    if (result.failed.includes(4)) throw new RoomError("already_in_room");
    // Otherwise step 2 failed: this seat is taken. Try the next one.
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

/**
 * Takes a connection out of its room (its tab closed): frees its seat and deletes its two other
 * items, all at once. Returns where it was, so the relay can tell the others, or undefined if it
 * wasn't in a room (someone who opened the game and never created or joined one).
 *
 * A freed seat can be taken again: a guest who reloads and rejoins gets their seat back, and the
 * host removes the old player first, so there's no ghost.
 */
export async function leaveRoom(
  store: RoomStore,
  connectionId: string,
): Promise<Membership | undefined> {
  const me = await findMembership(store, connectionId);
  if (!me) return undefined;
  await store.transact([
    {
      kind: "delete",
      key: { PK: `ROOM#${me.code}`, SK: `SEAT#${me.seat}` },
      onlyIfConnId: connectionId, // never free a seat someone else has taken since
    },
    { kind: "delete", key: { PK: `ROOM#${me.code}`, SK: `CONN#${connectionId}` } },
    { kind: "delete", key: { PK: `CONN#${connectionId}`, SK: "ROOM" } },
  ]);
  return me;
}

/** Where a connection is: its room and seat, or undefined if it isn't in a room. */
export interface Membership {
  readonly code: string;
  readonly seat: number;
}

/** Looks up which room and seat a connection is in (the CONN#<id> / ROOM item). */
export async function findMembership(
  store: RoomStore,
  connectionId: string,
): Promise<Membership | undefined> {
  const item = await store.get({ PK: `CONN#${connectionId}`, SK: "ROOM" });
  if (!item) return undefined;
  return { code: String(item["room"]), seat: Number(item["seat"]) };
}

/** The host's connection for a room, or undefined if the room is gone. */
export async function findHost(store: RoomStore, code: string): Promise<string | undefined> {
  const meta = await store.get({ PK: `ROOM#${code}`, SK: "META" });
  return meta ? String(meta["hostConnId"]) : undefined;
}

/** The connections of everyone in a room except the host (seats 1–3), from its SEAT# items. */
export async function findGuests(store: RoomStore, code: string): Promise<string[]> {
  const seats = await store.query(`ROOM#${code}`, "SEAT#");
  return seats.filter((s) => s.SK !== "SEAT#0").map((s) => String(s["connId"]));
}
