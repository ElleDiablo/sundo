/**
 * The relay's message handling, separate from AWS so it can be tested with fakes.
 *
 * API Gateway keeps one WebSocket open per browser and calls the Lambda for each event:
 *   $connect     a browser opened the socket          → accept
 *   $disconnect  it closed (tab closed, reloaded, network lost) → leave the room (S1-06): a guest
 *                frees their seat and the host gets player_left; the host leaving ends the room
 *                and every guest gets host_left
 *   create_room  {"action":"create_room"}             → make a room; host gets room_created
 *   join_room    {"action":"join_room","code":"BAHO"} → take a seat; guest gets room_joined,
 *                                                       host gets player_joined
 *   input        {"action":"input","seq":7,"up":true,…} → passed to the host, with the guest's seat
 *   snapshot     {"action":"snapshot","tick":120,…}     → passed from the host to every guest
 *   $default     anything else                         → reply with an error
 * Which route runs is decided by the message's "action" field (the API's route selection).
 *
 * input and snapshot are the busy routes (up to ~40 messages a second in a full room), so a bad
 * message there is logged and dropped instead of answered: replying would double the traffic.
 */
import { readInputBody, readJoinCode, readSnapshotBody, type ServerMessage } from "./messages.ts";
import {
  createRoom,
  findGuests,
  findHost,
  findMembership,
  joinRoom,
  leaveRoom,
  RoomError,
  type RoomStore,
} from "./rooms.ts";

export type { ServerMessage };

/** Sends a message to one connected browser (API Gateway's "post to connection"). */
export interface Sender {
  send(connectionId: string, message: ServerMessage): Promise<void>;
}

/** Everything the relay needs from the outside world, passed in so tests can use fakes. */
export interface RelayDeps {
  readonly store: RoomStore;
  readonly sender: Sender;
  readonly now: () => number;
  readonly random: () => number;
  /** Where to report problems that shouldn't fail the request (CloudWatch Logs in Lambda). */
  readonly log?: (message: string) => void;
}

/** What API Gateway needs back: 200 = handled. (The reply itself goes through the Sender.) */
export interface RelayResult {
  readonly statusCode: number;
}

const OK: RelayResult = { statusCode: 200 };

export async function handleRoute(
  routeKey: string,
  connectionId: string,
  body: string | undefined,
  deps: RelayDeps,
): Promise<RelayResult> {
  switch (routeKey) {
    case "$connect":
      return OK;

    case "$disconnect": {
      // Nobody can be answered here (the connection is already closed); only the others are told.
      const left = await leaveRoom(deps.store, connectionId);
      if (!left) return OK; // wasn't in a room
      if (left.seat === 0) {
        // The host ran the game. Without them the room is over: tell every guest.
        const guests = await findGuests(deps.store, left.code);
        await Promise.all(guests.map((guest) => trySend(deps, guest, { type: "host_left" })));
      } else {
        const host = await findHost(deps.store, left.code);
        if (host) await trySend(deps, host, { type: "player_left", seat: left.seat });
      }
      return OK;
    }

    case "create_room": {
      try {
        const room = await createRoom(deps.store, connectionId, deps.now(), deps.random);
        await deps.sender.send(connectionId, { type: "room_created", code: room.code });
      } catch (error) {
        // A known problem (e.g. already in a room) becomes a friendly message; anything else is a bug.
        if (!(error instanceof RoomError)) throw error;
        await deps.sender.send(connectionId, { type: "error", message: error.message });
      }
      return OK;
    }

    case "join_room": {
      const code = readJoinCode(body) ?? "";
      try {
        const joined = await joinRoom(deps.store, connectionId, code, deps.now());
        await deps.sender.send(connectionId, {
          type: "room_joined",
          code: joined.code,
          seat: joined.seat,
        });
        // Tell the host. If the host's connection is already gone, the guest is still seated;
        // handling a departed host is S1-06, so just log it here.
        try {
          await deps.sender.send(joined.hostConnId, { type: "player_joined", seat: joined.seat });
        } catch (error) {
          deps.log?.(`could not notify host of room ${joined.code}: ${String(error)}`);
        }
      } catch (error) {
        if (!(error instanceof RoomError)) throw error;
        await deps.sender.send(connectionId, {
          type: "join_error",
          reason: error.reason,
          message: error.message,
        });
      }
      return OK;
    }

    case "input": {
      const input = readInputBody(body);
      if (!input) return dropped(deps, "input", connectionId);
      // Which seat sent this is looked up from the connection, never read from the message:
      // a guest can't move someone else's player by writing a different seat number.
      const me = await findMembership(deps.store, connectionId);
      if (!me || me.seat === 0) return dropped(deps, "input from a non-guest", connectionId);
      const host = await findHost(deps.store, me.code);
      if (!host) return dropped(deps, "input for a closed room", connectionId);
      await trySend(deps, host, { type: "input", seat: me.seat, ...input });
      return OK;
    }

    case "snapshot": {
      const snapshot = readSnapshotBody(body);
      if (!snapshot) return dropped(deps, "snapshot", connectionId);
      // Only the host (seat 0) decides where everyone is.
      const me = await findMembership(deps.store, connectionId);
      if (!me || me.seat !== 0) return dropped(deps, "snapshot from a non-host", connectionId);
      const guests = await findGuests(deps.store, me.code);
      // Send to every guest at once. One closed tab must not stop the others getting theirs.
      const message: ServerMessage = { type: "snapshot", ...snapshot };
      await Promise.all(guests.map((guest) => trySend(deps, guest, message)));
      return OK;
    }

    default: {
      const action = parseAction(body);
      await deps.sender.send(connectionId, {
        type: "error",
        message: action ? `unknown action "${action}"` : 'send JSON like {"action":"create_room"}',
      });
      return OK;
    }
  }
}

/** Sends a message; if the browser is gone (tab closed), logs it instead of failing the request. */
async function trySend(deps: RelayDeps, connectionId: string, message: ServerMessage) {
  try {
    await deps.sender.send(connectionId, message);
  } catch (error) {
    deps.log?.(`could not send ${message.type} to ${connectionId}: ${String(error)}`);
  }
}

/** Logs a message that was ignored and answers 200 (the browser isn't waiting for a reply). */
function dropped(deps: RelayDeps, what: string, connectionId: string): RelayResult {
  deps.log?.(`dropped ${what} from ${connectionId}`);
  return OK;
}

/** Reads the "action" field of a message, or undefined if it isn't JSON with one. */
function parseAction(body: string | undefined): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body ?? "");
    if (
      parsed &&
      typeof parsed === "object" &&
      "action" in parsed &&
      typeof parsed.action === "string"
    ) {
      return parsed.action.slice(0, 40); // never echo back long input
    }
  } catch {
    // not JSON
  }
  return undefined;
}
