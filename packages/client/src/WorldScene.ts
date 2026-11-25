/**
 * The game world: draws the Tiled map, reads the keyboard, runs the engine, follows the player.
 *
 * Division of work (ADR-0004): the ENGINE decides where everyone is; this scene only turns keys
 * into inputs and draws the engine's state. There is no movement or collision code in here.
 *
 * Draw order (depth), bottom to top:
 *   0 ground · 1 decor · 2 objects (walls, trunks, fences) · 10 player
 *   20 above (roofs, canopies, bamboo tops: they hide the player when he walks behind them)
 *   30 night tint · 31 warm glows from doorways and windows
 */
import Phaser from "phaser";
import {
  createGame,
  findTiledPoint,
  mapFromTiled,
  step,
  TICK_MS,
  TILE_SIZE_PX,
  UNITS_PER_TILE,
  type GameState,
  type MoveInput,
  type TiledMap,
} from "@sundo/engine";
import { advance, createFixedStep, type FixedStep } from "./fixedStep.ts";

const PLAYER_ID = "me";
/** Engine units → screen pixels (1 tile = 1000 units = 16 px). */
const toPx = (units: number) => (units / UNITS_PER_TILE) * TILE_SIZE_PX;

/** Moonlit night: every colour is multiplied by this (lighting proper comes in S3-01). */
const NIGHT_TINT = 0x9ea8d9;

const DEPTH = { ground: 0, decor: 1, objects: 2, player: 10, above: 20, night: 30, glow: 31 };

type Keys = Record<
  "W" | "A" | "S" | "D" | "UP" | "DOWN" | "LEFT" | "RIGHT",
  Phaser.Input.Keyboard.Key
>;

export class WorldScene extends Phaser.Scene {
  private state!: GameState; // the engine's current state
  private previous!: GameState; // the state one tick ago, for smooth drawing between ticks
  private clock!: FixedStep;
  private keys!: Keys;
  private player!: Phaser.GameObjects.Sprite;
  private glows: Phaser.GameObjects.Image[] = [];

  constructor() {
    super("world");
  }

  preload(): void {
    // Paths are relative to index.html, so the game works at any URL (localhost or CloudFront).
    this.load.tilemapTiledJSON("barangay", "assets/maps/barangay.tmj");
    this.load.image("barangay-tiles", "assets/tiles/barangay.png");
    // 4 frames of 16 × 28 px side by side: stand, left step, stand (dip), right step.
    this.load.spritesheet("tanod", "assets/sprites/tanod.png", { frameWidth: 16, frameHeight: 28 });
    this.load.image("glow", "assets/sprites/glow.png");
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
    const spawn = findTiledPoint(tiled, "spawns", "player");
    this.state = createGame(mapFromTiled(tiled), [{ id: PLAYER_ID, ...spawn }]);
    this.previous = this.state;
    this.clock = createFixedStep(TICK_MS);

    // 3. The player: my tanod sprite with a 4-frame walk.
    //    Origin (0.5, 1) = bottom-centre, so (x, y) is where the feet are.
    this.anims.create({
      key: "tanod-walk",
      frames: this.anims.generateFrameNumbers("tanod", { start: 0, end: 3 }),
      frameRate: 8,
      repeat: -1,
    });
    this.player = this.add.sprite(0, 0, "tanod", 0).setOrigin(0.5, 1).setDepth(DEPTH.player);
    this.drawPlayer(1);

    // 4. Night: multiply the whole screen by a cool moonlight colour, then add warm glows on top
    //    where the map's "lights" layer has a point (doorways, windows, the store's candle).
    const { width, height } = this.scale;
    this.add
      .rectangle(0, 0, width, height, NIGHT_TINT)
      .setOrigin(0)
      .setScrollFactor(0) // stays put while the camera moves
      .setDepth(DEPTH.night)
      .setBlendMode(Phaser.BlendModes.MULTIPLY);
    for (const light of map.getObjectLayer("lights")?.objects ?? []) {
      this.glows.push(
        this.add
          .image(light.x ?? 0, light.y ?? 0, "glow")
          .setDepth(DEPTH.glow)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setScale(light.name === "window" ? 0.6 : 1)
          .setAlpha(0.45),
      );
    }

    // 5. Camera: follow the player, never show outside the map.
    this.cameras.main.setBounds(0, 0, map.widthInPixels, map.heightInPixels);
    this.cameras.main.startFollow(this.player, true);

    // 6. Keyboard: WASD and the arrow keys.
    const keyboard = this.input.keyboard;
    if (!keyboard) throw new Error("no keyboard input available");
    this.keys = keyboard.addKeys("W,A,S,D,UP,DOWN,LEFT,RIGHT") as Keys;
  }

  /** Phaser calls this every screen frame; `delta` is the real time since the last frame in ms. */
  override update(time: number, delta: number): void {
    const { ticks, alpha } = advance(this.clock, delta);
    const input = this.readInput();
    for (let i = 0; i < ticks; i++) {
      this.previous = this.state;
      this.state = step(this.state, { [PLAYER_ID]: input }).state;
    }
    this.drawPlayer(alpha);
    this.animatePlayer(input);
    // Candles flicker a little (each one slightly out of step with the others).
    this.glows.forEach((g, i) => g.setAlpha(0.42 + 0.05 * Math.sin(time * 0.009 + i * 1.7)));
  }

  private readInput(): MoveInput {
    const k = this.keys;
    return {
      up: k.W.isDown || k.UP.isDown,
      down: k.S.isDown || k.DOWN.isDown,
      left: k.A.isDown || k.LEFT.isDown,
      right: k.D.isDown || k.RIGHT.isDown,
    };
  }

  /** Draws the player part-way between the last two ticks (alpha 0 = previous, 1 = current). */
  private drawPlayer(alpha: number): void {
    const now = this.state.players.find((p) => p.id === PLAYER_ID);
    const before = this.previous.players.find((p) => p.id === PLAYER_ID) ?? now;
    if (!now || !before) return;
    // The collision box centre is the "feet" position; draw the sprite standing on it.
    const x = toPx(before.x + (now.x - before.x) * alpha);
    const y = toPx(before.y + (now.y - before.y) * alpha) + 4;
    this.player.setPosition(Math.round(x), Math.round(y));
  }

  /** Walk while the engine actually moved me (walls stop the animation too); face left or right. */
  private animatePlayer(input: MoveInput): void {
    const now = this.state.players.find((p) => p.id === PLAYER_ID);
    const before = this.previous.players.find((p) => p.id === PLAYER_ID);
    const moving = !!now && !!before && (now.x !== before.x || now.y !== before.y);
    if (moving) this.player.anims.play("tanod-walk", true);
    else {
      this.player.anims.stop();
      this.player.setFrame(0);
    }
    if (input.left !== input.right) this.player.setFlipX(input.left);
  }
}
