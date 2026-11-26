/**
 * Starts the game. 384 × 216 pixels is 24 × 13.5 tiles of 16 px, 16:9 like most screens;
 * Phaser scales it up to fit the window with no smoothing (`pixelArt`), so pixels stay square.
 *
 * The world starts running straight away behind the lobby. Once the lobby puts this browser in a
 * room, this file connects the world to the relay:
 *   host   player_joined → add the friend; player_left → remove them; input → their keys;
 *          my snapshots → send()
 *   guest  my keys → send(); snapshot → draw it; host_left → back to the menu (S1-06)
 * After "Start walking", the lobby plaza's picker opens (S2-01, wardrobe.ts): hat and shirt for
 * everyone, Start round for the host. It closes, with a "Brownout!" message, when the round starts.
 * During the round the top-right shows the dawn timer, how many children are home and my
 * flashlight battery ("Dawn 5:42 · Home 2 / 5 · Light 80%", S2-04/S2-05/S3-01), and a chime plays for everyone when a child goes inside. When the
 * round ends the result screen (result.ts) shows the team score; the host takes everyone back.
 * A guest also shows the measured round trip (keys → host → snapshot back) in the room badge, and
 * logs a summary to the console every 50 samples (the number recorded in the S1-05 PR).
 */
import Phaser from "phaser";
// Pixel fonts (SIL Open Font License), bundled by Vite from npm, so no request to a font CDN:
// Silkscreen for text inside the game and for titles, Pixelify Sans for the page's menus.
import "@fontsource/silkscreen/400.css";
import "@fontsource/pixelify-sans/400.css";
import "@fontsource/pixelify-sans/600.css";
import { LatencyStats } from "./inputSender.ts";
import { backToMenu, setBadgeDetail, setupLobby, toast } from "./lobby.ts";
import { onServerMessage, send } from "./net.ts";
import { setupResult } from "./result.ts";
import { playCaught, playDawn, playKidHome, playWin, toggleMuted } from "./sounds.ts";
import { setupWardrobe } from "./wardrobe.ts";
import { WorldScene, type RoundInfo } from "./WorldScene.ts";

// Phaser draws text into the canvas once, with whatever font is ready at that moment. Wait for the
// pixel font first (a second at most), or the first labels would be drawn in a fallback font.
await Promise.race([
  document.fonts.load('8px "Silkscreen"'),
  new Promise((resolve) => setTimeout(resolve, 1000)),
]);

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

/** Set once the lobby puts me in a room: the picker needs to know if I'm the host. */
let mySeat: number | undefined;

setupLobby(
  (room) => {
    mySeat = room.seat;
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
                `p95 ${Math.round(stats.percentile(0.95) ?? 0)} ms; ` +
                // NET-02: how often others were held still because a snapshot was late.
                `frames held ${Math.round((world.snapshotHeldRatio() ?? 0) * 100)} %`,
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
        case "player_left": // I'm the host and a friend closed their tab: no ghost left behind.
          world.removeRemotePlayer(message.seat);
          toast(`Player ${message.seat + 1} left`);
          break;
        case "host_left": // I'm a guest. Only the host ran the game, so this room is over.
          backToMenu("The host left, so the room has ended.");
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
  },
  // "Start walking": only now do my keys move my tanod (the menu doesn't walk it), and the
  // lobby plaza's picker opens.
  () => {
    const world = game.scene.getScene("world") as WorldScene;
    world.enableControls();
    const wardrobe = setupWardrobe({
      isHost: mySeat === 0,
      look: world.myLook,
      onLook: (look) => world.setLook(look),
      onStart: () => world.startRound(),
    });
    // S2-03: a child started following me.
    world.events.on("escort", (name: string) => toast(`${name} is following you`));
    // S2-04 / S2-05: the timer and counter, the result screen, and a sound when the round ends.
    const hud = document.getElementById("hud");
    const result = setupResult({ isHost: mySeat === 0, onAgain: () => world.returnToLobby() });
    let roundPhase: string | undefined;
    world.listenToRound((info) => {
      if (hud) {
        hud.hidden = info.phase === "lobby";
        // S3-01: my flashlight battery, as a percentage.
        hud.textContent =
          `Dawn ${clock(info.secondsLeft)} · Home ${info.home} / ${info.total}` +
          ` · Light ${info.battery}%` +
          // S3-04: when Q (baliktad) works again.
          (info.phase === "round"
            ? ` · Q ${info.baliktadIn > 0 ? `${info.baliktadIn}s` : "ready"}`
            : "");
      }
      result.show(info);
      // The moment the round ends (not when someone joins an ended round: that's from "round").
      if (roundPhase === "round" && info.phase === "won") playWin();
      if (roundPhase === "round" && info.phase === "lost") playDawn();
      roundPhase = info.phase;
    });
    // S3-05: M switches the sound on and off (not while typing in a text box).
    window.addEventListener("keydown", (event) => {
      if (event.code !== "KeyM" || event.target instanceof HTMLInputElement) return;
      toast(toggleMuted() ? "Sound off (M). The red ring still warns you." : "Sound on (M)", 2000);
    });
    // S3-03: someone was caught by the tikbalang.
    world.events.on("naligaw", (player: string, me: boolean) => {
      playCaught(me);
      const seat = Number(player.slice(1)) + 1;
      toast(
        me
          ? "Naligaw! The tikbalang left you lost in the bamboo grove."
          : `Player ${seat} naligaw! Their children ran off to hide.`,
        4500,
      );
    });
    world.events.on("kid_home", (name: string, { home, total }: RoundInfo) => {
      playKidHome();
      toast(`${name} is home! ${home} / ${total}`);
    });
    let shownPhase: string | undefined;
    world.listenToLobby((phase, seconds) => {
      wardrobe.show(phase, seconds);
      // Lobby → round: the brownout. (Also shown to someone who joins a round already running.)
      if (phase === "round" && shownPhase !== "round") {
        toast("Brownout! Bring the children home before dawn.", 5000);
      }
      shownPhase = phase;
    });
  },
);

/** Seconds as a clock: 342 → "5:42", 7 → "0:07". */
function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
