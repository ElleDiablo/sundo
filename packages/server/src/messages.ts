/**
 * The messages that travel over the WebSocket, shared by the relay and the browser client so both
 * sides agree on the shapes (one definition, checked by TypeScript on both ends).
 */

/** Browser → relay. API Gateway picks the route from `action`. */
export type ClientMessage = { readonly action: "create_room" };

/** Relay → browser. */
export type ServerMessage =
  | { readonly type: "room_created"; readonly code: string }
  | { readonly type: "error"; readonly message: string };

/** Parses a message from the relay, or returns undefined if it isn't one we know. */
export function parseServerMessage(data: string): ServerMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || !("type" in value)) return undefined;
  if (value.type === "room_created" && "code" in value && typeof value.code === "string") {
    return { type: "room_created", code: value.code };
  }
  if (value.type === "error" && "message" in value && typeof value.message === "string") {
    return { type: "error", message: value.message };
  }
  return undefined;
}
