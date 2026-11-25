/**
 * The lobby overlay: a title card where a host creates a room or a friend joins one with a code.
 * Plain HTML on top of the game canvas: buttons and text fields are easier to read, type into and
 * reach by keyboard as DOM elements than drawn inside Phaser.
 *
 *   Create room  → shows the new code → "Start walking" closes the lobby
 *   Join with code → type 4 letters → "Join" → shows "You're player N" → "Start walking"
 */
import { createRoom, joinRoom, loadConfig, type Room } from "./net.ts";

/** Called once the player is in a room, as host (seat 0) or guest (seat 1–3). */
export type OnRoom = (room: Room) => void;

/** Finds an element by id, or throws: a missing element is a bug in index.html. */
function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} missing from index.html`);
  return found as T;
}

export function setupLobby(onRoom: OnRoom): void {
  const panel = el<HTMLElement>("lobby");
  const status = el<HTMLElement>("lobby-status");
  const codeBox = el<HTMLElement>("room-code");
  const createBtn = el<HTMLButtonElement>("create");
  const showJoinBtn = el<HTMLButtonElement>("join");
  const joinForm = el<HTMLFormElement>("join-form");
  const codeInput = el<HTMLInputElement>("join-code");
  const enterBtn = el<HTMLButtonElement>("enter");
  const badge = el<HTMLElement>("room-badge");

  /** Shows a message under the buttons (also read out by screen readers: role="status"). */
  const say = (text: string) => (status.textContent = text);

  /** The relay's address, or undefined (with a message shown) if multiplayer isn't set up. */
  async function relayUrl(): Promise<string | undefined> {
    const { wsUrl } = await loadConfig();
    if (!wsUrl) say("Multiplayer isn't set up here: no relay address in the config.");
    return wsUrl;
  }

  /** Switches the lobby to "you're in": big code, one button to start walking. */
  function entered(room: Room, line: string) {
    codeBox.textContent = room.code;
    codeBox.hidden = false;
    say(line);
    createBtn.hidden = true;
    showJoinBtn.hidden = true;
    joinForm.hidden = true;
    enterBtn.hidden = false;
    enterBtn.focus();
    badge.textContent =
      room.seat === 0 ? `Room ${room.code} · host` : `Room ${room.code} · player ${room.seat + 1}`;
    onRoom(room);
  }

  // Host: create a room.
  createBtn.addEventListener("click", async () => {
    createBtn.disabled = true;
    say("Opening a room…");
    const wsUrl = await relayUrl();
    if (!wsUrl) return void (createBtn.disabled = false);
    const started = performance.now();
    try {
      const room = await createRoom(wsUrl);
      console.info(`room ${room.code} created in ${Math.round(performance.now() - started)} ms`);
      entered(room, "Share this code with friends. They'll join with it.");
    } catch (error) {
      say(`Couldn't create a room: ${(error as Error).message}`);
      createBtn.disabled = false;
    }
  });

  // Guest: show the code field.
  showJoinBtn.addEventListener("click", () => {
    joinForm.hidden = false;
    showJoinBtn.hidden = true;
    codeInput.focus();
  });

  // Keep the field to 4 capital letters as the player types (codes are always shown in capitals).
  codeInput.addEventListener("input", () => {
    codeInput.value = codeInput.value
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, 4);
  });

  // Guest: join with the typed code. A <form> submit handles both the button and the Enter key.
  joinForm.addEventListener("submit", async (event) => {
    event.preventDefault(); // stay on the page (a form would otherwise navigate)
    const code = codeInput.value;
    if (code.length !== 4) return void say("Room codes are 4 letters, like BAHO.");
    const submit = joinForm.querySelector("button");
    if (submit) submit.disabled = true;
    say(`Joining ${code}…`);
    const wsUrl = await relayUrl();
    try {
      if (!wsUrl) return;
      const room = await joinRoom(wsUrl, code);
      entered(room, `You're in! You're player ${room.seat + 1}.`);
    } catch (error) {
      // The relay's messages are already friendly ("No room with that code…").
      say((error as Error).message);
      codeInput.select();
    } finally {
      if (submit) submit.disabled = false;
    }
  });

  // Close the lobby and hand the keyboard to the game.
  enterBtn.addEventListener("click", () => {
    panel.hidden = true;
    badge.hidden = false;
    document.querySelector<HTMLElement>("#game canvas")?.focus();
  });
}

/** Shows a short message at the top of the screen for a few seconds (e.g. "Player 2 joined"). */
export function toast(text: string, ms = 3500): void {
  const box = el<HTMLElement>("toast");
  box.textContent = text;
  box.hidden = false;
  window.setTimeout(() => {
    if (box.textContent === text) box.hidden = true;
  }, ms);
}
