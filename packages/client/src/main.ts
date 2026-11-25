/**
 * Starts the game. 384 × 216 pixels is 24 × 13.5 tiles of 16 px, 16:9 like most screens;
 * Phaser scales it up to fit the window with no smoothing (`pixelArt`), so pixels stay square.
 *
 * The world starts running straight away behind the lobby. Once the lobby puts this browser in a
 * room, messages from the relay are passed to the world: the host sees friends appear, and a
 * guest takes control of their own seat's player.
 */
import Phaser from "phaser";
import { setupLobby, toast } from "./lobby.ts";
import { onServerMessage } from "./net.ts";
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

setupLobby((room) => {
  // The world scene is long created by the time anyone clicks a lobby button.
  const world = game.scene.getScene("world") as WorldScene;
  if (room.seat > 0) world.becomeSeat(room.seat); // I joined as a guest

  onServerMessage(room, (message) => {
    if (message.type === "player_joined") {
      // I'm the host and a friend took a seat: show them in my world.
      world.addRemotePlayer(message.seat);
      toast(`Player ${message.seat + 1} joined`);
    }
  });
  room.socket.addEventListener("close", () => toast("Disconnected from the room"));
});
