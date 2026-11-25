/**
 * Starts the game. 384 × 216 pixels is 24 × 13.5 tiles of 16 px, 16:9 like most screens;
 * Phaser scales it up to fit the window with no smoothing (`pixelArt`), so pixels stay square.
 *
 * The world starts running straight away behind the lobby. Once the lobby puts this browser in a
 * room, this file connects the world to the relay:
 *   host   player_joined → add the friend; input → their keys; my snapshots → send()
 *   guest  my keys → send(); snapshot → draw it
 * A guest also shows the measured round trip (keys → host → snapshot back) in the room badge, and
 * logs a summary to the console every 50 samples (the number recorded in the S1-05 PR).
 */
import Phaser from "phaser";
import { LatencyStats } from "./inputSender.ts";
import { setBadgeDetail, setupLobby, toast } from "./lobby.ts";
import { onServerMessage, send } from "./net.ts";
import { WorldScene } from "./WorldScene.ts";

const game = new Phaser.Game({
  type: Phaser.AUTO, // WebGL where available
  parent: "game",
  width: 384,
  height: 216,
  pixelArt: true,
  backgroundColor: "#0b0e16",
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: [WorldScene],
});

// Dev builds only: expose the game so the browser console (and automated two-browser tests) can
// look inside, e.g. sundo.scene.getScene("world"). Vite removes this block from production builds.
if (import.meta.env.DEV) (window as unknown as { sundo: Phaser.Game }).sundo = game;

setupLobby((room) => {
  // The world scene is long created by the time anyone clicks a lobby button.
  const world = game.scene.getScene("world") as WorldScene;
  if (room.seat === 0) {
    world.hostRoom((snapshot) => send(room, { action: "snapshot", ...snapshot }));
  } else {
    const stats = new LatencyStats();
    let shownAt = 0;
    let measured = 0; // samples so far (stats only keeps the last 50)
    world.becomeGuest(
      room.seat,
      (input) => send(room, { action: "input", ...input }),
      (ms) => {
        stats.add(ms);
        measured += 1;
        // Show the median, refreshed at most once a second so it's readable.
        const now = performance.now();
        if (now - shownAt > 1000) {
          setBadgeDetail(`${Math.round(stats.percentile(0.5) ?? 0)} ms`);
          shownAt = now;
        }
        if (measured % 50 === 0) {
          console.info(
            `round trip (keys → host → snapshot), last 50: ` +
              `median ${Math.round(stats.percentile(0.5) ?? 0)} ms, ` +
              `p95 ${Math.round(stats.percentile(0.95) ?? 0)} ms`,
          );
        }
      },
    );
  }

  onServerMessage(room, (message) => {
    switch (message.type) {
      case "player_joined": // I'm the host and a friend took a seat: show them in my world.
        world.addRemotePlayer(message.seat);
        toast(`Player ${message.seat + 1} joined`);
        break;
      case "input": // I'm the host: a guest's keys.
        world.receiveInput(message.seat, message);
        break;
      case "snapshot": // I'm a guest: where everyone is now.
        world.receiveSnapshot(message);
        break;
    }
  });
  room.socket.addEventListener("close", () => toast("Disconnected from the room"));
});
