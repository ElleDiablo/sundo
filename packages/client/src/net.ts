/**
 * Talking to the multiplayer relay (API Gateway WebSocket, ADR-0001).
 *
 * The relay's address isn't baked into the build: it only exists after AWS has created the API.
 * So the game reads it at startup from a small JSON file next to index.html:
 *   - deployed: config.json, written by the SundoWeb stack at deploy time
 *   - local dev: config.local.json, written by `npm run config -w @sundo/client` (git-ignored)
 */
import { parseServerMessage, type ClientMessage } from "@sundo/server/messages";

export interface GameConfig {
  readonly wsUrl?: string;
}

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

export interface Room {
  readonly code: string;
  readonly socket: WebSocket;
}

/**
 * Opens a connection, asks the relay for a room, and resolves with the 4-letter code.
 * The socket stays open: it's how other players will reach this host (S1-04).
 */
export function createRoom(wsUrl: string, timeoutMs = 5000): Promise<Room> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const fail = (message: string) => {
      clearTimeout(timer);
      socket.close();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail("the relay didn't answer in time"), timeoutMs);

    socket.addEventListener("open", () => {
      const message: ClientMessage = { action: "create_room" };
      socket.send(JSON.stringify(message));
    });
    socket.addEventListener("message", (event) => {
      const message = parseServerMessage(String(event.data));
      if (message?.type === "room_created") {
        clearTimeout(timer);
        resolve({ code: message.code, socket });
      } else if (message?.type === "error") {
        fail(message.message);
      }
    });
    socket.addEventListener("error", () => fail("couldn't reach the relay"));
  });
}
