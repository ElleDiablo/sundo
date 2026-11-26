/**
 * Game state and the step() function (ADR-0004).
 *
 * The whole game is a loop of:   state  +  inputs  →  step()  →  new state  (+ events)
 *
 * step() is a pure function: it never changes the state it is given and never reads the clock,
 * the DOM or the network. The host browser calls it 20 times a second (every 50 ms, a "tick");
 * tests and the simulator call it as fast as they like and get identical results.
 *
 * Coordinate system (same as the screen and as Phaser):
 *
 *     (0,0) ──── x grows to the right ────►
 *       │
 *       │   y grows DOWNWARDS, so "up" (W) means y gets smaller.
 *       ▼
 *
 * Positions are in "units", not tiles: 1 tile = 1000 units (see map.ts for why).
 * Tile (2, 3) covers x = 2000…2999 and y = 3000…3999; its centre is (2500, 3500).
 */

// Bring in helpers from map.ts. `type TileMap` imports only the type (erased when the code runs).
import { isWall, tileOf, UNITS_PER_TILE, type TileMap } from "./map.ts";
import { inZone, type Zone } from "./light.ts";
import { createRng, type Rng } from "./rng.ts";
import { spawnTikbalang, updateTikbalang, type TikbalangState, type TikMode } from "./tikbalang.ts";

// ─── Tuning constants ────────────────────────────────────────────────────────────────────────
// `export` lets other files (tests, the client) import these. `const` means they never change.

// Player speed in units per tick.
// Design doc: 4 tiles per second. One tick is 1/20 s, so per tick: 4 / 20 = 0.2 tiles = 200 units.
export const PLAYER_SPEED = 200;

// Per-axis speed when moving diagonally.
// Holding W+D at full speed on both axes would travel √(200² + 200²) ≈ 283 per tick: 41% faster.
// Dividing by √2 fixes it: √(141² + 141²) ≈ 199.4, just under 200.
// Math.floor rounds DOWN, so it stays a whole number and is never faster than straight.
export const PLAYER_DIAGONAL_SPEED = Math.floor(PLAYER_SPEED / Math.SQRT2); // = 141

// Half the width of a player's square collision box: 300 units = 0.3 tiles.
// The full box is 600 × 600 units (0.6 × 0.6 tiles), centred on the player's position:
//
//     ┌──────────── one tile (1000) ────────────┐
//     │        ┌────── box (600) ──────┐        │
//     │  200   │           ● (x, y)    │  200   │   ← 200 units of slack on each side
//     │        └───────────────────────┘        │
//     └─────────────────────────────────────────┘
//
// Smaller than a tile, so walking through a 1-tile doorway doesn't need pixel-perfect aim.
export const PLAYER_HALF_SIZE = 300;

// How many hats and shirt colours there are to pick from in the lobby (S2-01). The engine only
// checks that a choice is in range; the client decides what each number looks like
// (packages/client/src/looks.ts): hat 0 = salakot, 1 = cap, 2 = bandana, 3 = none.
export const HAT_COUNT = 4;
export const SHIRT_COUNT = 6;

// A full room (the relay's MAX_PLAYERS). When this many players are in the lobby, the round
// starts on its own after a countdown, so a full room never waits on the host (GDD §8).
export const FULL_ROOM = 4;
// The countdown: 10 s = 200 ticks of 50 ms.
export const START_COUNTDOWN_TICKS = 200;

// How many lost children each round has (S2-02, GDD: 5 of 12 possible spots).
export const KID_COUNT = 5;

// Escorting (S2-03, GDD §5). A player leading at least one child walks at 2.5 tiles/s instead
// of 4: 2.5 / 20 ticks = 0.125 tiles = 125 units a tick (88 per axis on a diagonal).
export const ESCORT_SPEED = 125;
export const ESCORT_DIAGONAL_SPEED = Math.floor(ESCORT_SPEED / Math.SQRT2); // = 88
// How close (centre to centre) a player must be to call a child with E: 1.5 tiles.
export const CALL_RANGE = 1500;
// The most children one player can lead at once.
export const MAX_ESCORT = 2;
// A following child stays this far behind whoever is in front of it (0.8 tiles)...
export const FOLLOW_GAP = 800;
// ...and walks at up to 3 tiles/s, a little faster than an escort, so it always catches up.
export const KID_SPEED = 150;
// Going home (S2-04): a following child whose centre comes within 1 tile of the centre of their
// own house's doorway goes inside. The doorway is one tile wide and the child trails 0.8 tiles
// behind, so the player has to step into the doorway (or right up to it) for this to happen.
export const HOME_RANGE = 1000;

// The flashlight (S3-01, GDD §5): 90 s of light in total = 1800 ticks of battery. It drains one
// tick per tick while on during a round, and recharges 6 ticks per tick inside a safe zone (empty
// to full in 15 s).
export const BATTERY_MAX = 90 * 20;
export const BATTERY_RECHARGE = 6;

// Emotes (S2-06, ADR-0005: no free-text chat). Four of them; the client decides the words
// (packages/client/src/emotes.ts: 0 = "Dito!", 1 = "Takbo!", 2 = "Tulong!", 3 = "Salamat!").
export const EMOTE_COUNT = 4;
// An emote shows over the player for 2 s (40 ticks)...
export const EMOTE_TICKS = 40;
// ...and a player can start a new one at most once a second (20 ticks), so holding a key or
// pressing all four quickly can't flood everyone's screen.
export const EMOTE_COOLDOWN_TICKS = 20;

// The dawn timer (S2-05, GDD §2): a round lasts 6 minutes = 360 s × 20 ticks = 7200 ticks.
export const ROUND_TICKS = 6 * 60 * 20;
// The team score (GDD §2): children saved × 100 + seconds left × 2 − times lost × 25.
export const SCORE_PER_KID = 100;
export const SCORE_PER_SECOND = 2;
export const SCORE_PER_TIME_LOST = 25;

// ─── Types ───────────────────────────────────────────────────────────────────────────────────
// `interface` describes the shape of an object. Types exist only while compiling: they are
// checked by TypeScript and then erased, so they cost nothing at run time.
// `readonly` means code can't reassign the field after creating it (TypeScript reports an
// error), which keeps step() honest about never changing the old state.

// Which movement keys a player is holding during this tick.
// The client turns WASD / arrow keys into this; the engine never sees keyboard events.
export interface MoveInput {
  readonly up: boolean; // W or ↑ held?
  readonly down: boolean; // S or ↓ held?
  readonly left: boolean; // A or ← held?
  readonly right: boolean; // D or → held?
}

// Everything a player can send for one tick: the movement keys, plus (in the lobby only) a new
// hat or shirt choice. `?` = optional: a missing hat means "keep the one I have".
export interface PlayerInput extends MoveInput {
  readonly hat?: number; // 0 … HAT_COUNT - 1
  readonly shirt?: number; // 0 … SHIRT_COUNT - 1
  readonly call?: boolean; // E held: call the nearest lost child in range (S2-03)
  readonly emote?: number; // 1–4 pressed: show emote 0 … EMOTE_COUNT - 1 (S2-06)
  readonly light?: boolean; // Space held: flashlight on, if the battery has any left (S3-01)
}

// One player's state. More fields arrive in later sprints (flashlight, escorting, baliktad).
export interface PlayerState {
  readonly id: string; // unique id, assigned when the player joins a room (S1-04)
  readonly x: number; // centre of the box, left↔right, in units (always a whole number)
  readonly y: number; // centre of the box, top↕bottom, in units (always a whole number)
  readonly hat: number; // which hat they wear (S2-01); only changes in the lobby
  readonly shirt: number; // which shirt colour (S2-01); only changes in the lobby
  readonly emote: number | null; // the emote showing over them (S2-06), or null for none
  readonly emoteAt: number | null; // the tick their last emote started, for its 2 s and the 1 s limit
  // The way they last walked (S3-01): each −1, 0 or 1, never both 0. The flashlight points this way.
  readonly faceX: number;
  readonly faceY: number;
  readonly light: boolean; // flashlight on this tick (Space held and battery left)
  readonly battery: number; // ticks of light left, 0 … BATTERY_MAX
}

// A lost child (S2-02). Ids are "k0"…"k4"; the client picks each one's sprite and name by it.
// Child "k<n>" lives in the nth house of the map's homes (S2-04, see kidHome).
export interface KidState {
  readonly id: string;
  readonly x: number; // centre, in units, like a player
  readonly y: number;
  // The id of the player this child follows (S2-03), or null while they're lost.
  // A player's line is in the order of the `kids` array: a newly called child goes to the end.
  readonly following: string | null;
}

// A tile, used for the map's hiding spots.
export interface Spot {
  readonly tileX: number;
  readonly tileY: number;
}

// The parts of a game. "lobby" (S2-01): players gather in the kapilya plaza and pick their
// looks. "round": the brownout has started; looks are fixed and the dawn timer runs. The round
// ends (S2-05) as "won" (every child is home) or "lost" (dawn came first); the timer stops and the
// result screen shows until the host takes everyone back to the lobby. (A string union: the type
// allows exactly these strings, so a typo like "lobbby" is a compile error.)
export type Phase = "lobby" | "round" | "won" | "lost";

// Everything needed to continue the game from this exact moment.
export interface GameState {
  readonly tick: number; // how many steps have run since the game began; labels snapshots (S1-05)
  readonly map: TileMap; // the level layout; never changes during a round
  readonly phase: Phase; // lobby or round (S2-01)
  // Ticks left before a full lobby starts the round on its own, or null when no countdown is
  // running (fewer than FULL_ROOM players, or the round has started).
  readonly countdown: number | null;
  // The seeded random generator's state (ADR-0004: the engine's ONLY randomness). Every random
  // choice reads it and stores the new state, so the same seed always gives the same round.
  readonly rngState: number;
  // Where children can hide (the map's "kid" points). Fixed for the whole game.
  readonly kidSpots: readonly Spot[];
  // The lost children: none in the lobby, KID_COUNT once the round starts (S2-02). A child who
  // gets home leaves this list (S2-04).
  readonly kids: readonly KidState[];
  // Lit, safe places (S3-01): the kapilya plaza and the sari-sari store. Batteries recharge in
  // them, and the tikbalang can't enter or see into them (S3-02). Fixed.
  readonly safeZones: readonly Zone[];
  // The tikbalang (S3-02): null in the lobby (and on a map without a "tikbalang" point).
  readonly tikbalang: TikbalangState | null;
  // Where it appears, and the points it walks between and lies in wait at (the map's
  // "tikbalang", "patrol" and "ambush" points). Fixed.
  readonly tikSpawn: Spot | null;
  readonly patrol: readonly Spot[];
  readonly ambush: readonly Spot[];
  // Where a caught player is dropped (S3-03): the map's "grove" points, deep in the bamboo. Fixed.
  readonly grove: readonly Spot[];
  // The last catch this round (S3-03), so every browser can say "Naligaw!" once: who and when.
  readonly lastCaught: { readonly player: string; readonly tick: number } | null;
  // Each house's doorway, in the map's order: child "k<n>" lives at homes[n] (S2-04). Fixed.
  readonly homes: readonly Spot[];
  // The ids of the children who are home this round, in the order they got there (S2-04).
  // `home.length` is the "2 / 5" counter; empty in the lobby.
  readonly home: readonly string[];
  // Ticks left until dawn (S2-05): ROUND_TICKS when the round starts, counting down by one a tick.
  // Frozen when the round ends (it's the "seconds left" in the score); 0 in the lobby.
  readonly dawn: number;
  // How many times a player was caught and got lost (naligaw) this round: −25 each in the score.
  // Always 0 until the tikbalang can catch anyone (S3); here so the score is complete already.
  readonly timesLost: number;
  // An array, not an object keyed by id, so players are always processed in the same order.
  // Order will matter once players affect each other (e.g. two grabbing the same kid).
  readonly players: readonly PlayerState[];
}

// Inputs for one tick, keyed by player id: { "p1": { up: true, ... }, "p2": { ... } }.
// Record<string, MoveInput> = an object whose keys are strings and whose values are MoveInputs.
// A player missing from this object is treated as "no keys held" (e.g. their packet was late).
export type Inputs = Readonly<Record<string, PlayerInput>>;

// Things that happened during a step that the client reacts to once: a sound, "Naligaw!",
// a telemetry record. More types join this union in later stories (kid_home, caught, …).
export type GameEvent =
  | { readonly type: "round_started" }
  // A player called a lost child and it now follows them (S2-03): for a sound, telemetry later.
  | { readonly type: "kid_called"; readonly kid: string; readonly player: string }
  // The tikbalang started stalking or chasing a player (S3-02): for sounds, telemetry later.
  | { readonly type: "tikbalang"; readonly mode: TikMode; readonly player: string }
  // The tikbalang caught a player (S3-02): they're naligaw, dropped in the bamboo grove (S3-03).
  | { readonly type: "caught"; readonly player: string }
  // A player started an emote (S2-06): for telemetry later (which emotes help teams win?).
  | { readonly type: "emote"; readonly player: string; readonly emote: number }
  // A child reached their own house and went inside (S2-04). `player` is who led them there.
  | { readonly type: "kid_home"; readonly kid: string; readonly player: string }
  // The round ended (S2-05): every child is home, or dawn came first. `score` is the team score.
  | { readonly type: "round_won"; readonly score: number }
  | { readonly type: "dawn"; readonly score: number };

// What step() returns: the next state plus whatever happened on the way there.
export interface StepResult {
  readonly state: GameState; // the game after this tick
  readonly events: readonly GameEvent[]; // what happened during this tick (often nothing)
}

// Where a player starts, in whole tiles (easier to write than units).
export interface PlayerSpawn {
  readonly id: string; // which player
  readonly tileX: number; // starting tile column; the player is placed at the tile's centre
  readonly tileY: number; // starting tile row
  readonly hat?: number; // starting hat (default 0)
  readonly shirt?: number; // starting shirt (default 0; the client gives each seat its own)
}

// Extra settings for a new game. `?` = optional; createGame fills in a default.
export interface GameOptions {
  readonly seed?: number; // starts the random generator (the host picks one per game)
  readonly kidSpots?: readonly Spot[]; // the map's hiding spots
  readonly homes?: readonly Spot[]; // the map's house doorways, child k0's first (S2-04)
  readonly safeZones?: readonly Zone[]; // the map's safe zones (S3-01)
  readonly tikSpawn?: Spot; // where the tikbalang appears (S3-02)
  readonly patrol?: readonly Spot[]; // the tikbalang's patrol points (S3-02)
  readonly ambush?: readonly Spot[]; // the tikbalang's ambush points (S3-02)
  readonly grove?: readonly Spot[]; // where caught players are dropped (S3-03)
}

// ─── Public functions ────────────────────────────────────────────────────────────────────────

// Builds the starting state of a round: tick 0, every player in the middle of their spawn tile.
export function createGame(
  map: TileMap,
  spawns: readonly PlayerSpawn[],
  options: GameOptions = {},
): GameState {
  // A hiding spot inside a wall would put a child where nobody can reach: refuse it loudly.
  const kidSpots = options.kidSpots ?? [];
  for (const { tileX, tileY } of kidSpots) {
    if (isWall(map, tileX, tileY)) {
      throw new RangeError(`kid spot (${tileX}, ${tileY}) is inside a wall`);
    }
  }
  // Same for a doorway: a child could never be led into a wall.
  const homes = options.homes ?? [];
  for (const { tileX, tileY } of homes) {
    if (isWall(map, tileX, tileY)) {
      throw new RangeError(`home (${tileX}, ${tileY}) is inside a wall`);
    }
  }
  // .map() builds a NEW array by turning each spawn into a PlayerState.
  // `({ id, tileX, tileY })` is destructuring: it pulls those three fields out of each spawn.
  const players = spawns.map(({ id, tileX, tileY, hat, shirt }) => {
    // A player spawned inside a wall could never move out, so refuse it loudly.
    if (isWall(map, tileX, tileY)) {
      // `throw` stops the function with an error; the backticks build a message with ${values}.
      throw new RangeError(`player ${id} would spawn inside a wall at (${tileX}, ${tileY})`);
    }
    // Tile → units: tile 3 starts at 3000, and + 500 (half a tile) puts the player at its centre.
    const look = { hat: validHat(hat) ?? 0, shirt: validShirt(shirt) ?? 0 };
    const x = tileX * UNITS_PER_TILE + 500;
    return { id, x, y: tileY * UNITS_PER_TILE + 500, ...look, ...NEW_PLAYER };
  });
  // `{ tick: 0, map, players }` is shorthand for { tick: 0, map: map, players: players }.
  // Every game starts in the lobby, with no countdown running and no children out yet.
  // `>>> 0` turns the seed into a whole 32-bit number, the form the generator works with.
  const rngState = (options.seed ?? 1) >>> 0;
  return {
    tick: 0,
    map,
    phase: "lobby",
    countdown: null,
    rngState,
    kidSpots,
    kids: [],
    homes,
    home: [],
    safeZones: options.safeZones ?? [],
    tikbalang: null,
    tikSpawn: options.tikSpawn ?? null,
    patrol: options.patrol ?? [],
    ambush: options.ambush ?? [],
    grove: options.grove ?? [],
    lastCaught: null,
    dawn: 0,
    timesLost: 0,
    players,
  };
}

// Where child `kidId` lives (S2-04): "k2" → homes[2]. Undefined for an id with no house (a map
// with fewer houses than children, or a made-up id): that child can't be taken home.
export function kidHome(homes: readonly Spot[], kidId: string): Spot | undefined {
  const n = Number(kidId.slice(1)); // "k2" → 2; anything that isn't a number gives NaN
  return Number.isInteger(n) && n >= 0 ? homes[n] : undefined;
}

// The parts of a new player that don't depend on where they spawn or what they wear: no emote
// (S2-06), facing down (towards the viewer), flashlight off with a full battery (S3-01).
const NEW_PLAYER = {
  emote: null,
  emoteAt: null,
  faceX: 0,
  faceY: 1,
  light: false,
  battery: BATTERY_MAX,
} as const;

// Whole seconds left on the dawn timer, at 20 ticks a second (index.ts TICKS_PER_SECOND; not
// imported from there, which would make the two files import each other): 7200 ticks → 360,
// 19 ticks → 0 (a part second is no second).
export function secondsLeft(dawn: number): number {
  return Math.floor(dawn / 20);
}

// The team score (S2-05, GDD §2): children saved × 100 + seconds left × 2 − times lost × 25.
// Takes only the three numbers it needs, so a guest can work it out from a snapshot too.
// `saved` = how many children are home (state.home.length).
export function teamScore(score: {
  readonly saved: number;
  readonly dawn: number;
  readonly timesLost: number;
}): number {
  return (
    score.saved * SCORE_PER_KID +
    secondsLeft(score.dawn) * SCORE_PER_SECOND -
    score.timesLost * SCORE_PER_TIME_LOST
  );
}

// Ends the lobby and starts the round now (the host pressed Start). Returns a NEW state.
// Calling it again once the round has started changes nothing.
export function startRound(state: GameState): GameState {
  if (state.phase === "round") return state;
  return beginRound(state);
}

// The host takes everyone back to the kapilya plaza after a round (S2-05). Only works once the
// round has ended (won or lost); otherwise nothing changes. Everyone is placed around `spawn`
// again (same rule as addPlayer), in the same order, keeping their looks, and the next round
// can be set up and started like the first. The random generator keeps going, so the next round
// hides the children in new places.
export function returnToLobby(
  state: GameState,
  spawn: { readonly tileX: number; readonly tileY: number },
): GameState {
  if (state.phase !== "won" && state.phase !== "lost") return state;
  const lobby: GameState = {
    ...state,
    phase: "lobby",
    countdown: null,
    kids: [],
    home: [],
    dawn: 0,
    timesLost: 0,
    lastCaught: null, // S3-03
    tikbalang: null, // S3-02: gone until the next round
    players: [],
  };
  // Re-add each player at the spawn: addPlayer finds each one a free tile near it.
  return state.players.reduce(
    (next, p) => addPlayer(next, { id: p.id, ...spawn, hat: p.hat, shirt: p.shirt }),
    lobby,
  );
}

// Adds a player to a running game (someone joined the room). Returns a NEW state, like step().
// They start on the first free tile among: the spawn tile, then its neighbours to the right,
// left, below and above, so players who join together don't stand on top of each other.
// Adding a player who is already in the game changes nothing.
export function addPlayer(state: GameState, spawn: PlayerSpawn): GameState {
  // Already here (e.g. a repeated "player_joined" message): keep the state as it is.
  if (state.players.some((p) => p.id === spawn.id)) return state;

  // Which tiles already have someone standing on them (by their centre's tile).
  const taken = new Set(state.players.map((p) => `${tileOf(p.x)},${tileOf(p.y)}`));
  // Candidate tiles, nearest first: the spawn itself, then 1 and 2 tiles away.
  const offsets = [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [2, 0],
    [-2, 0],
    [1, 1],
    [-1, 1],
  ];
  for (const [dx = 0, dy = 0] of offsets) {
    const tx = spawn.tileX + dx;
    const ty = spawn.tileY + dy;
    if (isWall(state.map, tx, ty) || taken.has(`${tx},${ty}`)) continue;
    const player = {
      id: spawn.id,
      x: tx * UNITS_PER_TILE + 500,
      y: ty * UNITS_PER_TILE + 500,
      hat: validHat(spawn.hat) ?? 0,
      shirt: validShirt(spawn.shirt) ?? 0,
      ...NEW_PLAYER, // no emote, facing down, flashlight off, full battery
    };
    // `[...a, b]` is a new array: every old player, then the new one at the end.
    return { ...state, players: [...state.players, player] };
  }
  throw new RangeError(`no free tile near (${spawn.tileX}, ${spawn.tileY}) for player ${spawn.id}`);
}

// Takes a player out of a running game (they closed their tab, S1-06). Returns a NEW state.
// Removing someone who isn't in the game changes nothing.
export function removePlayer(state: GameState, id: string): GameState {
  // Not here (e.g. a repeated "player_left" message): keep the state as it is.
  if (!state.players.some((p) => p.id === id)) return state;
  // .filter() builds a new array with everyone except them; the order of the rest is unchanged.
  const players = state.players.filter((p) => p.id !== id);
  // Children who were following them are lost again, right where they stand (S2-03).
  const kids = state.kids.map((k) => (k.following === id ? { ...k, following: null } : k));
  return { ...state, players, kids };
}

// Advances the game by exactly one tick (50 ms of game time).
// It never edits `state`: it builds a new state and returns it, so the old one stays valid.
// That's what lets tests compare "before" and "after", and lets a round be replayed exactly.
export function step(state: GameState, inputs: Inputs): StepResult {
  const inLobby = state.phase === "lobby";
  const tick = state.tick + 1; // the tick this step produces
  const events: GameEvent[] = [];
  // Who is leading children right now: they walk slower (S2-03).
  const escorting = new Set(state.kids.flatMap((k) => (k.following ? [k.following] : [])));
  // Build the new list of players, one at a time, in the same order as before.
  const players = state.players.map((player) => {
    // Look up this player's keys. This is `undefined` if no input arrived for them this tick.
    const input = inputs[player.id];
    // No input → standing still with the light off (an old emote still runs out: S2-06, and the
    // battery still recharges in a safe zone: S3-01).
    if (!input) {
      const still = updateLight(player, undefined, state);
      return updateEmote(still, undefined, tick, events);
    }
    const moved = movePlayer(state.map, player, input, escorting.has(player.id));
    // Hats and shirts can only change in the lobby. Out-of-range choices are ignored.
    const looked = inLobby ? changeLook(moved, input) : moved;
    // The flashlight and battery (S3-01).
    const lit = updateLight(looked, input, state);
    // Emotes work in every phase: the lobby, the round and the result screen (S2-06).
    return updateEmote(lit, input, tick, events);
  });

  // The children: anyone holding E calls the nearest lost child in range, then every following
  // child walks after whoever is in front of it (S2-03).
  // Once the round has ended (S2-05) nobody can call a child or take one home any more; players
  // can still walk about while the result screen shows.
  const inRound = state.phase === "round";
  const called = inRound ? callKids(state.kids, players, inputs, events) : state.kids;
  const moved = moveKids(state.map, called, players);
  // Then any following child now standing at their own doorway goes inside (S2-04).
  const { kids, home } = inRound
    ? bringKidsHome(moved, state.homes, state.home, events)
    : { kids: moved, home: state.home };

  // New state: tick goes up by one; the map is shared (it's read-only, so sharing is safe).
  // `let`: the tikbalang's tick below may replace it.
  let next: GameState = { ...state, tick, players, kids, home };

  // The tikbalang's tick (S3-02), during the round only.
  // Its random choices use the game's generator and save where it got to, like placeKids.
  if (inRound && state.tikbalang) {
    const rng = createRng(state.rngState);
    const { tikbalang, caught } = updateTikbalang(
      state.tikbalang,
      players,
      kids,
      state,
      rng,
      events,
    );
    next = { ...next, tikbalang };
    // Caught (S3-03): naligaw. Uses the same generator (for the drop spot) before saving it.
    if (caught) next = naligaw(next, caught, rng);
    next = { ...next, rngState: rng.state };
  }

  // The round: the dawn timer counts down, and the round ends (S2-05). Every child home wins,
  // checked first, so bringing the last one in on the very last tick still counts as a win.
  // (`home.length > 0` too: a test map with no hiding spots has no children, and no instant win.)
  if (inRound) {
    const dawn = Math.max(0, state.dawn - 1);
    if (kids.length === 0 && home.length > 0) {
      const won: GameState = { ...next, phase: "won", dawn };
      return { state: won, events: [...events, { type: "round_won", score: scoreOf(won) }] };
    }
    if (dawn === 0) {
      const lost: GameState = { ...next, phase: "lost", dawn };
      return { state: lost, events: [...events, { type: "dawn", score: scoreOf(lost) }] };
    }
    return { state: { ...next, dawn }, events };
  }

  // The lobby countdown: runs while the room is full, stops if anyone leaves, and starts the
  // round when it reaches 0. `??` = "if the left side is null/undefined, use the right side".
  if (inLobby && players.length >= FULL_ROOM) {
    const countdown = (state.countdown ?? START_COUNTDOWN_TICKS) - 1;
    if (countdown <= 0) {
      return { state: beginRound(next), events: [...events, { type: "round_started" }] };
    }
    return { state: { ...next, countdown }, events };
  }
  return { state: { ...next, countdown: null }, events };
}

// The team score of a state (the round's numbers, read off it).
function scoreOf(state: GameState): number {
  return teamScore({ saved: state.home.length, dawn: state.dawn, timesLost: state.timesLost });
}

// ─── The round (private helpers) ─────────────────────────────────────────────────────────────

// The lobby ends: switch phase and send the children out to hide. Used by startRound (the host's
// button) and by the countdown, so both start a round exactly the same way.
function beginRound(state: GameState): GameState {
  const { kids, rngState } = placeKids(state);
  return {
    ...state,
    phase: "round",
    countdown: null,
    kids,
    home: [],
    dawn: ROUND_TICKS, // S2-05: 6 minutes to dawn
    timesLost: 0,
    lastCaught: null, // S3-03
    rngState,
    // S3-02: the tikbalang appears at its spawn point (if the map has one), waiting out the grace.
    tikbalang: state.tikSpawn ? spawnTikbalang(state.tikSpawn) : null,
    players: state.players.map((p) => ({ ...p, battery: BATTERY_MAX })), // S3-01: fresh batteries
  };
}

// Picks KID_COUNT different hiding spots at random (seeded) and puts a child on each.
// The method is a partial Fisher–Yates shuffle: for each child, pick one of the spots not used
// yet and swap it out of the way, so no spot can be picked twice. With fewer spots than
// children (a small test map), every spot gets one child.
function placeKids(state: GameState): { kids: KidState[]; rngState: number } {
  const rng = createRng(state.rngState);
  const spots = [...state.kidSpots]; // a copy: shuffling must not change the state's list
  const count = Math.min(KID_COUNT, spots.length);
  const kids: KidState[] = [];
  for (let i = 0; i < count; i++) {
    const j = rng.int(i, spots.length - 1); // one of the spots from i onwards (not used yet)
    [spots[i], spots[j]] = [spots[j]!, spots[i]!]; // swap it into place i
    const { tileX, tileY } = spots[i]!;
    const x = tileX * UNITS_PER_TILE + 500;
    kids.push({ id: `k${i}`, x, y: tileY * UNITS_PER_TILE + 500, following: null });
  }
  // Save where the generator got to, so the NEXT random choice continues from here.
  return { kids, rngState: rng.state };
}

// ─── Escorting children (private helpers, S2-03) ─────────────────────────────────────────────

// Players holding E each call the nearest lost child within CALL_RANGE, if they lead fewer than
// MAX_ESCORT. One child per player per tick (holding E near two calls both, a tick apart).
// Players are handled in order, so if two reach for the same child the first one gets it.
// A called child moves to the END of the list: list order is line order.
function callKids(
  kids: readonly KidState[],
  players: readonly PlayerState[],
  inputs: Inputs,
  events: GameEvent[],
): readonly KidState[] {
  let result = kids;
  for (const player of players) {
    if (!inputs[player.id]?.call) continue;
    const leading = result.filter((k) => k.following === player.id).length;
    if (leading >= MAX_ESCORT) continue;
    // The nearest lost child in range. Squared distances: whole numbers, no square root needed.
    let nearest: KidState | undefined;
    // Start just past the range so a child exactly CALL_RANGE away still counts; `<` keeps the
    // FIRST of two equally near children, so ties always go the same way.
    let best = CALL_RANGE * CALL_RANGE + 1;
    for (const kid of result) {
      if (kid.following !== null) continue;
      const d = (kid.x - player.x) ** 2 + (kid.y - player.y) ** 2;
      if (d < best) {
        best = d;
        nearest = kid;
      }
    }
    if (!nearest) continue;
    const chosen = nearest;
    result = [...result.filter((k) => k !== chosen), { ...chosen, following: player.id }];
    events.push({ type: "kid_called", kid: chosen.id, player: player.id });
  }
  return result;
}

// Every following child walks toward whoever is in front of it in its line (the player for the
// first child, the first child for the second) and stops FOLLOW_GAP short. Walls block children
// like players (same box), so they slide along a wall instead of walking through it.
// A child whose player has left stays where it is (removePlayer makes it lost anyway).
function moveKids(
  map: TileMap,
  kids: readonly KidState[],
  players: readonly PlayerState[],
): readonly KidState[] {
  if (!kids.some((k) => k.following !== null)) return kids; // nobody following: nothing moves
  const moved: KidState[] = [];
  for (const kid of kids) {
    const leader = players.find((p) => p.id === kid.following);
    if (!leader) {
      moved.push(kid);
      continue;
    }
    // In front of me: the last child already moved this tick in the same line, else the player.
    // (A loop from the end instead of .findLast(), which needs a newer `lib` than ES2022.)
    let ahead: { x: number; y: number } = leader;
    for (let i = moved.length - 1; i >= 0; i--) {
      if (moved[i]!.following === kid.following) {
        ahead = moved[i]!;
        break;
      }
    }
    const dx = ahead.x - kid.x;
    const dy = ahead.y - kid.y;
    // Math.sqrt is exact to the last bit in every JavaScript engine (IEEE 754), so the result
    // is the same on the host and on a guest's prediction. (Math.hypot isn't guaranteed to be.)
    const dist = Math.sqrt(dx * dx + dy * dy);
    const go = Math.min(KID_SPEED, dist - FOLLOW_GAP); // close enough already → go ≤ 0
    if (go <= 0) {
      moved.push(kid);
      continue;
    }
    // A step of `go` units toward the target, rounded to whole units like every position.
    const x = moveX(map, kid.x, kid.y, Math.round((dx * go) / dist));
    const y = moveY(map, x, kid.y, Math.round((dy * go) / dist));
    moved.push({ ...kid, x, y });
  }
  return moved;
}

// Takes every FOLLOWING child within HOME_RANGE of their own doorway out of `kids` and adds them
// to `home`, with a kid_home event each (S2-04). A lost child sitting near their house doesn't go
// in by themselves: someone has to bring them. Returns the same arrays when nobody got home, so
// the usual tick copies nothing.
function bringKidsHome(
  kids: readonly KidState[],
  homes: readonly Spot[],
  home: readonly string[],
  events: GameEvent[],
): { kids: readonly KidState[]; home: readonly string[] } {
  const arrived = kids.filter((kid) => {
    if (kid.following === null) return false;
    const door = kidHome(homes, kid.id);
    if (!door) return false;
    // The doorway tile's centre, in units, and the squared distance to it (no square root).
    const dx = door.tileX * UNITS_PER_TILE + 500 - kid.x;
    const dy = door.tileY * UNITS_PER_TILE + 500 - kid.y;
    return dx * dx + dy * dy <= HOME_RANGE * HOME_RANGE;
  });
  if (arrived.length === 0) return { kids, home };
  for (const kid of arrived) {
    events.push({ type: "kid_home", kid: kid.id, player: kid.following! });
  }
  return {
    kids: kids.filter((k) => !arrived.includes(k)),
    home: [...home, ...arrived.map((k) => k.id)],
  };
}

// ─── Getting caught (private helper, S3-03) ──────────────────────────────────────────────────

// The tikbalang caught `id`: they're naligaw (lost), never hurt (GDD §2, PG-13). They're dropped at
// a random grove point (seeded), the team's times-lost count goes up (−25 in the score), and the
// children following them scatter: each runs to the nearest hiding spot no other lost child is on,
// and has to be found and called again.
function naligaw(state: GameState, id: string, rng: Rng): GameState {
  const drop = state.grove.length > 0 ? state.grove[rng.int(0, state.grove.length - 1)]! : null;
  const players = state.players.map((p) =>
    p.id === id && drop
      ? { ...p, x: drop.tileX * UNITS_PER_TILE + 500, y: drop.tileY * UNITS_PER_TILE + 500 }
      : p,
  );
  // Scatter, one child at a time in list order, so two never pick the same spot.
  const taken = new Set(
    state.kids.filter((k) => k.following === null).map((k) => `${tileOf(k.x)},${tileOf(k.y)}`),
  );
  const kids = state.kids.map((k) => {
    if (k.following !== id) return k;
    let best: Spot | undefined;
    let bestD = Infinity;
    for (const spot of state.kidSpots) {
      if (taken.has(`${spot.tileX},${spot.tileY}`)) continue;
      const d =
        (spot.tileX * UNITS_PER_TILE + 500 - k.x) ** 2 +
        (spot.tileY * UNITS_PER_TILE + 500 - k.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = spot;
      }
    }
    if (!best) return { ...k, following: null }; // nowhere to run: lost right here
    taken.add(`${best.tileX},${best.tileY}`);
    const x = best.tileX * UNITS_PER_TILE + 500;
    return { ...k, x, y: best.tileY * UNITS_PER_TILE + 500, following: null };
  });
  return {
    ...state,
    players,
    kids,
    timesLost: state.timesLost + 1,
    lastCaught: { player: id, tick: state.tick },
  };
}

// ─── The flashlight (private helper, S3-01) ──────────────────────────────────────────────────

// Updates which way a player faces, whether their flashlight is on and their battery. Facing
// follows the keys held (even into a wall: you can point at it). The light is on while Space is
// held and there's battery; during a round it drains one tick per tick, except inside a safe zone,
// where the battery recharges instead. Returns the same object when nothing changes.
function updateLight(
  player: PlayerState,
  input: PlayerInput | undefined,
  state: GameState,
): PlayerState {
  const dirX = input ? Number(input.right) - Number(input.left) : 0;
  const dirY = input ? Number(input.down) - Number(input.up) : 0;
  const turned = dirX !== 0 || dirY !== 0;
  const faceX = turned ? dirX : player.faceX;
  const faceY = turned ? dirY : player.faceY;
  const light = !!input?.light && player.battery > 0;
  let battery = player.battery;
  if (inZone(state.safeZones, player.x, player.y)) {
    battery = Math.min(BATTERY_MAX, battery + BATTERY_RECHARGE);
  } else if (light && state.phase === "round") {
    battery -= 1;
  }
  const same =
    faceX === player.faceX &&
    faceY === player.faceY &&
    light === player.light &&
    battery === player.battery;
  return same ? player : { ...player, faceX, faceY, light, battery };
}

// ─── Emotes (private helper, S2-06) ──────────────────────────────────────────────────────────

// Starts the emote in `input` if it's valid and the player's last one started at least
// EMOTE_COOLDOWN_TICKS ago (adding an "emote" event), and clears an emote that has shown for
// EMOTE_TICKS. Returns the same object when nothing changes. A player holding a key keeps the
// emote in their input, so it repeats once a second while held, never faster.
function updateEmote(
  player: PlayerState,
  input: PlayerInput | undefined,
  tick: number,
  events: GameEvent[],
): PlayerState {
  const emote = input?.emote;
  const valid = Number.isInteger(emote) && emote! >= 0 && emote! < EMOTE_COUNT;
  const rested = player.emoteAt === null || tick - player.emoteAt >= EMOTE_COOLDOWN_TICKS;
  if (valid && rested) {
    events.push({ type: "emote", player: player.id, emote: emote! });
    return { ...player, emote: emote!, emoteAt: tick };
  }
  if (player.emote !== null && player.emoteAt !== null && tick - player.emoteAt >= EMOTE_TICKS) {
    return { ...player, emote: null }; // shown for 2 s: gone (emoteAt stays, for the limit)
  }
  return player;
}

// ─── Looks (private helpers) ─────────────────────────────────────────────────────────────────

// A hat number if it's a whole number in range, otherwise undefined (so `?? 0` picks a default).
// Inputs come from the network, so a bad value is ignored rather than trusted.
function validHat(hat: number | undefined): number | undefined {
  return Number.isInteger(hat) && hat! >= 0 && hat! < HAT_COUNT ? hat : undefined;
}

// Same for a shirt colour.
function validShirt(shirt: number | undefined): number | undefined {
  return Number.isInteger(shirt) && shirt! >= 0 && shirt! < SHIRT_COUNT ? shirt : undefined;
}

// Applies a hat / shirt choice from an input, if it has one and it's valid. Returns the same
// object when nothing changes, so a player who isn't changing looks isn't copied every tick.
function changeLook(player: PlayerState, input: PlayerInput): PlayerState {
  const hat = validHat(input.hat) ?? player.hat;
  const shirt = validShirt(input.shirt) ?? player.shirt;
  return hat === player.hat && shirt === player.shirt ? player : { ...player, hat, shirt };
}

// ─── Movement and collision (private helpers: no `export`, so only this file can use them) ───

// Turns held keys into a movement for one tick, then applies it with wall collision.
function movePlayer(
  map: TileMap,
  player: PlayerState,
  input: MoveInput,
  escorting = false, // leading a child: walk at escort speed (S2-03)
): PlayerState {
  // Number(true) = 1 and Number(false) = 0, so this gives -1 (left), 0 (none) or +1 (right).
  // A and D together → 1 - 1 = 0: opposite keys cancel out.
  const dirX = Number(input.right) - Number(input.left);
  // Same for vertical. "down" is +1 because y grows downwards (see the diagram at the top).
  const dirY = Number(input.down) - Number(input.up);

  // No direction on either axis: nothing to do, return the player unchanged.
  if (dirX === 0 && dirY === 0) return player;

  // Moving on BOTH axes = diagonal = use the slower per-axis speed; otherwise full speed.
  const diagonal = dirX !== 0 && dirY !== 0;
  const speed = escorting
    ? diagonal
      ? ESCORT_DIAGONAL_SPEED
      : ESCORT_SPEED
    : diagonal
      ? PLAYER_DIAGONAL_SPEED
      : PLAYER_SPEED;

  // Move left/right first. dirX * speed is the signed distance: e.g. -1 × 200 = -200 (left).
  const x = moveX(map, player.x, player.y, dirX * speed);
  // Then move up/down, starting from the NEW x. If a wall blocked the x move, this one still
  // happens on its own, so a player pushing diagonally into a wall slides along it.
  const y = moveY(map, x, player.y, dirY * speed);

  // `...player` copies every field of player (spread syntax); then x and y are overwritten.
  // It's a new object, so the old player is left untouched.
  return { ...player, x, y };
}

// Which tiles (along one axis) a player's box covers when centred at `centre`.
//   centre 1500 → units 1200…1799 → { first: 1, last: 1 }  (fully inside tile 1)
//   centre 2100 → units 1800…2399 → { first: 1, last: 2 }  (straddling tiles 1 and 2)
function tileSpan(centre: number): { first: number; last: number } {
  return {
    // The box's first unit is 300 left of (or above) the centre.
    first: tileOf(centre - PLAYER_HALF_SIZE),
    // Its last unit is centre + 299, not + 300. A box centred at 1700 covers 1400…1999, all in
    // tile 1. With + 300 it would reach 2000 (tile 2), so a player standing flush against a wall
    // in tile 2 would count as overlapping it and get stuck. The classic off-by-one bug.
    last: tileOf(centre + PLAYER_HALF_SIZE - 1),
  };
}

// Tries to move horizontally by `dx` units (negative = left). Returns the new x: either the
// full move, or the position flush against the wall that blocked it.
function moveX(map: TileMap, x: number, y: number, dx: number): number {
  // Not moving sideways: keep x as it is.
  if (dx === 0) return x;

  // Where the player WANTS to be after this tick.
  const nextX = x + dx;

  // Which rows the box covers. y isn't changing here, so use the current y.
  const rows = tileSpan(y);
  // Which columns the box would cover at the new x.
  const cols = tileSpan(nextX);

  // Only the LEADING edge can enter a new column: the right edge when moving right, the left
  // edge when moving left. 200 units per tick is much less than a 1000-unit tile, so the player
  // can never jump clean over a column in one tick (that bug is called "tunnelling").
  const col = dx > 0 ? cols.last : cols.first;

  // The box can straddle two rows, so check the leading column in every row it covers.
  for (let ty = rows.first; ty <= rows.last; ty++) {
    // Is there a wall in that tile?
    if (isWall(map, col, ty)) {
      // Blocked: snap so the box's edge touches the wall exactly, instead of stopping short.
      return dx > 0
        ? // Moving right into wall column 9 (units 9000…9999): right edge at 9000 → x = 8700.
          col * UNITS_PER_TILE - PLAYER_HALF_SIZE
        : // Moving left into wall column 0 (units 0…999): left edge at 1000 → x = 1300.
          (col + 1) * UNITS_PER_TILE + PLAYER_HALF_SIZE;
    }
  }

  // Nothing in the way: take the full move.
  return nextX;
}

// Same as moveX turned 90°: tries to move vertically by `dy` units (negative = up).
function moveY(map: TileMap, x: number, y: number, dy: number): number {
  // Not moving up or down: keep y as it is.
  if (dy === 0) return y;

  // Where the player WANTS to be after this tick.
  const nextY = y + dy;

  // Which columns the box covers. x is already final (moveX ran first), so use it.
  const cols = tileSpan(x);
  // Which rows the box would cover at the new y.
  const rows = tileSpan(nextY);

  // The leading edge: the bottom edge when moving down, the top edge when moving up.
  const row = dy > 0 ? rows.last : rows.first;

  // The box can straddle two columns, so check the leading row in every column it covers.
  for (let tx = cols.first; tx <= cols.last; tx++) {
    // Is there a wall in that tile?
    if (isWall(map, tx, row)) {
      // Blocked: snap so the box's edge touches the wall exactly.
      return dy > 0
        ? // Moving down: bottom edge at the wall's top side.
          row * UNITS_PER_TILE - PLAYER_HALF_SIZE
        : // Moving up: top edge at the wall's bottom side.
          (row + 1) * UNITS_PER_TILE + PLAYER_HALF_SIZE;
    }
  }

  // Nothing in the way: take the full move.
  return nextY;
}
