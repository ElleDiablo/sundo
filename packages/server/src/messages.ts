/**
 * The messages that travel over the WebSocket, shared by the relay and the browser client so both
 * sides agree on the shapes (one definition, checked by TypeScript on both ends).
 *
 *   browser → relay   {"action":"create_room"}            → host gets room_created
 *                     {"action":"join_room","code":"BAHO"} → guest gets room_joined,
 *                                                            host gets player_joined
 *   relay → browser   join_error when a code is wrong, the room is full, …
 */
import type { RoomErrorReason } from "./rooms.ts";

/** Browser → relay. API Gateway picks the route from `action`. */
export type ClientMessage =
  { readonly action: "create_room" } | { readonly action: "join_room"; readonly code: string };

/** Relay → browser. */
export type ServerMessage =
  /** To the host: your room exists, share this code. */
  | { readonly type: "room_created"; readonly code: string }
  /** To a guest: you're in, in this seat (1–3; the host is 0). */
  | { readonly type: "room_joined"; readonly code: string; readonly seat: number }
  /** To the host: someone took this seat. */
  | { readonly type: "player_joined"; readonly seat: number }
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
    default:
      return undefined;
  }
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
