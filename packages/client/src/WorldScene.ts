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
 * Escorting (S2-03): holding E near a lost child makes it follow me; a hint ("Tala · E") shows
 * over the nearest one in reach. A guest predicts its own line too (Predictor gets the kids), so
 * calling and leading feel instant. The page hears about it through the scene event "escort".
 *
 * Going home (S2-04): each child lives in one of the map's 5 houses (the "home" points: k0 in the
 * first, …). While a child follows me, a label ("Tala's house") marks their doorway, pinned to the
 * edge of the screen with an arrow when the house is off screen. The engine takes a child inside
 * at their doorway; snapshots carry who is home (`home`), and `onRound` tells the page so it can
 * update the "Home 2 / 5" counter, while the scene event "kid_home" (with the name) plays the sound.
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
  startRound,
  findTiledPoint,
  findTiledPoints,
  mapFromTiled,
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
  type TiledMap,
  type TileMap,
} from "@sundo/engine";
import type { InputFields, SnapshotFields, SnapshotPlayer } from "@sundo/server/messages";
import { advance, createFixedStep, type FixedStep } from "./fixedStep.ts";
import { InputSender } from "./inputSender.ts";
import { SnapshotBuffer, TICKS_PER_SNAPSHOT } from "./interpolation.ts";
import { KID_NAMES, kidRow } from "./kids.ts";
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

/** What the page shows during a round (S2-04): how many children are home, out of how many. */
export interface RoundInfo {
  readonly phase: Phase;
  readonly home: number;
  readonly total: number;
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

const DEPTH = { ground: 0, decor: 1, objects: 2, player: 10, above: 20, night: 30, glow: 31 };

/** Keep the walk animation going this long after a player last moved, so it doesn't flicker. */
const WALK_HOLD_MS = 120;

type Keys = Record<
  "W" | "A" | "S" | "D" | "UP" | "DOWN" | "LEFT" | "RIGHT" | "E",
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
  /** One sprite per lost child, by id ("k0"…"k4"). Empty in the lobby. */
  private kidSprites = new Map<string, Phaser.GameObjects.Sprite>();
  /** "Tala · E" over the nearest lost child I can call (S2-03). Hidden when none is in reach. */
  private callHint!: Phaser.GameObjects.Text;
  /** Children following me last frame, to notice a new one (for the "escort" event). */
  private myEscort = new Set<string>();
  /** Each house's doorway (the map's "home" points, S2-04): child k<n> lives at homes[n]. */
  private homes: readonly Spot[] = [];
  /** "Tala's house" over the doorway of each child following me, by child id (S2-04). */
  private houseLabels = new Map<string, Phaser.GameObjects.Text>();
  /** Children already known to be home, to notice a new one (sound, toast). Undefined = not yet read. */
  private knownHome: Set<string> | undefined;
  /** Tells the page the round's counter; called only when something it shows changes (S2-04). */
  private onRound: OnRound | undefined;
  /** The last RoundInfo passed to onRound, as text, to call it only on a change. */
  private shownRound = "";
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
    // The lost children (S2-02): same frame size, one row per child (kids.ts), 4 walk frames.
    this.load.spritesheet("kids", "assets/sprites/kids.png", { frameWidth: 16, frameHeight: 28 });
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
    this.state = createGame(this.map, [{ id: this.localId, ...this.spawn, ...this.look }], {
      seed,
      kidSpots,
      homes: this.homes,
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

    // The call hint: tiny text, drawn above the night tint so it stays readable in the dark.
    this.callHint = this.add
      .text(0, 0, "", {
        fontFamily: "monospace",
        fontSize: "8px",
        color: "#f0a24a",
        backgroundColor: "#0b0e16cc",
        padding: { x: 2, y: 1 },
        resolution: 4, // sharper text when the canvas is scaled up
      })
      .setOrigin(0.5, 1)
      .setDepth(DEPTH.glow + 1)
      .setVisible(false);

    // 5. Camera: never show outside the map. (It follows my player: see addSprite.)
    this.cameras.main.setBounds(0, 0, map.widthInPixels, map.heightInPixels);

    // 6. Keyboard: WASD and the arrow keys.
    const keyboard = this.input.keyboard;
    if (!keyboard) throw new Error("no keyboard input available");
    this.keys = keyboard.addKeys("W,A,S,D,UP,DOWN,LEFT,RIGHT,E") as Keys; // E: call a child (S2-03)

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

  /** Phaser calls this every screen frame; `delta` is the real time since the last frame in ms. */
  override update(time: number, delta: number): void {
    const now = performance.now();
    if (this.guest) this.updateGuest(this.guest, delta, now);
    else this.updateHost(delta, now);
    this.reportLobby();
    this.reportRound();
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
      // S2-02 (empty in the lobby); `following` only for children who follow someone (S2-03).
      kids: this.state.kids.map(({ id, x, y, following }) =>
        following === null ? { id, x, y } : { id, x, y, following },
      ),
      home: this.state.home, // S2-04: who is home (the counter, and the guests' sound)
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
    // Children: the snapshot's, except mine, which come from my prediction (instant, S2-03).
    const predicted = guest.predictor.myKids(alpha);
    const kids = guest.buffer
      .sampleKids(now)
      .filter((k) => !predicted.some((p) => p.id === k.id))
      .map((k) => ({ ...k, following: k.following ?? null }));
    this.drawKids([...kids, ...predicted], me, now, guest.buffer.latest?.kids ?? []);
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
      call: k.E.isDown, // S2-03: call the nearest lost child
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

    // The counter first, so a "kid_home" listener already sees the new numbers.
    const info: RoundInfo = { phase, home: home.length, total: home.length + lost };
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

      this.animate(sprite, p, walkKey(row), row * WALK_FRAMES, now);
    }
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
      this.callHint.setText(`${KID_NAMES[kidRow(lost.id)]} · E`);
      this.callHint.setPosition(Math.round(toPx(lost.x)), Math.round(toPx(lost.y)) - 22);
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
          .text(0, 0, "", {
            fontFamily: "monospace",
            fontSize: "8px",
            color: "#ddd7c6",
            backgroundColor: "#0b0e16cc",
            padding: { x: 2, y: 1 },
            resolution: 4,
          })
          .setOrigin(0.5, 1)
          .setDepth(DEPTH.glow + 1);
        this.houseLabels.set(id, label);
      }
      // The doorway's centre in pixels; the label sits just above it (on the house's wall).
      const x = (door.tileX + 0.5) * TILE_SIZE_PX;
      const y = door.tileY * TILE_SIZE_PX - 2;
      // Pin it inside the visible area, and say which way(s) it was pushed.
      const left = view.x + margin + 30;
      const right = view.right - margin - 30;
      const top = view.y + margin + topBar + 12; // + 12: the label hangs above its point
      const bottom = view.bottom - margin;
      const px = Phaser.Math.Clamp(x, left, right);
      const py = Phaser.Math.Clamp(y, top, bottom);
      const arrow =
        (y < top ? "↑" : y > bottom ? "↓" : "") + (x < left ? "←" : x > right ? "→" : "");
      const name = KID_NAMES[kidRow(id)];
      label.setText(arrow ? `${arrow} ${name}'s house` : `${name}'s house`);
      label.setPosition(Math.round(px), Math.round(py));
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
