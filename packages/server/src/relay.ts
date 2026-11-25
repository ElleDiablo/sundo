/**
 * The relay's message handling, separate from AWS so it can be tested with fakes.
 *
 * API Gateway keeps one WebSocket open per browser and calls the Lambda for each event:
 *   $connect     a browser opened the socket          → accept
 *   $disconnect  it closed (tab closed, network lost) → nothing yet (S1-06 removes the player)
 *   create_room  {"action":"create_room"}             → make a room; host gets room_created
 *   join_room    {"action":"join_room","code":"BAHO"} → take a seat; guest gets room_joined,
 *                                                       host gets player_joined
 *   $default     anything else                         → reply with an error
 * Which route runs is decided by the message's "action" field (the API's route selection).
 */
import { readJoinCode, type ServerMessage } from "./messages.ts";
import { createRoom, joinRoom, RoomError, type RoomStore } from "./rooms.ts";

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
    case "$disconnect":
      return OK;

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
