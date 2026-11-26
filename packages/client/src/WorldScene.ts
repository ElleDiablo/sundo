/**
 * The game world: draws the Tiled map, reads the keyboard, runs the engine, follows the player.
 *
 * Division of work (ADR-0004): the ENGINE decides where everyone is; this scene only turns keys
 * into inputs and draws the engine's state. There is no movement or collision code in here.
 *
 * Players are named by seat: "p0" is the host, "p1"–"p3" are friends who joined (S1-04).
 *
 * Two modes (ADR-0001, host-authoritative):
 *   HOST (also playing alone): runs the engine at 20 ticks/s with my keys plus the latest keys
 *        each guest sent, and every tick (20/s, NET-02) sends a snapshot of where everyone is.
 *   GUEST: sends my keys to the host (InputSender) and draws the OTHER players from the host's
 *        snapshots ~50 ms in the past, sliding between them (SnapshotBuffer). My OWN player is
 *        predicted (NET-01, Predictor): the guest runs the engine on just me, with the same keys
 *        the host gets, so I move the moment I press a key instead of a round trip later
 *        (~220–330 ms). Each snapshot corrects the prediction if the host disagrees.
 *
 * Lobby and round (S2-01): every game starts in the LOBBY phase in the kapilya plaza. Players
 * walk around and pick a hat and shirt (setLook; sent with the keys, applied by the host's engine).
 * The host starts the round (startRound), or a full room starts itself after a 10 s countdown.
 * The phase travels in snapshots, and `onLobby` tells the page (wardrobe.ts) when it changes.
 * Looks are drawn from one spritesheet with a row per hat + shirt (looks.ts).
 *
 * Lost children (S2-02): when the round starts the engine puts 5 kids on 5 of the map's 12 "kid"
 * points, chosen with the seeded generator (the host picks the seed). The host draws them from
 * its engine; guests from snapshots (`kids`), slid between snapshots like players.
 *
 * Escorting (S2-03): holding E near a lost child makes it follow me; a hint ("Tala [E]") shows
 * over the nearest one in reach. A guest predicts its own line too (Predictor gets the kids), so
 * calling and leading feel instant. The page hears about it through the scene event "escort".
 *
 * Going home (S2-04): each child lives in one of the map's 5 houses (the "home" points: k0 in the
 * first, …). While a child follows me, a label ("Tala's house") marks their doorway, pinned to the
 * edge of the screen with an arrow when the house is off screen. The engine takes a child inside
 * at their doorway; snapshots carry who is home (`home`), and `onRound` tells the page so it can
 * update the "Home 2 / 5" counter, while the scene event "kid_home" (with the name) plays the sound.
 *
 * The end of a round (S2-05): the engine counts down 6:00 to dawn and ends the round as "won" (all
 * children home) or "lost" (dawn came). Snapshots carry `dawn` (ticks left) and `timesLost`, so
 * every browser shows the same timer and works out the same score (engine teamScore). The host's
 * "Back to the plaza" calls returnToLobby(), which puts everyone back at the spawn for another round.
 *
 * Darkness and the flashlight (S3-01): during the round a darkness layer (darkness.ts) covers
 * everything except the safe zones (the map's "safe" rectangles), the map's lights, a small glow
 * around each tanod and flashlight cones (Space; they point the way each tanod last walked). The
 * engine runs the battery; snapshots carry facing, light and battery; the HUD shows my battery.
 *
 * The tikbalang (S3-02): the host's engine runs it (tikbalang.ts in the engine); snapshots carry
 * where it is, its mode and facing, and guests slide it between snapshots like a player. It's drawn
 * among the players (so the darkness hides it unless it's lit), and while it stalks or chases, its
 * eye is drawn again above the darkness: a glint in the dark is all you see coming.
 *
 * Getting caught (S3-03): the host's engine drops a caught player in the bamboo grove and scatters
 * their children. Snapshots carry the last catch (`caught`: who, which tick); a new one fires the
 * scene event "naligaw" (player id, and whether it's me) for the message, the sound and a shake.
 *
 * Baliktad (S3-04): Q (a tap is kept for 150 ms, like an emote) turns my shirt inside out: the
 * engine hides me from the tikbalang for 5 s, then I wait 30 s. Everyone sees a hidden tanod
 * faded and pale; the HUD shows when Q is ready again.
 *
 * Hoofbeats and the warning ring (S3-05): from the distance between me and the tikbalang,
 * hoofbeats.ts says how often and how loud to play a hoofbeat and how strong to draw a red arc at
 * the screen's edge, pointing at it. The ring shows whether the sound is on or not (M switches it).
 *
 * Emotes (S2-06): keys 1–4 put an emote number in my input (kept for at least 150 ms, see
 * emotes.ts); the host's engine shows it for 2 s, at most once a second, and snapshots carry it,
 * so everyone draws the same speech bubble ("Dito!") over my tanod.
 *
 * Draw order (depth), bottom to top:
 *   0 ground · 1 decor · 2 objects (walls, trunks, fences) · 10 players
 *   20 above (roofs, canopies, bamboo tops: they hide players who walk behind them)
 *   30 night tint · 31 warm glows from doorways and windows
 */
import Phaser from "phaser";
import {
  addPlayer,
  CALL_RANGE,
  createGame,
  removePlayer,
  returnToLobby,
  secondsLeft,
  startRound,
  teamScore,
  findTiledPoint,
  findTiledPoints,
  findTiledRects,
  mapFromTiled,
  BATTERY_MAX,
  step,
  TICK_MS,
  TILE_SIZE_PX,
  UNITS_PER_TILE,
  kidHome,
  type GameState,
  type KidState,
  type Phase,
  type PlayerInput,
  type PlayerState,
  type Spot,
  type Zone,
  type TiledMap,
  type TileMap,
} from "@sundo/engine";
import type {
  InputFields,
  SnapshotFields,
  SnapshotPlayer,
  SnapshotTikbalang,
} from "@sundo/server/messages";
import { advance, createFixedStep, type FixedStep } from "./fixedStep.ts";
import { InputSender } from "./inputSender.ts";
import { SnapshotBuffer, TICKS_PER_SNAPSHOT } from "./interpolation.ts";
import { KID_NAMES, kidRow } from "./kids.ts";
import { Darkness, type Beam, type Glow } from "./darkness.ts";
import { EMOTE_HOLD_MS, emoteText } from "./emotes.ts";
import { warning } from "./hoofbeats.ts";
import { playHoof } from "./sounds.ts";
import { defaultShirt, HATS, lookRow, SHIRTS, WALK_FRAMES } from "./looks.ts";
import { INK, pixelTextStyle, placeCentred } from "./pixelText.ts";
import { Predictor } from "./prediction.ts";

/** Engine units → screen pixels (1 tile = 1000 units = 16 px). */
const toPx = (units: number) => (units / UNITS_PER_TILE) * TILE_SIZE_PX;

/** The player id for a seat: seat 0 (the host) is "p0", and so on. */
export const playerId = (seat: number) => `p${seat}`;

/** The seat a player id belongs to: "p2" → 2. */
const seatOf = (id: string) => Number(id.slice(1)) || 0;

/** A player's hat and shirt numbers (see looks.ts for what they look like). */
export interface Look {
  readonly hat: number;
  readonly shirt: number;
}

/** What the page needs to show about the lobby: the phase, and whole seconds left on the countdown. */
export type OnLobby = (phase: Phase, countdownSeconds: number | null) => void;

/**
 * What the page shows during and after a round: how many children are home, out of how many
 * (S2-04); the seconds left to dawn, times lost and the team score (S2-05).
 */
export interface RoundInfo {
  readonly phase: Phase;
  readonly home: number;
  readonly total: number;
  readonly secondsLeft: number;
  readonly timesLost: number;
  readonly score: number;
  /** My flashlight battery, 0–100 % (S3-01). */
  readonly battery: number;
  /** Whole seconds until my baliktad is ready (S3-04); 0 = ready now. */
  readonly baliktadIn: number;
}
export type OnRound = (info: RoundInfo) => void;

/** Moonlit night: every colour is multiplied by this (lighting proper comes in S3-01). */
const NIGHT_TINT = 0x9ea8d9;
/**
 * Brownout (the round has started): a second multiply layer over the night one, making the world
 * ~30 % darker (measured on the plaza: 76,80,94 → 52,56,72) so the candles and doorways stand out
 * more. A separate layer switched on and off, so going back to the lobby later is one line.
 */
const BROWNOUT_TINT = 0xb0b4c4;

const DEPTH = {
  ground: 0,
  decor: 1,
  objects: 2,
  player: 10,
  above: 20,
  night: 30,
  dark: 30.5, // S3-01: the brownout's darkness, with the lights cut out
  glow: 31,
};

/**
 * How dark the darkness layer is in each phase (S3-01): none in the lobby, nearly black during the
 * round and its win screen, and much lighter once dawn has come.
 */
const DARKNESS: Record<Phase, number> = { lobby: 0, round: 0.92, won: 0.92, lost: 0.4 };
/** Light sizes in pixels (diameter): around each tanod, and the map's doorways / windows / candles. */
const TANOD_GLOW = 40;
const MAP_GLOW: Record<string, number> = { doorway: 56, window: 36, kapilya: 96, store: 96 };

/** Keep the walk animation going this long after a player last moved, so it doesn't flicker. */
const WALK_HOLD_MS = 120;

type Keys = Record<
  | "W"
  | "A"
  | "S"
  | "D"
  | "UP"
  | "DOWN"
  | "LEFT"
  | "RIGHT"
  | "E"
  | "ONE"
  | "TWO"
  | "THREE"
  | "FOUR"
  | "SPACE"
  | "Q",
  Phaser.Input.Keyboard.Key
>;

/** A player as draw() takes it: from a snapshot (emote missing = none) or the engine (null = none). */
type DrawnPlayer =
  | SnapshotPlayer
  | (Omit<SnapshotPlayer, "emote" | "light"> & {
      emote: number | null;
      // From the engine (host, or my own prediction): facing as two numbers (S3-01).
      faceX?: number;
      faceY?: number;
      light?: boolean;
      baliktad?: number; // S3-04: ticks left in baliktad
    });

/** Is this tanod in baliktad (S3-04)? From the engine (`baliktad`) or a snapshot (`bal`). */
function inBaliktad(p: DrawnPlayer): boolean {
  if ("baliktad" in p && p.baliktad !== undefined) return p.baliktad > 0;
  return "bal" in p && (p.bal ?? 0) > 0;
}

/** A snapshot's packed facing (0–8) → faceX, faceY (each −1, 0 or 1). Missing → facing down. */
function unpackFace(face: number | undefined): { faceX: number; faceY: number } {
  if (face === undefined) return { faceX: 0, faceY: 1 };
  return { faceX: Math.floor(face / 3) - 1, faceY: (face % 3) - 1 };
}

/** faceX, faceY → the snapshot's packed facing, 0–8. */
const packFace = (faceX: number, faceY: number) => (faceX + 1) * 3 + (faceY + 1);

export class WorldScene extends Phaser.Scene {
  private state!: GameState; // the engine's current state
  private previous!: GameState; // the state one tick ago, for smooth drawing between ticks
  private clock!: FixedStep;
  private keys!: Keys;
  /**
   * Off while the lobby menu is open: the world runs behind the menu, but my tanod mustn't walk
   * until I press "Start walking" (enableControls). Keys pressed on the menu are ignored.
   */
  private controlsOn = false;
  private spawn!: { tileX: number; tileY: number }; // the map's "player" spawn point
  private map!: TileMap; // which tiles are walls (the engine's view of the map)
  /** Which player this browser controls. Starts as the host; a guest becomes their seat. */
  private localId = playerId(0);
  /** One sprite per player id. */
  private sprites = new Map<string, Phaser.GameObjects.Sprite>();
  /** The speech bubble over each player (S2-06), by player id; hidden while they have no emote. */
  private bubbles = new Map<string, Phaser.GameObjects.Text>();
  /** The emote key I last pressed (0–3) and until when it stays in my input (EMOTE_HOLD_MS). */
  private emoteKey: { emote: number; until: number } | undefined;
  /** Until when a tap of Q stays in my input (S3-04; same reason as EMOTE_HOLD_MS). */
  private baliktadUntil = 0;
  /** The tikbalang (S3-02) and its eye glint (above the darkness); hidden outside the round. */
  private tikSprite!: Phaser.GameObjects.Sprite;
  private tikEye!: Phaser.GameObjects.Sprite;
  /** The red warning arc at the screen's edge (S3-05), and when the last hoofbeat played. */
  private ring!: Phaser.GameObjects.Graphics;
  private lastHoof = 0;
  /** One sprite per lost child, by id ("k0"…"k4"). Empty in the lobby. */
  private kidSprites = new Map<string, Phaser.GameObjects.Sprite>();
  /** "Tala [E]" over the nearest lost child I can call (S2-03). Hidden when none is in reach. */
  private callHint!: Phaser.GameObjects.Text;
  /** Children following me last frame, to notice a new one (for the "escort" event). */
  private myEscort = new Set<string>();
  /** Each house's doorway (the map's "home" points, S2-04): child k<n> lives at homes[n]. */
  private homes: readonly Spot[] = [];
  /** "Tala's house" over the doorway of each child following me, by child id (S2-04). */
  private houseLabels = new Map<string, Phaser.GameObjects.Text>();
  /** Children already known to be home, to notice a new one (sound, toast). Undefined = not yet read. */
  private knownHome: Set<string> | undefined;
  /** The tick of the last catch already announced (S3-03). Undefined = not read yet. */
  private knownCaught: number | null | undefined;
  /** Tells the page the round's counter; called only when something it shows changes (S2-04). */
  private onRound: OnRound | undefined;
  /** The last RoundInfo passed to onRound, as text, to call it only on a change. */
  private shownRound = "";
  /** Where each sprite was last drawn (units) and when it last moved: drives walking and facing. */
  private motion = new Map<string, { x: number; y: number; movedAt: number }>();
  private glows: Phaser.GameObjects.Image[] = [];
  /** The darkness layer (S3-01) and the fixed lights cut out of it: the map's lights and safe zones. */
  private darkness!: Darkness;
  private mapGlows: Glow[] = [];
  private safeZones: Zone[] = [];
  /** This frame's moving lights (each tanod's glow and flashlight), collected by draw(). */
  private tanodGlows: Glow[] = [];
  private beams: Beam[] = [];
  private brownout!: Phaser.GameObjects.Rectangle; // extra darkness, shown once the round starts
  /** The hat and shirt I've picked (S2-01). Seat 0 until I join someone's room as a guest. */
  private look: Look = { hat: 0, shirt: defaultShirt(0) };
  /** Tells the page about the lobby; called only when the phase or the seconds left change. */
  private onLobby: OnLobby | undefined;
  /** The last phase and countdown seconds passed to onLobby, to call it only on a change. */
  private shownLobby: { phase: Phase | undefined; seconds: number | null } = {
    phase: undefined,
    seconds: null,
  };

  // ── Host side ──
  /** The latest keys each guest sent, by seat, with the seq they came in (older ones are ignored). */
  private remote = new Map<number, InputFields>();
  /**
   * How many ticks I've applied each guest's latest input for, by seat. Sent back as snapshot
   * `ackTicks` so the guest's prediction knows exactly how far I've got (NET-01).
   */
  private remoteTicks = new Map<number, number>();
  /** How to send a snapshot to the guests, once I host a room that has guests. */
  private sendSnapshot: ((snapshot: SnapshotFields) => void) | undefined;

  // ── Guest side ──
  /** Set once I join someone's room: from then on the host's snapshots are what I draw. */
  private guest:
    | {
        readonly seat: number;
        readonly sender: InputSender;
        readonly buffer: SnapshotBuffer;
        readonly predictor: Predictor;
        readonly clock: FixedStep; // the guest's own 20 ticks/s, for prediction
        readonly sendInput: (input: InputFields) => void;
        readonly onRoundTrip: (ms: number) => void;
      }
    | undefined;

  constructor() {
    super("world");
  }

  preload(): void {
    // Paths are relative to index.html, so the game works at any URL (localhost or CloudFront).
    this.load.tilemapTiledJSON("barangay", "assets/maps/barangay.tmj");
    this.load.image("barangay-tiles", "assets/tiles/barangay.png");
    // 16 × 28 px frames. Across: stand, left step, stand (dip), right step. Down: one row per
    // hat + shirt combination (looks.ts), 24 rows.
    this.load.spritesheet("tanod", "assets/sprites/tanod.png", { frameWidth: 16, frameHeight: 28 });
    this.load.image("glow", "assets/sprites/glow.png");
    // S3-01: white light shapes, erased out of the darkness (darkness.ts).
    this.load.image("light", "assets/sprites/light.png");
    this.load.image("cone", "assets/sprites/cone.png");
    // The lost children (S2-02): same frame size, one row per child (kids.ts), 4 walk frames.
    this.load.spritesheet("kids", "assets/sprites/kids.png", { frameWidth: 16, frameHeight: 28 });
    // The tikbalang (S3-02): 24 × 32 frames, 4-frame walk; and the same frames with only its eye.
    const tikFrames = { frameWidth: 24, frameHeight: 32 };
    this.load.spritesheet("tikbalang", "assets/sprites/tikbalang.png", tikFrames);
    this.load.spritesheet("tikbalang-eye", "assets/sprites/tikbalang-eye.png", tikFrames);
  }

  create(): void {
    // 1. Draw the map. Layer and tileset names must match the ones in Tiled.
    const map = this.make.tilemap({ key: "barangay" });
    const tiles = map.addTilesetImage("barangay", "barangay-tiles");
    if (!tiles) throw new Error('tileset "barangay" missing from barangay.tmj');
    for (const name of ["ground", "decor", "objects", "above"] as const) {
      map.createLayer(name, tiles)?.setDepth(DEPTH[name]);
    }

    // 2. Give the SAME file to the engine, which only cares which tiles are walls.
    const tiled = this.cache.tilemap.get("barangay").data as TiledMap;
    this.spawn = findTiledPoint(tiled, "spawns", "player");
    this.map = mapFromTiled(tiled);
    // The seed for this game's random choices (where the kids hide). The engine may not use
    // Math.random (ADR-0004), so the browser picks the seed and the engine does the rest. Only
    // the host's game matters: a guest's engine stops when it joins a room.
    const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
    const kidSpots = findTiledPoints(tiled, "spawns", "kid");
    this.homes = findTiledPoints(tiled, "spawns", "home"); // S2-04: the houses, k0's first
    this.safeZones = findTiledRects(tiled, "zones", "safe"); // S3-01: plaza and store
    this.state = createGame(this.map, [{ id: this.localId, ...this.spawn, ...this.look }], {
      seed,
      kidSpots,
      homes: this.homes,
      safeZones: this.safeZones,
      // S3-02: the tikbalang's spawn, patrol and ambush points.
      tikSpawn: findTiledPoint(tiled, "spawns", "tikbalang"),
      patrol: findTiledPoints(tiled, "spawns", "patrol"),
      ambush: findTiledPoints(tiled, "spawns", "ambush"),
      grove: findTiledPoints(tiled, "spawns", "grove"), // S3-03: where the caught wake up
    });
    this.previous = this.state;
    this.clock = createFixedStep(TICK_MS);

    // 3. A walk animation per look (4 frames, 8 per second), named after its spritesheet row.
    for (let row = 0; row < HATS.length * SHIRTS.length; row++) {
      this.anims.create({
        key: walkKey(row),
        frames: this.anims.generateFrameNumbers("tanod", {
          start: row * WALK_FRAMES,
          end: row * WALK_FRAMES + WALK_FRAMES - 1,
        }),
        frameRate: 8,
        repeat: -1,
      });
    }
    // The children's walks (S2-03), one per row of kids.png.
    for (let row = 0; row < KID_NAMES.length; row++) {
      this.anims.create({
        key: kidWalkKey(row),
        frames: this.anims.generateFrameNumbers("kids", {
          start: row * WALK_FRAMES,
          end: row * WALK_FRAMES + WALK_FRAMES - 1,
        }),
        frameRate: 8,
        repeat: -1,
      });
    }
    // The tikbalang's walk (S3-02): a little slower than a person's, it's a big creature.
    this.anims.create({
      key: "tikbalang-walk",
      frames: this.anims.generateFrameNumbers("tikbalang", { start: 0, end: 3 }),
      frameRate: 6,
      repeat: -1,
    });
    this.tikSprite = this.add.sprite(0, 0, "tikbalang", 0).setOrigin(0.5, 1).setVisible(false);
    this.tikEye = this.add
      .sprite(0, 0, "tikbalang-eye", 0)
      .setOrigin(0.5, 1)
      .setDepth(DEPTH.glow + 0.5) // above the darkness
      .setVisible(false);
    // S3-05: the warning ring, fixed to the screen, above the darkness.
    this.ring = this.add
      .graphics()
      .setScrollFactor(0)
      .setDepth(DEPTH.glow + 3);
    this.draw(this.state.players, 0);

    // 4. Night: multiply the whole screen by a cool moonlight colour, then add warm glows on top
    //    where the map's "lights" layer has a point (doorways, windows, the store's candle).
    const { width, height } = this.scale;
    this.add
      .rectangle(0, 0, width, height, NIGHT_TINT)
      .setOrigin(0)
      .setScrollFactor(0) // stays put while the camera moves
      .setDepth(DEPTH.night)
      .setBlendMode(Phaser.BlendModes.MULTIPLY);
    this.brownout = this.add
      .rectangle(0, 0, width, height, BROWNOUT_TINT)
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(DEPTH.night)
      .setBlendMode(Phaser.BlendModes.MULTIPLY)
      .setVisible(false); // switched on when the round starts (reportLobby)
    // S3-01: the brownout's darkness, between the night tint and the warm glows.
    this.darkness = new Darkness(this, DEPTH.dark);
    for (const light of map.getObjectLayer("lights")?.objects ?? []) {
      this.mapGlows.push({ x: light.x ?? 0, y: light.y ?? 0, size: MAP_GLOW[light.name] ?? 48 });
      this.glows.push(
        this.add
          .image(light.x ?? 0, light.y ?? 0, "glow")
          .setDepth(DEPTH.glow)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setScale(light.name === "window" ? 0.6 : 1)
          .setAlpha(0.45),
      );
    }

    // The call hint: tiny text, drawn above the night tint so it stays readable in the dark.
    this.callHint = this.add
      .text(0, 0, "", pixelTextStyle(INK.amber, INK.night)) // pixel font: see pixelText.ts
      .setOrigin(0, 1) // bottom-left; placeCentred() centres it on whole pixels
      .setDepth(DEPTH.glow + 1)
      .setVisible(false);

    // 5. Camera: never show outside the map. (It follows my player: see addSprite.)
    this.cameras.main.setBounds(0, 0, map.widthInPixels, map.heightInPixels);

    // 6. Keyboard: WASD and the arrow keys.
    const keyboard = this.input.keyboard;
    if (!keyboard) throw new Error("no keyboard input available");
    // E: call a child (S2-03). ONE–FOUR: the number keys 1–4 above the letters, emotes (S2-06).
    // SPACE: the flashlight (S3-01).
    // Q: baliktad (S3-04).
    this.keys = keyboard.addKeys("W,A,S,D,UP,DOWN,LEFT,RIGHT,E,ONE,TWO,THREE,FOUR,SPACE,Q") as Keys;
    this.keys.Q.on("down", () => {
      if (this.controlsOn) this.baliktadUntil = performance.now() + EMOTE_HOLD_MS;
    });
    // A press of 1–4 is remembered for EMOTE_HOLD_MS, so even a very quick tap reaches the engine.
    (["ONE", "TWO", "THREE", "FOUR"] as const).forEach((name, emote) =>
      this.keys[name].on("down", () => {
        if (this.controlsOn) this.emoteKey = { emote, until: performance.now() + EMOTE_HOLD_MS };
      }),
    );

    // 7. Typing in a text box (the room code) must not walk the tanod. Phaser "captures" these
    //    keys for the whole page: it cancels the browser's normal handling, so W, A, S and D would
    //    never reach the box either. While a text box has focus, switch the game's keyboard off
    //    (no capture, no key tracking) and forget any keys it thought were held.
    const isTextBox = (target: EventTarget | null) =>
      target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    document.addEventListener("focusin", (event) => {
      if (!isTextBox(event.target)) return;
      keyboard.enabled = false;
      keyboard.disableGlobalCapture();
      keyboard.resetKeys(); // a key held while clicking into the box would otherwise stick
    });
    document.addEventListener("focusout", (event) => {
      if (!isTextBox(event.target)) return;
      keyboard.enabled = true;
      keyboard.enableGlobalCapture();
    });
  }

  /**
   * I host a room: from now on send a snapshot to my guests 20 times a second (once there are any).
   */
  hostRoom(sendSnapshot: (snapshot: SnapshotFields) => void): void {
    this.sendSnapshot = sendSnapshot;
  }

  /** A guest joined my room (I'm the host): add them to my world next to the spawn, in their seat's shirt. */
  addRemotePlayer(seat: number): void {
    const spawn = { id: playerId(seat), ...this.spawn, shirt: defaultShirt(seat) };
    this.state = addPlayer(this.state, spawn);
    this.previous = this.state;
  }

  /** A guest left my room (I'm the host): take their player out, and forget their keys. */
  removeRemotePlayer(seat: number): void {
    this.state = removePlayer(this.state, playerId(seat));
    this.previous = this.state;
    this.remote.delete(seat);
    this.remoteTicks.delete(seat);
    // Their sprite goes on the next draw(), which only draws players still in the state.
  }

  /** A guest's keys arrived (I'm the host). Kept until newer ones come; late, older ones are ignored. */
  receiveInput(seat: number, input: InputFields): void {
    const known = this.remote.get(seat);
    if (known && input.seq <= known.seq) return;
    this.remote.set(seat, input);
    this.remoteTicks.set(seat, 0); // a new input: none of my ticks have used it yet
  }

  /**
   * I joined someone else's room in this seat. My own engine stops: from now on the host's
   * snapshots decide where everyone is, and my keys are sent to the host instead.
   */
  becomeGuest(
    seat: number,
    sendInput: (input: InputFields) => void,
    onRoundTrip: (ms: number) => void,
  ): void {
    this.localId = playerId(seat);
    this.look = { hat: 0, shirt: defaultShirt(seat) }; // my seat's starting shirt, like the host gives me
    this.guest = {
      seat,
      sender: new InputSender(),
      buffer: new SnapshotBuffer(),
      predictor: new Predictor(this.map, this.localId),
      clock: createFixedStep(TICK_MS),
      sendInput,
      onRoundTrip,
    };
    // Nobody is drawn until the first snapshot arrives (a fraction of a second).
    this.draw([], performance.now());
  }

  /**
   * Guest only: the share of frames (0–1) where the next snapshot was late, so other players were
   * held still for a moment (NET-02 measures this to check a 50 ms buffer is enough).
   */
  snapshotHeldRatio(): number | undefined {
    return this.guest?.buffer.heldRatio;
  }

  /** A snapshot arrived from the host (I'm a guest). */
  receiveSnapshot(snapshot: SnapshotFields): void {
    const guest = this.guest;
    if (!guest) return;
    const now = performance.now();
    if (!guest.buffer.push(snapshot, now)) return; // out of order or repeated

    // Correct my prediction: where the host has me, and how far it got with my inputs.
    // No ackTicks (a host from before NET-01) → no prediction; I'm drawn from snapshots instead.
    const me = snapshot.players.find((p) => p.id === this.localId);
    const ackTicks = snapshot.ackTicks?.[guest.seat];
    if (me && ackTicks !== undefined) {
      guest.predictor.reconcile({
        x: me.x,
        y: me.y,
        ackSeq: snapshot.acks[guest.seat] ?? 0,
        ackTicks,
        // The snapshot's children, in the engine's shape (no `following` = lost).
        kids: (snapshot.kids ?? []).map((k) => ({ ...k, following: k.following ?? null })),
        // The phase only when the snapshot has one (`exactOptionalPropertyTypes`, S2-05).
        ...(snapshot.phase ? { phase: snapshot.phase } : {}),
        ...(me.battery === undefined ? {} : { battery: me.battery }), // S3-01
      });
    }

    // The host has applied my inputs up to this seq: how long did that take?
    const ms = guest.sender.acked(snapshot.acks[guest.seat] ?? 0, now);
    if (ms !== undefined) guest.onRoundTrip(ms);
  }

  /** The page wants to hear about the lobby: the phase, and the countdown (S2-01). */
  listenToLobby(onLobby: OnLobby): void {
    this.onLobby = onLobby;
    this.shownLobby = { phase: undefined, seconds: null }; // report the current state on the next frame
  }

  /** The page wants the round's counter (S2-04): called now-ish, then whenever it changes. */
  listenToRound(onRound: OnRound): void {
    this.onRound = onRound;
    this.shownRound = ""; // report on the next frame
  }

  /** My current hat and shirt (the picker shows these as selected). */
  get myLook(): Look {
    return this.look;
  }

  /**
   * I picked a hat or shirt in the lobby. It goes out with my next input (a guest's InputSender
   * counts it as a change) and the engine applies it, so everyone sees it; after the round has
   * started the engine ignores it.
   */
  setLook(look: Look): void {
    this.look = look;
  }

  /** Host only: start the round now (the Start button). Guests find out from the next snapshot. */
  startRound(): void {
    if (this.guest) return; // only the host runs the engine
    this.state = startRound(this.state);
  }

  /**
   * Host only: after a round, take everyone back to the plaza (S2-05). Everyone is moved to the
   * spawn at once; a guest's prediction sees a jump of more than 2 tiles and snaps to it.
   */
  returnToLobby(): void {
    if (this.guest) return;
    this.state = returnToLobby(this.state, this.spawn);
    this.previous = this.state; // no sliding from where they were: they're simply back
  }

  /** Phaser calls this every screen frame; `delta` is the real time since the last frame in ms. */
  override update(time: number, delta: number): void {
    const now = performance.now();
    if (this.guest) this.updateGuest(this.guest, delta, now);
    else this.updateHost(delta, now);
    this.reportLobby();
    this.reportRound();
    this.drawDarkness();
    // Candles flicker a little (each one slightly out of step with the others).
    this.glows.forEach((g, i) => g.setAlpha(0.42 + 0.05 * Math.sin(time * 0.009 + i * 1.7)));
  }

  /** Host (or alone): run the engine on everyone's keys; send a snapshot every tick (TICKS_PER_SNAPSHOT). */
  private updateHost(delta: number, now: number): void {
    const { ticks, alpha } = advance(this.clock, delta);
    const inputs: Record<string, PlayerInput> = { [this.localId]: this.readInput() };
    for (const [seat, input] of this.remote) inputs[playerId(seat)] = input;

    for (let i = 0; i < ticks; i++) {
      this.previous = this.state;
      this.state = step(this.state, inputs).state;
      // Count this tick against each guest's latest input (only once they're in the game).
      for (const seat of this.remote.keys()) {
        if (this.find(this.state, playerId(seat))) {
          this.remoteTicks.set(seat, (this.remoteTicks.get(seat) ?? 0) + 1);
        }
      }
      if (this.state.tick % TICKS_PER_SNAPSHOT === 0) this.broadcast();
    }

    // Draw everyone part-way between the last two ticks (alpha 0 = previous, 1 = current).
    const drawn = this.state.players.map((p) => {
      const before = this.find(this.previous, p.id) ?? p;
      return {
        ...p, // id, hat, shirt
        x: before.x + (p.x - before.x) * alpha,
        y: before.y + (p.y - before.y) * alpha,
      };
    });
    this.draw(drawn, now);
    // The children, also part-way between the last two ticks (they walk now: S2-03).
    const kids = this.state.kids.map((k) => {
      const before = this.previous.kids.find((b) => b.id === k.id) ?? k;
      return {
        ...k,
        x: before.x + (k.x - before.x) * alpha,
        y: before.y + (k.y - before.y) * alpha,
      };
    });
    this.drawKids(
      kids,
      drawn.find((p) => p.id === this.localId),
      now,
    );
    // The tikbalang, part-way between the last two ticks too (S3-02).
    const t = this.state.tikbalang;
    const b = this.previous.tikbalang ?? t;
    this.drawTikbalang(
      t && b ? { ...t, x: b.x + (t.x - b.x) * alpha, y: b.y + (t.y - b.y) * alpha } : undefined,
      now,
      drawn.find((p) => p.id === this.localId),
    );
  }

  /** Sends the current state to the guests, if I'm hosting a room that has any. */
  private broadcast(): void {
    if (!this.sendSnapshot || this.state.players.length < 2) return;
    // acks[seat] = the last input seq from that seat that this state includes.
    const seats = [0, 1, 2, 3];
    const acks = seats.map((seat) => this.remote.get(seat)?.seq ?? 0);
    // ackTicks[seat] = for how many ticks that input has been applied (NET-01).
    const ackTicks = seats.map((seat) => this.remoteTicks.get(seat) ?? 0);
    const { tick, phase, countdown } = this.state;
    const snapshot: SnapshotFields = {
      tick,
      // The emote only while one is showing (S2-06), like a child's `following`.
      // S3-01: facing packed into one number, the light only while on, and the battery.
      players: this.state.players.map(
        ({
          id,
          x,
          y,
          hat,
          shirt,
          emote,
          faceX,
          faceY,
          light,
          battery,
          baliktad,
          baliktadCooldown,
        }) => ({
          id,
          x,
          y,
          hat,
          shirt,
          ...(emote === null ? {} : { emote }),
          face: packFace(faceX, faceY),
          ...(light ? { light } : {}),
          battery,
          // S3-04: baliktad and its cooldown, only while they run.
          ...(baliktad > 0 ? { bal: baliktad } : {}),
          ...(baliktadCooldown > 0 ? { cool: baliktadCooldown } : {}),
        }),
      ),
      acks,
      ackTicks,
      phase, // S2-01: lobby or round, so guests can show the picker or the brownout
      // S2-02 (empty in the lobby); `following` only for children who follow someone (S2-03).
      kids: this.state.kids.map(({ id, x, y, following }) =>
        following === null ? { id, x, y } : { id, x, y, following },
      ),
      home: this.state.home, // S2-04: who is home (the counter, and the guests' sound)
      // S3-02: the tikbalang, only during the round (`exactOptionalPropertyTypes`: no undefined).
      ...(this.state.tikbalang
        ? {
            tikbalang: {
              x: this.state.tikbalang.x,
              y: this.state.tikbalang.y,
              mode: this.state.tikbalang.mode,
              faceX: this.state.tikbalang.faceX,
            },
          }
        : {}),
      // S3-03: the last catch, so guests announce it too.
      ...(this.state.lastCaught ? { caught: this.state.lastCaught } : {}),
      dawn: this.state.dawn, // S2-05: the timer (frozen once the round has ended)
      timesLost: this.state.timesLost, // S2-05: for the score
    };
    // The countdown only while it runs (`exactOptionalPropertyTypes`: no `countdown: undefined`).
    this.sendSnapshot(countdown === null ? snapshot : { ...snapshot, countdown });
  }

  /**
   * Guest: send my keys when they change; predict my own player at 20 ticks/s; draw everyone
   * else from the host's snapshots ~50 ms in the past.
   */
  private updateGuest(guest: NonNullable<WorldScene["guest"]>, delta: number, now: number): void {
    const message = guest.sender.update(this.readInput(), now);
    if (message) guest.sendInput(message);

    // Prediction ticks at the same fixed 50 ms as the host, with the keys last SENT (see
    // Predictor.tick for why not the keys held this instant).
    const { ticks, alpha } = advance(guest.clock, delta);
    for (let i = 0; i < ticks; i++) guest.predictor.tick(guest.sender.current);
    guest.predictor.decay(delta);

    const players = guest.buffer.sample(now);
    if (!players) return;
    // Swap the snapshot's (old) copy of me for the predicted one, once prediction has started.
    // In the lobby I'm drawn in the look I just picked (no waiting for the host); once the round
    // has started, in the look the host has for me (it's fixed, and that's what others see).
    const mine = guest.predictor.position(alpha);
    const old = players.find((p) => p.id === this.localId);
    const look: Look =
      guest.buffer.latest?.phase === "round" && old
        ? { hat: old.hat ?? 0, shirt: old.shirt ?? defaultShirt(guest.seat) }
        : this.look;
    // My speech bubble comes from the snapshot (the host decides it, ~100 ms after the key).
    // My flashlight comes from the prediction too (S3-01), so it turns and switches at once.
    const me = mine
      ? {
          id: this.localId,
          ...mine,
          hat: look.hat,
          shirt: look.shirt,
          emote: old?.emote ?? null,
          ...guest.predictor.facing(),
          baliktad: old?.bal ?? 0, // S3-04: the host decides it; from the snapshot
        }
      : old;
    this.draw([...players.filter((p) => p.id !== this.localId), ...(me ? [me] : [])], now);
    // Children: the snapshot's, except mine, which come from my prediction (instant, S2-03).
    const predicted = guest.predictor.myKids(alpha);
    const kids = guest.buffer
      .sampleKids(now)
      .filter((k) => !predicted.some((p) => p.id === k.id))
      .map((k) => ({ ...k, following: k.following ?? null }));
    this.drawKids([...kids, ...predicted], me, now, guest.buffer.latest?.kids ?? []);
    this.drawTikbalang(guest.buffer.sampleTikbalang(now), now, me); // S3-02
  }

  /**
   * Draws the tikbalang (S3-02) at this position (engine units), or hides it (outside the round).
   * Sorted by height among the players, so the darkness covers it unless a light is on it; its
   * eye glints above the darkness while it stalks or chases.
   */
  private drawTikbalang(
    t: SnapshotTikbalang | undefined,
    now: number,
    me?: { readonly x: number; readonly y: number },
  ): void {
    this.tikSprite.setVisible(!!t);
    this.warn(t, me, now); // S3-05: hoofbeats and the ring
    if (!t) {
      this.tikEye.setVisible(false);
      return;
    }
    const x = Math.round(toPx(t.x));
    const y = Math.round(toPx(t.y) + 4);
    this.tikSprite.setPosition(x, y).setDepth(DEPTH.player + y / 10_000);
    this.animate(this.tikSprite, { id: "tikbalang", x: t.x, y: t.y }, "tikbalang-walk", 0, now);
    this.tikSprite.setFlipX(t.faceX < 0); // the sheet faces right
    const hunting = t.mode === "stalk" || t.mode === "chase";
    this.tikEye
      .setVisible(hunting)
      .setPosition(x, y)
      .setFrame(this.tikSprite.frame.name)
      .setFlipX(t.faceX < 0);
  }

  /** The lobby closed ("Start walking"): from now on my keys move my tanod. */
  enableControls(): void {
    this.input.keyboard?.resetKeys(); // forget anything pressed while the menu was open
    this.controlsOn = true;
  }

  /** My keys this frame, plus my picked look (the engine only applies it in the lobby). */
  private readInput(): PlayerInput {
    const look = this.look;
    if (!this.controlsOn) return { up: false, down: false, left: false, right: false, ...look };
    const k = this.keys;
    const keys = {
      up: k.W.isDown || k.UP.isDown,
      down: k.S.isDown || k.DOWN.isDown,
      left: k.A.isDown || k.LEFT.isDown,
      right: k.D.isDown || k.RIGHT.isDown,
      call: k.E.isDown, // S2-03: call the nearest lost child
      light: k.SPACE.isDown, // S3-01: the flashlight
      // S3-04: baliktad while Q is held, or for a moment after a quick tap.
      baliktad: k.Q.isDown || performance.now() < this.baliktadUntil,
      ...look,
    };
    // S2-06: the emote key, while it's held or for EMOTE_HOLD_MS after it was pressed.
    const held = this.emoteKey;
    const numbers = [k.ONE, k.TWO, k.THREE, k.FOUR];
    if (held && (performance.now() < held.until || numbers[held.emote]?.isDown)) {
      return { ...keys, emote: held.emote };
    }
    this.emoteKey = undefined;
    return keys;
  }

  /**
   * Tells the page about the lobby when something it shows has changed: the phase (lobby /
   * round) or the whole seconds left on the countdown. The host reads its own engine; a guest
   * reads the newest snapshot (a host from before S2-01 sends no phase: treated as the lobby).
   */
  private reportLobby(): void {
    const latest = this.guest?.buffer.latest;
    if (this.guest && !latest) return; // a guest before the first snapshot: nothing to say yet
    const phase = this.guest ? (latest?.phase ?? "lobby") : this.state.phase;
    const ticks = this.guest ? latest?.countdown : this.state.countdown;
    const seconds =
      ticks === undefined || ticks === null ? null : Math.ceil((ticks * TICK_MS) / 1000);
    const shown = this.shownLobby;
    if (phase === shown.phase && seconds === shown.seconds) return;
    // The brownout lasts through the round and its win screen; at dawn (lost) the extra darkness
    // lifts (S2-05).
    this.brownout.setVisible(phase === "round" || phase === "won");
    this.shownLobby = { phase, seconds };
    this.onLobby?.(phase, seconds);
  }

  /**
   * Redraws the brownout's darkness (S3-01) for the current phase: the map's fixed lights and safe
   * zones, plus this frame's tanod glows and flashlight beams (collected by draw()).
   */
  private drawDarkness(): void {
    const phase = this.guest ? (this.guest.buffer.latest?.phase ?? "lobby") : this.state.phase;
    const px = TILE_SIZE_PX;
    const areas = this.safeZones.map((z) => ({
      x: z.tileX * px,
      y: z.tileY * px,
      width: z.width * px,
      height: z.height * px,
    }));
    this.darkness.draw(
      this.cameras.main,
      DARKNESS[phase],
      [...this.mapGlows, ...this.tanodGlows],
      this.beams,
      areas,
    );
  }

  /**
   * Hoofbeats and the warning ring (S3-05) for a tikbalang at `t`, heard from my tanod at `me`.
   * A hoofbeat plays every `intervalMs`; the ring is a thick red arc on a circle around the screen
   * centre, pointing toward the tikbalang, as strong as it is near (hoofbeats.ts).
   */
  private warn(
    t: SnapshotTikbalang | undefined,
    me: { readonly x: number; readonly y: number } | undefined,
    now: number,
  ): void {
    this.ring.clear();
    if (!t || !me) return;
    const dx = t.x - me.x;
    const dy = t.y - me.y;
    const w = warning(Math.sqrt(dx * dx + dy * dy) / UNITS_PER_TILE, t.mode);
    if (!w) return;
    if (now - this.lastHoof >= w.intervalMs) {
      playHoof(w.volume);
      this.lastHoof = now;
    }
    // The arc pulses with the hooves: brightest right after a beat.
    const pulse = 1 - Math.min(1, (now - this.lastHoof) / w.intervalMs) * 0.5;
    const { width, height } = this.scale;
    const angle = Math.atan2(dy, dx);
    this.ring
      .lineStyle(4, 0xb0302a, Math.min(1, 0.2 + w.ring * 0.8) * pulse)
      .beginPath()
      .arc(width / 2, height / 2, Math.min(width, height) * 0.46, angle - 0.4, angle + 0.4)
      .strokePath();
  }

  /**
   * The round's counter (S2-04): which children are home, read from my engine (host) or the newest
   * snapshot (guest). A child who wasn't home last frame fires the scene event "kid_home" with
   * their name (the page plays a sound and says so); the very first read only records who's home,
   * so joining mid-round doesn't chime for children brought home before I arrived.
   */
  private reportRound(): void {
    const latest = this.guest?.buffer.latest;
    if (this.guest && !latest) return;
    const phase = this.guest ? (latest?.phase ?? "lobby") : this.state.phase;
    const home = this.guest ? (latest?.home ?? []) : this.state.home;
    const lost = this.guest ? (latest?.kids?.length ?? 0) : this.state.kids.length;
    const dawn = this.guest ? (latest?.dawn ?? 0) : this.state.dawn;
    const timesLost = this.guest ? (latest?.timesLost ?? 0) : this.state.timesLost;
    // My battery (S3-01): the host's engine, or my copy in the newest snapshot.
    const mine = latest?.players.find((p) => p.id === this.localId);
    const engineMe = this.find(this.state, this.localId);
    const battery = this.guest
      ? (mine?.battery ?? BATTERY_MAX)
      : (engineMe?.battery ?? BATTERY_MAX);
    // S3-04: ticks until my baliktad is ready.
    const cooldown = this.guest ? (mine?.cool ?? 0) : (engineMe?.baliktadCooldown ?? 0);

    // The counter first, so a "kid_home" listener already sees the new numbers. The score is the
    // engine's own formula, so host and guests show the same number.
    const info: RoundInfo = {
      phase,
      home: home.length,
      total: home.length + lost,
      secondsLeft: secondsLeft(dawn),
      timesLost,
      score: teamScore({ saved: home.length, dawn, timesLost }),
      battery: Math.ceil((battery / BATTERY_MAX) * 100),
      baliktadIn: Math.ceil((cooldown * TICK_MS) / 1000),
    };
    const text = JSON.stringify(info);
    if (text !== this.shownRound) {
      this.shownRound = text;
      this.onRound?.(info);
    }

    if (this.knownHome) {
      for (const id of home) {
        if (!this.knownHome.has(id)) this.events.emit("kid_home", KID_NAMES[kidRow(id)], info);
      }
    }
    this.knownHome = new Set(home);

    // S3-03: a new catch → "naligaw" (who, and whether it's me). The first read only records it.
    const caught = this.guest ? latest?.caught : (this.state.lastCaught ?? undefined);
    const caughtTick = caught?.tick ?? null;
    if (this.knownCaught !== undefined && caught && caughtTick !== this.knownCaught) {
      this.events.emit("naligaw", caught.player, caught.player === this.localId);
      if (caught.player === this.localId) this.cameras.main.shake(400, 0.01);
    }
    this.knownCaught = caughtTick;
  }

  /**
   * Draws these players (positions in engine units, possibly fractional) and nobody else: adds
   * sprites for newcomers, removes sprites of players who are gone, and walks or idles each one.
   * Both modes end here, so host and guests draw players exactly the same way.
   */
  private draw(players: readonly DrawnPlayer[], now: number): void {
    const ids = new Set(players.map((p) => p.id));
    this.tanodGlows = [];
    this.beams = [];
    for (const [id, sprite] of this.sprites) {
      if (ids.has(id)) continue;
      sprite.destroy();
      this.sprites.delete(id);
      this.motion.delete(id);
      this.bubbles.get(id)?.destroy();
      this.bubbles.delete(id);
    }

    for (const p of players) {
      const sprite = this.sprites.get(p.id) ?? this.addSprite(p.id);
      // Which spritesheet row: their hat + shirt (a host from before S2-01 sends none: seat shirt).
      const row = lookRow(p.hat ?? 0, p.shirt ?? defaultShirt(seatOf(p.id)));
      // The collision box centre is the "feet" position; draw the sprite standing on it.
      const x = toPx(p.x);
      const y = toPx(p.y) + 4;
      sprite.setPosition(Math.round(x), Math.round(y));
      // Lower on screen = nearer the viewer: draw players further down in front of the others.
      sprite.setDepth(DEPTH.player + y / 10_000);

      this.animate(sprite, p, walkKey(row), row * WALK_FRAMES, now);
      // S3-04: in baliktad, faded and pale (the shirt's inside showing), for everyone to see.
      if (inBaliktad(p)) sprite.setAlpha(0.55).setTint(0xc8d0ff);
      else sprite.setAlpha(1).clearTint();
      this.drawBubble(p.id, emoteText(p.emote), Math.round(x), Math.round(y) - 30);

      // S3-01: a small glow around every tanod, and their flashlight cone while it's on. The
      // cone starts at their chest (12 px above the feet) and points the way they face.
      this.tanodGlows.push({ x, y: y - 10, size: TANOD_GLOW });
      if (p.light) {
        const { faceX, faceY } =
          "faceX" in p && p.faceX !== undefined
            ? { faceX: p.faceX, faceY: p.faceY ?? 1 }
            : unpackFace("face" in p ? p.face : undefined);
        this.beams.push({ x, y: y - 12, angle: Math.atan2(faceY, faceX) });
      }
    }
  }

  /**
   * The speech bubble over a player (S2-06): `text` at (x, y) in world pixels (just above their
   * head), or hidden when `text` is undefined. Drawn above the night tint, like the call hint, so
   * it can be read in the dark.
   */
  private drawBubble(id: string, text: string | undefined, x: number, y: number): void {
    let bubble = this.bubbles.get(id);
    if (!text) {
      bubble?.setVisible(false);
      return;
    }
    if (!bubble) {
      bubble = this.add
        .text(0, 0, "", pixelTextStyle(INK.night, INK.parchment)) // dark on paper, like a sign
        .setOrigin(0, 1) // bottom-left; placeCentred() centres it on whole pixels
        .setDepth(DEPTH.glow + 2);
      this.bubbles.set(id, bubble);
    }
    placeCentred(bubble.setText(text), x, y).setVisible(true);
  }

  /**
   * Walking or standing, and which way to face, from how far `thing` (a player or a child) moved
   * since the last frame. Works the same for everyone, including players whose keys I never see.
   */
  private animate(
    sprite: Phaser.GameObjects.Sprite,
    thing: { readonly id: string; readonly x: number; readonly y: number },
    walk: string,
    standFrame: number,
    now: number,
  ): void {
    const last = this.motion.get(thing.id);
    const dx = last ? thing.x - last.x : 0;
    const moved = !!last && (dx !== 0 || thing.y !== last.y);
    const movedAt = moved ? now : (last?.movedAt ?? -Infinity);
    this.motion.set(thing.id, { x: thing.x, y: thing.y, movedAt });
    if (dx !== 0) sprite.setFlipX(dx < 0);
    if (now - movedAt < WALK_HOLD_MS) {
      sprite.anims.play(walk, true); // `true`: keep going if it's already playing
    } else {
      sprite.anims.stop();
      sprite.setFrame(standFrame); // standing (also right after a look change)
    }
  }

  /**
   * Draws the lost children (S2-02) at these positions (engine units), and nobody else: adds a
   * sprite for each new child, removes ones no longer listed, walks or idles each one (S2-03).
   * Also places the call hint over the nearest lost child within reach of `me`, and emits the
   * scene event "escort" (with the child's name) when a child starts following me according to
   * `confirmed` (the host's own state, or a guest's newest snapshot: not a prediction, which
   * can be wrong if someone else grabbed the same child first).
   */
  private drawKids(
    kids: readonly KidState[],
    me: { readonly x: number; readonly y: number } | undefined,
    now: number,
    confirmed: readonly { readonly id: string; readonly following?: string | null }[] = kids,
  ): void {
    const ids = new Set(kids.map((k) => k.id));
    for (const [id, sprite] of this.kidSprites) {
      if (ids.has(id)) continue;
      sprite.destroy();
      this.kidSprites.delete(id);
      this.motion.delete(id);
    }
    for (const kid of kids) {
      let sprite = this.kidSprites.get(kid.id);
      if (!sprite) {
        // Origin bottom-centre (feet), standing frame of their row.
        sprite = this.add.sprite(0, 0, "kids", kidRow(kid.id) * WALK_FRAMES).setOrigin(0.5, 1);
        this.kidSprites.set(kid.id, sprite);
      }
      const x = toPx(kid.x);
      const y = toPx(kid.y) + 4;
      sprite.setPosition(Math.round(x), Math.round(y));
      // Sorted by height on screen together with the players (same depth band).
      sprite.setDepth(DEPTH.player + y / 10_000);
      const row = kidRow(kid.id);
      this.animate(sprite, kid, kidWalkKey(row), row * WALK_FRAMES, now);
    }

    // The hint: the nearest lost child within CALL_RANGE of me (the same test the engine uses).
    const lost = me
      ? kids
          .filter((k) => k.following === null)
          .map((k) => ({ k, d: (k.x - me.x) ** 2 + (k.y - me.y) ** 2 }))
          .filter(({ d }) => d <= CALL_RANGE * CALL_RANGE)
          .sort((a, b) => a.d - b.d)[0]?.k
      : undefined;
    this.callHint.setVisible(!!lost && this.controlsOn);
    if (lost) {
      this.callHint.setText(`${KID_NAMES[kidRow(lost.id)]} [E]`); // ASCII: see pixelText.ts
      placeCentred(this.callHint, toPx(lost.x), toPx(lost.y) - 22);
    }

    // Their houses: a label over the doorway of each child following me (as drawn: on a guest
    // that includes a call I've only predicted so far, so the label shows up at once).
    this.drawHouseLabels(kids.filter((k) => k.following === this.localId).map((k) => k.id));

    // A child newly following me → tell the page (it shows "Tala is following you").
    const mine = new Set(confirmed.filter((k) => k.following === this.localId).map((k) => k.id));
    for (const id of mine) {
      if (!this.myEscort.has(id)) this.events.emit("escort", KID_NAMES[kidRow(id)]);
    }
    this.myEscort = mine;
  }

  /**
   * "Tala's house" over the doorway of each of these children (S2-04). If the doorway is off screen,
   * the label is pinned to the screen's edge in its direction, with an arrow pointing that way,
   * so I always know which way to lead them. Labels of children no longer listed are removed.
   */
  private drawHouseLabels(ids: readonly string[]): void {
    for (const [id, label] of this.houseLabels) {
      if (ids.includes(id)) continue;
      label.destroy();
      this.houseLabels.delete(id);
    }
    const view = this.cameras.main.worldView; // the part of the world on screen, in pixels
    // Keep clear of the room badge and the counter along the top (page elements over the canvas).
    const margin = 6;
    const topBar = 16;
    for (const id of ids) {
      const door = kidHome(this.homes, id);
      if (!door) continue;
      let label = this.houseLabels.get(id);
      if (!label) {
        label = this.add
          .text(0, 0, "", pixelTextStyle(INK.parchment, INK.night))
          .setOrigin(0, 1) // bottom-left; placeCentred() centres it on whole pixels
          .setDepth(DEPTH.glow + 1);
        this.houseLabels.set(id, label);
      }
      // The doorway's centre in pixels; the label sits just above it (on the house's wall).
      const x = (door.tileX + 0.5) * TILE_SIZE_PX;
      const y = door.tileY * TILE_SIZE_PX - 2;
      // Which way(s) the doorway is off screen: that's the arrow ("<" = to the left, …).
      const left = view.x + margin;
      const right = view.right - margin;
      const top = view.y + margin + topBar + 12; // + 12: the label hangs above its point
      const bottom = view.bottom - margin;
      const arrow =
        (y < top ? "^" : y > bottom ? "v" : "") + (x < left ? "<" : x > right ? ">" : ""); // ASCII
      const name = KID_NAMES[kidRow(id)];
      label.setText(arrow ? `${arrow} ${name}'s house` : `${name}'s house`);
      // Then pin it inside the visible area, using its real width so no letter is cut off.
      const half = label.width / 2;
      const px = Phaser.Math.Clamp(x, left + half, right - half);
      const py = Phaser.Math.Clamp(y, top, bottom);
      placeCentred(label, px, py);
    }
  }

  /** Makes a sprite for a player; the camera follows it if it's mine. draw() sets its look. */
  private addSprite(id: string): Phaser.GameObjects.Sprite {
    // Origin (0.5, 1) = bottom-centre, so (x, y) is where the feet are.
    const sprite = this.add.sprite(0, 0, "tanod", 0).setOrigin(0.5, 1).setDepth(DEPTH.player);
    this.sprites.set(id, sprite);
    if (id === this.localId) this.cameras.main.startFollow(sprite, true);
    return sprite;
  }

  private find(state: GameState, id: string): PlayerState | undefined {
    return state.players.find((p) => p.id === id);
  }
}

/** The walk animation's name for a spritesheet row (one per look). */
function walkKey(row: number): string {
  return `tanod-walk-${row}`;
}

/** The walk animation's name for a child's spritesheet row. */
function kidWalkKey(row: number): string {
  return `kid-walk-${row}`;
}
