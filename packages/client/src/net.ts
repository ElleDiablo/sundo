/**
 * Talking to the multiplayer relay (API Gateway WebSocket, ADR-0001).
 *
 * The relay's address isn't baked into the build: it only exists after AWS has created the API.
 * So the game reads it at startup from a small JSON file next to index.html:
 *   - deployed: config.json, written by the SundoWeb stack at deploy time
 *   - local dev: config.local.json, written by `npm run config -w @sundo/client` (git-ignored)
 *
 * Both createRoom and joinRoom open a socket, send one request and wait for the matching reply.
 * The socket then stays open: it's the line the host and guests talk over from now on
 * (send() for inputs and snapshots, onServerMessage() for what comes back).
 */
import { parseServerMessage, type ClientMessage, type ServerMessage } from "@sundo/server/messages";

export interface GameConfig {
  readonly wsUrl?: string;
}

/** Reads the config file; an empty config (no wsUrl) means multiplayer isn't available here. */
export async function loadConfig(): Promise<GameConfig> {
  const file = import.meta.env.DEV ? "config.local.json" : "config.json";
  try {
    const res = await fetch(file, { cache: "no-store" });
    if (!res.ok) return {};
    return (await res.json()) as GameConfig;
  } catch {
    return {};
  }
}

/** An open connection to a room, from the host's or a guest's side. */
export interface Room {
  readonly code: string;
  /** 0 for the host, 1–3 for guests. */
  readonly seat: number;
  readonly socket: WebSocket;
}

/** Opens a connection, asks the relay for a new room, and resolves with its code (I'm the host). */
export function createRoom(wsUrl: string, timeoutMs = 5000): Promise<Room> {
  return request(wsUrl, { action: "create_room" }, timeoutMs, (message, socket) =>
    message.type === "room_created" ? { code: message.code, seat: 0, socket } : undefined,
  );
}

/** Opens a connection and joins the room with this code (I'm a guest). Rejects with a friendly message. */
export function joinRoom(wsUrl: string, code: string, timeoutMs = 5000): Promise<Room> {
  return request(wsUrl, { action: "join_room", code }, timeoutMs, (message, socket) =>
    message.type === "room_joined" ? { code: message.code, seat: message.seat, socket } : undefined,
  );
}

/**
 * Opens a socket, sends `request`, and waits for a reply that `accept` turns into a Room.
 * An "error" or "join_error" reply, a timeout or a network failure rejects with a readable message.
 */
function request(
  wsUrl: string,
  request: ClientMessage,
  timeoutMs: number,
  accept: (message: ServerMessage, socket: WebSocket) => Room | undefined,
): Promise<Room> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail("The relay didn't answer in time. Try again."), timeoutMs);

    socket.addEventListener("open", () => socket.send(JSON.stringify(request)));
    socket.addEventListener("message", (event) => {
      if (settled) return; // later messages are for whoever listens after this (main.ts)
      const message = parseServerMessage(String(event.data));
      if (!message) return;
      if (message.type === "error" || message.type === "join_error") return fail(message.message);
      const room = accept(message, socket);
      if (room) {
        settled = true;
        clearTimeout(timer);
        resolve(room);
      }
    });
    socket.addEventListener("error", () =>
      fail("Couldn't reach the relay. Check your connection."),
    );
  });
}

/** Calls `handler` for every message the relay sends on this room's socket from now on. */
export function onServerMessage(room: Room, handler: (message: ServerMessage) => void): void {
  room.socket.addEventListener("message", (event) => {
    const message = parseServerMessage(String(event.data));
    if (message) handler(message);
  });
}

/** Sends a message on the room's socket. Dropped silently if the socket has closed. */
export function send(room: Room, message: ClientMessage): void {
  if (room.socket.readyState === WebSocket.OPEN) room.socket.send(JSON.stringify(message));
}
