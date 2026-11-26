/**
 * The messages that travel over the WebSocket, shared by the relay and the browser client so both
 * sides agree on the shapes (one definition, checked by TypeScript on both ends).
 *
 *   browser → relay   {"action":"create_room"}            → host gets room_created
 *                     {"action":"join_room","code":"BAHO"} → guest gets room_joined,
 *                                                            host gets player_joined
 *                     {"action":"input",…}    guest → host   the keys a guest is holding (S1-05)
 *                     {"action":"snapshot",…} host → guests  where everyone is (S1-05)
 *   relay → browser   join_error when a code is wrong, the room is full, the host has left, …
 *                     player_left (to the host) / host_left (to guests) when a tab closes (S1-06)
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
  /** The hat and shirt colour I picked in the lobby (S2-01). Optional: older clients don't send them. */
  readonly hat?: number;
  readonly shirt?: number;
  /** E held: call the nearest lost child (S2-03). Optional: older clients don't send it. */
  readonly call?: boolean;
}

/** One player in a snapshot: position in engine units (1 tile = 1000), and looks (S2-01). */
export interface SnapshotPlayer {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly hat?: number;
  readonly shirt?: number;
}

/** One lost child in a snapshot (S2-02): where they are, in engine units. */
export interface SnapshotKid {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** The player id this child follows (S2-03); missing while the child is lost. */
  readonly following?: string;
}

/** The game phases a snapshot may name (S2-01 lobby / round, S2-05 won / lost). */
const PHASES: readonly string[] = ["lobby", "round", "won", "lost"];

/** The most children a snapshot may list (5 per round; a little room for later designs). */
const MAX_KIDS = 8;

/** The host's view of the game at one tick, sent to every guest 20 times a second. */
export interface SnapshotFields {
  /** The engine tick this was taken at (20 per second), so guests can order and time snapshots. */
  readonly tick: number;
  readonly players: readonly SnapshotPlayer[];
  /**
   * acks[seat] = the last input seq from that seat the host has applied (0 = none yet).
   * A guest compares it with when it sent that input to measure the full round trip.
   */
  readonly acks: readonly number[];
  /**
   * ackTicks[seat] = how many ticks the host has applied that seat's latest input (acks[seat]) for
   * so far (NET-01). Inputs are sent only when keys change and the host keeps using the last one,
   * so a guest needs this count to know which of its predicted ticks the host has already run.
   * Optional so an older client or relay without it still works (the guest then doesn't predict).
   */
  readonly ackTicks?: readonly number[];
  /**
   * "lobby" or "round" (S2-01), or how the round ended: "won" / "lost" (S2-05). Optional so an
   * older host still works.
   */
  readonly phase?: "lobby" | "round" | "won" | "lost";
  /** Ticks left on the full-room countdown, while it runs (S2-01). */
  readonly countdown?: number;
  /** The lost children (S2-02). Optional: missing before the round (and from older hosts). */
  readonly kids?: readonly SnapshotKid[];
  /**
   * The ids of the children who are home this round, in the order they got there (S2-04): the
   * "2 / 5" counter, and how a guest notices a new one (to play the sound and name them).
   */
  readonly home?: readonly string[];
  /** Ticks left until dawn (S2-05): the timer, and the "seconds left" in the score. */
  readonly dawn?: number;
  /** Times a player got lost this round (S2-05 score; always 0 until the tikbalang, S3). */
  readonly timesLost?: number;
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
  /** To the host: the guest in this seat left (closed or reloaded their tab). S1-06 */
  | { readonly type: "player_left"; readonly seat: number }
  /** To each guest: the host left, so nobody runs the game any more and the room is over. S1-06 */
  | { readonly type: "host_left" }
  /** To the host: a guest's keys. The relay adds the seat, so a guest can't pretend to be someone else. */
  | ({ readonly type: "input"; readonly seat: number } & InputFields)
  /** To each guest: where everyone is, passed on from the host. */
  | ({ readonly type: "snapshot" } & SnapshotFields)
  /** To someone who couldn't join, with a message to show as is. */
  | { readonly type: "join_error"; readonly reason: RoomErrorReason; readonly message: string }
  /** Anything else that went wrong (unknown action, broken JSON). */
  | { readonly type: "error"; readonly message: string };

/** The reasons a join can fail, for checking messages from the network. */
const JOIN_ERROR_REASONS: readonly string[] = [
  "bad_code",
  "not_found",
  "ended",
  "full",
  "already_in_room",
];

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
    case "player_left":
      return seat !== undefined ? { type: "player_left", seat } : undefined;
    case "host_left":
      return { type: "host_left" };
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
/**
 * A hat or shirt number. The relay doesn't know how many there are (that's the engine's job), so
 * it only checks for a small whole number; the engine ignores anything out of range.
 */
const isLook = (n: unknown): n is number => isCount(n) && n < 16;

/**
 * Copies the optional `hat` and `shirt` fields onto `into` if they're valid. Returns false if one
 * is present but invalid (the whole message is then refused, like any other bad field).
 */
function copyLook(from: Record<string, unknown>, into: { hat?: number; shirt?: number }): boolean {
  for (const key of ["hat", "shirt"] as const) {
    const value = from[key];
    if (value === undefined) continue;
    if (!isLook(value)) return false;
    into[key] = value;
  }
  return true;
}

/** Checks the fields of an input message; undefined if any is missing or the wrong type. */
function readInput(v: Record<string, unknown>): InputFields | undefined {
  const { seq, up, down, left, right } = v;
  if (!isCount(seq)) return undefined;
  if (![up, down, left, right].every((b) => typeof b === "boolean")) return undefined;
  const input: { -readonly [K in keyof InputFields]: InputFields[K] } = {
    seq,
    up: up as boolean,
    down: down as boolean,
    left: left as boolean,
    right: right as boolean,
  };
  if (!copyLook(v, input)) return undefined;
  if (v["call"] !== undefined) {
    if (typeof v["call"] !== "boolean") return undefined;
    input.call = v["call"];
  }
  return input;
}

/** Checks the fields of a snapshot message; undefined if anything is off. */
function readSnapshot(v: Record<string, unknown>): SnapshotFields | undefined {
  const { tick, players, acks, ackTicks, phase, countdown, kids, home, dawn, timesLost } = v;
  if (!isCount(tick)) return undefined;
  if (!Array.isArray(players) || players.length > MAX_PLAYERS) return undefined;
  const isCounts = (a: unknown): a is number[] =>
    Array.isArray(a) && a.length <= MAX_PLAYERS && a.every(isCount);
  if (!isCounts(acks)) return undefined;
  // ackTicks may be missing (older host), but if it's there it must be valid.
  if (ackTicks !== undefined && !isCounts(ackTicks)) return undefined;
  // S2-01 fields, also optional: if present they must be valid.
  if (phase !== undefined && !PHASES.includes(phase as string)) return undefined;
  if (countdown !== undefined && !isCount(countdown)) return undefined;
  // S2-05: the timer and the times-lost count are whole numbers, 0 or more.
  if (dawn !== undefined && !isCount(dawn)) return undefined;
  if (timesLost !== undefined && !isCount(timesLost)) return undefined;
  const checkedKids = kids === undefined ? undefined : readKids(kids);
  if (kids !== undefined && !checkedKids) return undefined;
  // S2-04: a short list of short ids (the same limits as the kids themselves).
  const isIds = (a: unknown): a is string[] =>
    Array.isArray(a) &&
    a.length <= MAX_KIDS &&
    a.every((id) => typeof id === "string" && id.length <= 8);
  if (home !== undefined && !isIds(home)) return undefined;
  const checked: SnapshotPlayer[] = [];
  for (const p of players as unknown[]) {
    if (!p || typeof p !== "object") return undefined;
    const fields = p as Record<string, unknown>;
    const { id, x, y } = fields;
    if (typeof id !== "string" || id.length > 8 || !isCoord(x) || !isCoord(y)) return undefined;
    // Copy only the known fields: extra ones are dropped, not passed on.
    const player: { -readonly [K in keyof SnapshotPlayer]: SnapshotPlayer[K] } = { id, x, y };
    if (!copyLook(fields, player)) return undefined;
    checked.push(player);
  }
  // Build the result with only the optional fields that were sent (`exactOptionalPropertyTypes`
  // doesn't allow writing `ackTicks: undefined`, so they're added one by one).
  const snapshot: { -readonly [K in keyof SnapshotFields]: SnapshotFields[K] } = {
    tick,
    players: checked,
    acks,
  };
  if (ackTicks !== undefined) snapshot.ackTicks = ackTicks;
  if (phase !== undefined) snapshot.phase = phase as NonNullable<SnapshotFields["phase"]>;
  if (countdown !== undefined) snapshot.countdown = countdown;
  if (checkedKids) snapshot.kids = checkedKids;
  if (home !== undefined) snapshot.home = home;
  if (dawn !== undefined) snapshot.dawn = dawn;
  if (timesLost !== undefined) snapshot.timesLost = timesLost;
  return snapshot;
}

/** Checks a snapshot's `kids` list (S2-02); undefined if it isn't a short list of valid kids. */
function readKids(kids: unknown): SnapshotKid[] | undefined {
  if (!Array.isArray(kids) || kids.length > MAX_KIDS) return undefined;
  const checked: SnapshotKid[] = [];
  for (const k of kids as unknown[]) {
    if (!k || typeof k !== "object") return undefined;
    const { id, x, y, following } = k as Record<string, unknown>;
    if (typeof id !== "string" || id.length > 8 || !isCoord(x) || !isCoord(y)) return undefined;
    if (following !== undefined && (typeof following !== "string" || following.length > 8)) {
      return undefined;
    }
    // Known fields only; `following` only when there is one.
    checked.push(following === undefined ? { id, x, y } : { id, x, y, following });
  }
  return checked;
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
