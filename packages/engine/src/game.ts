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

// One player's state. More fields arrive in later sprints (flashlight, escorting, baliktad).
export interface PlayerState {
  readonly id: string; // unique id, assigned when the player joins a room (S1-04)
  readonly x: number; // centre of the box, left↔right, in units (always a whole number)
  readonly y: number; // centre of the box, top↕bottom, in units (always a whole number)
}

// Everything needed to continue the game from this exact moment.
export interface GameState {
  readonly tick: number; // how many steps have run since the round began; labels snapshots (S1-05)
  readonly map: TileMap; // the level layout; never changes during a round
  // An array, not an object keyed by id, so players are always processed in the same order.
  // Order will matter once players affect each other (e.g. two grabbing the same kid).
  readonly players: readonly PlayerState[];
}

// Inputs for one tick, keyed by player id: { "p1": { up: true, ... }, "p2": { ... } }.
// Record<string, MoveInput> = an object whose keys are strings and whose values are MoveInputs.
// A player missing from this object is treated as "no keys held" (e.g. their packet was late).
export type Inputs = Readonly<Record<string, MoveInput>>;

// Things that happened during a step that the client reacts to once: a sound, "Naligaw!",
// a telemetry record. None exist yet, so the type is `never` (a type with no possible values):
// the events array can only be empty until real event types are added here.
export type GameEvent = never;

// What step() returns: the next state plus whatever happened on the way there.
export interface StepResult {
  readonly state: GameState; // the game after this tick
  readonly events: readonly GameEvent[]; // what happened during this tick (empty for now)
}

// Where a player starts, in whole tiles (easier to write than units).
export interface PlayerSpawn {
  readonly id: string; // which player
  readonly tileX: number; // starting tile column; the player is placed at the tile's centre
  readonly tileY: number; // starting tile row
}

// ─── Public functions ────────────────────────────────────────────────────────────────────────

// Builds the starting state of a round: tick 0, every player in the middle of their spawn tile.
export function createGame(map: TileMap, spawns: readonly PlayerSpawn[]): GameState {
  // .map() builds a NEW array by turning each spawn into a PlayerState.
  // `({ id, tileX, tileY })` is destructuring: it pulls those three fields out of each spawn.
  const players = spawns.map(({ id, tileX, tileY }) => {
    // A player spawned inside a wall could never move out, so refuse it loudly.
    if (isWall(map, tileX, tileY)) {
      // `throw` stops the function with an error; the backticks build a message with ${values}.
      throw new RangeError(`player ${id} would spawn inside a wall at (${tileX}, ${tileY})`);
    }
    // Tile → units: tile 3 starts at 3000, and + 500 (half a tile) puts the player at its centre.
    return { id, x: tileX * UNITS_PER_TILE + 500, y: tileY * UNITS_PER_TILE + 500 };
  });
  // `{ tick: 0, map, players }` is shorthand for { tick: 0, map: map, players: players }.
  return { tick: 0, map, players };
}

// Advances the game by exactly one tick (50 ms of game time).
// It never edits `state`: it builds a new state and returns it, so the old one stays valid.
// That's what lets tests compare "before" and "after", and lets a round be replayed exactly.
export function step(state: GameState, inputs: Inputs): StepResult {
  // Build the new list of players, one at a time, in the same order as before.
  const players = state.players.map((player) => {
    // Look up this player's keys. This is `undefined` if no input arrived for them this tick.
    const input = inputs[player.id];
    // `a ? b : c` means "if a then b else c". No input → the same player, standing still.
    return input ? movePlayer(state.map, player, input) : player;
  });
  // New state: tick goes up by one; the map is shared (it's read-only, so sharing is safe).
  // No events yet, so the events list is empty.
  return { state: { tick: state.tick + 1, map: state.map, players }, events: [] };
}

// ─── Movement and collision (private helpers: no `export`, so only this file can use them) ───

// Turns held keys into a movement for one tick, then applies it with wall collision.
function movePlayer(map: TileMap, player: PlayerState, input: MoveInput): PlayerState {
  // Number(true) = 1 and Number(false) = 0, so this gives -1 (left), 0 (none) or +1 (right).
  // A and D together → 1 - 1 = 0: opposite keys cancel out.
  const dirX = Number(input.right) - Number(input.left);
  // Same for vertical. "down" is +1 because y grows downwards (see the diagram at the top).
  const dirY = Number(input.down) - Number(input.up);

  // No direction on either axis: nothing to do, return the player unchanged.
  if (dirX === 0 && dirY === 0) return player;

  // Moving on BOTH axes = diagonal = use the slower per-axis speed; otherwise full speed.
  const speed = dirX !== 0 && dirY !== 0 ? PLAYER_DIAGONAL_SPEED : PLAYER_SPEED;

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
