/**
 * The messages that travel over the WebSocket, shared by the relay and the browser client so both
 * sides agree on the shapes (one definition, checked by TypeScript on both ends).
 *
 *   browser → relay   {"action":"create_room"}            → host gets room_created
 *                     {"action":"join_room","code":"BAHO"} → guest gets room_joined,
 *                                                            host gets player_joined
 *                     {"action":"input",…}    guest → host   the keys a guest is holding (S1-05)
 *                     {"action":"snapshot",…} host → guests  where everyone is (S1-05)
 *   relay → browser   join_error when a code is wrong, the room is full, …
 *
 * Everything that arrives from the network is text that anyone could have written, so every
 * message is checked field by field before it's used (the parse… functions below).
 */
import { MAX_PLAYERS, type RoomErrorReason } from "./rooms.ts";

/** The keys a guest is holding, numbered so the host can ignore an older message that arrives late. */
export interface InputFields {
  /** Counts up by one per message from this guest. */
  readonly seq: number;
  readonly up: boolean;
  readonly down: boolean;
  readonly left: boolean;
  readonly right: boolean;
}

/** One player's position in a snapshot, in engine units (1 tile = 1000). */
export interface SnapshotPlayer {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/** The host's view of the game at one tick, sent to every guest 10 times a second. */
export interface SnapshotFields {
  /** The engine tick this was taken at (20 per second), so guests can order and time snapshots. */
  readonly tick: number;
  readonly players: readonly SnapshotPlayer[];
  /**
   * acks[seat] = the last input seq from that seat the host has applied (0 = none yet).
   * A guest compares it with when it sent that input to measure the full round trip.
   */
  readonly acks: readonly number[];
}

/** Browser → relay. API Gateway picks the route from `action`. */
export type ClientMessage =
  | { readonly action: "create_room" }
  | { readonly action: "join_room"; readonly code: string }
  | ({ readonly action: "input" } & InputFields)
  | ({ readonly action: "snapshot" } & SnapshotFields);

/** Relay → browser. */
export type ServerMessage =
  /** To the host: your room exists, share this code. */
  | { readonly type: "room_created"; readonly code: string }
  /** To a guest: you're in, in this seat (1–3; the host is 0). */
  | { readonly type: "room_joined"; readonly code: string; readonly seat: number }
  /** To the host: someone took this seat. */
  | { readonly type: "player_joined"; readonly seat: number }
  /** To the host: a guest's keys. The relay adds the seat, so a guest can't pretend to be someone else. */
  | ({ readonly type: "input"; readonly seat: number } & InputFields)
  /** To each guest: where everyone is, passed on from the host. */
  | ({ readonly type: "snapshot" } & SnapshotFields)
  /** To someone who couldn't join, with a message to show as is. */
  | { readonly type: "join_error"; readonly reason: RoomErrorReason; readonly message: string }
  /** Anything else that went wrong (unknown action, broken JSON). */
  | { readonly type: "error"; readonly message: string };

/** The reasons a join can fail, for checking messages from the network. */
const JOIN_ERROR_REASONS: readonly string[] = ["bad_code", "not_found", "full", "already_in_room"];

/**
 * Parses a message from the relay, or returns undefined if it isn't one we know.
 * Messages arrive as text from the network, so every field is checked before it's trusted.
 */
export function parseServerMessage(data: string): ServerMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || !("type" in value)) return undefined;
  const v = value as Record<string, unknown>;
  const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : undefined);
  const seat =
    typeof v["seat"] === "number" && Number.isInteger(v["seat"])
      ? (v["seat"] as number)
      : undefined;
  const code = str("code");
  const message = str("message");

  switch (v["type"]) {
    case "room_created":
      return code ? { type: "room_created", code } : undefined;
    case "room_joined":
      return code && seat !== undefined ? { type: "room_joined", code, seat } : undefined;
    case "player_joined":
      return seat !== undefined ? { type: "player_joined", seat } : undefined;
    case "join_error": {
      const reason = str("reason");
      return reason && JOIN_ERROR_REASONS.includes(reason) && message
        ? { type: "join_error", reason: reason as RoomErrorReason, message }
        : undefined;
    }
    case "error":
      return message ? { type: "error", message } : undefined;
    case "input": {
      const input = readInput(v);
      return input && seat !== undefined ? { type: "input", seat, ...input } : undefined;
    }
    case "snapshot": {
      const snapshot = readSnapshot(v);
      return snapshot ? { type: "snapshot", ...snapshot } : undefined;
    }
    default:
      return undefined;
  }
}

/** Positions are whole engine units. No map is anywhere near 10 000 tiles across. */
const MAX_COORD = 10_000_000;

const isCount = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isCoord = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && Math.abs(n) <= MAX_COORD;

/** Checks the fields of an input message; undefined if any is missing or the wrong type. */
function readInput(v: Record<string, unknown>): InputFields | undefined {
  const { seq, up, down, left, right } = v;
  if (!isCount(seq)) return undefined;
  if (![up, down, left, right].every((b) => typeof b === "boolean")) return undefined;
  return {
    seq,
    up: up as boolean,
    down: down as boolean,
    left: left as boolean,
    right: right as boolean,
  };
}

/** Checks the fields of a snapshot message; undefined if anything is off. */
function readSnapshot(v: Record<string, unknown>): SnapshotFields | undefined {
  const { tick, players, acks } = v;
  if (!isCount(tick)) return undefined;
  if (!Array.isArray(players) || players.length > MAX_PLAYERS) return undefined;
  if (!Array.isArray(acks) || acks.length > MAX_PLAYERS || !acks.every(isCount)) return undefined;
  const checked: SnapshotPlayer[] = [];
  for (const p of players as unknown[]) {
    if (!p || typeof p !== "object") return undefined;
    const { id, x, y } = p as Record<string, unknown>;
    if (typeof id !== "string" || id.length > 8 || !isCoord(x) || !isCoord(y)) return undefined;
    checked.push({ id, x, y }); // copy only the known fields: extra ones are dropped, not passed on
  }
  return { tick, players: checked, acks: acks as number[] };
}

/** Parses a JSON message body into an object, or undefined if it isn't one. */
function readObject(body: string | undefined): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body ?? "");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Reads an input message body from a guest, or undefined if it isn't a valid one. */
export function readInputBody(body: string | undefined): InputFields | undefined {
  const v = readObject(body);
  return v ? readInput(v) : undefined;
}

/** Reads a snapshot message body from a host, or undefined if it isn't a valid one. */
export function readSnapshotBody(body: string | undefined): SnapshotFields | undefined {
  const v = readObject(body);
  return v ? readSnapshot(v) : undefined;
}

/** Reads the `code` field of a join_room message body, or undefined if it's missing. */
export function readJoinCode(body: string | undefined): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body ?? "");
    if (
      parsed &&
      typeof parsed === "object" &&
      "code" in parsed &&
      typeof parsed.code === "string"
    ) {
      return parsed.code.slice(0, 10); // codes are 4 letters; never echo back long input
    }
  } catch {
    // not JSON
  }
  return undefined;
}
