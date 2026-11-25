/**
 * The game world: draws the Tiled map, reads the keyboard, runs the engine, follows the player.
 *
 * Division of work (ADR-0004): the ENGINE decides where everyone is; this scene only turns keys
 * into inputs and draws the engine's state. There is no movement or collision code in here.
 *
 * Players are named by seat: "p0" is the host, "p1"–"p3" are friends who joined (S1-04).
 * For now each browser runs its own world: the host sees friends appear at the spawn, standing
 * still. Sending their movement across the network is S1-05.
 *
 * Draw order (depth), bottom to top:
 *   0 ground · 1 decor · 2 objects (walls, trunks, fences) · 10 players
 *   20 above (roofs, canopies, bamboo tops: they hide players who walk behind them)
 *   30 night tint · 31 warm glows from doorways and windows
 */
import Phaser from "phaser";
import {
  addPlayer,
  createGame,
  findTiledPoint,
  mapFromTiled,
  step,
  TICK_MS,
  TILE_SIZE_PX,
  UNITS_PER_TILE,
  type GameState,
  type MoveInput,
  type PlayerState,
  type TiledMap,
} from "@sundo/engine";
import { advance, createFixedStep, type FixedStep } from "./fixedStep.ts";

/** Engine units → screen pixels (1 tile = 1000 units = 16 px). */
const toPx = (units: number) => (units / UNITS_PER_TILE) * TILE_SIZE_PX;

/** The player id for a seat: seat 0 (the host) is "p0", and so on. */
export const playerId = (seat: number) => `p${seat}`;

/**
 * A colour per seat so players can tell each other apart until each has their own outfit
 * (ART-03). Multiplied over the sprite: white = unchanged.
 */
const SEAT_TINTS = [0xffffff, 0xa8d4ff, 0xffb8a8, 0xbff0a8];

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
  private spawn!: { tileX: number; tileY: number }; // the map's "player" spawn point
  /** Which player this browser controls. Starts as the host; a guest becomes their seat. */
  private localId = playerId(0);
  /** One sprite per player id. */
  private sprites = new Map<string, Phaser.GameObjects.Sprite>();
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
    this.spawn = findTiledPoint(tiled, "spawns", "player");
    this.state = createGame(mapFromTiled(tiled), [{ id: this.localId, ...this.spawn }]);
    this.previous = this.state;
    this.clock = createFixedStep(TICK_MS);

    // 3. The walk animation shared by every player sprite (my tanod, 4 frames, 8 per second).
    this.anims.create({
      key: "tanod-walk",
      frames: this.anims.generateFrameNumbers("tanod", { start: 0, end: 3 }),
      frameRate: 8,
      repeat: -1,
    });
    this.syncSprites();
    this.drawPlayers(1);

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

    // 5. Camera: never show outside the map; follow whoever this browser controls.
    this.cameras.main.setBounds(0, 0, map.widthInPixels, map.heightInPixels);
    this.followLocal();

    // 6. Keyboard: WASD and the arrow keys.
    const keyboard = this.input.keyboard;
    if (!keyboard) throw new Error("no keyboard input available");
    this.keys = keyboard.addKeys("W,A,S,D,UP,DOWN,LEFT,RIGHT") as Keys;
  }

  /**
   * A guest joined my room (I'm the host): add them to my world at the spawn.
   * They stand still for now; their movement arrives in S1-05.
   */
  addRemotePlayer(seat: number): void {
    this.state = addPlayer(this.state, { id: playerId(seat), ...this.spawn });
    this.previous = this.state;
    this.syncSprites();
    this.drawPlayers(1);
  }

  /**
   * I joined someone else's room in this seat: from now on this browser controls that player.
   * (My own world is rebuilt around the new id; showing the host's world is S1-05.)
   */
  becomeSeat(seat: number): void {
    this.localId = playerId(seat);
    this.state = createGame(this.state.map, [{ id: this.localId, ...this.spawn }]);
    this.previous = this.state;
    this.syncSprites();
    this.followLocal();
    this.drawPlayers(1);
  }

  /** Phaser calls this every screen frame; `delta` is the real time since the last frame in ms. */
  override update(time: number, delta: number): void {
    const { ticks, alpha } = advance(this.clock, delta);
    const input = this.readInput();
    for (let i = 0; i < ticks; i++) {
      this.previous = this.state;
      // Only my own player gets keys; everyone else stands still until S1-05.
      this.state = step(this.state, { [this.localId]: input }).state;
    }
    this.drawPlayers(alpha);
    this.animatePlayers(input);
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

  /** Makes sure there is exactly one sprite per player in the engine's state. */
  private syncSprites(): void {
    const ids = new Set(this.state.players.map((p) => p.id));
    for (const [id, sprite] of this.sprites) {
      if (!ids.has(id)) {
        sprite.destroy();
        this.sprites.delete(id);
      }
    }
    for (const p of this.state.players) {
      if (this.sprites.has(p.id)) continue;
      const seat = Number(p.id.slice(1)) || 0;
      // Origin (0.5, 1) = bottom-centre, so (x, y) is where the feet are.
      const sprite = this.add
        .sprite(0, 0, "tanod", 0)
        .setOrigin(0.5, 1)
        .setDepth(DEPTH.player)
        .setTint(SEAT_TINTS[seat % SEAT_TINTS.length] ?? 0xffffff);
      this.sprites.set(p.id, sprite);
    }
  }

  /** Points the camera at the player this browser controls. */
  private followLocal(): void {
    const me = this.sprites.get(this.localId);
    if (me) this.cameras.main.startFollow(me, true);
  }

  /** Draws every player part-way between the last two ticks (alpha 0 = previous, 1 = current). */
  private drawPlayers(alpha: number): void {
    for (const now of this.state.players) {
      const sprite = this.sprites.get(now.id);
      if (!sprite) continue;
      const before = this.find(this.previous, now.id) ?? now;
      // The collision box centre is the "feet" position; draw the sprite standing on it.
      const x = toPx(before.x + (now.x - before.x) * alpha);
      const y = toPx(before.y + (now.y - before.y) * alpha) + 4;
      sprite.setPosition(Math.round(x), Math.round(y));
      // Lower on screen = nearer the viewer: draw players further down in front of the others.
      sprite.setDepth(DEPTH.player + y / 10_000);
    }
  }

  /** Walks a sprite while its player actually moved this tick; my sprite faces the keys I hold. */
  private animatePlayers(input: MoveInput): void {
    for (const now of this.state.players) {
      const sprite = this.sprites.get(now.id);
      const before = this.find(this.previous, now.id);
      if (!sprite) continue;
      const moving = !!before && (now.x !== before.x || now.y !== before.y);
      if (moving) sprite.anims.play("tanod-walk", true);
      else {
        sprite.anims.stop();
        sprite.setFrame(0);
      }
      if (now.id === this.localId && input.left !== input.right) sprite.setFlipX(input.left);
    }
  }

  private find(state: GameState, id: string): PlayerState | undefined {
    return state.players.find((p) => p.id === id);
  }
}
