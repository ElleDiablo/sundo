/**
 * The game world: draws the Tiled map, reads the keyboard, runs the engine, follows the player.
 *
 * Division of work (ADR-0004): the ENGINE decides where everyone is; this scene only turns keys
 * into inputs and draws the engine's state. There is no movement or collision code in here.
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

type Keys = Record<
  "W" | "A" | "S" | "D" | "UP" | "DOWN" | "LEFT" | "RIGHT",
  Phaser.Input.Keyboard.Key
>;

export class WorldScene extends Phaser.Scene {
  private state!: GameState; // the engine's current state
  private previous!: GameState; // the state one tick ago, for smooth drawing between ticks
  private clock!: FixedStep;
  private keys!: Keys;
  private player!: Phaser.GameObjects.Image;

  constructor() {
    super("world");
  }

  preload(): void {
    // Paths are relative to index.html, so the game works at any URL (localhost or CloudFront).
    this.load.tilemapTiledJSON("barangay", "assets/maps/barangay.tmj");
    this.load.image("placeholder-tiles", "assets/tiles/placeholder.png");
    this.load.image("tanod", "assets/sprites/tanod.png");
  }

  create(): void {
    // 1. Draw the map. Layer names must match the layer names in Tiled.
    const map = this.make.tilemap({ key: "barangay" });
    const tiles = map.addTilesetImage("placeholder", "placeholder-tiles");
    if (!tiles) throw new Error('tileset "placeholder" missing from barangay.tmj');
    map.createLayer("ground", tiles);
    map.createLayer("objects", tiles);

    // 2. Give the SAME file to the engine, which only cares which tiles are walls.
    const tiled = this.cache.tilemap.get("barangay").data as TiledMap;
    const spawn = findTiledPoint(tiled, "spawns", "player");
    this.state = createGame(mapFromTiled(tiled), [{ id: PLAYER_ID, ...spawn }]);
    this.previous = this.state;
    this.clock = createFixedStep(TICK_MS);

    // 3. The player sprite. Origin (0.5, 1) = bottom-centre, so (x, y) is where the feet are.
    this.player = this.add.image(0, 0, "tanod").setOrigin(0.5, 1);
    this.drawPlayer(1);

    // 4. Camera: follow the player, never show outside the map.
    this.cameras.main.setBounds(0, 0, map.widthInPixels, map.heightInPixels);
    this.cameras.main.startFollow(this.player, true);

    // 5. Keyboard: WASD and the arrow keys.
    const keyboard = this.input.keyboard;
    if (!keyboard) throw new Error("no keyboard input available");
    this.keys = keyboard.addKeys("W,A,S,D,UP,DOWN,LEFT,RIGHT") as Keys;
  }

  /** Phaser calls this every screen frame; `delta` is the real time since the last frame in ms. */
  override update(_time: number, delta: number): void {
    const { ticks, alpha } = advance(this.clock, delta);
    const input = this.readInput();
    for (let i = 0; i < ticks; i++) {
      this.previous = this.state;
      this.state = step(this.state, { [PLAYER_ID]: input }).state;
    }
    this.drawPlayer(alpha);
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
}
