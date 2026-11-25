/**
 * The lobby overlay: a title card with "Create room" (and "Join", which arrives in S1-04).
 * Plain HTML on top of the game canvas: buttons and text are easier to read and reach by keyboard
 * as DOM elements than drawn inside Phaser.
 */
import { createRoom, loadConfig, type Room } from "./net.ts";

export function setupLobby(onRoom: (room: Room) => void): void {
  const panel = document.querySelector<HTMLElement>("#lobby");
  const createBtn = document.querySelector<HTMLButtonElement>("#create");
  const status = document.querySelector<HTMLElement>("#lobby-status");
  const codeBox = document.querySelector<HTMLElement>("#room-code");
  const enterBtn = document.querySelector<HTMLButtonElement>("#enter");
  const badge = document.querySelector<HTMLElement>("#room-badge");
  if (!panel || !createBtn || !status || !codeBox || !enterBtn || !badge) return;

  createBtn.addEventListener("click", async () => {
    createBtn.disabled = true;
    status.textContent = "Opening a room…";
    const config = await loadConfig();
    if (!config.wsUrl) {
      status.textContent = "Multiplayer isn't set up here: no relay address in the config.";
      createBtn.disabled = false;
      return;
    }
    const started = performance.now();
    try {
      const room = await createRoom(config.wsUrl);
      const ms = Math.round(performance.now() - started);
      console.info(`room ${room.code} created in ${ms} ms`);
      codeBox.textContent = room.code;
      codeBox.hidden = false;
      status.textContent = "Share this code with friends. They'll join with it.";
      createBtn.hidden = true;
      enterBtn.hidden = false;
      enterBtn.focus();
      badge.textContent = `Room ${room.code}`;
      onRoom(room);
    } catch (error) {
      status.textContent = `Couldn't create a room: ${(error as Error).message}. Try again.`;
      createBtn.disabled = false;
    }
  });

  enterBtn.addEventListener("click", () => {
    panel.hidden = true;
    badge.hidden = false;
    document.querySelector<HTMLElement>("#game canvas")?.focus();
  });
}
