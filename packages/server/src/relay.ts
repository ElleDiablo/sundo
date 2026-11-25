/**
 * The relay's message handling, separate from AWS so it can be tested with fakes.
 *
 * API Gateway keeps one WebSocket open per browser and calls the Lambda for each event:
 *   $connect     a browser opened the socket        → accept
 *   $disconnect  it closed (tab closed, network lost) → nothing yet (S1-06 removes the player)
 *   create_room  {"action":"create_room"}           → make a room, reply {"type":"room_created","code"}
 *   $default     anything else                       → reply with an error
 * Which route runs is decided by the message's "action" field (the API's route selection).
 */
import type { ServerMessage } from "./messages.ts";
import { createRoom, type RoomStore } from "./rooms.ts";

export type { ServerMessage };

/** Sends a message to one connected browser (API Gateway's "post to connection"). */
export interface Sender {
  send(connectionId: string, message: ServerMessage): Promise<void>;
}

export interface RelayDeps {
  readonly store: RoomStore;
  readonly sender: Sender;
  readonly now: () => number;
  readonly random: () => number;
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
      const room = await createRoom(deps.store, connectionId, deps.now(), deps.random);
      await deps.sender.send(connectionId, { type: "room_created", code: room.code });
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
      return parsed.action.slice(0, 40);
    }
  } catch {
    // not JSON
  }
  return undefined;
}
