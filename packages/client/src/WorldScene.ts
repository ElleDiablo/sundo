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
 * Draw order (depth), bottom to top:
 *   0 ground · 1 decor · 2 objects (walls, trunks, fences) · 10 players
 *   20 above (roofs, canopies, bamboo tops: they hide players who walk behind them)
 *   30 night tint · 31 warm glows from doorways and windows
 */
import Phaser from "phaser";
import {
  addPlayer,
  createGame,
  removePlayer,
  startRound,
  findTiledPoint,
  mapFromTiled,
  step,
  TICK_MS,
  TILE_SIZE_PX,
  UNITS_PER_TILE,
  type GameState,
  type Phase,
  type PlayerInput,
  type PlayerState,
  type TiledMap,
  type TileMap,
} from "@sundo/engine";
import type { InputFields, SnapshotFields, SnapshotPlayer } from "@sundo/server/messages";
import { advance, createFixedStep, type FixedStep } from "./fixedStep.ts";
import { InputSender } from "./inputSender.ts";
import { SnapshotBuffer, TICKS_PER_SNAPSHOT } from "./interpolation.ts";
import { defaultShirt, HATS, lookRow, SHIRTS, WALK_FRAMES } from "./looks.ts";
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

/** Moonlit night: every colour is multiplied by this (lighting proper comes in S3-01). */
const NIGHT_TINT = 0x9ea8d9;
/**
 * Brownout (the round has started): a second multiply layer over the night one, making the world
 * ~30 % darker (measured on the plaza: 76,80,94 → 52,56,72) so the candles and doorways stand out
 * more. A separate layer switched on and off, so going back to the lobby later is one line.
 */
const BROWNOUT_TINT = 0xb0b4c4;

const DEPTH = { ground: 0, decor: 1, objects: 2, player: 10, above: 20, night: 30, glow: 31 };

/** Keep the walk animation going this long after a player last moved, so it doesn't flicker. */
const WALK_HOLD_MS = 120;

type Keys = Record<
  "W" | "A" | "S" | "D" | "UP" | "DOWN" | "LEFT" | "RIGHT",
  Phaser.Input.Keyboard.Key
>;

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
  /** Where each sprite was last drawn (units) and when it last moved: drives walking and facing. */
  private motion = new Map<string, { x: number; y: number; movedAt: number }>();
  private glows: Phaser.GameObjects.Image[] = [];
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
    this.state = createGame(this.map, [{ id: this.localId, ...this.spawn, ...this.look }]);
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

    // 5. Camera: never show outside the map. (It follows my player: see addSprite.)
    this.cameras.main.setBounds(0, 0, map.widthInPixels, map.heightInPixels);

    // 6. Keyboard: WASD and the arrow keys.
    const keyboard = this.input.keyboard;
    if (!keyboard) throw new Error("no keyboard input available");
    this.keys = keyboard.addKeys("W,A,S,D,UP,DOWN,LEFT,RIGHT") as Keys;

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

  /** Phaser calls this every screen frame; `delta` is the real time since the last frame in ms. */
  override update(time: number, delta: number): void {
    const now = performance.now();
    if (this.guest) this.updateGuest(this.guest, delta, now);
    else this.updateHost(delta, now);
    this.reportLobby();
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
      players: this.state.players.map(({ id, x, y, hat, shirt }) => ({ id, x, y, hat, shirt })),
      acks,
      ackTicks,
      phase, // S2-01: lobby or round, so guests can show the picker or the brownout
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
    const me = mine ? { id: this.localId, ...mine, hat: look.hat, shirt: look.shirt } : old;
    this.draw([...players.filter((p) => p.id !== this.localId), ...(me ? [me] : [])], now);
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
    return {
      up: k.W.isDown || k.UP.isDown,
      down: k.S.isDown || k.DOWN.isDown,
      left: k.A.isDown || k.LEFT.isDown,
      right: k.D.isDown || k.RIGHT.isDown,
      ...look,
    };
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
    this.brownout.setVisible(phase === "round");
    this.shownLobby = { phase, seconds };
    this.onLobby?.(phase, seconds);
  }

  /**
   * Draws these players (positions in engine units, possibly fractional) and nobody else: adds
   * sprites for newcomers, removes sprites of players who are gone, and walks or idles each one.
   * Both modes end here, so host and guests draw players exactly the same way.
   */
  private draw(players: readonly SnapshotPlayer[], now: number): void {
    const ids = new Set(players.map((p) => p.id));
    for (const [id, sprite] of this.sprites) {
      if (ids.has(id)) continue;
      sprite.destroy();
      this.sprites.delete(id);
      this.motion.delete(id);
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

      // Walking or standing, and which way to face, from how far they moved since the last frame.
      // This works the same for my player and for players whose keys I never see.
      const last = this.motion.get(p.id);
      const dx = last ? p.x - last.x : 0;
      const moved = !!last && (dx !== 0 || p.y !== last.y);
      const movedAt = moved ? now : (last?.movedAt ?? -Infinity);
      this.motion.set(p.id, { x: p.x, y: p.y, movedAt });
      if (dx !== 0) sprite.setFlipX(dx < 0);
      if (now - movedAt < WALK_HOLD_MS) {
        sprite.anims.play(walkKey(row), true); // `true`: keep going if it's already playing
      } else {
        sprite.anims.stop();
        sprite.setFrame(row * WALK_FRAMES); // standing, in their look (also after a look change)
      }
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
