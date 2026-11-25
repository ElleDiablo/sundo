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
import { isWall, tileOf, UNITS_PER_TILE, type TileMap } from "./map.ts";

// ─── Tuning constants ────────────────────────────────────────────────────────────────────────

/**
 * Player speed in units per tick.
 * Design doc: 4 tiles per second. One tick is 1/20 s, so per tick that's
 * 4 / 20 = 0.2 tiles = 0.2 × 1000 = 200 units.
 */
export const PLAYER_SPEED = 200;

/**
 * Per-axis speed when moving diagonally.
 *
 * Holding W+D moves on both axes at once. At full speed on each axis, the actual distance per
 * tick would be the hypotenuse: √(200² + 200²) ≈ 283, i.e. 41% faster than walking straight,
 * and players would zig-zag everywhere to go faster.
 *
 * Dividing each axis by √2 fixes it: √(141² + 141²) ≈ 199.4, just under 200.
 * Math.floor (round DOWN) keeps it a whole number and guarantees it is never faster than 200.
 */
export const PLAYER_DIAGONAL_SPEED = Math.floor(PLAYER_SPEED / Math.SQRT2); // = 141

/**
 * Half the width of a player's square collision box: 300 units = 0.3 tiles.
 *
 * The box is 600 × 600 units (0.6 × 0.6 tiles), centred on the player's position:
 *
 *     ┌──────────── one tile (1000) ────────────┐
 *     │        ┌────── box (600) ──────┐        │
 *     │  200   │           ● (x, y)    │  200   │   ← 200 units of slack on each side
 *     │        └───────────────────────┘        │
 *     └─────────────────────────────────────────┘
 *
 * Being smaller than a tile means a 1-tile-wide gap has 400 units of slack, so players
 * don't need pixel-perfect aim to walk through a doorway.
 */
export const PLAYER_HALF_SIZE = 300;

// ─── Types ───────────────────────────────────────────────────────────────────────────────────
// `interface` describes the shape of an object. `readonly` means code can't reassign the field
// after creating it (TypeScript reports an error), which keeps step() honest about being pure.

/**
 * Which movement keys a player is holding during this tick.
 * The client turns WASD / arrow keys into this; the engine never sees actual keyboard events.
 */
export interface MoveInput {
  readonly up: boolean;
  readonly down: boolean;
  readonly left: boolean;
  readonly right: boolean;
}

/** One player's state. More fields arrive in later sprints (flashlight, escorting, baliktad). */
export interface PlayerState {
  /** Unique id, assigned when the player joins a room (S1-04). */
  readonly id: string;
  /** Centre of the player's box, in units (1 tile = 1000). Always a whole number. */
  readonly x: number;
  readonly y: number;
}

/** Everything needed to continue the game from this exact moment. */
export interface GameState {
  /** How many steps have run since the round began. Snapshots (S1-05) are labelled with it. */
  readonly tick: number;
  /** The level layout. It never changes during a round; snapshots won't need to resend it. */
  readonly map: TileMap;
  /**
   * An array, not an object keyed by id, so players are always processed in the same order.
   * Order matters once players can affect each other (e.g. two grabbing the same kid).
   */
  readonly players: readonly PlayerState[];
}

/**
 * Inputs for one tick, keyed by player id: `{ "p1": { up: true, ... }, "p2": { ... } }`.
 * `Record<string, MoveInput>` = an object whose keys are strings and values are MoveInputs.
 * A player missing from this object is treated as "no keys held" (e.g. their packet was late).
 */
export type Inputs = Readonly<Record<string, MoveInput>>;

/**
 * Things that happened during a step that the client should react to once: play a sound,
 * show "Naligaw!", log telemetry. None exist yet, so the type is `never` (a type with no
 * possible values): the events array can only be empty until real events are added here.
 */
export type GameEvent = never;

/** What step() returns: the next state plus whatever happened on the way there. */
export interface StepResult {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

/** Where a player starts, in whole tiles (easier to write than units). */
export interface PlayerSpawn {
  readonly id: string;
  /** The tile the player starts in; they are placed at its centre. */
  readonly tileX: number;
  readonly tileY: number;
}

// ─── Public functions ────────────────────────────────────────────────────────────────────────

/**
 * Builds the starting state of a round: tick 0, every player in the middle of their spawn tile.
 * Throws if a spawn is inside a wall, because the player could never move out of it.
 */
export function createGame(map: TileMap, spawns: readonly PlayerSpawn[]): GameState {
  // .map() makes a NEW array by transforming each spawn into a PlayerState.
  // `({ id, tileX, tileY })` is destructuring: it pulls those three fields out of each spawn.
  const players = spawns.map(({ id, tileX, tileY }) => {
    if (isWall(map, tileX, tileY)) {
      throw new RangeError(`player ${id} would spawn inside a wall at (${tileX}, ${tileY})`);
    }
    // Tile → units: tile 3 starts at 3000; + 500 is half a tile, so the centre is 3500.
    return { id, x: tileX * UNITS_PER_TILE + 500, y: tileY * UNITS_PER_TILE + 500 };
  });
  return { tick: 0, map, players };
}

/**
 * Advances the game by exactly one tick (50 ms of game time).
 *
 * It never edits `state`. It builds a new state object and returns it. The old one is still
 * valid afterwards, which is what lets tests compare "before" and "after", and lets a whole
 * round be replayed from its starting state and the list of inputs.
 */
export function step(state: GameState, inputs: Inputs): StepResult {
  const players = state.players.map((player) => {
    // Look up this player's keys. `inputs[player.id]` is undefined if none arrived this tick.
    const input = inputs[player.id];
    // No input → return the same player object unchanged (standing still).
    return input ? movePlayer(state.map, player, input) : player;
  });
  // The map is shared, not copied: it's read-only, so sharing it is safe and cheap.
  return { state: { tick: state.tick + 1, map: state.map, players }, events: [] };
}

// ─── Movement and collision (private helpers, not exported) ──────────────────────────────────

/** Turns held keys into a movement for one tick, then applies it with wall collision. */
function movePlayer(map: TileMap, player: PlayerState, input: MoveInput): PlayerState {
  // Turn keys into a direction of -1, 0 or +1 on each axis.
  // Number(true) = 1 and Number(false) = 0, so:
  //   only D held      → 1 - 0 =  1  (right)
  //   only A held      → 0 - 1 = -1  (left)
  //   A and D together → 1 - 1 =  0  (they cancel: no sideways movement)
  // For y, "down" is +1 because y grows downwards (see the diagram at the top).
  const dirX = Number(input.right) - Number(input.left);
  const dirY = Number(input.down) - Number(input.up);

  // No direction at all: return the same object, no work to do.
  if (dirX === 0 && dirY === 0) return player;

  // Moving on both axes = diagonal = use the slower per-axis speed (see PLAYER_DIAGONAL_SPEED).
  const speed = dirX !== 0 && dirY !== 0 ? PLAYER_DIAGONAL_SPEED : PLAYER_SPEED;

  // Move one axis at a time: x first, then y starting from the NEW x.
  // If a wall blocks the x move, the y move still happens on its own, so a player pushing
  // diagonally into a wall slides along it instead of stopping dead ("wall sliding").
  const x = moveX(map, player.x, player.y, dirX * speed);
  const y = moveY(map, x, player.y, dirY * speed);

  // `{ ...player, x, y }` copies every field of player (spread syntax), then overrides x and y.
  // A new object, so the old player is left untouched.
  return { ...player, x, y };
}

/**
 * Which tiles (along one axis) a player's box covers when centred at `centre`.
 *
 * The box runs from `centre - 300` to `centre + 299`. Note the last unit is +299, not +300:
 * a box centred at 1700 covers units 1400…1999, which is all inside tile 1. With +300 it would
 * reach 2000 (tile 2), and a player standing flush against a wall in tile 2 would count as
 * overlapping it and get stuck. This off-by-one is the classic collision bug.
 *
 * Examples:
 *   centre 1500 → units 1200…1799 → { first: 1, last: 1 }  (fully inside tile 1)
 *   centre 2100 → units 1800…2399 → { first: 1, last: 2 }  (straddling tiles 1 and 2)
 */
function tileSpan(centre: number): { first: number; last: number } {
  return {
    first: tileOf(centre - PLAYER_HALF_SIZE),
    last: tileOf(centre + PLAYER_HALF_SIZE - 1),
  };
}

/**
 * Tries to move horizontally by `dx` units (negative = left). Returns the new x:
 * either the full move, or the position flush against the wall that blocked it.
 */
function moveX(map: TileMap, x: number, y: number, dx: number): number {
  if (dx === 0) return x;

  // Where the player WANTS to be.
  const nextX = x + dx;

  // Which rows the box covers (y isn't changing here) and which columns it would cover after
  // the move.
  const rows = tileSpan(y);
  const cols = tileSpan(nextX);

  // Only the LEADING edge can enter a new column: the right edge when moving right, the left
  // edge when moving left. The player moves 200 units per tick, much less than a 1000-unit tile,
  // so it can never jump clean over a column in one tick (that bug is called "tunnelling").
  const col = dx > 0 ? cols.last : cols.first;

  // The box may straddle two rows, so check the leading column in every row it covers.
  for (let ty = rows.first; ty <= rows.last; ty++) {
    if (isWall(map, col, ty)) {
      // Blocked: snap so the box's edge touches the wall exactly, instead of stopping short.
      //   Moving right into wall column 9 (units 9000…9999): right edge at 9000 → x = 9000 - 300 = 8700
      //   Moving left into wall column 0 (units 0…999):       left edge at 1000 → x = 1000 + 300 = 1300
      return dx > 0
        ? col * UNITS_PER_TILE - PLAYER_HALF_SIZE
        : (col + 1) * UNITS_PER_TILE + PLAYER_HALF_SIZE;
    }
  }

  // Nothing in the way: take the full move.
  return nextX;
}

/**
 * Same as moveX, turned 90°: tries to move vertically by `dy` units (negative = up).
 * Checks the leading ROW across every column the box covers.
 */
function moveY(map: TileMap, x: number, y: number, dy: number): number {
  if (dy === 0) return y;
  const nextY = y + dy;
  const cols = tileSpan(x);
  const rows = tileSpan(nextY);
  const row = dy > 0 ? rows.last : rows.first; // bottom edge going down, top edge going up
  for (let tx = cols.first; tx <= cols.last; tx++) {
    if (isWall(map, tx, row)) {
      return dy > 0
        ? row * UNITS_PER_TILE - PLAYER_HALF_SIZE
        : (row + 1) * UNITS_PER_TILE + PLAYER_HALF_SIZE;
    }
  }
  return nextY;
}
